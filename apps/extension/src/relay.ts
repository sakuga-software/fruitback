import { type RelayRequest, type RelayResponse, relayRefusal } from './protocol.ts';
import type { AccessResult } from './session.ts';
import { isSecureWorkerEndpoint } from './endpoint.ts';
import type { SiteConfig } from './sites.ts';

/**
 * The call the page asked for, made by the background instead (SKG-596).
 *
 * This is the whole of team mode's security, and it is here rather than in the content script for
 * one reason: **a content script's input is written by the page**. The isolated world carries the
 * request across and nothing else. What may be sent, where, and with which credential is decided in
 * the only context the page cannot reach.
 *
 * Three things never come from the message:
 *
 * - the **origin**, which comes from the sender the browser reports;
 * - the **endpoint**, which is checked against the entry the reviewer stored for that origin;
 * - the **credential**, which is attached here and exists nowhere the page can read.
 *
 * Behind seams so `node --test` reaches every refusal: none of them is visible from the outside,
 * and a gate that is never exercised is a gate nobody can trust.
 */

/** The one path the widget calls, on both directions of the seed (`embed.ts`). */
export const FEEDBACK_PATH = '/feedback';

export type RelaySeams = {
  readSite: (origin: string) => Promise<SiteConfig | undefined>;
  ensureAccess: (endpoint: string) => Promise<AccessResult>;
  send: (request: RelayRequest) => Promise<RelayResponse>;
};

export type Relay = (request: RelayRequest, origin: string | undefined) => Promise<RelayResponse>;

export function createRelay({ readSite, ensureAccess, send }: RelaySeams): Relay {
  /**
   * Never rejects, whatever any of the three seams does.
   *
   * Storage and the session both do I/O, and a rejection would leave the background with nothing to
   * answer the runtime message with: the page would then wait out its whole deadline for a refusal
   * that had already happened, and the reviewer would watch a dead send button for half a minute.
   * Raised in review.
   */
  return async (request, origin) => {
    try {
      return await decide(request, origin);
    } catch {
      return relayRefusal('relay-failed');
    }
  };

  async function decide(request: RelayRequest, origin: string | undefined): Promise<RelayResponse> {
    if (origin === undefined) return relayRefusal('unknown-sender');

    const site = await readSite(origin);
    if (site === undefined) return relayRefusal('site-not-configured');
    if (!site.enabled) return relayRefusal('site-switched-off');
    if (site.mode !== 'team') return relayRefusal('site-not-in-team-mode');

    // The page declares where its widget is pointed, and this is where that declaration is checked
    // rather than obeyed. A page that names another worker is **refused, never redirected**: sending
    // the call to the stored endpoint instead would make the widget report to a worker nobody on the
    // page chose, and report success for it.
    if (!targets(request.url, site.endpoint)) return relayRefusal('endpoint-not-declared-for-this-site');

    // The token below is a bearer credential, and this call is the only thing carrying it. An
    // `http://` worker would put it on the wire in the clear, where the page's own network already
    // is. Loopback is the exception, because it is the dev loop and is not on a wire. Raised in
    // review.
    if (!isSecureWorkerEndpoint(site.endpoint)) return relayRefusal('insecure-endpoint');

    // A session exists per endpoint, and the popup only opens one after `grantWorkerOrigin` has been
    // granted for that same endpoint's origin. So a grant here means this extension holds the host
    // permission for the URL below, and the fetch is privileged rather than an ordinary CORS
    // request. **Relaxing the check above breaks that**, and the break is invisible from here.
    const access = await ensureAccess(site.endpoint);
    if (!access.ok) return relayRefusal(access.reason);

    // Built name by name, never spread from the request. The page may name `Content-Type` and
    // nothing else; `Authorization` is written here, from a token the page has no way to see.
    const headers: Record<string, string> = { Authorization: `Bearer ${access.grant.accessToken}` };
    const contentType = request.headers['Content-Type'];
    if (contentType !== undefined) headers['Content-Type'] = contentType;

    try {
      return await send({
        url: request.url,
        method: request.method,
        headers,
        ...(request.body !== undefined ? { body: request.body } : {}),
      });
    } catch (error) {
      // The background aborts a call that runs past `RELAY_CALL_TIMEOUT_MS`. Said apart from an
      // unreachable worker because it is the only refusal a reviewer can act on by waiting.
      return relayRefusal(isTimeout(error) ? 'worker-timeout' : 'worker-unreachable');
    }
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

/**
 * The one URL this origin's widget is allowed to ask for.
 *
 * An allowlist of a single path, so a route the widget grows later is refused here until somebody
 * adds it — rather than the relay becoming a way to reach anything on that worker. The origin and
 * the path are compared apart because an endpoint may carry a path of its own
 * (`https://example.com/fruitback`), and the query is deliberately not compared: `?url=…&client=…`
 * is the widget's, and it is the site's own client id in it.
 */
function targets(url: string, endpoint: string): boolean {
  try {
    const target = new URL(url);
    const worker = new URL(`${endpoint}${FEEDBACK_PATH}`);

    return target.origin === worker.origin && target.pathname === worker.pathname;
  } catch {
    return false;
  }
}
