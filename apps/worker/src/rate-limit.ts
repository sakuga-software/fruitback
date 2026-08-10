/** Requests per window, per client IP. Tunable through `RATE_LIMIT_PER_MINUTE`. */
export const DEFAULT_LIMIT = 20;
const WINDOW_MS = 60_000;

/**
 * In-process sliding window.
 *
 * On a single long-lived Node process this is a real limiter, unlike the edge equivalent. The one
 * caveat to remember: it is **per replica**. Scale the service to N containers behind Traefik and the
 * effective ceiling becomes N × LIMIT, because nothing is shared between them. Moving to a shared
 * store (Redis) is the fix if that ever matters — for one container it does not.
 */
const hits = new Map<string, number[]>();

export function checkRateLimit(clientIp: string, options: { limit?: number; now?: number } = {}): boolean {
  const { limit = DEFAULT_LIMIT, now = Date.now() } = options;
  const window = (hits.get(clientIp) ?? []).filter((at) => now - at < WINDOW_MS);

  if (window.length >= limit) {
    hits.set(clientIp, window);
    return false;
  }

  window.push(now);
  hits.set(clientIp, window);

  return true;
}

/**
 * Work out who is calling, from the socket address and the forwarded chain.
 *
 * This is the part the platform change makes subtle. `X-Forwarded-For` is *appended* to by each
 * proxy, so the chain reads `<what the caller sent>, <peer seen by proxy 1>, …, <peer seen by the
 * last proxy>`. Everything on the **left** is caller-controlled and forgeable; only the rightmost
 * entries were written by infrastructure we control.
 *
 * So the client IP is the entry `trustedHops` from the right. Reading the leftmost entry — the usual
 * reflex, and the correct one behind Cloudflare where the edge rewrites the header — would let any
 * caller mint a fresh rate-limit bucket per request just by sending a random header.
 */
export function resolveClientIp(
  forwardedFor: string | null | undefined,
  socketAddress: string | undefined,
  trustedHops: number,
): string {
  const chain = (forwardedFor ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  // No proxy in front, or a direct hit: the socket peer is the truth.
  if (trustedHops === 0 || chain.length === 0) return socketAddress || 'unknown';

  // A chain shorter than the trusted hop count means the request did not come through the expected
  // path. Fall back to the socket peer rather than trusting a caller-supplied entry.
  if (chain.length < trustedHops) return socketAddress || 'unknown';

  return chain[chain.length - trustedHops] ?? socketAddress ?? 'unknown';
}

/** Test seam: the limiter keeps module-level state. */
export function resetRateLimitState(): void {
  hits.clear();
}
