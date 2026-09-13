import { randomUUID } from 'node:crypto';
import { type Kv, KvError } from './kv.ts';

/**
 * A short-lived read cache in front of the store.
 *
 * The read path runs on every page load of a client's staging site, and a provider API key is
 * rate-limited per key, not per visitor. Ten people on one page must not spend ten times the quota.
 *
 * **Two layers, and each one holds a different property** (SKG-542):
 *
 * - The in-flight promise stays in this process. Concurrent misses on one replica share one load. A
 *   promise cannot cross a process, so N replicas that miss together make up to N loads.
 * - The settled answer goes to the `Kv`, for `CACHE_TTL_MS`. Every replica on one Redis reads it.
 *
 * A failure is never written, so an outage is not served for the rest of the TTL.
 */

export const CACHE_TTL_MS = 15_000;

/**
 * How long a page version lives after its last write.
 *
 * It must be longer than `CACHE_TTL_MS` plus the slowest load. If a version expires while a slow load
 * is still in flight, that load can write a stale answer under the version the next reader uses.
 */
export const PAGE_VERSION_TTL_MS = 24 * 60 * 60 * 1000;

const inFlight = new Map<string, Promise<unknown>>();

/**
 * Serve `load` for `key`, which belongs to `page`.
 *
 * The key carries the page's current version. `invalidate` writes a new version, so a write needs no
 * list of keys and no scan. A load that started before the write stores its answer under the old
 * version, where no reader looks.
 */
export async function cached<T>(kv: Kv, page: string, key: string, load: () => Promise<T>): Promise<T> {
  let version: string;

  try {
    version = (await kv.get(versionKey(page))) ?? 'none';
  } catch (error) {
    // A cache that does not answer costs quota, never a read.
    if (error instanceof KvError) return load();
    throw error;
  }

  const entryKey = `fruitback:read:${version}:${key}`;
  const joined = inFlight.get(entryKey);
  if (joined !== undefined) return joined as Promise<T>;

  const promise = readThrough(kv, entryKey, load);
  inFlight.set(entryKey, promise);

  const settle = () => {
    if (inFlight.get(entryKey) === promise) inFlight.delete(entryKey);
  };
  promise.then(settle, settle);

  return promise;
}

async function readThrough<T>(kv: Kv, entryKey: string, load: () => Promise<T>): Promise<T> {
  const hit = await ignoreKvError(kv.get(entryKey));

  if (hit !== undefined) {
    try {
      return JSON.parse(hit) as T;
    } catch {
      // An entry that does not parse is a miss. It is replaced below.
    }
  }

  const value = await load();
  await ignoreKvError(kv.set(entryKey, JSON.stringify(value), CACHE_TTL_MS));

  return value;
}

async function ignoreKvError<T>(operation: Promise<T>): Promise<T | undefined> {
  try {
    return await operation;
  } catch (error) {
    if (error instanceof KvError) return undefined;
    throw error;
  }
}

/**
 * Make every cached answer for `page` stale, because a write just changed it.
 *
 * Without this, a pin planted on a page stays invisible to the next reader for up to a TTL, and the
 * reporter thinks the note is lost. It rejects with `KvError` if the `Kv` does not answer.
 */
export async function invalidate(kv: Kv, page: string): Promise<void> {
  await kv.set(versionKey(page), randomUUID(), PAGE_VERSION_TTL_MS);
}

function versionKey(page: string): string {
  return `fruitback:page:${page}`;
}

/** Test seam: forget the loads in flight. The answers live in the `Kv`. */
export function resetCacheState(): void {
  inFlight.clear();
}
