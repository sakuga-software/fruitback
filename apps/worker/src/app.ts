import { canonicalizePageUrl, parseSeed, type SeedReporter } from '@sakuga/fruitback-shared';
import { readBearerToken, stripClaimedVerification, verifyIdentityToken } from './identity.ts';
import { type ClientResolution, normalizeClientId, resolveClient } from './clients.ts';
import { type WorkerConfig, type WorkerEnv, readAllowedOrigins, readConfig } from './env.ts';
import { LinearError } from './linear.ts';
import * as realLinear from './linear.ts';
import * as memoryLinear from './linear-memory.ts';
import { diagnosticCorsHeaders, resolveCors } from './cors.ts';
import { checkRateLimit } from './rate-limit.ts';
import { cached, invalidate } from './cache.ts';

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
 * Which Linear this process talks to. The in-memory one only ever wins in the dev loop — `readConfig`
 * refuses the flag under `NODE_ENV=production`, so this cannot silently become the deployed
 * behaviour.
 */
function linearFor(config: WorkerConfig): Pick<typeof realLinear, 'createSeedIssue' | 'fetchSeedIssues'> {
  return config.fakeLinear ? memoryLinear : realLinear;
}

/** What the transport knows and the request itself cannot say. */
export type RequestContext = {
  /** Already resolved against the trusted proxy chain — see `resolveClientIp`. */
  clientIp: string;
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
    // of green check.
    return json(200, config.config.fakeLinear ? { ok: true, fakeLinear: true } : { ok: true });
  }

  if (!config.ok) {
    // Configuration is wrong on the service, not in the request: say so once, clearly.
    const headers = origins.length > 0 ? resolveCors(request, origins).headers : diagnosticCorsHeaders(request);

    return json(500, { error: 'misconfigured', missing: config.missing }, headers);
  }

  const cors = resolveCors(request, config.config.allowedOrigins);
  if (!cors.allowed) {
    return json(403, { error: 'origin-not-allowed' });
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors.headers });
  }

  if (pathname !== '/feedback') {
    return json(404, { error: 'not-found' }, cors.headers);
  }

  if (request.method !== 'GET' && request.method !== 'POST') {
    return json(405, { error: 'method-not-allowed' }, cors.headers);
  }

  // Both directions are metered: a read hits Linear too, and the quota it burns is the same one the
  // write path needs.
  if (!checkRateLimit(context.clientIp, { limit: config.config.rateLimitPerMinute })) {
    return json(429, { error: 'rate-limited' }, cors.headers);
  }

  return request.method === 'GET'
    ? getFeedback(request, config.config, cors.headers)
    : postFeedback(request, config.config, cors.headers);
}

/**
 * Which team and project this request belongs to (SKG-504).
 *
 * On a single-client worker this is the configured team and nothing else happens. With a client map,
 * a request that names nobody — or names a client it cannot be embedded as — is refused rather than
 * served from the default, because on a multi-tenant worker the default *is* the leak.
 */
function routeFor(request: Request, config: WorkerConfig, clientId: string | undefined): ClientResolution {
  return resolveClient({
    clients: config.clients,
    clientId,
    origin: request.headers.get('Origin'),
    fallback: {
      teamId: config.linearTeamId,
      projectId: config.linearProjectId,
      // A single-client worker takes its secret from the env; a mapped client brings its own.
      identitySecret: config.identitySecret,
    },
  });
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

  try {
    // The team is part of the key: two clients reading the same URL must not share an entry.
    const key = JSON.stringify([route.routing.teamId, clientId ?? null, url]);
    const issues = await cached(key, () => linearFor(config).fetchSeedIssues(config, route.routing, { url, clientId }));

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
    if (error instanceof LinearError) {
      return json(502, { error: 'linear-unavailable', message: error.message }, corsHeaders);
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
  const identity = await attributionFor(request, route.routing.identitySecret, seed.reporter);
  if (!identity.ok) {
    return json(401, { error: 'invalid-identity', reason: identity.reason }, corsHeaders);
  }

  const attributed = { ...seed, ...optionalReporter(identity.reporter) };

  try {
    const issue = await linearFor(config).createSeedIssue(config, route.routing, attributed);

    // The page just changed, so every cached answer for it is wrong. Matching on the URL covers the
    // per-client keys too, which is what a reviewer reloading right after posting will ask for.
    invalidate((key) => key.includes(JSON.stringify(attributed.page.url)));

    return json(201, { issue }, corsHeaders);
  } catch (error) {
    if (error instanceof LinearError) {
      // Upstream failed, not the caller: 502 tells the widget to keep the note and retry.
      return json(502, { error: 'linear-unavailable', message: error.message }, corsHeaders);
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
