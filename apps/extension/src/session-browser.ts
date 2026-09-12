import { browser } from 'wxt/browser';
import { createStoredSessions } from './session-storage.ts';
import type { SessionResponse, Sessions } from './session.ts';

/**
 * `session.ts` wired to the real browser (SKG-599).
 *
 * Everything that binds `browser` or `fetch` is here, so the domain beside it stays runnable under
 * `node --test`. The same split `bridge.ts` made for SKG-534.
 */

/** Long enough for a slow worker on a slow connection, short enough to unwedge the endpoint. */
const REQUEST_TIMEOUT_MS = 20 * 1_000;

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

/**
 * **Two areas, and nothing calls `setAccessLevel` on the session one.**
 *
 * The refresh token goes in `local`, which survives the browser closing, and the access token in
 * `session`, which the browser empties. The epoch goes beside the session it dates, in `local`,
 * because it has to outlive everything it refuses.
 *
 * The default access level of `session` keeps it to the extension's trusted contexts — this
 * background and the popup — and out of content scripts, which is the boundary this whole batch
 * exists to hold: the isolated script never reads a token, it asks the background to make the call.
 * `TRUSTED_AND_UNTRUSTED_CONTEXTS` would put the token one `postMessage` mistake away from the page.
 *
 * Which key holds what is in `session-storage.ts`, and so is the upgrade. Both are read through a
 * parser rather than cast: `chrome.storage` outlives an upgrade, so a shape an older version wrote
 * costs its own entry and not the extension.
 */
export function createBrowserSessions(): Sessions {
  return createStoredSessions(
    () => browser.storage.local,
    () => browser.storage.session,
    postJson,
  );
}
