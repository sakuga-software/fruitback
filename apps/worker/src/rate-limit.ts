import type { Kv } from './kv.ts';

/** Requests per window, per client IP. Tunable through `RATE_LIMIT_PER_MINUTE`. */
export const DEFAULT_LIMIT = 20;
export const WINDOW_MS = 60_000;

/**
 * A sliding window, estimated from two fixed windows (FRU-49).
 *
 * The count lives in the `Kv`. On a worker with no database it lives in the process, and N replicas
 * allow N times the limit; with a database the replicas share it (FRU-67). The previous window's count is weighted by how much of it still overlaps the last minute.
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
export function checkRateLimit(
  kv: Kv,
  clientIp: string,
  options: { limit?: number; now?: number } = {},
): Promise<boolean> {
  return chargeRateLimit(kv, clientIp, 1, options);
}

/**
 * Counts `amount` more requests for this caller in the window of `now`, and says whether the caller
 * is still within the limit (FRU-124).
 *
 * A batch of N notes has passed `checkRateLimit` for one request when its body is read: the N − 1
 * others are counted here, before anything is written. Counted even when refused, as a refused
 * request is.
 */
export async function chargeRateLimit(
  kv: Kv,
  clientIp: string,
  amount: number,
  options: { limit?: number; now?: number; counter?: (clientIp: string, window: number) => string } = {},
): Promise<boolean> {
  const { limit = DEFAULT_LIMIT, now = Date.now() } = options;
  // A batch of one note has nothing more to count, and `incr` takes no amount below one.
  if (amount < 1) return true;
  const window = Math.floor(now / WINDOW_MS);
  const overlap = 1 - (now % WINDOW_MS) / WINDOW_MS;

  const key = options.counter ?? windowKey;
  // Two windows of expiry, so the previous count is still there for the whole current window.
  const [current, previous] = await Promise.all([
    kv.incr(key(clientIp, window), 2 * WINDOW_MS, amount),
    kv.get(key(clientIp, window - 1)),
  ]);

  return Number(previous ?? 0) * overlap + current <= limit;
}

/**
 * The most notes one request may carry (FRU-124): half the limit of a minute, and ten at most. A
 * reviewer who reads pages and then sends a full batch stays under the limit. Below two, a worker
 * takes no batch, and does not offer one.
 */
export function maxBatch(limit: number = DEFAULT_LIMIT): number {
  const max = Math.min(10, Math.floor(limit / 2));

  return max < 2 ? 0 : max;
}

/** JSON, because an IPv6 address contains the separator a plain join would use. */
function windowKey(clientIp: string, window: number): string {
  return `fruitback:rate:${JSON.stringify([clientIp, window])}`;
}

/** The replies one address writes with no session in a minute (FRU-257), counted apart from the requests. */
export const REPLY_LIMIT = 5;

/** Whether this address may write one more reply with no session now. It counts in its own key. */
export function checkReplyLimit(kv: Kv, clientIp: string, now: number = Date.now()): Promise<boolean> {
  return chargeRateLimit(kv, clientIp, 1, {
    limit: REPLY_LIMIT,
    now,
    counter: (ip, window) => `fruitback:rate:reply:${JSON.stringify([ip, window])}`,
  });
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
 * (measured, FRU-50). Behind them the chain is shorter, and a count that is too high falls back to
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

  // `trustedHops` is a whole number, 0 or more (`env.ts`). With no proxy in front, a direct hit, or a
  // chain shorter than the trusted hop count, there is no entry at that place: the request did not
  // come through the expected path, and the socket peer is the truth rather than a caller-supplied
  // entry.
  const entry = trustedHops > 0 ? chain[chain.length - trustedHops] : undefined;

  return entry ?? (socketAddress || 'unknown');
}
