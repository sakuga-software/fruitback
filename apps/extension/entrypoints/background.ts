import { browser } from 'wxt/browser';
import { readAll } from '../src/sites.ts';
import { matchPatternFor, serialize, syncRegistration } from '../src/registration.ts';
import { SESSIONS_KEY, createBrowserSessions } from '../src/session-browser.ts';

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

  browser.runtime.onInstalled.addListener(() => void sync());
  browser.runtime.onStartup.addListener(() => void sync());
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.sites !== undefined) void sync();
    // A pairing or a logout from the popup, and — once the worker rotates — this run's own write.
    // That re-entry settles at once: the second run finds the token fresh, refreshes nothing and
    // only re-arms the alarm.
    if (changes[SESSIONS_KEY] !== undefined) void refreshSessions();
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
