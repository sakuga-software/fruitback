import { browser } from 'wxt/browser';
import { readAll, readSite } from '../src/sites.ts';
import { matchPatternFor, serialize, syncRegistration } from '../src/registration.ts';
import { createBrowserSessions } from '../src/session-browser.ts';
import { touchesASession } from '../src/session-storage.ts';
import {
  REFUSED_STATUS,
  RELAY_CALL_TIMEOUT_MS,
  type RelayRequest,
  type RelayResponse,
  parseBridgeMessage,
  relayRefusal,
} from '../src/protocol.ts';
import { createRelay } from '../src/relay.ts';

/** Named once: the alarm is created, cleared and answered in three different places. */
const SESSION_ALARM = 'fruitback-session-refresh';

/**
 * How soon the earliest alarm may be.
 *
 * A browser clamps an alarm that is too near, and how near differs between them. The floor is here
 * so this code decides rather than discovers it. It is well inside the refresh margin, so a token is
 * still replaced before it expires.
 */
const MIN_ALARM_DELAY_MS = 60 * 1000;

/**
 * Keeps the two content scripts registered for exactly the sites that are switched on (SKG-534).
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
      const sites = await readAll();
      const wanted = Object.entries(sites)
        .filter(([, site]) => site.enabled)
        .map(([origin]) => origin);

      // A permission the reviewer granted once can be revoked in the browser's own settings, without
      // this extension hearing about it in any way it could act on. Registering a script for an
      // origin we no longer hold throws, so the grant is checked rather than assumed.
      const granted: string[] = [];
      for (const origin of wanted) {
        if (await browser.permissions.contains({ origins: [matchPatternFor(origin)] })) granted.push(origin);
      }

      await syncRegistration(browser.scripting, granted);
    } catch (error) {
      console.error('[fruitback] could not sync the content script registration', error);
    }
  });

  /**
   * Keeps every paired worker's access token fresh, and the alarm pointed at the next one (SKG-599).
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
   * Team mode: the call the page cannot make, made here (SKG-596).
   *
   * The origin is read off the sender the browser reports and never off the message — a content
   * script's input is written by the page, and this is the context the page cannot reach. Everything
   * else it decides lives in `src/relay.ts`.
   */
  const relay = createRelay({ readSite, ensureAccess: (endpoint) => sessions.ensureAccess(endpoint), send });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const parsed = parseBridgeMessage(message);
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

  browser.runtime.onInstalled.addListener(() => void sync());
  browser.runtime.onStartup.addListener(() => void sync());
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.sites !== undefined) void sync();
    // A pairing or a logout from the popup, and this run's own write — the worker rotates on every
    // refresh (SKG-600), so every refresh stores a new token here. That re-entry settles at once:
    // the second run finds the token fresh, refreshes nothing and only re-arms the alarm.
    if (touchesASession(Object.keys(changes))) void refreshSessions();
  });
  browser.permissions.onRemoved.addListener(() => void sync());
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SESSION_ALARM) void refreshSessions();
  });

  void sync();
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
