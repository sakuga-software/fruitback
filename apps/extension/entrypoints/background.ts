import { browser } from 'wxt/browser';
import { readAll, readFreshPreviews, readSite, rememberPreviews, replaceAll } from '../src/sites.ts';
import { refreshPreviews } from '../src/cloud.ts';
import { PREVIEWS_REFRESH_MS, touchesPreviews } from '../src/proven-previews.ts';
import { accessOf, patternsOf } from '../src/access-return.ts';
import { createBrowserAccessReturn } from '../src/access-return-browser.ts';
import { createBrowserPending } from '../src/pending-site-browser.ts';
import { createSiteOwner, isExtensionPage, parseSiteMutation } from '../src/site-writes.ts';
import { lendsSession, parseSitePattern } from '../src/site-patterns.ts';
import { matchPatternFor, serialize, syncRegistration } from '../src/registration.ts';
import { createBrowserSessions } from '../src/session-browser.ts';
import { createSessionPreviews } from '../src/session-previews.ts';
import { touchesARefreshToken } from '../src/session-storage.ts';
import {
  REFUSED_STATUS,
  RELAY_CALL_TIMEOUT_MS,
  type RelayRequest,
  type RelayResponse,
  parseBridgeMessage,
  relayRefusal,
} from '../src/protocol.ts';
import { createRelay } from '../src/relay.ts';
import { KNOWN_SETTING, SYNC_SETTING, createSiteSync } from '../src/site-sync.ts';
import { type CaptureArea, createCapture, pixelsOf } from '../src/capture.ts';
import { pollConnect } from '../src/connect.ts';
import { PENDING_CONNECT_KEY, createBrowserConnect } from '../src/connect-browser.ts';

/** Named once: the alarm is created, cleared and answered in three different places. */
const SESSION_ALARM = 'fruitback-session-refresh';

/** The alarm that asks the workers again which previews they proved (FRU-103). */
const PREVIEWS_ALARM = 'fruitback-previews-refresh';

/**
 * The alarm that claims a sign-in the console may have approved (FRU-251), while the popup is closed.
 * Opening the tab of the console closes the popup: without it, the person would approve and come
 * back to a popup that asks them to sign in.
 */
const CONNECT_ALARM = 'fruitback-connect';

/**
 * How soon the earliest alarm may be.
 *
 * A browser clamps an alarm that is too near, and how near differs between them. The floor is here
 * so this code decides rather than discovers it. It is well inside the refresh margin, so a token is
 * still replaced before it expires.
 */
const MIN_ALARM_DELAY_MS = 60 * 1000;

/**
 * Keeps the two content scripts registered for exactly the sites that are switched on (FRU-41).
 *
 * The extension declares no host permission, so nothing runs anywhere until this does it — see
 * wxt.config.ts for why an install-time `<all_urls>` was not acceptable for a review tool.
 *
 * An MV3 service worker is stopped and restarted whenever the browser feels like it, so this keeps
 * no state: every path recomputes the whole set from storage and the granted permissions. Registered
 * scripts survive the worker being killed, which is what makes that affordable.
 */
export default defineBackground(() => {
  // Serialised: four event sources call this, and the read-then-write inside would otherwise race
  // with itself. See `serialize`.
  // The whole body is guarded, not just the registration call. `serialize` swallows a rejection to
  // keep the queue moving, and every caller below is fire-and-forget, so a throw that is not logged
  // here is logged nowhere at all: the scripts stay unregistered, no page mounts anything, and the
  // popup still reports the site as on. The first version wrapped `syncRegistration` alone, which
  // left a failing `readAll` or a throwing `permissions.contains` perfectly silent. Raised in review.
  const sync = serialize(async (): Promise<void> => {
    try {
      // FRU-103: a team wildcard is registered only while its worker lists it, so a proof that is lost
      // takes the scripts off the previews at the next sync.
      const [sites, proven] = await Promise.all([readAll(), readFreshPreviews()]);
      // A key that is not a pattern covers nothing in `resolveSite`, so it registers nothing here.
      const wanted = Object.entries(sites)
        .filter(
          ([pattern, site]) =>
            site.enabled && parseSitePattern(pattern) === pattern && !lendsSession(pattern, site, proven),
        )
        .map(([pattern]) => pattern);

      // A permission the reviewer granted once can be revoked in the browser's own settings, without
      // this extension hearing about it in any way it could act on. Chromium registers a script for
      // an origin we do not hold and says nothing (measured, FRU-45), so the grant is checked here.
      const held = await Promise.all(
        wanted.map((pattern) => browser.permissions.contains({ origins: [matchPatternFor(pattern)] })),
      );
      const granted = wanted.filter((_, index) => held[index]);

      await syncRegistration(browser.scripting, granted);
    } catch (error) {
      console.error('[fruitback] could not sync the content script registration', error);
    }
  });

  /**
   * Keeps every paired worker's access token fresh, and the alarm pointed at the next one (FRU-60).
   *
   * **No token leaves the extension's trusted contexts.** This one and the popup hold them; the
   * isolated content script asks this to make a call, and the page's world is never told anything.
   * See `src/session.ts`, and `src/worlds.test.ts` for the guard.
   *
   * An alarm rather than a timer, because an MV3 service worker is stopped whenever the browser
   * feels like it and a `setTimeout` dies with it. Scheduled at the next due moment rather than on a
   * period: one session with a ten-minute token and a two-minute margin wakes this every eight
   * minutes, and a worker that cannot be reached backs off to `RETRY_DELAY_MS` instead of retrying
   * every minute for as long as it stays down.
   *
   * Serialised and fully guarded for the same two reasons `sync` is: three event sources call it,
   * and every caller is fire-and-forget, so an error nobody logs here is logged nowhere.
   */
  const sessions = createBrowserSessions();
  const refreshSessions = serialize(async (): Promise<void> => {
    try {
      await sessions.refreshDue();

      const due = await sessions.dueAt();
      if (due === undefined) {
        await browser.alarms.clear(SESSION_ALARM);

        return;
      }

      // Awaited: it answers a promise, so a rejection would escape the guard below. Raised in review.
      await browser.alarms.create(SESSION_ALARM, { when: Math.max(due, Date.now() + MIN_ALARM_DELAY_MS) });
    } catch (error) {
      console.error('[fruitback] could not refresh the extension session', error);
    }
  });

  /**
   * Asks each paired worker again which previews its workspace proved (FRU-103), then registers what
   * that leaves. On a period, and when the browser starts: an answer grants for `PREVIEWS_FRESH_MS`
   * only, so a worker that is not asked stops granting. Guarded like the two above.
   */
  const refreshProven = serialize(async (): Promise<void> => {
    try {
      await refreshPreviews({
        endpoints: async () => Object.keys(await sessions.list()),
        ensureAccess: (endpoint) => sessions.ensureAccess(endpoint),
        remember: rememberPreviews,
        // The epoch of the session in place: an answer is kept only for the session that asked.
        sessionOf: async (endpoint) => {
          const held = (await sessions.list())[endpoint];

          return held === undefined ? undefined : (held.epoch ?? '');
        },
      });
    } catch (error) {
      console.error('[fruitback] could not ask the workers for the previews they proved', error);
    }
    // Also when nothing was written: an answer that aged out since the last sync must stop its rule.
    await sync();
  });

  /**
   * Claims the sign-in that waits, once (FRU-251). The alarm stops when the request is settled:
   * signed in, refused or expired. The popup claims too while it is open; `pollConnect` says why the
   * two cannot take the session twice. Guarded like the three above.
   */
  const connect = createBrowserConnect(sessions);
  const claimSignIn = serialize(async (): Promise<void> => {
    try {
      // Kept: how it ended is for the popup to say.
      const state = await pollConnect(connect, { keep: true });
      if (state !== 'waiting' && state !== 'unavailable') await browser.alarms.clear(CONNECT_ALARM);
    } catch (error) {
      console.error('[fruitback] could not claim the sign-in', error);
    }
  });

  const sessionPreviews = createSessionPreviews({
    forget: (endpoint) => rememberPreviews(endpoint, undefined),
    ask: refreshProven,
    report: (error) => console.error('[fruitback] could not forget the previews of a session that ended', error),
  });

  /**
   * Team mode: the call the page cannot make, made here (FRU-57).
   *
   * The origin is read off the sender the browser reports and never off the message — a content
   * script's input is written by the page, and this is the context the page cannot reach. Everything
   * else it decides lives in `src/relay.ts`.
   */
  const relay = createRelay({
    readSite,
    ensureAccess: (endpoint) => sessions.ensureAccess(endpoint),
    renewAccess: (endpoint, refused) => sessions.renewAccess(endpoint, refused),
    send,
  });

  /** The picture of a note (FRU-44): see `src/capture.ts`. */
  const capture = (area: CaptureArea, origin: string | undefined, windowId: number) =>
    createCapture({
      readSite,
      ensureAccess: (endpoint) => sessions.ensureAccess(endpoint),
      renewAccess: (endpoint, refused) => sessions.renewAccess(endpoint, refused),
      captureTab: async () => (await fetch(await browser.tabs.captureVisibleTab(windowId, { format: 'png' }))).blob(),
      crop: cropPicture,
      upload: async (url, accessToken, png) => {
        const response = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'image/png' },
          credentials: 'omit',
          signal: AbortSignal.timeout(RELAY_CALL_TIMEOUT_MS),
          body: png,
        });

        return { status: response.status, body: await response.text() };
      },
    })(area, origin);

  /** The only writer of the sites map, so a change from the popup and one from the options page cannot drop each other (FRU-43). */
  const returnAccess = createBrowserAccessReturn(sessions);
  // FRU-115: a rule that is switched off, removed or moved to another worker gives its access back.
  // FRU-72: the rules in the account of the browser, when the reviewer asked for it. See `site-sync.ts`.
  const siteSync = createSiteSync({
    enabled: async () => (await browser.storage.local.get(SYNC_SETTING))[SYNC_SETTING] === true,
    known: {
      read: async () => {
        const stored = (await browser.storage.local.get(KNOWN_SETTING))[KNOWN_SETTING];

        return Array.isArray(stored) ? stored.filter((each): each is string => typeof each === 'string') : [];
      },
      write: (patterns) => browser.storage.local.set({ [KNOWN_SETTING]: patterns }),
    },
    readLocal: readAll,
    area: {
      get: () => browser.storage.sync.get(null),
      set: (items) => browser.storage.sync.set(items),
      remove: (keys) => browser.storage.sync.remove(keys),
    },
    apply: (mutation) => ownSites(mutation),
  });
  const mergeRules = (): void =>
    void siteSync
      .merge()
      .catch((error: unknown) => console.error('[fruitback] could not merge the rules of the browser account', error));
  const ownSites = createSiteOwner({ read: readAll, replace: replaceAll }, async (before, mutation) => {
    // The copy first, and its failure (a quota, an account that is away) does not keep the access.
    await siteSync
      .stored(mutation)
      .catch((error: unknown) =>
        console.error('[fruitback] could not copy a site change to the browser account', error),
      );
    await returnAccess(accessOf(before, patternsOf(mutation)));
  });
  const extensionRoot = browser.runtime.getURL('/popup.html').replace(/popup\.html$/, '');
  const pending = createBrowserPending((pattern, site) => ownSites({ kind: 'write', entries: { [pattern]: site } }));

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const mutation = parseSiteMutation(message);
    if (mutation !== undefined) {
      // A content script can send this too, and a page must not add a rule for itself.
      if (!isExtensionPage(sender, browser.runtime.id, extensionRoot)) return false;

      void ownSites(mutation).then(
        () => sendResponse({ ok: true }),
        (error: unknown) => {
          console.error('[fruitback] could not store a site change', error);
          sendResponse({ ok: false });
        },
      );

      return true;
    }

    const parsed = parseBridgeMessage(message);
    // FRU-44: the picture of a note, of the tab the content script runs in, and of no other tab.
    if (parsed?.kind === 'capture-request') {
      const windowId = sender.tab?.windowId;
      if (windowId === undefined || sender.tab?.active !== true) {
        sendResponse({});

        return false;
      }
      void capture(parsed.area, senderOrigin(sender), windowId).then((picture) =>
        sendResponse(picture === undefined ? {} : { picture }),
      );

      return true;
    }
    if (parsed?.kind !== 'relay-request') return false;

    void relay(parsed.request, senderOrigin(sender))
      // `createRelay` answers rather than rejects, and this is the backstop for the case it cannot
      // reach — the runtime message must be answered, or the page waits out its whole deadline.
      .catch(() => relayRefusal('extension-unavailable'))
      .then((response) => {
        // The only place a refusal is ever readable. The widget treats it as an unreachable worker, so
        // without this a reviewer whose session has expired sees a page with no pins and no reason.
        if (response.status === REFUSED_STATUS) console.warn('[fruitback] the relay refused a call:', response.body);

        sendResponse(response);
      });

    // The answer comes later, and returning `false` here would close the channel before it does.
    return true;
  });

  browser.runtime.onInstalled.addListener(() => {
    void sync();
    // A rule switched off before FRU-115 kept its access. An update gives it back, once.
    void readAll()
      .then((sites) => returnAccess(accessOf(sites, Object.keys(sites))))
      .catch((error: unknown) =>
        console.error('[fruitback] could not give back the access of the rules that are off', error),
      );
  });
  browser.runtime.onStartup.addListener(() => {
    void sync();
    mergeRules();
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
      void siteSync
        .changed(changes)
        .catch((error: unknown) => console.error('[fruitback] could not take a rule of the browser account', error));

      return;
    }
    if (area === 'session' && changes[PENDING_CONNECT_KEY] !== undefined) {
      // A sign-in started, or ended: claim it every minute while it waits, and stop after.
      const waiting = changes[PENDING_CONNECT_KEY].newValue !== undefined;
      void (
        waiting
          ? browser.alarms.create(CONNECT_ALARM, { delayInMinutes: MIN_ALARM_DELAY_MS / 60_000, periodInMinutes: 1 })
          : browser.alarms.clear(CONNECT_ALARM)
      ).catch((error: unknown) => console.error('[fruitback] could not set the alarm of the sign-in', error));
    }
    if (area !== 'local') return;
    // The reviewer just turned the copy on: each side takes the rules it does not have.
    if (changes[SYNC_SETTING]?.newValue === true) mergeRules();
    // Turned off: what was known of the account is forgotten, so the next merge removes nothing.
    if (changes[SYNC_SETTING] !== undefined && changes[SYNC_SETTING].newValue !== true) {
      void siteSync
        .forget()
        .catch((error: unknown) =>
          console.error('[fruitback] could not forget the rules of the browser account', error),
        );
    }
    if (changes.sites !== undefined || touchesPreviews(Object.keys(changes))) void sync();
    // A pairing or a logout from the popup, this run's own writes — the worker rotates on every
    // refresh (FRU-61), so every refresh stores a new token — and the upgrade in `upgradeAreas`,
    // which writes every endpoint at once. Each re-entry settles at once: the next run finds the
    // tokens fresh, refreshes nothing and only re-arms the alarm.
    if (touchesARefreshToken(Object.keys(changes))) void refreshSessions();
    // FRU-103: a pairing or a logout ends what the worker listed. See `session-previews.ts`.
    void sessionPreviews(Object.keys(changes));
  });
  browser.permissions.onRemoved.addListener(() => void sync());
  // The options page grants access to an entry that is already stored, so no storage change follows.
  browser.permissions.onAdded.addListener(() => {
    // FRU-118: the prompt can close the popup that asked, so the site it asked for is finished here.
    void pending
      .settle()
      .catch((error: unknown) => console.error('[fruitback] could not turn on the site that was asked for', error))
      .then(() => sync());
  });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SESSION_ALARM) void refreshSessions();
    if (alarm.name === PREVIEWS_ALARM) void refreshProven();
    if (alarm.name === CONNECT_ALARM) void claimSignIn();
  });
  // Created at each start of the service worker: `create` replaces the alarm of the same name.
  void browser.alarms
    .create(PREVIEWS_ALARM, { periodInMinutes: PREVIEWS_REFRESH_MS / 60_000 })
    .catch((error: unknown) => console.error('[fruitback] could not set the alarm of the previews', error));

  void sync();
  void refreshProven();
  // `chrome.storage.session` is empty after the browser restarts, so this is also what mints the
  // first access token of the day rather than waiting for something to ask for one.
  void refreshSessions();
});

/**
 * The origin the browser says the message came from, never the one the message claims.
 *
 * `sender.origin` is Chrome's; Firefox reports `sender.url` instead, and the origin of the document
 * a content script runs in is what both of them describe. A sender with neither is not a content
 * script of ours, and `relay.ts` refuses it.
 */
function senderOrigin(sender: { origin?: string; url?: string }): string | undefined {
  if (sender.origin !== undefined) return sender.origin;
  if (sender.url === undefined) return undefined;

  try {
    return new URL(sender.url).origin;
  } catch {
    return undefined;
  }
}

/**
 * The relayed call itself.
 *
 * `credentials: 'omit'` because the token in the headers is the only authority this call carries.
 * A cookie the reviewer happens to hold on the worker's domain is not something the page asking for
 * this relay should be able to spend.
 *
 * A rejection — an abort included — is caught by `createRelay`, which turns it into a refusal.
 */
async function send(request: RelayRequest): Promise<RelayResponse> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    credentials: 'omit',
    // Aborted rather than merely given up on. A worker that accepts the connection and never answers
    // would otherwise keep this request in flight while the page is told the call failed — and a
    // reviewer told their note failed presses send again, which plants it twice. Raised in review.
    signal: AbortSignal.timeout(RELAY_CALL_TIMEOUT_MS),
    ...(request.body !== undefined ? { body: request.body } : {}),
  });

  return { ok: response.ok, status: response.status, body: await response.text() };
}

/** The area of the element, cut out of the capture of the tab, as a PNG (FRU-44). */
async function cropPicture(picture: Blob, area: CaptureArea): Promise<Blob> {
  const bitmap = await createImageBitmap(picture);
  const cut = pixelsOf(area, bitmap);
  if (cut === undefined) throw new Error('the element is not on the screen');
  const canvas = new OffscreenCanvas(cut.width, cut.height);
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('no 2d context');
  context.drawImage(bitmap, cut.left, cut.top, cut.width, cut.height, 0, 0, cut.width, cut.height);
  bitmap.close();

  return canvas.convertToBlob({ type: 'image/png' });
}
