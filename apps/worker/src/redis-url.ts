/**
 * The address of a Redis, read once (FRU-49). No socket and no parser of replies here: the boot check
 * of every worker reads this file, and only a worker on Redis loads `redis.ts`.
 */

export type RedisTarget = {
  host: string;
  port: number;
  tls: boolean;
  username: string;
  password: string;
  database: string | undefined;
};

/**
 * The one reading of `FRUITBACK_REDIS_URL`. `readKvConfig` asks it at boot, and the client connects with
 * what it answers.
 *
 * Two readings let a URL pass the boot check and then fail on every request, with `/health` green.
 * It answers `undefined` for:
 *
 * - a scheme other than `redis:` or `rediss:`, or no host;
 * - a database that is not a number;
 * - a user or a password that does not percent-decode.
 */
export function parseRedisUrl(value: string): RedisTarget | undefined {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  if ((url.protocol !== 'redis:' && url.protocol !== 'rediss:') || url.hostname === '') return undefined;

  const database = url.pathname === '' || url.pathname === '/' ? undefined : url.pathname.slice(1);
  if (database !== undefined && !/^\d+$/.test(database)) return undefined;

  try {
    return {
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: Number(url.port || 6379),
      tls: url.protocol === 'rediss:',
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database,
    };
  } catch {
    return undefined;
  }
}
