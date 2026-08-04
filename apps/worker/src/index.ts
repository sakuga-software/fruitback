import { canonicalizePageUrl, parseSeed } from '@fruitback/shared';
import { type WorkerConfig, type WorkerEnv, readConfig } from './env';
import { LinearError, createSeedIssue } from './linear';
import { resolveCors } from './cors';
import { checkRateLimit } from './rate-limit';

/**
 * The only server-side piece of Fruitback. Its single reason to exist: the Linear API key cannot
 * live in JavaScript served on a client's public site. Everything else — storage, status, threads —
 * is Linear's job.
 */

/** A seed with a long note and a DOM path is a few KB. 64 is generous; unbounded is an invitation. */
const MAX_BODY_BYTES = 64 * 1_024;

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const config = readConfig(env);
    if (!config.ok) {
      // Configuration is wrong on the Worker, not in the request: say so once, clearly.
      return json(500, { error: 'misconfigured', missing: config.missing });
    }

    const cors = resolveCors(request, config.config);
    if (!cors.allowed) {
      return json(403, { error: 'origin-not-allowed' });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors.headers });
    }

    const { pathname } = new URL(request.url);
    if (pathname !== '/feedback') {
      return json(404, { error: 'not-found' }, cors.headers);
    }

    if (request.method === 'GET') {
      return json(501, { error: 'not-implemented', ticket: 'SKG-499' }, cors.headers);
    }

    if (request.method !== 'POST') {
      return json(405, { error: 'method-not-allowed' }, cors.headers);
    }

    if (!(await checkRateLimit(env, request))) {
      return json(429, { error: 'rate-limited' }, cors.headers);
    }

    return postFeedback(request, config.config, cors.headers);
  },
};

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

/** Read the body, refusing anything over the cap — both the declared length and the actual one. */
async function readBoundedText(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get('Content-Length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;

  const body = await request.text();

  return new TextEncoder().encode(body).length > MAX_BODY_BYTES ? null : body;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
