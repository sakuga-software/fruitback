import { type RelayRequest, type RelayResponse, relayRefusal } from './protocol.ts';
import type { AccessResult } from './session.ts';
import { isSecureWorkerEndpoint } from './endpoint.ts';
import type { SiteConfig } from './sites.ts';

/**
 * The call the page asked for, made by the background instead (FRU-57).
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

/** The path the widget calls, on both directions of the note (`embed.ts`). */
export const FEEDBACK_PATH = '/feedback';

/**
 * The path of a reply under one note (FRU-257), after the endpoint: `FEEDBACK_PATH`, the id of the
 * issue, then `/replies`. The id has the characters that the worker takes, and no other.
 */
export const REPLY_PATH = /^\/feedback\/[A-Za-z0-9_-]{1,100}\/replies$/;

/**
 * The path of a verdict on one note (FRU-294, FRU-300): « Looks fixed » or « Still wrong », from the
 * side panel through the widget. The same shape as a reply: `FEEDBACK_PATH`, the id, then `/check`.
 */
export const CHECK_PATH = /^\/feedback\/[A-Za-z0-9_-]{1,100}\/check$/;

/**
 * The path of the text of one note, edited by its author (FRU-475): `FEEDBACK_PATH`, the id, then
 * `/text`. The worker decides who may: the relay carries the session, as for a reply.
 */
export const EDIT_PATH = /^\/feedback\/[A-Za-z0-9_-]{1,100}\/text$/;

/**
 * The path of a file of a note on its way (FRU-332): `POST /attachments`, its bytes in base64 between
 * the page and the background. The only path that takes a body in base64.
 */
export const ATTACHMENTS_PATH = '/attachments';

export type RelaySeams = {
  readSite: (origin: string) => Promise<SiteConfig | undefined>;
  ensureAccess: (endpoint: string) => Promise<AccessResult>;
  /**
   * A new access token, because the worker refused `refused` with `401` (FRU-238): `Sessions.renewAccess`.
   * A session that ended is refused its refresh too, and forgotten there: the popup then offers to
   * sign in again. A token that was only old is renewed, and the call is sent once more.
   */
  renewAccess?: (endpoint: string, refused: string) => Promise<AccessResult>;
  send: (request: RelayRequest) => Promise<RelayResponse>;
  /**
   * Why a call got `401` with no session (FRU-238). The background logs a refusal of status 0, and
   * this one is a `401` so the widget says to sign in again: without it, the console says nothing.
   */
  warn?: (reason: string) => void;
};

export type Relay = (request: RelayRequest, origin: string | undefined) => Promise<RelayResponse>;

export function createRelay({ readSite, ensureAccess, renewAccess, send, warn }: RelaySeams): Relay {
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
    // A file goes to `POST /attachments` and nowhere else; nothing else goes there.
    const file = isAttachmentsPath(request.url, site.endpoint);
    if (file !== (request.encoding === 'base64') || (file && request.method !== 'POST')) {
      return relayRefusal('endpoint-not-declared-for-this-site');
    }

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
    if (!access.ok) {
      // No session, or one that ended: `401`, as the worker says it, so the widget keeps the text and
      // says to sign in again rather than « try again » (FRU-238). A worker that did not answer is
      // the moment, and stays a refusal.
      const signedOut = access.reason === 'not-paired' || access.reason === 'session-revoked-or-expired';

      if (!signedOut) return relayRefusal(access.reason);
      warn?.(access.reason);

      return { ...relayRefusal(access.reason), status: 401 };
    }

    // Built name by name, never spread from the request. The page may name `Content-Type` and
    // nothing else; `Authorization` is written here, from a token the page has no way to see.
    const contentType = request.headers['Content-Type'];
    const sent = (token: string): Promise<RelayResponse> =>
      send({
        url: request.url,
        method: request.method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(contentType === undefined ? {} : { 'Content-Type': contentType }),
        },
        ...(request.body !== undefined ? { body: request.body } : {}),
        ...(request.encoding === 'base64' ? { encoding: 'base64' as const } : {}),
      });

    try {
      const answer = await sent(access.grant.accessToken);
      // Refused for its session: renewed once. Ended, the renewal fails and forgets the session, and
      // the widget is given the refusal (it keeps the text, and says to sign in again). Only old, the
      // call goes once more. Never a second renewal: a worker that refuses every token is answered.
      if (answer.status !== 401 || renewAccess === undefined) return answer;
      const renewed = await renewAccess(site.endpoint, access.grant.accessToken);

      return renewed.ok ? await sent(renewed.grant.accessToken) : answer;
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
 * An allowlist of four paths, the notes, a reply under one note, a verdict on one note
 * (FRU-300), and a file of a note (FRU-332), so a route the widget grows
 * later is refused here until somebody adds it — rather than the relay becoming a way to reach
 * anything on that worker. The origin and
 * the path are compared apart because an endpoint may carry a path of its own
 * (`https://example.com/fruitback`), and the query is deliberately not compared: `?url=…&client=…`
 * is the widget's, and it is the site's own client id in it.
 */
function targets(url: string, endpoint: string): boolean {
  try {
    const target = new URL(url);
    const worker = new URL(`${endpoint}${FEEDBACK_PATH}`);

    if (target.origin !== worker.origin) return false;
    if (target.pathname === worker.pathname) return true;
    const base = worker.pathname.slice(0, -FEEDBACK_PATH.length);

    if (!target.pathname.startsWith(base)) return false;
    const rest = target.pathname.slice(base.length);

    return REPLY_PATH.test(rest) || CHECK_PATH.test(rest) || EDIT_PATH.test(rest) || rest === ATTACHMENTS_PATH;
  } catch {
    return false;
  }
}

/** Whether the call is `POST /attachments` of this endpoint (FRU-332). */
function isAttachmentsPath(url: string, endpoint: string): boolean {
  try {
    const target = new URL(url);
    const files = new URL(`${endpoint}${ATTACHMENTS_PATH}`);

    return target.origin === files.origin && target.pathname === files.pathname;
  } catch {
    return false;
  }
}
