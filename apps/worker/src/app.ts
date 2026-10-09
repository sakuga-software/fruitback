import { SEED_STAGES, canonicalizePageUrl, parseSeed, type SeedReporter } from '@fruitback/shared';
import { type IdentityResult, readBearerToken, stripClaimedVerification, verifyIdentityToken } from './identity.ts';
import {
  type ClientPolicy,
  type ClientResolution,
  normalizeClientId,
  openReadClients,
  originsFromClients,
  resolveClient,
} from './clients.ts';
import type { AccountStore } from './accounts.ts';
import { consoleCors, handleConsoleSession, isConsoleRoute } from './console-routes.ts';
import { handleConsoleApi } from './console-api.ts';
import { handleGitHub } from './github-oauth.ts';
import { type Mailer, createTemMailer } from './mail.ts';
import { createSqliteAccountStore } from './accounts-sqlite.ts';
import { type WorkerConfig, type WorkerEnv, readAllowedOrigins, readConfig } from './env.ts';
import { type SeedStore, StoreError } from './store.ts';
import { type CorsDecision, diagnosticCorsHeaders, openCors, resolveCors } from './cors.ts';
import { PAIR_PATH, pairPage } from './pair-page.ts';
import { checkRateLimit } from './rate-limit.ts';
import { cached, invalidate } from './cache.ts';
import { type Kv, KvError, processKv } from './kv.ts';
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
 * Which store this process writes to (FRU-29, FRU-33).
 *
 * It was a `Pick<typeof realLinear, 'createSeedIssue' | 'fetchSeedIssues'>` — an interface
 * discovered by accident — then a branch on a `fakeLinear` boolean with Linear's three credentials
 * read straight off the config. Both are gone: the provider was selected and validated at boot
 * (`stores.ts`), and this is only where it is built. SQLite (FRU-31) and GitHub (FRU-32) each
 * added an entry to the registry and nothing here.
 *
 * A dev-only store cannot win in production: `readStoreConfig` refuses it at boot rather than
 * letting the process start.
 */
export function storeFor(config: WorkerConfig): SeedStore {
  return config.store.create();
}

/**
 * The extension's session store, or `undefined` when this worker runs without one (FRU-42).
 *
 * Deliberately not built from `config.store`: sessions are credentials and seeds are not, so they
 * never share a backend. See `FRUITBACK_SESSION_PATH`.
 */
export function sessionStoreFor(config: WorkerConfig): SessionStore | undefined {
  return config.sessionPath === undefined ? undefined : createSqliteSessionStore(config.sessionPath);
}

/** What sends the e-mail of this worker, or `undefined` when it sends none (FRU-98). */
export function mailerFor(config: WorkerConfig): Mailer | undefined {
  return config.mail === undefined ? undefined : createTemMailer(config.mail);
}

/** The accounts of this worker, or `undefined` when its clients come from the env (FRU-96). */
export function accountStoreFor(config: WorkerConfig): AccountStore | undefined {
  return config.accountsPath === undefined ? undefined : createSqliteAccountStore(config.accountsPath);
}

/**
 * The configuration with the sites of every workspace as its clients, and their origins allowed.
 *
 * An empty map stays an empty map: a worker with accounts and no site yet serves no client, and an
 * `undefined` here would turn it into a single-client worker that answers anybody.
 */
async function withSites(config: WorkerConfig, accounts: AccountStore): Promise<WorkerConfig> {
  const clients = await accounts.clientMap();

  return {
    ...config,
    clients,
    allowedOrigins: [...new Set([...config.allowedOrigins, ...originsFromClients(clients)])],
  };
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
   * request the moment FRU-31 landed. A refactor that exists to let a store hold a resource must
   * not reconstruct it on every call.
   *
   * Optional because `handleRequest` answers `/health` and the misconfigured diagnostic *before*
   * there is a validated config to build a store from, so the transport cannot always have one. When
   * it is absent the fallback builds one, which is also what a test driving this directly wants: a
   * fresh store per case.
   */
  store?: SeedStore;
  /** Same reason as `store`, for the sessions (FRU-42). A suite hands over a fresh file per case. */
  sessionStore?: SessionStore;
  /** Same reason, for the accounts, the workspaces and their sites (FRU-96). */
  accounts?: AccountStore;
  /** What sends the sign-in links (FRU-98). A suite hands over one that keeps what it was given. */
  mailer?: Mailer;
  /** What reaches GitHub on a sign-in (FRU-97). A suite hands over a double of GitHub. */
  fetcher?: typeof fetch;
  /**
   * Where the rate limiter and the read cache keep their state (FRU-49). When it is absent, the
   * handler uses `processKv`, which gives the one instance of this process and never a new empty one.
   */
  kv?: Kv;
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
    // of green check. The open-read count is here for the same reason (FRU-40) — a deployment
    // whose pins anyone can read should be able to say so without an operator reading the config.
    //
    // A count and not the ids: `/health` needs no authentication either, and listing client ids
    // would hand over the map this worker serves.
    // With accounts the clients are in a file, and this probe never opens one: it says nothing of them.
    const openRead =
      config.config.accountsPath === undefined
        ? openReadClients({ read: config.config.read, clients: config.config.clients }).length
        : 0;

    return json(200, {
      ok: true,
      // The store's name, always, rather than the old `fakeLinear: true` (FRU-33). Which store a
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

  // With accounts, the sites the console wrote are this worker's clients (FRU-96), read per request so
  // a site added a second ago is served now. Everything below reads the served map and nothing else.
  const accounts = context.accounts ?? accountStoreFor(config.config);
  let served: WorkerConfig;
  try {
    served = accounts === undefined ? config.config : await withSites(config.config, accounts);
  } catch (error) {
    if (error instanceof StoreError) return json(502, { error: 'store-unavailable' }, diagnosticCorsHeaders(request));
    throw error;
  }

  // The session routes answer the extension, which is not a site on the allowlist and cannot be put
  // on one — see `openCors`. Resolved before the gate, so the preflight succeeds too.
  const session = pathname.startsWith('/session/');
  // The pairing page is opened from a link, by a browser, as a document. No site reads it through
  // CORS, so the list of client sites does not apply and it answers with no CORS header at all.
  const pairing = pathname === PAIR_PATH;
  const site = (): CorsDecision => resolveCors(request, served.allowedOrigins);
  const extension = (): CorsDecision => (session ? openCors(request) : site());
  // The console's routes answer the console and no site, with the cookie of its session (FRU-98).
  const consoleRoute = served.accountsPath !== undefined && isConsoleRoute(pathname);
  const chosen = (): CorsDecision => (consoleRoute ? consoleCors(request, served) : extension());
  const cors: CorsDecision = pairing ? { allowed: true, headers: {} } : chosen();
  if (!cors.allowed) {
    return json(403, { error: 'origin-not-allowed' });
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors.headers });
  }

  // The console removes a site or a workspace with DELETE, and no other route takes one.
  const deletes = consoleRoute && request.method === 'DELETE';
  if (request.method !== 'GET' && request.method !== 'POST' && !deletes) {
    return json(405, { error: 'method-not-allowed' }, cors.headers);
  }

  // Metered before the dispatch, and that ordering is the point (FRU-42). Both feedback directions
  // burn the same provider quota, and `/session/pair` is a code-guessing oracle without a limit —
  // this check used to sit *below* the `404`, so a new route would have been unmetered by default.
  // An unknown path costs quota too now, which is the right answer for something being probed.
  const kv = context.kv ?? processKv();
  let allowed: boolean;

  try {
    allowed = await checkRateLimit(kv, context.clientIp, { limit: served.rateLimitPerMinute });
  } catch (error) {
    if (!(error instanceof KvError)) throw error;
    // Refused, not let through (FRU-49). A limiter that opens whenever its `Kv` does not answer is a
    // limiter any caller can open. `/health` does not reach this line, so it keeps answering.
    console.error(`[fruitback] rate limit unavailable: ${error.message}`);

    return json(503, { error: 'limiter-unavailable' }, cors.headers);
  }

  if (!allowed) {
    return json(429, { error: 'rate-limited' }, cors.headers);
  }

  if (consoleRoute && accounts !== undefined) {
    const sessions = context.sessionStore ?? sessionStoreFor(served);
    if (sessions === undefined || served.identitySecret === undefined)
      return json(404, { error: 'not-found' }, cors.headers);

    try {
      // Top-level navigations to and from GitHub, not calls of the console (FRU-97).
      if (served.github !== undefined && served.publicUrl !== undefined && served.consoleUrl !== undefined) {
        const viaGitHub = await handleGitHub(request, pathname, {
          oauth: served.github,
          publicUrl: served.publicUrl,
          consoleUrl: served.consoleUrl,
          accounts,
          sessions,
          kv,
          secret: served.identitySecret,
          ...(context.fetcher === undefined ? {} : { fetcher: context.fetcher }),
        });
        if (viaGitHub !== undefined) return viaGitHub;
      }

      const answer =
        (await handleConsoleSession(
          request,
          pathname,
          served,
          { accounts, sessions, mailer: context.mailer ?? mailerFor(served), kv, secret: served.identitySecret },
          cors.headers,
        )) ??
        (await handleConsoleApi(
          request,
          pathname,
          { accounts, sessions, secret: served.identitySecret },
          cors.headers,
        ));

      return answer ?? json(404, { error: 'not-found' }, cors.headers);
    } catch (error) {
      if (error instanceof StoreError) return json(502, { error: 'store-unavailable' }, cors.headers);
      throw error;
    }
  }

  if (pairing) {
    // It exists only where the sessions do, like the three routes below: a worker without the
    // extension does not advertise the page.
    if (context.sessionStore === undefined && served.sessionPath === undefined) {
      return json(404, { error: 'not-found' });
    }
    if (request.method !== 'GET') return json(405, { error: 'method-not-allowed' });

    return pairPage();
  }

  if (session) {
    try {
      return await handleSession(request, pathname, served, context, cors.headers);
    } catch (error) {
      // A volume nobody mounted, a read-only disk, a file that is not a database. Answered like the
      // seed path's outage rather than as a bare `500`, so the extension can tell "retry later" from
      // "this request was wrong" — and so the answer carries the CORS headers it needs to read it.
      if (error instanceof StoreError) return json(502, { error: 'store-unavailable' }, cors.headers);
      throw error;
    }
  }

  if (pathname !== '/feedback') {
    return json(404, { error: 'not-found' }, cors.headers);
  }

  // Resolved once here, not inside each handler: see `RequestContext.store`.
  const store = context.store ?? storeFor(served);

  return request.method === 'GET'
    ? getFeedback(request, served, store, kv, cors.headers)
    : postFeedback(request, served, store, kv, cors.headers);
}

/**
 * The extension's session endpoints (FRU-42).
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

  // `readBoundedText` and not `request.text()`: it refuses a declared length over the cap before a
  // byte is read, and cancels the stream once a chunked upload crosses it. The first version of this
  // handler buffered the whole body and then measured `text.length` — which is UTF-16 units, not
  // bytes, so a multibyte body passed a byte cap it had already exceeded. Raised in review.
  const text = await readBoundedText(request);
  if (text === null) return json(413, { error: 'payload-too-large', maxBytes: MAX_BODY_BYTES }, headers);

  const body = parseJsonObject(text);
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
            // Every refresh rotates (FRU-61), and this field is the whole of the client's half.
            // It is named here rather than spread, so leaving it out is what this route would do by
            // default — the rotation would work perfectly and reach nobody. A test asserts the body
            // carries it, because `tsc` cannot: the object is built field by field.
            refreshToken: refreshed.refreshToken,
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
  identity: { subject: string; name?: string; email?: string; workspace?: string },
): Promise<{ code: string; expiresAt: number }> {
  const store = sessionStoreFor(config);
  if (store === undefined) throw new Error('FRUITBACK_SESSION_PATH is not set, so this worker keeps no sessions');

  return openPairing(store, identity);
}

/** A session body is a JSON object or nothing. An array is not an object here, whatever `typeof` says. */
function parseJsonObject(text: string): Record<string, unknown> | undefined {
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
 * Which client this request belongs to, and what was decided for it (FRU-15).
 *
 * On a single-client worker this is the worker's own defaults and nothing else happens. With a client
 * map, a request that names nobody — or names a client it cannot be embedded as — is refused rather
 * than served from the default, because on a multi-tenant worker the default *is* the leak.
 *
 * `teamId` and `projectId` used to be resolved here too. They went to the Linear connector with
 * FRU-29: falling back to *the worker's team* is a rule about teams, and this function has no
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
      locale: config.teamLocale,
    },
    ...(config.sessionPath !== undefined && config.identitySecret !== undefined
      ? { sessionSecret: config.identitySecret }
      : {}),
  });
}

/**
 * Verifies a token for one client: as the site's own, or as a session of the client's workspace.
 *
 * The site's key comes first. A session token then verifies only with the worker key **and** a `ws`
 * that names the workspace of this client (FRU-95). The signature alone is not enough: every session
 * of every workspace is signed with that one key.
 */
async function verifyForClient(token: string, policy: ClientPolicy): Promise<IdentityResult | undefined> {
  const asSite =
    policy.identitySecret === undefined ? undefined : await verifyIdentityToken(token, policy.identitySecret);
  if (asSite?.ok === true || policy.sessions === undefined) return asSite;

  const asSession = await verifyIdentityToken(token, policy.sessions.secret);
  if (!asSession.ok) return asSite ?? asSession;

  return asSession.workspace === policy.sessions.workspace ? asSession : { ok: false, reason: 'invalid-claims' };
}

/**
 * Whether this caller may read this client's pins (FRU-40).
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

  const verified = await verifyForClient(token, policy);
  if (verified === undefined) return { ok: false, reason: 'identity-not-configured' };

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
  policy: ClientPolicy,
  claimed: SeedReporter | undefined,
): Promise<{ ok: true; reporter: SeedReporter | undefined } | { ok: false; reason: string }> {
  const token = readBearerToken(request.headers.get('Authorization'));
  if (token === undefined) return { ok: true, reporter: stripClaimedVerification(claimed) };

  const verified = await verifyForClient(token, policy);
  if (verified === undefined) return { ok: false, reason: 'identity-not-configured' };
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
  kv: Kv,
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
    const issues = await cached(kv, url, key, () => store.findForPage({ url, clientId }, route.client, route.policy));

    return json(
      200,
      // `stages` does not depend on the page, so it is not in the cached answer.
      { url, issues, stages: store.stages ?? SEED_STAGES },
      // No browser cache, deliberately. The read cache above is what protects the Linear
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
  kv: Kv,
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

  // Whose word the attribution is (FRU-9). The claimed reporter loses `verified` whatever it said,
  // and only a token this worker checked can put it back.
  const identity = await attributionFor(request, route.policy, seed.reporter);
  if (!identity.ok) {
    return json(401, { error: 'invalid-identity', reason: identity.reason }, corsHeaders);
  }

  const attributed = { ...seed, ...optionalReporter(identity.reporter) };

  try {
    const issue = await store.create(attributed, route.client, route.policy);

    // The page just changed, so every cached answer for it is wrong, for every client.
    try {
      await invalidate(kv, attributed.page.url);
    } catch (error) {
      if (!(error instanceof KvError)) throw error;
      // The issue exists now. A 502 here tells the widget to retry, and the retry plants the note a
      // second time. The cost of answering 201 is a pin that shows up one TTL late.
      console.error(`[fruitback] cache not invalidated after a write: ${error.message}`);
    }

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
