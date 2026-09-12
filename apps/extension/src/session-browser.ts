import { browser } from 'wxt/browser';
import {
  GRANT_PREFIX,
  LEGACY_GRANTS_KEY,
  LEGACY_SESSIONS_KEY,
  SESSION_PREFIX,
  createArea,
  splitLegacyRecord,
} from './session-storage.ts';
import {
  type AccessGrant,
  type Area,
  type SessionResponse,
  type Sessions,
  type StoredSession,
  createSessions,
  parseAccessGrant,
  parseStoredSession,
} from './session.ts';

/**
 * `session.ts` wired to the real browser (SKG-599).
 *
 * Everything that binds `browser` or `fetch` is here, so the domain beside it stays runnable under
 * `node --test`. The same split `bridge.ts` made for SKG-534.
 */

/** Long enough for a slow worker on a slow connection, short enough to unwedge the endpoint. */
const REQUEST_TIMEOUT_MS = 20 * 1_000;

/**
 * The refresh token, in the area that survives the browser closing.
 *
 * Read through a parser rather than cast: `chrome.storage` outlives an upgrade, so a shape an older
 * version wrote has to cost its own entry and not the extension.
 */
function localArea(ready: Promise<void>): Area<StoredSession> {
  return createArea(() => browser.storage.local, SESSION_PREFIX, parseStoredSession, ready);
}

/**
 * The access token, in the area the browser empties when it closes.
 *
 * **Nothing changes the access level of this area, and that is deliberate.** Its default keeps it to
 * the extension's trusted contexts — this background and the popup — and out of content scripts,
 * which is exactly the boundary this ticket exists to hold: the isolated script does not read the
 * token, it asks the background to make the call. Widening the area to
 * `TRUSTED_AND_UNTRUSTED_CONTEXTS` would put the token one `postMessage` mistake away from the page.
 */
function sessionArea(ready: Promise<void>): Area<AccessGrant> {
  return createArea(() => browser.storage.session, GRANT_PREFIX, parseAccessGrant, ready);
}

/**
 * The upgrade to one key per endpoint (SKG-602), once per context.
 *
 * It reads both areas, because a browser that was upgraded without closing still holds the legacy
 * grants record — and a grant left under a key nothing reads any more costs one needless refresh per
 * worker, with nothing anywhere to say why.
 *
 * A failure is swallowed on purpose. Storage that cannot be read is not a reason for the background
 * to stop registering content scripts, and the next startup tries again; the credentials are still
 * under the legacy key until the removal lands.
 */
async function migrate(): Promise<void> {
  await Promise.all([
    splitLegacyRecord(browser.storage.local, LEGACY_SESSIONS_KEY, SESSION_PREFIX, parseStoredSession),
    splitLegacyRecord(browser.storage.session, LEGACY_GRANTS_KEY, GRANT_PREFIX, parseAccessGrant),
  ]).catch(() => undefined);
}

/**
 * The three session routes, over `fetch`.
 *
 * The routes are exempt from the worker's origin allowlist (SKG-535) and answer a
 * `chrome-extension://` origin with the CORS headers that let an extension page read the reply, so
 * an ordinary cross-origin `fetch` should reach them. `Content-Type: application/json` makes the
 * request preflighted, which the worker allows. **That was measured with `curl`, which does not
 * enforce CORS**, so the popup asks for a host permission on the worker's origin before pairing
 * rather than relying on it — see `grantWorkerOrigin`. Raised in review.
 *
 * A body that is not JSON is handed on as `undefined` rather than throwing: the caller already has
 * to tell a refusal from an outage, and a parser is not the place to decide which one a broken body
 * is. A `fetch` that rejects stays a rejection, which `session.ts` reads as "the worker said
 * nothing".
 */
async function postJson(url: string, body: Record<string, unknown>): Promise<SessionResponse> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // **A refresh that never settles wedges this endpoint for good.** `refreshOnce` holds the
    // in-flight promise so a second caller joins it rather than spending the token twice, and a
    // worker that accepts the connection and never answers would leave that promise pending for the
    // life of the service worker. The relay's own call is bounded for a smaller reason.
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify(body),
  });

  return { status: response.status, body: await response.json().catch(() => undefined) };
}

export function createBrowserSessions(): Sessions {
  const ready = migrate();

  return createSessions({ sessions: localArea(ready), grants: sessionArea(ready), post: postJson });
}
