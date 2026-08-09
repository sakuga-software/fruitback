import { canonicalizePageUrl, parseSeed } from '@fruitback/shared';
import { type WorkerConfig, type WorkerEnv, readConfig, splitOrigins } from './env.ts';
import { LinearError, createSeedIssue, fetchSeedIssues } from './linear.ts';
import { diagnosticCorsHeaders, resolveCors } from './cors.ts';
import { checkRateLimit } from './rate-limit.ts';
import { CACHE_TTL_MS, cached } from './cache.ts';

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

/** What the transport knows and the request itself cannot say. */
export type RequestContext = {
  /** Already resolved against the trusted proxy chain — see `resolveClientIp`. */
  clientIp: string;
};

export async function handleRequest(request: Request, env: WorkerEnv, context: RequestContext): Promise<Response> {
  const { pathname } = new URL(request.url);

  // Read the allowlist straight from the env, before validation: a misconfigured service still has
  // to answer with CORS headers, or the browser turns the diagnostic into an opaque CORS failure
  // and the widget never gets to read which var is missing.
  const origins = splitOrigins(env.ALLOWED_ORIGINS);
  const config = readConfig(env);

  // Readiness, before anything else: a container that cannot serve must not be routed to.
  if (pathname === '/health') {
    return config.ok
      ? json(200, { ok: true })
      : json(503, { ok: false, error: 'misconfigured', missing: config.missing });
  }

  if (!config.ok) {
    // Configuration is wrong on the service, not in the request: say so once, clearly.
    const headers = origins.length > 0 ? resolveCors(request, origins).headers : diagnosticCorsHeaders(request);

    return json(500, { error: 'misconfigured', missing: config.missing }, headers);
  }

  const cors = resolveCors(request, origins);
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
  if (!checkRateLimit(context.clientIp)) {
    return json(429, { error: 'rate-limited' }, cors.headers);
  }

  return request.method === 'GET'
    ? getFeedback(request, config.config, cors.headers)
    : postFeedback(request, config.config, cors.headers);
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

  // Optional: narrows to one client's label. Absent means every seed on that URL, which is what a
  // single-client workspace wants.
  const clientId = params.get('client')?.trim() || undefined;

  try {
    const issues = await cached(JSON.stringify([clientId ?? null, url]), () =>
      fetchSeedIssues(config, { url, clientId }),
    );

    return json(
      200,
      { url, issues },
      // `private`, because the answer is scoped to a client label and a browser cache is the only
      // one that may hold it. Same window as the in-process cache, so a reload costs nothing.
      { ...corsHeaders, 'Cache-Control': `private, max-age=${Math.round(CACHE_TTL_MS / 1_000)}` },
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
  const seed = {
    ...parsed.seed,
    page: { ...parsed.seed.page, url: canonicalizePageUrl(parsed.seed.page.url) },
  };

  try {
    const issue = await createSeedIssue(config, seed);
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
