/**
 * Where the rate limiter and the read cache keep their state (SKG-542).
 *
 * Both kept a `Map` of their own. The interface is the smallest one both callers need: a value with an
 * expiry, and a counter with an expiry. This process holds one memory implementation. A store shared
 * between replicas is SKG-606, and it is one more implementation of this type.
 *
 * **Values are strings, the memory store included.** A store that kept objects would accept a value a
 * remote store cannot hold, and every test would pass against it.
 */
export type Kv = {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  /** Add one and return the new count. A new key starts at 1 and expires after `ttlMs`. */
  incr(key: string, ttlMs: number): Promise<number>;
  close(): Promise<void>;
};

/** The shared state did not answer. Never a reason to fail a read; a reason to refuse a metered call. */
export class KvError extends Error {}

/** Expired entries are swept at most this often, on any call. Nothing is scheduled while idle. */
const SWEEP_INTERVAL_MS = 1_000;

/** What this worker did before SKG-542, and still the right answer for a single container. */
export type MemoryKv = Kv & {
  /** How many entries it holds, expired ones included until the next sweep. */
  size(): number;
};

export function createMemoryKv(options: { now?: () => number } = {}): MemoryKv {
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
    size: () => entries.size,
    async get(key) {
      // Every call sweeps, reads included. A page served from the cache only ever calls `get`.
      sweep();

      return live(key)?.value;
    },
    async set(key, value, ttlMs) {
      sweep();
      entries.set(key, { value, expiresAt: now() + ttlMs });
    },
    async incr(key, ttlMs) {
      sweep();
      const entry = live(key);

      if (entry === undefined) {
        entries.set(key, { value: '1', expiresAt: now() + ttlMs });

        return 1;
      }

      // Redis counts only a canonical integer: no `+`, no leading zero, no `-0`, no space. Measured
      // against redis:7. `Number()` accepts all of those, so it cannot be the test.
      if (!/^(0|-?[1-9]\d*)$/.test(entry.value)) throw new KvError('value is not an integer');
      // The stored value is checked as well as the result: `Number()` rounds -(2^53 + 1) up to a
      // safe integer, and the count would then come back one too high. Raised in review.
      const previous = Number(entry.value);
      if (!Number.isSafeInteger(previous)) throw new KvError('value is out of range');
      const count = previous + 1;
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

let shared: MemoryKv | undefined;

/**
 * The one `Kv` of this process. The transport passes it in `RequestContext.kv`, and the handler falls
 * back to it, so a caller that passes none does not get an empty counter per request.
 */
export function processKv(): Kv {
  shared ??= createMemoryKv();

  return shared;
}

/** Test seam: forget every counter and every cached answer. */
export async function resetSharedKv(): Promise<void> {
  await shared?.close();
  shared = undefined;
}
