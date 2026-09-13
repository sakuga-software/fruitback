import { type Kv, type KvConfig, createMemoryKv } from './kv.ts';
import { createRedisKv } from './redis.ts';

export type KvConfigResult = { ok: true; config: KvConfig } | { ok: false; missing: string[] };

/**
 * Read `FRUITBACK_KV` and `FRUITBACK_REDIS_URL` (SKG-542).
 *
 * A diagnostic names the variable and never quotes the URL, because the URL can carry a password.
 */
export function readKvConfig(env: Record<string, string | undefined>): KvConfigResult {
  const provider = env.FRUITBACK_KV?.trim() || 'memory';
  const url = env.FRUITBACK_REDIS_URL?.trim() || undefined;

  if (provider === 'memory') {
    // A URL with no `FRUITBACK_KV=redis` is an operator who expects a shared limit and does not have
    // one. That is the defect SKG-542 closes, so it is refused and not ignored.
    return url === undefined
      ? { ok: true, config: { provider } }
      : { ok: false, missing: ['FRUITBACK_KV (FRUITBACK_REDIS_URL is set, and only FRUITBACK_KV=redis reads it)'] };
  }

  if (provider !== 'redis') return { ok: false, missing: ['FRUITBACK_KV'] };
  if (url === undefined || !isRedisUrl(url)) return { ok: false, missing: ['FRUITBACK_REDIS_URL'] };

  return { ok: true, config: { provider, url } };
}

function isRedisUrl(value: string): boolean {
  try {
    const { protocol, hostname } = new URL(value);

    return (protocol === 'redis:' || protocol === 'rediss:') && hostname !== '';
  } catch {
    return false;
  }
}

const shared = new Map<string, Kv>();

/**
 * One instance per configuration, for the whole process.
 *
 * The transport builds it and passes it in `RequestContext.kv`. The handler falls back to this same
 * instance, so a caller that does not pass one does not get an empty counter per request.
 */
export function kvFor(config: KvConfig): Kv {
  const id = config.provider === 'redis' ? `redis ${config.url}` : 'memory';
  let kv = shared.get(id);

  if (kv === undefined) {
    kv = config.provider === 'redis' ? createRedisKv(config.url) : createMemoryKv();
    shared.set(id, kv);
  }

  return kv;
}

/** Test seam: forget every shared instance, and with them every counter and cached answer. */
export async function resetSharedKv(): Promise<void> {
  const instances = [...shared.values()];
  shared.clear();
  await Promise.all(instances.map((kv) => kv.close()));
}
