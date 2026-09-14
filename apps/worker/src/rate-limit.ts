import type { Kv } from './kv.ts';

/** Requests per window, per client IP. Tunable through `RATE_LIMIT_PER_MINUTE`. */
export const DEFAULT_LIMIT = 20;
export const WINDOW_MS = 60_000;

/**
 * A sliding window, estimated from two fixed windows (SKG-542).
 *
 * The count lives in the `Kv`, which lives in the process: N replicas allow N times the limit until a
 * store shared between them exists (SKG-606). The previous window's count is weighted by how much of it still overlaps the last minute.
 *
 * - `incr` comes first and is atomic. A check before the count would let a burst of parallel requests
 *   all read the same low count and all pass.
 * - A refused request is counted too. A caller that keeps sending stays refused.
 * - The estimate assumes the previous window was spread evenly. So a burst at the end of one window,
 *   then a caller who sends at the right moments, gets `2 × limit − 1` requests through in 60
 *   seconds: 39 for the default 20. That is the most any caller gets, and `rate-limit.test.ts` holds
 *   it. The steady rate stays at the limit.
 *
 * It rejects with `KvError` when the `Kv` does not answer. The caller decides what that means.
 */
export async function checkRateLimit(
  kv: Kv,
  clientIp: string,
  options: { limit?: number; now?: number } = {},
): Promise<boolean> {
  const { limit = DEFAULT_LIMIT, now = Date.now() } = options;
  const window = Math.floor(now / WINDOW_MS);
  const overlap = 1 - (now % WINDOW_MS) / WINDOW_MS;

  // Two windows of expiry, so the previous count is still there for the whole current window.
  const [current, previous] = await Promise.all([
    kv.incr(windowKey(clientIp, window), 2 * WINDOW_MS),
    kv.get(windowKey(clientIp, window - 1)),
  ]);

  return Number(previous ?? 0) * overlap + current <= limit;
}

/** JSON, because an IPv6 address contains the separator a plain join would use. */
function windowKey(clientIp: string, window: number): string {
  return `fruitback:rate:${JSON.stringify([clientIp, window])}`;
}

/**
 * Work out who is calling, from the socket address and the forwarded chain.
 *
 * The client address is the entry `trustedHops` from the right of `X-Forwarded-For`. A proxy that
 * appends to the header keeps what the caller sent on the left, so the left of the chain is
 * forgeable. If this function reads the leftmost entry, any caller gets a new rate-limit bucket per
 * request.
 *
 * Other proxies replace the header: Traefik and Caddy by default, and nginx with `$remote_addr`
 * (measured, SKG-543). Behind them the chain is shorter, and a count that is too high falls back to
 * the socket peer.
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
