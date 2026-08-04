import type { WorkerEnv } from './env';

/** Requests per window, per client IP, when falling back to the local limiter. */
const FALLBACK_LIMIT = 20;
const FALLBACK_WINDOW_MS = 60_000;

/**
 * Isolate-local fallback. It is not a real distributed limiter — each isolate keeps its own count,
 * so the effective limit is higher than `FALLBACK_LIMIT` under load. Good enough to stop a stuck
 * client from hammering Linear, and it keeps `wrangler dev` and the tests working without the
 * binding. Production gets the real thing through `FEEDBACK_RATE_LIMITER`.
 */
const hits = new Map<string, number[]>();

export async function checkRateLimit(env: WorkerEnv, request: Request): Promise<boolean> {
  const key = clientKey(request);

  if (env.FEEDBACK_RATE_LIMITER) {
    const { success } = await env.FEEDBACK_RATE_LIMITER.limit({ key });
    return success;
  }

  return allowLocally(key);
}

function clientKey(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? request.headers.get('X-Forwarded-For') ?? 'unknown';
}

function allowLocally(key: string, now = Date.now()): boolean {
  const window = (hits.get(key) ?? []).filter((at) => now - at < FALLBACK_WINDOW_MS);

  if (window.length >= FALLBACK_LIMIT) {
    hits.set(key, window);
    return false;
  }

  window.push(now);
  hits.set(key, window);

  return true;
}

/** Test seam: the fallback limiter keeps module-level state. */
export function resetRateLimitState(): void {
  hits.clear();
}
