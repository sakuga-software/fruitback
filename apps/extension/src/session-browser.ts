import { browser } from 'wxt/browser';
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

export const SESSIONS_KEY = 'sessions';
export const GRANTS_KEY = 'access';

/**
 * The refresh token, in the area that survives the browser closing.
 *
 * Read through a parser rather than cast: `chrome.storage` outlives an upgrade, so a shape an older
 * version wrote has to cost its own entry and not the extension.
 */
function localArea(): Area<StoredSession> {
  return area(() => browser.storage.local, SESSIONS_KEY, parseStoredSession);
}

/**
 * The access token, in the area the browser empties when it closes.
 *
 * **Nothing changes the access level of this area, and that is deliberate.** Its default excludes
 * content scripts, which is exactly the boundary this ticket exists to hold: the isolated script
 * does not read the token, it asks the background to make the call. Widening the area to
 * `TRUSTED_AND_UNTRUSTED_CONTEXTS` would put the token one `postMessage` mistake away from the page.
 */
function sessionArea(): Area<AccessGrant> {
  return area(() => browser.storage.session, GRANTS_KEY, parseAccessGrant);
}

function area<T>(
  of: () => { get(key: string): Promise<unknown>; set(items: Record<string, unknown>): Promise<void> },
  key: string,
  parse: (value: unknown) => T | undefined,
): Area<T> {
  return {
    async read() {
      const stored = await of().get(key);
      const raw = isRecord(stored) ? stored[key] : undefined;
      if (!isRecord(raw)) return {};

      const entries: Record<string, T> = {};
      for (const [endpoint, value] of Object.entries(raw)) {
        const parsed = parse(value);
        if (parsed !== undefined) entries[endpoint] = parsed;
      }

      return entries;
    },
    async write(entries) {
      await of().set({ [key]: entries });
    },
  };
}

/**
 * The three session routes, over `fetch`.
 *
 * **No host permission is needed for this and none is asked for.** The routes are exempt from the
 * worker's origin allowlist (SKG-535) and answer a `chrome-extension://` origin with the CORS
 * headers that let an extension page read the reply, so an ordinary cross-origin `fetch` reaches
 * them. `Content-Type: application/json` makes the request preflighted, which the worker allows.
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
    body: JSON.stringify(body),
  });

  return { status: response.status, body: await response.json().catch(() => undefined) };
}

export function createBrowserSessions(): Sessions {
  return createSessions({ sessions: localArea(), grants: sessionArea(), post: postJson });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
