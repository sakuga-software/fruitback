import { browser } from 'wxt/browser';
import { readAll, readFreshPreviews, readSite, rememberPreviews, replaceAll } from '../src/sites.ts';
import { finishAdd, refreshPreviews } from '../src/cloud.ts';
import { PREVIEWS_REFRESH_MS, touchesPreviews } from '../src/proven-previews.ts';
import { accessOf, patternsOf } from '../src/access-return.ts';
import { createBrowserAccessReturn } from '../src/access-return-browser.ts';
import { createBrowserPending } from '../src/pending-site-browser.ts';
import { createSiteOwner, isExtensionPage, parseSiteMutation } from '../src/site-writes.ts';
import { lendsSession, parseSitePattern } from '../src/site-patterns.ts';
import { matchPatternFor, serialize, syncRegistration } from '../src/registration.ts';
import { HIDDEN_ORIGINS_KEY, readHidden } from '../src/page-visibility.ts';
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
import { type CaptureArea, bytesOf, captureAnswerOf, createCapture, pixelsOf } from '../src/capture.ts';
import { pollConnect } from '../src/connect.ts';
import { PENDING_CONNECT_KEY, createBrowserConnect } from '../src/connect-browser.ts';
import { runShortcut, tabOfCommand } from '../src/shortcut.ts';
import { captureMenu, runCaptureMenu } from '../src/context-menu.ts';
import { holdsSiteAccess } from '../src/site-grant.ts';
import { LANGUAGE_KEY, storedLanguage } from '../src/language.ts';
import { nearest } from '../src/i18n.ts';
import { acceptedSignIn, createSignInGate } from '../src/sign-in-request.ts';
import { cloudEndpoint, wantsSession } from '../src/popup-state.ts';
import {
  PANEL_ON_CLICK_KEY,
  PANEL_PORT,
  type PanelApis,
  iconOpensPanel,
  keepPopupOnActionClick,
  pinsKeeper,
  setPanelOnClick,
} from '../src/side-panel.ts';
import { tabCommand } from '../src/tab-command.ts';
import { WELCOME_PATH, opensWelcome } from '../src/welcome-install.ts';

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
      // FRU-444: the origins where the reviewer hid the widget get no script.
      const [sites, proven, hidden] = await Promise.all([
        readAll(),
        readFreshPreviews(),
        readHidden(browser.storage.local),
      ]);
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
        // FRU-425: a grant of the site itself. `<all_urls>` does not count: see `src/site-grant.ts`.
        wanted.map((pattern) => holdsSiteAccess(matchPatternFor(pattern), browser.permissions)),
      );
      const granted = wanted.filter((_, index) => held[index]);

      await syncRegistration(browser.scripting, granted, hidden);
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
    warn: (reason) => console.warn('[fruitback] the relay answered 401, with no session:', reason),
  });

  /** A capture of the page or of an area (FRU-44, FRU-332): see `src/capture.ts`. It sends nothing. */
  const capture = (area: CaptureArea | undefined, origin: string | undefined, windowId: number) =>
    createCapture({
      readSite,
      ensureAccess: (endpoint) => sessions.ensureAccess(endpoint),
      captureTab: async () => (await fetch(await browser.tabs.captureVisibleTab(windowId, { format: 'png' }))).blob(),
      crop: cropPicture,
      toJpeg: jpegOf,
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
  const signInGate = createSignInGate();
  // FRU-454: a site of no workspace is added here when the prompt closed the popup that asked.
  const pending = createBrowserPending(
    (pattern, site) => ownSites({ kind: 'write', entries: { [pattern]: site } }),
    (pattern, intent) => finishAdd(pattern, intent, { ensureAccess: (endpoint) => sessions.ensureAccess(endpoint) }),
  );

  // FRU-307: the pins a side panel hid come back when the panel goes, whatever closed it.
  browser.runtime.onConnect.addListener((port) => {
    if (
      port.name !== PANEL_PORT ||
      !isExtensionPage(port.sender ?? {}, browser.runtime.id, browser.runtime.getURL('/'))
    ) {
      return;
    }
    const keeper = pinsKeeper((tabId) => {
      void browser.tabs.sendMessage(tabId, tabCommand('show-pins')).catch(() => undefined);
    });
    port.onMessage.addListener(keeper.heard);
    port.onDisconnect.addListener(() => keeper.closed());
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // FRU-315: the widget of a tab asks for the sign-in. The popup opens over that tab, and only
    // when the site of the tab wants a session this browser does not hold.
    const asking = acceptedSignIn(message, sender, browser.runtime.id);
    if (asking !== undefined) {
      // Once in a while per tab: a page can forge the ask, and must not open the popup in a loop.
      if (asking.id !== undefined && signInGate(asking.id)) {
        // The sessions of this worker, read once more: a store that cannot be read opens nothing.
        void openSignIn(asking, () => sessions.list()).catch((error: unknown) =>
          console.warn('[fruitback] could not decide whether to open the popup for the sign-in', error),
        );
      }

      return false;
    }

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
      void capture(parsed.area, senderOrigin(sender), windowId).then((taken) => sendResponse(captureAnswerOf(taken)));

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

  // FRU-302: « Open notes in the sidebar ». The icon opens the panel on a site that is on, and the
  // popup elsewhere: set again for the active tab when it changes, and when the preference does.
  const panelOnClick = async (): Promise<void> => {
    const wanted = (await browser.storage.local.get(PANEL_ON_CLICK_KEY))[PANEL_ON_CLICK_KEY] === true;
    const [active] = await browser.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
    let siteOn = false;
    if (wanted && active?.url !== undefined) {
      try {
        const site = await readSite(new URL(active.url).origin);
        const ended =
          site !== undefined &&
          wantsSession(site, cloudEndpoint(import.meta.env.WXT_FRUITBACK_CLOUD), await sessions.list());
        siteOn = iconOpensPanel(wanted, site, ended);
      } catch {
        siteOn = false;
      }
    }
    await setPanelOnClick(browser as unknown as PanelApis, wanted, siteOn);
  };
  const followPanelOnClick = (): void =>
    void panelOnClick().catch((error: unknown) =>
      console.error('[fruitback] could not set what the icon opens', error),
    );
  browser.tabs.onActivated.addListener(followPanelOnClick);
  browser.tabs.onUpdated.addListener((_id, change, tab) => {
    if (tab.active && change.url !== undefined) followPanelOnClick();
  });
  browser.windows.onFocusChanged.addListener(followPanelOnClick);
  // The local area only, by its own event: the listener of every area below stays the one that reads
  // the sessions (`session-previews.test.ts`).
  // A session made or ended changes it too: a site whose session ended opens the popup (review).
  browser.storage.local.onChanged.addListener((changes) => {
    // FRU-423: the item of the context menu speaks the language of the reviewer.
    if (changes[LANGUAGE_KEY] !== undefined) void placeCaptureMenu();
    const keys = Object.keys(changes);
    if (changes[PANEL_ON_CLICK_KEY] !== undefined || changes.sites !== undefined || touchesARefreshToken(keys)) {
      followPanelOnClick();
    }
  });

  browser.runtime.onInstalled.addListener((details) => {
    // A first install opens the page that says what comes next (FRU-318). An extension page needs
    // no permission to open, and an update opens nothing.
    if (opensWelcome(details)) {
      void browser.tabs
        .create({ url: browser.runtime.getURL(WELCOME_PATH) })
        .catch((error: unknown) => console.error('[fruitback] could not open the welcome page', error));
    }
    void placeCaptureMenu();
    void sync();
    // FRU-296: the click on the icon opens the popup; the panel opens from it. The browser keeps the
    // behaviour, so it is set at install and at each update.
    void keepPopupOnActionClick(browser as unknown as PanelApis)
      .then(() => panelOnClick())
      .catch((error: unknown) => console.error('[fruitback] could not keep the popup on the click of the icon', error));
    // A rule switched off before FRU-115 kept its access. An update gives it back, once.
    void readAll()
      .then((sites) => returnAccess(accessOf(sites, Object.keys(sites))))
      .catch((error: unknown) =>
        console.error('[fruitback] could not give back the access of the rules that are off', error),
      );
  });
  browser.runtime.onStartup.addListener(() => {
    void placeCaptureMenu();
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
    if (
      changes.sites !== undefined ||
      changes[HIDDEN_ORIGINS_KEY] !== undefined ||
      touchesPreviews(Object.keys(changes))
    ) {
      void sync();
    }
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
  // FRU-423: « Capture with Fruitback ». Its click grants `activeTab` for the tab. See `src/context-menu.ts`.
  browser.contextMenus.onClicked.addListener((info, tab) =>
    runCaptureMenu(info, tab, (tabId, message) => browser.tabs.sendMessage(tabId, message)),
  );
  // FRU-291: the key of the manifest starts a note on the tab it was pressed on. See `runShortcut`.
  browser.commands.onCommand.addListener((command, tab) => {
    void tabOfCommand(tab, () => browser.tabs.query({ active: true, currentWindow: true })).then((pressedOn) =>
      runShortcut(command, pressedOn, (tabId, message) => browser.tabs.sendMessage(tabId, message)),
    );
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
 * The popup, over the tab whose widget asked for the sign-in (FRU-315).
 *
 * `action.openPopup` is what Chrome 127 and later give every extension. Firefox opens it only from
 * a gesture, which a message is not: the call then fails, and the widget's words still say to sign
 * in from the toolbar's button. Nothing else is opened in its place: the sign-in starts in the popup
 * because the popup is where its word is compared.
 */
async function openSignIn(
  tab: { url?: string; windowId?: number },
  listSessions: () => Promise<Record<string, unknown>>,
): Promise<void> {
  if (tab.url === undefined) return;
  let origin: string;
  try {
    origin = new URL(tab.url).origin;
  } catch {
    return;
  }
  const site = await readSite(origin);
  const held = await listSessions();
  if (site === undefined || !wantsSession(site, cloudEndpoint(import.meta.env.WXT_FRUITBACK_CLOUD), held)) return;

  // A popup already open is where the person is: nothing opens over it.
  const runtime = browser.runtime as typeof browser.runtime & {
    getContexts?: (filter: { contextTypes: string[] }) => Promise<unknown[]>;
  };
  // A browser without `getContexts`, or one that refuses it, cannot tell: the popup is asked for all
  // the same, and the failure is written down (review of #378). `openPopup` over an open popup
  // leaves it as it is.
  const open = await runtime.getContexts?.({ contextTypes: ['POPUP'] }).catch((error: unknown) => {
    console.warn('[fruitback] could not tell whether the popup is open', error);

    return [];
  });
  if (open !== undefined && open.length > 0) return;

  await browser.action
    .openPopup(tab.windowId === undefined ? undefined : { windowId: tab.windowId })
    .catch((error: unknown) => console.warn('[fruitback] the popup did not open for the sign-in', error));
}

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
    // FRU-332: a file of a note travels as base64 between the page and here, and leaves as bytes.
    ...(request.body !== undefined
      ? { body: request.encoding === 'base64' ? bytesOf(request.body) : request.body }
      : {}),
  });

  return { ok: response.ok, status: response.status, body: await response.text() };
}

/** The same picture as a JPEG of quality 0.85, for a PNG over the limit of the worker (FRU-332). */
async function jpegOf(picture: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(picture);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('no 2d context');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();

  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
}

/** The area, cut out of the capture of the tab, as a PNG (FRU-44, FRU-332). */
async function cropPicture(picture: Blob, area: CaptureArea): Promise<Blob> {
  const bitmap = await createImageBitmap(picture);
  const cut = pixelsOf(area, bitmap);
  if (cut === undefined) throw new Error('the area is not on the screen');
  const canvas = new OffscreenCanvas(cut.width, cut.height);
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('no 2d context');
  context.drawImage(bitmap, cut.left, cut.top, cut.width, cut.height, 0, 0, cut.width, cut.height);
  bitmap.close();

  return canvas.convertToBlob({ type: 'image/png' });
}

/**
 * Places « Capture with Fruitback » in the context menu (FRU-423), in the language of the reviewer.
 * Removed first: `create` fails on an id that is there, and a menu of the version before stays.
 */
async function placeCaptureMenu(): Promise<void> {
  try {
    const kept = await storedLanguage(browser.storage.local);
    await browser.contextMenus.removeAll();
    browser.contextMenus.create(captureMenu(nearest(kept ?? browser.i18n.getUILanguage())));
  } catch (error) {
    console.error('[fruitback] could not place the item of the context menu', error);
  }
}
