/**
 * A short-lived read cache in front of Linear.
 *
 * The read path is called on every page load of a client's staging site, and a Linear API key is
 * rate-limited per key, not per visitor — ten people reviewing the same page at once would otherwise
 * spend ten times the quota on an answer that does not change between them.
 *
 * The entry holds the in-flight *promise*, not the resolved value, so concurrent callers that miss
 * together still make a single request upstream instead of a burst. Failures are evicted
 * immediately: a Linear outage must not be served back for the whole TTL.
 *
 * In-process, therefore per replica — same caveat as the rate limiter. For one container it is the
 * whole story.
 */

export const CACHE_TTL_MS = 15_000;

type Entry = { expiresAt: number; value: Promise<unknown> };

const entries = new Map<string, Entry>();

export function cached<T>(key: string, load: () => Promise<T>, now = Date.now()): Promise<T> {
  const hit = entries.get(key);
  if (hit !== undefined && hit.expiresAt > now) return hit.value as Promise<T>;

  const value = load();
  entries.set(key, { expiresAt: now + CACHE_TTL_MS, value });

  value.catch(() => {
    // Only drop our own entry: a later call may already have replaced it with a healthy one.
    if (entries.get(key)?.value === value) entries.delete(key);
  });

  evictExpired(now);

  return value;
}

/**
 * Swept on every miss rather than on a timer, so the process has nothing scheduled when it is idle.
 * One entry per (page, client) being reviewed right now — this map never grows large.
 */
function evictExpired(now: number): void {
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= now) entries.delete(key);
  }
}

/** Test seam: the cache keeps module-level state. */
export function resetCacheState(): void {
  entries.clear();
}
