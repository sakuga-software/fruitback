import { type Kv, processKv } from './kv.ts';
import { parseRedisUrl } from './redis-url.ts';

/**
 * Which `Kv` this worker runs on (FRU-67): the memory of the process, or a Redis that several
 * replicas share.
 *
 * **Memory is the default, and Redis is off unless `FRUITBACK_KV=redis`.** A worker on memory loads
 * no client: `redis.ts` is imported at the first call of a worker that asked for it.
 */
export const KV_PROVIDERS = ['memory', 'redis'] as const;
export type KvProvider = (typeof KV_PROVIDERS)[number];
export type KvConfig = { provider: 'memory' } | { provider: 'redis'; url: string };

export type KvConfigResult = { ok: true; config: KvConfig } | { ok: false; missing: string[] };

/**
 * Read `FRUITBACK_KV` and `FRUITBACK_REDIS_URL`.
 *
 * A diagnostic names the variable and never quotes the URL, because the URL can carry a password.
 */
export function readKvConfig(env: Record<string, string | undefined>): KvConfigResult {
  const provider = env.FRUITBACK_KV?.trim() || 'memory';
  const url = env.FRUITBACK_REDIS_URL?.trim() || undefined;

  if (provider === 'memory') {
    // A URL with no `FRUITBACK_KV=redis` is an operator who expects a shared limit and does not have
    // one. That is the defect FRU-49 closes, so it is refused and not ignored.
    return url === undefined
      ? { ok: true, config: { provider } }
      : { ok: false, missing: ['FRUITBACK_KV (FRUITBACK_REDIS_URL is set, and only FRUITBACK_KV=redis reads it)'] };
  }

  if (provider !== 'redis') return { ok: false, missing: ['FRUITBACK_KV (memory, or redis)'] };
  if (url === undefined || parseRedisUrl(url) === undefined) {
    return { ok: false, missing: ['FRUITBACK_REDIS_URL (redis:// or rediss://, with a database that is a number)'] };
  }

  return { ok: true, config: { provider, url } };
}

/** One client for each address, for the whole process: a connection, and what it pipelines. */
const shared = new Map<string, Kv>();

/**
 * The one `Kv` of this configuration, for the whole process.
 *
 * The transport builds it and passes it in `RequestContext.kv`. The handler falls back to this same
 * instance, so a caller that passes none does not get an empty counter per request.
 */
export function kvFor(config: KvConfig): Kv {
  if (config.provider === 'memory') return processKv();

  let kv = shared.get(config.url);
  if (kv === undefined) {
    kv = later(config.url);
    shared.set(config.url, kv);
  }

  return kv;
}

/**
 * A Redis `Kv` whose client is loaded at its first call. A worker on memory never reaches this, so
 * it loads no socket code and no parser.
 */
function later(url: string): Kv {
  let loaded: Promise<Kv> | undefined;
  const client = (): Promise<Kv> => (loaded ??= import('./redis.ts').then(({ createRedisKv }) => createRedisKv(url)));

  return {
    get: async (key) => (await client()).get(key),
    set: async (key, value, ttlMs) => (await client()).set(key, value, ttlMs),
    incr: async (key, ttlMs, by) => (await client()).incr(key, ttlMs, by),
    async close() {
      if (loaded !== undefined) await (await loaded).close();
    },
  };
}

/** Test seam: close every Redis client of the process, and forget it. */
export async function closeSharedKvs(): Promise<void> {
  const instances = [...shared.values()];
  shared.clear();
  await Promise.all(instances.map((kv) => kv.close()));
}
