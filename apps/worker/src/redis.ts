import { type Socket, connect as connectTcp, isIP } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { type Kv, KvError } from './kv.ts';
import { type RedisTarget, parseRedisUrl } from './redis-url.ts';

/**
 * A Redis client over `node:net`, with no dependency (FRU-49, back with FRU-67).
 *
 * It sends the four commands `kv.ts` needs and parses RESP2 replies. Commands are pipelined on one
 * connection, and replies come back in the order the commands went out.
 *
 * **Off unless `FRUITBACK_KV=redis`.** A worker on the memory store never loads this file: `kvs.ts`
 * imports it at the first call that needs it. It is the store of a worker with several replicas,
 * which share one rate limit and one read cache through it.
 */

/**
 * A Redis that accepts a connection and never answers must not hold a request open.
 *
 * The rate limiter runs on every request, so without this bound one stuck socket stops the worker.
 */
export const REDIS_COMMAND_TIMEOUT_MS = 2_000;

/**
 * `INCRBY` and `PEXPIRE` in one atomic step.
 *
 * Two separate commands can leave a counter with no expiry, if the connection drops between them.
 * That counter never resets, and the address it counts is refused for ever.
 *
 * The expiry is set when the key has none, which is a key that this call made. « The count equals the
 * increment » would be the same test only for a key that started at nothing: a batch counts its size
 * (FRU-124), and a key that held `0` would get a second expiry.
 */
export const INCR_WITH_EXPIRY =
  "local n = redis.call('INCRBY', KEYS[1], ARGV[2]) if redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end return n";

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
  // `readKvConfig` refuses such a URL at boot. The message does not quote it, because it can carry a password.
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

    // A named user is authenticated even with no password. Skipping AUTH there runs every command as
    // the default user, which is a different set of permissions than the operator asked for.
    if (username !== '') handshake.push(connection.send(['AUTH', username, password]));
    else if (password !== '') handshake.push(connection.send(['AUTH', password]));

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
    async get(key) {
      const reply = await command(['GET', key]);
      if (reply === null) return undefined;
      if (typeof reply !== 'string') throw new KvError('Redis answered GET with something other than a string');

      return reply;
    },
    async set(key, value, ttlMs) {
      await command(['SET', key, value, 'PX', String(ttlMs)]);
    },
    async incr(key, ttlMs, by = 1) {
      // The same refusal as the memory store, before anything is sent: Redis would count a negative
      // increment, and round nothing.
      if (!Number.isSafeInteger(by) || by < 1) throw new KvError('an increment is a positive integer');
      const reply = await command(['EVAL', INCR_WITH_EXPIRY, '1', key, String(ttlMs), String(by)]);
      if (typeof reply !== 'number') throw new KvError('Redis answered INCR with something other than a number');
      // RESP carries a 64-bit integer and a JavaScript number is exact only to 2^53, so 2^53 + 1 reads
      // back as 2^53. Measured. The memory store refuses at the same point, and so does this one.
      if (!Number.isSafeInteger(reply)) throw new KvError('value is out of range');

      return reply;
    },
    async close() {
      current?.connection.destroy();
      current = undefined;
    },
  };
}

function connect(target: RedisTarget, timeoutMs: number, onDead: () => void): Connection {
  const { host, port } = target;
  // Node refuses a server name that is an IP address, so SNI is sent for a hostname only.
  // WARNING: `rejectUnauthorized` is written, not left to its default. Left out, Node takes it from
  // `NODE_TLS_REJECT_UNAUTHORIZED`, and an operator who set that to 0 for something else would send
  // the password and the notes to a server nobody vouched for. `redis.test.ts` holds this.
  const socket: Socket = target.tls
    ? connectTls({ host, port, rejectUnauthorized: true, ...(isIP(host) === 0 ? { servername: host } : {}) })
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
