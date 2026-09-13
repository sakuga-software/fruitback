/**
 * The state the rate limiter and the read cache share between replicas (SKG-542).
 *
 * Both kept a `Map` in the process. Two containers behind one load balancer therefore doubled the
 * rate limit, and a cold page cost one provider call per replica. The interface is the smallest one
 * both callers need: a value with an expiry, and a counter with an expiry.
 *
 * **Values are strings in every implementation**, the memory one included. A memory store that kept
 * objects would accept a value Redis cannot hold, and the tests would pass against it.
 */
export type Kv = {
  readonly provider: KvProvider;
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  /** Add one and return the new count. A new key starts at 1 and expires after `ttlMs`. */
  incr(key: string, ttlMs: number): Promise<number>;
  close(): Promise<void>;
};

/** The shared state did not answer. Never a reason to fail a read; a reason to refuse a metered call. */
export class KvError extends Error {}

export const KV_PROVIDERS = ['memory', 'redis'] as const;
export type KvProvider = (typeof KV_PROVIDERS)[number];
export type KvConfig = { provider: 'memory' } | { provider: 'redis'; url: string };
/** Expired entries are swept at most this often, on a write. Nothing is scheduled while idle. */
const SWEEP_INTERVAL_MS = 1_000;

/** What this worker did before SKG-542, and still the right answer for a single container. */
export function createMemoryKv(options: { now?: () => number } = {}): Kv {
  const now = options.now ?? Date.now;
  const entries = new Map<string, { value: string; expiresAt: number }>();
  let nextSweep = 0;

  function live(key: string) {
    const entry = entries.get(key);
    if (entry === undefined || entry.expiresAt > now()) return entry;
    entries.delete(key);

    return undefined;
  }

  function sweep() {
    const at = now();
    if (at < nextSweep) return;
    nextSweep = at + SWEEP_INTERVAL_MS;

    for (const [key, entry] of entries) {
      if (entry.expiresAt <= at) entries.delete(key);
    }
  }

  return {
    provider: 'memory',
    async get(key) {
      return live(key)?.value;
    },
    async set(key, value, ttlMs) {
      sweep();
      entries.set(key, { value, expiresAt: now() + ttlMs });
    },
    async incr(key, ttlMs) {
      const entry = live(key);

      if (entry === undefined) {
        sweep();
        entries.set(key, { value: '1', expiresAt: now() + ttlMs });

        return 1;
      }

      // Redis counts only a canonical integer: no `+`, no leading zero, no `-0`, no space. Measured
      // against redis:7. `Number()` accepts all of those, so it cannot be the test.
      if (!/^(0|-?[1-9]\d*)$/.test(entry.value)) throw new KvError('value is not an integer');
      const count = Number(entry.value) + 1;
      // Redis refuses at 2^63 and this store at 2^53. No counter gets near either.
      if (!Number.isSafeInteger(count)) throw new KvError('value is out of range');
      entry.value = String(count);

      return count;
    },
    async close() {
      entries.clear();
    },
  };
}
