import { type Socket, connect as connectTcp, isIP } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { type Kv, KvError } from './kv.ts';

/**
 * A Redis client over `node:net`, with no dependency (SKG-542).
 *
 * It sends the four commands `kv.ts` needs and parses RESP2 replies. Commands are pipelined on one
 * connection, and replies come back in the order the commands went out.
 */

/**
 * A Redis that accepts a connection and never answers must not hold a request open.
 *
 * The rate limiter runs on every request, so without this bound one stuck socket stops the worker.
 */
export const REDIS_COMMAND_TIMEOUT_MS = 2_000;

/**
 * `INCR` and `PEXPIRE` in one atomic step.
 *
 * Two separate commands can leave a counter with no expiry, if the connection drops between them.
 * That counter never resets, and the address it counts is refused for ever.
 */
const INCR_WITH_EXPIRY =
  "local n = redis.call('INCR', KEYS[1]) if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end return n";

export type Reply = string | number | null | Reply[] | ReplyError;

export class ReplyError extends Error {}

/** Parse one reply from `buffer` at `start`. `undefined` means the reply is not complete yet. */
export function parseReply(buffer: Buffer, start = 0): { value: Reply; end: number } | undefined {
  const lineEnd = buffer.indexOf('\r\n', start);
  if (lineEnd === -1) return undefined;

  const type = buffer[start];
  const line = buffer.toString('utf8', start + 1, lineEnd);
  const after = lineEnd + 2;

  switch (type) {
    case 0x2b: // +
      return { value: line, end: after };
    case 0x2d: // -
      return { value: new ReplyError(line), end: after };
    case 0x3a: // :
      return { value: Number(line), end: after };
    case 0x24: {
      // $ — the length counts bytes, not characters.
      const length = Number(line);
      if (length === -1) return { value: null, end: after };
      if (buffer.length < after + length + 2) return undefined;

      return { value: buffer.toString('utf8', after, after + length), end: after + length + 2 };
    }
    case 0x2a: {
      // *
      const count = Number(line);
      if (count === -1) return { value: null, end: after };

      const items: Reply[] = [];
      let cursor = after;

      for (let index = 0; index < count; index += 1) {
        const item = parseReply(buffer, cursor);
        if (item === undefined) return undefined;
        items.push(item.value);
        cursor = item.end;
      }

      return { value: items, end: cursor };
    }
    default:
      throw new KvError('Redis sent a reply this client cannot read');
  }
}

export function encodeCommand(args: readonly string[]): string {
  return `*${args.length}\r\n${args.map((arg) => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`).join('')}`;
}

type Pending = { resolve(value: Reply): void; reject(error: Error): void; timer: NodeJS.Timeout };

type Connection = { send(args: readonly string[]): Promise<Reply>; destroy(): void };

/**
 * `redis://[[user]:password@]host[:port][/db]`, or `rediss://` for TLS.
 *
 * The connection opens on the first command and opens again after a failure. No error message names
 * the URL, because the URL can carry a password.
 */
export function createRedisKv(url: string, options: { timeoutMs?: number } = {}): Kv {
  const parsed = parseRedisUrl(url);
  // `kvs.ts` refuses such a URL at boot. The message does not quote it, because it can carry a password.
  if (parsed === undefined) throw new KvError('FRUITBACK_REDIS_URL is not a Redis URL this client can use');
  // A narrowed `const` loses its narrowing inside `open`, which is hoisted. This one is typed once.
  const target: RedisTarget = parsed;
  const timeoutMs = options.timeoutMs ?? REDIS_COMMAND_TIMEOUT_MS;
  let current: { connection: Connection; ready: Promise<void> } | undefined;

  function open() {
    const connection = connect(target, timeoutMs, () => {
      if (current?.connection === connection) current = undefined;
    });
    const handshake: Promise<Reply>[] = [];
    const { username, password, database } = target;

    if (password !== '') {
      handshake.push(connection.send(username === '' ? ['AUTH', password] : ['AUTH', username, password]));
    }

    if (database !== undefined) handshake.push(connection.send(['SELECT', database]));

    const ready = Promise.all(handshake).then((replies) => {
      const refused = replies.find((reply) => reply instanceof ReplyError);
      // The reply text is not quoted: an `AUTH` refusal can repeat what was sent.
      if (refused !== undefined) throw new KvError('Redis refused the connection handshake');
    });

    // A failed handshake leaves nothing worth reusing.
    ready.catch(() => connection.destroy());

    return { connection, ready };
  }

  async function command(args: readonly string[]): Promise<Reply> {
    current ??= open();
    const { connection, ready } = current;
    await ready;

    const reply = await connection.send(args);
    if (reply instanceof ReplyError) throw new KvError(`Redis refused ${args[0]}: ${reply.message}`);

    return reply;
  }

  return {
    provider: 'redis',
    async get(key) {
      const reply = await command(['GET', key]);
      if (reply === null) return undefined;
      if (typeof reply !== 'string') throw new KvError('Redis answered GET with something other than a string');

      return reply;
    },
    async set(key, value, ttlMs) {
      await command(['SET', key, value, 'PX', String(ttlMs)]);
    },
    async incr(key, ttlMs) {
      const reply = await command(['EVAL', INCR_WITH_EXPIRY, '1', key, String(ttlMs)]);
      if (typeof reply !== 'number') throw new KvError('Redis answered INCR with something other than a number');

      return reply;
    },
    async close() {
      current?.connection.destroy();
      current = undefined;
    },
  };
}

export type RedisTarget = {
  host: string;
  port: number;
  tls: boolean;
  username: string;
  password: string;
  database: string | undefined;
};

/**
 * The one reading of `FRUITBACK_REDIS_URL`. `kvs.ts` asks it at boot, and the client connects with
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

function connect(target: RedisTarget, timeoutMs: number, onDead: () => void): Connection {
  const { host, port } = target;
  // Node refuses a server name that is an IP address, so SNI is sent for a hostname only.
  const socket: Socket = target.tls
    ? connectTls({ host, port, ...(isIP(host) === 0 ? { servername: host } : {}) })
    : connectTcp({ host, port });
  const pending: Pending[] = [];
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let dead: Error | undefined;

  function fail(error: Error) {
    if (dead !== undefined) return;
    dead = error instanceof KvError ? error : new KvError(`Redis connection failed: ${error.message}`);
    onDead();
    socket.destroy();

    for (const entry of pending.splice(0)) {
      clearTimeout(entry.timer);
      entry.reject(dead);
    }
  }

  socket.on('data', (chunk: Buffer) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);

    try {
      for (let parsed = parseReply(buffer); parsed !== undefined; parsed = parseReply(buffer)) {
        buffer = buffer.subarray(parsed.end);
        const entry = pending.shift();
        // A reply nobody asked for means the order is lost. Every later reply would go to the wrong caller.
        if (entry === undefined) throw new KvError('Redis sent a reply with no command waiting for it');
        clearTimeout(entry.timer);
        entry.resolve(parsed.value);
      }
    } catch (error) {
      fail(error as Error);
    }
  });
  socket.on('error', fail);
  socket.on('close', () => fail(new KvError('Redis closed the connection')));

  return {
    send(args) {
      if (dead !== undefined) return Promise.reject(dead);

      return new Promise<Reply>((resolve, reject) => {
        // A late reply after a timeout would go to the next caller, so the whole connection goes.
        const timer = setTimeout(
          () => fail(new KvError(`Redis did not answer ${args[0]} within ${timeoutMs} ms`)),
          timeoutMs,
        );
        pending.push({ resolve, reject, timer });
        socket.write(encodeCommand(args));
      });
    },
    destroy() {
      fail(new KvError('Redis connection closed by this worker'));
    },
  };
}
