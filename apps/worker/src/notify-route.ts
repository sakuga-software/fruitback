import { json } from './http.ts';
import { MAX_BODY_BYTES, readBoundedText } from './bounded-body.ts';
import { normalizeClientId } from './clients.ts';
import { type DoneNotices, noticeLocale, readEmail, readNotifyToken } from './done-notices.ts';
import { type Kv, KvError } from './kv.ts';
import { routingFailure } from './note-helpers.ts';
import { checkNotifyCaller, checkNotifySite } from './rate-limit.ts';
import type { CallerChecks, Served } from './request-context.ts';
import { StoreError } from './store.ts';

/**
 * `POST /feedback/<note>/notify?client=<site>`, body `{ email, token, locale? }` (FRU-604): a visitor
 * with no account gives the address to write to once, when the team marks the note done.
 *
 * - **`<note>` is the id the widget gave the note**, and `token` is the `notify.token` of the answer
 *   of `POST /feedback` for that note. Without it, nothing: the address of a person cannot be put on
 *   the note of somebody else (`403 invalid-token`). It lasts `NOTIFY_TOKEN_TTL_MS`.
 * - **One address for a note, the first one** (`409 not-taken`): a second answer of the same widget,
 *   or a note that the index does not hold, writes nothing.
 * - **`NOTIFY_LIMIT` a minute from one caller, and `NOTIFY_SITE_LIMIT` for a site**, counted apart
 *   from the requests, before any write (`429`). The site counts only a request for a note that can
 *   take an address: a `409` costs the caller alone.
 * - **A worker that cannot send, or keeps no index, has no such route** (`404`), as a worker with no
 *   mailer has no `/console/auth/email`.
 */
export const NOTIFY_PATH = /^\/feedback\/([A-Za-z0-9_-]{1,100})\/notify$/;

export async function postNotify(
  request: Request,
  note: string,
  config: Served,
  kv: Kv,
  corsHeaders: Record<string, string>,
  context: { clientIp: string; notices: DoneNotices | undefined; sends: boolean; now?: number },
  checks: Pick<CallerChecks, 'routeFor'>,
): Promise<Response> {
  const secret = config.authSecret;
  if (context.notices === undefined || !context.sends || secret === undefined) {
    return json(404, { error: 'not-found' }, corsHeaders);
  }
  const text = await readBoundedText(request);
  if (text === null) return json(413, { error: 'payload-too-large', maxBytes: MAX_BODY_BYTES }, corsHeaders);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return json(400, { error: 'invalid-json' }, corsHeaders);
  }
  const body = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;

  const site = normalizeClientId(new URL(request.url).searchParams.get('client'));
  const route = await checks.routeFor(request, config, site);
  if (!route.ok) return routingFailure(route, corsHeaders);
  if (site === undefined || route.client?.workspace === undefined) {
    return json(404, { error: 'not-found' }, corsHeaders);
  }

  const now = context.now ?? Date.now();
  // The token before the address: a caller who holds none learns nothing of what the route takes.
  if (!readNotifyToken(secret, site, note, body.token, now)) {
    return json(403, { error: 'invalid-token' }, corsHeaders);
  }
  const email = readEmail(body.email);
  if (email === undefined) return json(400, { error: 'invalid-email' }, corsHeaders);

  try {
    // The caller's count first, then whether the note can take an address, then the count of the
    // site: a request that would be refused costs the caller, never the site.
    if (!(await checkNotifyCaller(kv, context.clientIp, now))) return json(429, { error: 'rate-limited' }, corsHeaders);
    if (!(await context.notices.open(site, note))) return json(409, { error: 'not-taken' }, corsHeaders);
    if (!(await checkNotifySite(kv, site, now))) return json(429, { error: 'rate-limited' }, corsHeaders);
    const taken = await context.notices.watch({ site, note, email, locale: noticeLocale(body.locale) }, now);

    return taken ? json(201, { ok: true }, corsHeaders) : json(409, { error: 'not-taken' }, corsHeaders);
  } catch (error) {
    if (error instanceof KvError) return json(503, { error: 'limiter-unavailable' }, corsHeaders);
    if (error instanceof StoreError) return json(502, { error: 'store-unavailable' }, corsHeaders);
    throw error;
  }
}
