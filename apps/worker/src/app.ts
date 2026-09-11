import { canonicalizePageUrl, parseSeed, type SeedReporter } from '@fruitback/shared';
import { readBearerToken, stripClaimedVerification, verifyIdentityToken } from './identity.ts';
import {
  type ClientPolicy,
  type ClientResolution,
  normalizeClientId,
  openReadClients,
  resolveClient,
} from './clients.ts';
import { type WorkerConfig, type WorkerEnv, readAllowedOrigins, readConfig } from './env.ts';
import { type SeedStore, StoreError } from './store.ts';
import { diagnosticCorsHeaders, openCors, resolveCors } from './cors.ts';
import { checkRateLimit } from './rate-limit.ts';
import { cached, invalidate } from './cache.ts';
import {
  type SessionStore,
  createPairing as openPairing,
  redeemPairing,
  refreshSession,
  revokeSession,
} from './session.ts';
import { createSqliteSessionStore } from './session-sqlite.ts';

/**
 * The only server-side piece of Fruitback. Its single reason to exist: the Linear API key cannot
 * live in JavaScript served on a client's public site. Everything else — storage, status, threads —
 * is Linear's job.
 *
 * The handler is written against web `Request`/`Response` and knows nothing about the transport;
 * `server.ts` adapts `node:http` onto it. That keeps every behaviour testable without opening a
 * socket, and keeps the door open if this ever moves to another runtime.
 */

/** A seed with a long note and a DOM path is a few KB. 64 is generous; unbounded is an invitation. */
const MAX_BODY_BYTES = 64 * 1_024;

/**
 * Which store this process writes to (SKG-522, SKG-526).
 *
 * It was a `Pick<typeof realLinear, 'createSeedIssue' | 'fetchSeedIssues'>` — an interface
 * discovered by accident — then a branch on a `fakeLinear` boolean with Linear's three credentials
 * read straight off the config. Both are gone: the provider was selected and validated at boot
 * (`stores.ts`), and this is only where it is built. SQLite (SKG-524) and GitHub (SKG-525) add an
 * entry to the registry and nothing here.
 *
 * A dev-only store cannot win in production: `readStoreConfig` refuses it at boot rather than
 * letting the process start.
 */
export function storeFor(config: WorkerConfig): SeedStore {
  return config.store.create();
}

/**
 * The extension's session store, or `undefined` when this worker runs without one (SKG-535).
 *
 * Deliberately not built from `config.store`: sessions are credentials and seeds are not, so they
 * never share a backend. See `FRUITBACK_SESSION_PATH`.
 */
export function sessionStoreFor(config: WorkerConfig): SessionStore | undefined {
  return config.sessionPath === undefined ? undefined : createSqliteSessionStore(config.sessionPath);
}

/** What the transport knows and the request itself cannot say. */
export type RequestContext = {
  /** Already resolved against the trusted proxy chain — see `resolveClientIp`. */
  clientIp: string;
  /**
   * The store, built **once by the transport** rather than per request.
   *
   * This began as `storeFor(config)` inside the two handlers, which was invisible for Linear and the
   * in-memory one — both are stateless closures — and would have opened a SQLite connection per
   * request the moment SKG-524 landed. A refactor that exists to let a store hold a resource must
   * not reconstruct it on every call.
   *
   * Optional because `handleRequest` answers `/health` and the misconfigured diagnostic *before*
   * there is a validated config to build a store from, so the transport cannot always have one. When
   * it is absent the fallback builds one, which is also what a test driving this directly wants: a
   * fresh store per case.
   */
  store?: SeedStore;
  /** Same reason as `store`, for the sessions (SKG-535). A suite hands over a fresh file per case. */
  sessionStore?: SessionStore;
};

export async function handleRequest(request: Request, env: WorkerEnv, context: RequestContext): Promise<Response> {
  const { pathname } = new URL(request.url);

  // Read straight from the env, before validation: a misconfigured service still has to answer with
  // CORS headers, or the browser turns the diagnostic into an opaque CORS failure and the widget
  // never gets to read which var is missing. It is the same computation the validated config uses —
  // a client declared only in `FRUITBACK_CLIENTS` has to be served here too.
  const origins = readAllowedOrigins(env);
  const config = readConfig(env);

  // Readiness, before anything else: a container that cannot serve must not be routed to.
  if (pathname === '/health') {
    if (!config.ok) return json(503, { ok: false, error: 'misconfigured', missing: config.missing });

    // Announced, not hidden: a `200 ok` that quietly stores feedback in RAM would be the worst kind
    // of green check. The open-read count is here for the same reason (SKG-533) — a deployment
    // whose pins anyone can read should be able to say so without an operator reading the config.
    //
    // A count and not the ids: `/health` needs no authentication either, and listing client ids
    // would hand over the map this worker serves.
    const openRead = openReadClients({ read: config.config.read, clients: config.config.clients }).length;

    return json(200, {
      ok: true,
      // The store's name, always, rather than the old `fakeLinear: true` (SKG-526). Which store a
      // process runs on is the thing an operator cannot tell from a green check, and naming one
      // provider in the answer was the last place `/health` assumed there was only ever one.
      store: config.config.store.provider,
      ...(openRead > 0 ? { openRead } : {}),
    });
  }

  if (!config.ok) {
    // Configuration is wrong on the service, not in the request: say so once, clearly.
    const headers = origins.length > 0 ? resolveCors(request, origins).headers : diagnosticCorsHeaders(request);

    return json(500, { error: 'misconfigured', missing: config.missing }, headers);
  }

  // The session routes answer the extension, which is not a site on the allowlist and cannot be put
  // on one — see `openCors`. Resolved before the gate, so the preflight succeeds too.
  const session = pathname.startsWith('/session/');
  const cors = session ? openCors(request) : resolveCors(request, config.config.allowedOrigins);
  if (!cors.allowed) {
    return json(403, { error: 'origin-not-allowed' });
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors.headers });
  }

  if (request.method !== 'GET' && request.method !== 'POST') {
    return json(405, { error: 'method-not-allowed' }, cors.headers);
  }

  // Metered before the dispatch, and that ordering is the point (SKG-535). Both feedback directions
  // burn the same provider quota, and `/session/pair` is a code-guessing oracle without a limit —
  // this check used to sit *below* the `404`, so a new route would have been unmetered by default.
  // An unknown path costs quota too now, which is the right answer for something being probed.
  if (!checkRateLimit(context.clientIp, { limit: config.config.rateLimitPerMinute })) {
    return json(429, { error: 'rate-limited' }, cors.headers);
  }

  if (session) {
    return handleSession(request, pathname, config.config, context, cors.headers);
  }

  if (pathname !== '/feedback') {
    return json(404, { error: 'not-found' }, cors.headers);
  }

  // Resolved once here, not inside each handler: see `RequestContext.store`.
  const store = context.store ?? storeFor(config.config);

  return request.method === 'GET'
    ? getFeedback(request, config.config, store, cors.headers)
    : postFeedback(request, config.config, store, cors.headers);
}

/**
 * The extension's session endpoints (SKG-535).
 *
 * Three routes and no more: spend a pairing code, exchange a refresh token for an access token, and
 * end the session. Minting a code is **not** here — it is a command an operator runs on the
 * container, so that vouching for a person never becomes a network surface this worker has to
 * defend. See `main.ts`.
 *
 * All three answer `404` when no session store is configured, which is the same answer an unknown
 * path gets: a worker without the extension does not advertise that these exist.
 */
async function handleSession(
  request: Request,
  pathname: string,
  config: WorkerConfig,
  context: RequestContext,
  headers: Record<string, string>,
): Promise<Response> {
  const store = context.sessionStore ?? sessionStoreFor(config);
  // `identitySecret` is present whenever `sessionPath` is — `readConfig` refuses the pair at boot.
  if (store === undefined || config.identitySecret === undefined) return json(404, { error: 'not-found' }, headers);
  if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);

  const body = await readJsonBody(request);
  // `413` and not `400` for the oversized case: the failure codes are a contract the widget reads.
  if (body === 'too-large') return json(413, { error: 'body-too-large' }, headers);
  if (body === undefined) return json(400, { error: 'invalid-body' }, headers);

  if (pathname === '/session/pair') {
    const code = typeof body.code === 'string' ? body.code : undefined;
    if (code === undefined) return json(400, { error: 'invalid-body' }, headers);

    const redeemed = await redeemPairing(store, code, config.identitySecret);
    // One answer for a code that never existed and one already spent: telling them apart is how a
    // caller works out which codes exist. `session.ts` returns the same reason for both.
    if (!redeemed.ok) return json(401, { error: redeemed.reason }, headers);

    return json(200, redeemed.session, headers);
  }

  const refreshToken = typeof body.refreshToken === 'string' ? body.refreshToken : undefined;
  if (refreshToken === undefined) return json(400, { error: 'invalid-body' }, headers);

  if (pathname === '/session/refresh') {
    const refreshed = await refreshSession(store, refreshToken, config.identitySecret);

    return refreshed.ok
      ? json(
          200,
          {
            accessToken: refreshed.accessToken,
            expiresIn: refreshed.expiresIn,
            identity: refreshed.identity,
          },
          headers,
        )
      : json(401, { error: refreshed.reason }, headers);
  }

  if (pathname === '/session/revoke') {
    // `204` whether or not this call is what revoked it. A logout that reported "there was nothing
    // to revoke" would tell a caller which refresh tokens are live.
    await revokeSession(store, refreshToken);

    return new Response(null, { status: 204, headers });
  }

  return json(404, { error: 'not-found' }, headers);
}

/** Mints a pairing code. Not reachable over HTTP — see `handleSession` and `main.ts`. */
export async function createPairingCommand(
  config: WorkerConfig,
  identity: { subject: string; name?: string; email?: string },
): Promise<{ code: string; expiresAt: number }> {
  const store = sessionStoreFor(config);
  if (store === undefined) throw new Error('FRUITBACK_SESSION_PATH is not set, so this worker keeps no sessions');

  return openPairing(store, identity);
}

/** The body of a session call: small, and JSON or nothing. `'too-large'` so the caller can say 413. */
async function readJsonBody(request: Request): Promise<Record<string, unknown> | 'too-large' | undefined> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return 'too-large';

  try {
    const parsed: unknown = JSON.parse(text);

    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Which client this request belongs to, and what was decided for it (SKG-504).
 *
 * On a single-client worker this is the worker's own defaults and nothing else happens. With a client
 * map, a request that names nobody — or names a client it cannot be embedded as — is refused rather
 * than served from the default, because on a multi-tenant worker the default *is* the leak.
 *
 * `teamId` and `projectId` used to be resolved here too. They went to the Linear connector with
 * SKG-522: falling back to *the worker's team* is a rule about teams, and this function has no
 * business knowing that a store has any.
 */
function routeFor(request: Request, config: WorkerConfig, clientId: string | undefined): ClientResolution {
  return resolveClient({
    clients: config.clients,
    clientId,
    origin: request.headers.get('Origin'),
    fallback: {
      // A single-client worker takes its secret from the env; a mapped client brings its own.
      identitySecret: config.identitySecret,
      showComments: config.showComments,
      read: config.read,
    },
  });
}

/**
 * Whether this caller may read this client's pins (SKG-533).
 *
 * Until now `GET /feedback` answered anyone who could build the URL, so every note, its author and
 * the team's replies were readable by any visitor of the client's site — and by `curl`, which is why
 * hiding the pins in the browser was never the fix. `read: 'authenticated'` closes that; `public`
 * keeps it, for the anonymous-feedback case where it is the right answer.
 *
 * Same token as the write path, verified the same way. What differs is what is done with it: the
 * write path needs *who* the reporter is, this one only needs that somebody vouched-for asked.
 *
 * A client asking for `authenticated` with no `identitySecret` cannot reach here — `readConfig`
 * refuses that at boot, rather than letting it become a permanent 401 nobody can diagnose.
 */
async function authorizeRead(
  request: Request,
  policy: ClientPolicy,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (policy.read === 'public') return { ok: true };

  const token = readBearerToken(request.headers.get('Authorization'));
  if (token === undefined) return { ok: false, reason: 'identity-required' };
  if (policy.identitySecret === undefined) return { ok: false, reason: 'identity-not-configured' };

  const verified = await verifyIdentityToken(token, policy.identitySecret);

  return verified.ok ? { ok: true } : { ok: false, reason: verified.reason };
}

/**
 * The reporter to store, and whether the worker vouches for it.
 *
 * No token means the claim stands as a claim — anonymous submission is the default and stays
 * possible. A token that fails to verify is refused outright rather than downgraded to a claim: a
 * site that meant to identify someone and got it wrong should hear about it, and silently accepting
 * an expired token as "self-declared" is how a broken integration goes unnoticed for a month.
 */
async function attributionFor(
  request: Request,
  secret: string | undefined,
  claimed: SeedReporter | undefined,
): Promise<{ ok: true; reporter: SeedReporter | undefined } | { ok: false; reason: string }> {
  const token = readBearerToken(request.headers.get('Authorization'));
  if (token === undefined) return { ok: true, reporter: stripClaimedVerification(claimed) };
  if (secret === undefined) return { ok: false, reason: 'identity-not-configured' };

  const verified = await verifyIdentityToken(token, secret);
  if (!verified.ok) return { ok: false, reason: verified.reason };

  return { ok: true, reporter: verified.reporter };
}

/** Spread, so an absent reporter stays absent — the round-trip forbids a key nobody provided. */
function optionalReporter(reporter: SeedReporter | undefined): { reporter?: SeedReporter } {
  return reporter === undefined ? {} : { reporter };
}

/** 400 when the caller has to say who they are, 403 when they said something they may not claim. */
function routingFailure(
  resolution: Extract<ClientResolution, { ok: false }>,
  headers: Record<string, string>,
): Response {
  const status = resolution.reason === 'origin-not-allowed-for-client' ? 403 : 400;

  return json(status, { error: resolution.reason }, headers);
}

/**
 * The read path: every seed planted on one page, with the Linear state that gives the pin its
 * colour. This is what lets a client come back to the page and see their own notes again.
 */
async function getFeedback(
  request: Request,
  config: WorkerConfig,
  store: SeedStore,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const requested = params.get('url');
  if (requested === null || requested.trim() === '') {
    return json(400, { error: 'missing-url' }, corsHeaders);
  }

  const url = canonicalizeRequestedPage(requested);
  if (url === null) {
    return json(400, { error: 'invalid-url' }, corsHeaders);
  }

  // Normalised once, here, because this value does three jobs: it picks the route, it builds the
  // Linear label the filter matches on, and it keys the cache. Normalising for only one of them is
  // how a note becomes unreadable by the client that wrote it.
  const clientId = normalizeClientId(params.get('client'));
  const route = routeFor(request, config, clientId);
  if (!route.ok) return routingFailure(route, corsHeaders);

  // **Before the cache, and that ordering is the guarantee.** The cached entry is per
  // (team, client, page) and holds the same answer for every entitled reader, so it is safe to
  // share — but only because an unauthorised caller is turned away here and never reaches the
  // lookup. Moving this below `cached` would serve a warm authenticated answer to an anonymous
  // request, which is the exact leak this ticket exists to close.
  const allowed = await authorizeRead(request, route.policy);
  if (!allowed.ok) {
    return json(401, { error: 'identity-required', reason: allowed.reason }, corsHeaders);
  }

  try {
    // The store says what separates one tenant from another — a team for Linear, nothing extra for
    // the in-memory one. The client id is in the key regardless, so two clients reading the same URL
    // never share an entry even when they share a team.
    const key = JSON.stringify([store.name, store.scope(route.client), clientId ?? null, url]);
    const issues = await cached(key, () => store.findForPage({ url, clientId }, route.client, route.policy));

    return json(
      200,
      { url, issues },
      // No browser cache, deliberately. The in-process cache above is what protects the Linear
      // quota; letting the browser hold a copy too only buys one saved request per page load, and
      // costs the widget the pin it planted a second ago — it re-reads and gets served its own
      // stale copy. The E2E suite found exactly that.
      { ...corsHeaders, 'Cache-Control': 'no-store' },
    );
  } catch (error) {
    if (error instanceof StoreError) {
      return json(502, { error: 'store-unavailable', message: error.message }, corsHeaders);
    }
    throw error;
  }
}

/**
 * Canonicalized server-side for the same reason the write path does it: the filter matches this
 * exact string inside the description, so a caller that skipped normalization would find nothing.
 */
function canonicalizeRequestedPage(requested: string): string | null {
  try {
    const url = new URL(requested);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    return canonicalizePageUrl(url);
  } catch {
    return null;
  }
}

async function postFeedback(
  request: Request,
  config: WorkerConfig,
  store: SeedStore,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const body = await readBoundedText(request);
  if (body === null) {
    return json(413, { error: 'payload-too-large', maxBytes: MAX_BODY_BYTES }, corsHeaders);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return json(400, { error: 'invalid-json' }, corsHeaders);
  }

  const parsed = parseSeed(payload);
  if (!parsed.ok) {
    return json(400, { error: 'invalid-seed', reason: parsed.reason }, corsHeaders);
  }

  // Re-canonicalize server-side. The read path finds seeds by matching this URL inside the
  // description, so a client that skipped normalization would plant a pin nobody can find again.
  //
  // The client id gets the same treatment and for the same reason: it becomes the `fruitback:<id>`
  // label the read filters on, so a padded id here means an issue nobody can query back.
  const clientId = normalizeClientId(parsed.seed.client?.id);
  const seed = {
    ...parsed.seed,
    page: { ...parsed.seed.page, url: canonicalizePageUrl(parsed.seed.page.url) },
    ...(parsed.seed.client !== undefined && clientId !== undefined
      ? { client: { ...parsed.seed.client, id: clientId } }
      : {}),
  };

  const route = routeFor(request, config, clientId);
  if (!route.ok) return routingFailure(route, corsHeaders);

  // Whose word the attribution is (SKG-498). The claimed reporter loses `verified` whatever it said,
  // and only a token this worker checked can put it back.
  const identity = await attributionFor(request, route.policy.identitySecret, seed.reporter);
  if (!identity.ok) {
    return json(401, { error: 'invalid-identity', reason: identity.reason }, corsHeaders);
  }

  const attributed = { ...seed, ...optionalReporter(identity.reporter) };

  try {
    const issue = await store.create(attributed, route.client, route.policy);

    // The page just changed, so every cached answer for it is wrong. Matching on the URL covers the
    // per-client keys too, which is what a reviewer reloading right after posting will ask for.
    invalidate((key) => key.includes(JSON.stringify(attributed.page.url)));

    return json(201, { issue }, corsHeaders);
  } catch (error) {
    if (error instanceof StoreError) {
      // Upstream failed, not the caller: 502 tells the widget to keep the note and retry.
      return json(502, { error: 'store-unavailable', message: error.message }, corsHeaders);
    }
    throw error;
  }
}

/**
 * Read the body, refusing anything over the cap.
 *
 * Streamed rather than `request.text()`: a client that omits or forges `Content-Length` would
 * otherwise get the whole payload buffered in memory before being told it was too large, which
 * defeats the point of having a cap.
 */
async function readBoundedText(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get('Content-Length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (request.body === null) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      // Stop pulling instead of draining the rest of the upload.
      await reader.cancel();
      return null;
    }

    chunks.push(value);
  }

  return new TextDecoder().decode(concat(chunks, size));
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const body = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
