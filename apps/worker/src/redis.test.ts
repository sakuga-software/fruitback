import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type AddressInfo, type Socket, createServer } from 'node:net';
import { KvError } from './kv.ts';
import { type Reply, ReplyError, createRedisKv, encodeCommand, parseRedisUrl, parseReply } from './redis.ts';

describe('parseRedisUrl', () => {
  it('reads what the client connects with', () => {
    assert.deepEqual(parseRedisUrl('rediss://reviewer:p%40ss@[::1]:6380/3'), {
      host: '::1',
      port: 6380,
      tls: true,
      username: 'reviewer',
      password: 'p@ss',
      database: '3',
    });
    assert.deepEqual(parseRedisUrl('redis://kv.internal/'), {
      host: 'kv.internal',
      port: 6379,
      tls: false,
      username: '',
      password: '',
      database: undefined,
    });
  });

  it('refuses at boot what the client would fail on at every request', () => {
    // The boot check and the client read the URL through this one function, so a URL cannot pass one
    // and fail the other. Raised in review.
    const refused = [
      'redis://kv.internal/not-a-db',
      'redis://kv.internal/0/1',
      'redis://:%zz@kv.internal',
      'http://kv.internal',
      'redis://',
      'not a url',
    ];

    for (const url of refused) assert.equal(parseRedisUrl(url), undefined, url);
  });
});

describe('parseReply', () => {
  it('reads every reply type, one after another', () => {
    const buffer = Buffer.from('+OK\r\n-ERR nope\r\n:42\r\n$-1\r\n$3\r\nabc\r\n*2\r\n$1\r\na\r\n:1\r\n');
    const values: Reply[] = [];
    let cursor = 0;

    for (let parsed = parseReply(buffer, cursor); parsed !== undefined; parsed = parseReply(buffer, cursor)) {
      values.push(parsed.value);
      cursor = parsed.end;
    }

    assert.equal(cursor, buffer.length);
    assert.equal(values[0], 'OK');
    assert.ok(values[1] instanceof ReplyError && values[1].message === 'ERR nope');
    assert.deepEqual(values.slice(2), [42, null, 'abc', ['a', 1]]);
  });

  it('counts a bulk string in bytes, not in characters', () => {
    const buffer = Buffer.from('$5\r\né€\r\n');

    assert.deepEqual(parseReply(buffer), { value: 'é€', end: buffer.length });
  });

  it('waits for the rest of a reply cut at any byte', () => {
    const buffer = Buffer.from('*3\r\n$2\r\né\r\n:7\r\n$-1\r\n');

    for (let cut = 0; cut < buffer.length; cut += 1) {
      assert.equal(parseReply(buffer.subarray(0, cut)), undefined, `a reply cut at byte ${cut} was read`);
    }
    assert.deepEqual(parseReply(buffer)?.value, ['é', 7, null]);
  });

  it('encodes each argument with its length in bytes', () => {
    assert.equal(encodeCommand(['SET', 'é']), '*2\r\n$3\r\nSET\r\n$2\r\né\r\n');
  });
});

type Answer = (args: string[], connection: number, socket: Socket) => string | undefined;

/** A server that speaks just enough RESP to drive the client. Not Redis: `kv.test.ts` is for that. */
async function fakeRedis(answer: Answer) {
  const commands: string[][] = [];
  const sockets = new Set<Socket>();
  let connections = 0;

  const server = createServer((socket) => {
    const connection = ++connections;
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    // Each reply goes out in two writes, so the client has to put one back together — and they are
    // chained, because two replies interleaved on the wire is a broken server, not a hard client.
    let writing = Promise.resolve();
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      for (let parsed = parseReply(buffer); parsed !== undefined; parsed = parseReply(buffer)) {
        buffer = buffer.subarray(parsed.end);
        const args = parsed.value as string[];
        commands.push(args);
        const reply = answer(args, connection, socket);
        if (reply === undefined || socket.destroyed) continue;

        writing = writing.then(
          () =>
            new Promise((resolve) => {
              const half = Math.floor(reply.length / 2);
              if (socket.writable) socket.write(reply.slice(0, half));
              setTimeout(() => {
                if (socket.writable) socket.write(reply.slice(half));
                resolve();
              }, 5);
            }),
        );
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    port,
    commands,
    connections: () => connections,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

describe('createRedisKv', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) await step();
  });

  async function setUp(answer: Answer, path = '', options: { timeoutMs?: number } = {}) {
    const server = await fakeRedis(answer);
    const kv = createRedisKv(`redis://${path}127.0.0.1:${server.port}`, options);
    cleanup.push(server.close, kv.close);

    return { server, kv };
  }

  it('hands each pipelined reply to the command that asked for it', async () => {
    const { kv } = await setUp((args) => {
      const key = args[1] ?? '';

      return `$${key.length + 6}\r\nvalue ${key}\r\n`;
    });

    assert.deepEqual(await Promise.all([kv.get('first'), kv.get('second')]), ['value first', 'value second']);
  });

  it('authenticates and selects the database before the first command', async () => {
    const { server, kv } = await setUp((args) => (args[0] === 'GET' ? '$-1\r\n' : '+OK\r\n'), 'reviewer:p%40ss@');
    const { port } = server;
    const kv3 = createRedisKv(`redis://reviewer:p%40ss@127.0.0.1:${port}/3`);
    cleanup.push(kv3.close);

    assert.equal(await kv.get('k'), undefined);
    assert.equal(await kv3.get('k'), undefined);
    assert.deepEqual(server.commands, [
      ['AUTH', 'reviewer', 'p@ss'],
      ['GET', 'k'],
      ['AUTH', 'reviewer', 'p@ss'],
      ['SELECT', '3'],
      ['GET', 'k'],
    ]);
  });

  it('authenticates a named user that has no password, instead of running as the default user', async () => {
    // `redis://alice@host` used to send no AUTH at all. Raised in review.
    const { server, kv } = await setUp((args) => (args[0] === 'GET' ? '$-1\r\n' : '+OK\r\n'), 'alice@');

    assert.equal(await kv.get('k'), undefined);
    assert.deepEqual(server.commands, [
      ['AUTH', 'alice', ''],
      ['GET', 'k'],
    ]);
  });

  it('does not repeat the password when Redis refuses it', async () => {
    // Some servers echo what they were sent. The message ends up in `docker logs`.
    const { kv } = await setUp(
      (args) => (args[0] === 'AUTH' ? `-WRONGPASS ${args.join(' ')}\r\n` : '$-1\r\n'),
      ':s3cret@',
    );

    await assert.rejects(kv.get('k'), (error: Error) => error instanceof KvError && !error.message.includes('s3cret'));
  });

  it('gives up on a Redis that never answers, then connects again', async () => {
    const { server, kv } = await setUp((_args, connection) => (connection === 1 ? undefined : '$2\r\nok\r\n'), '', {
      timeoutMs: 50,
    });

    await assert.rejects(kv.get('k'), KvError);
    assert.equal(await kv.get('k'), 'ok');
    assert.equal(server.connections(), 2);
  });

  it('fails the commands of a connection that closes, then connects again', async () => {
    const { server, kv } = await setUp((_args, connection, socket) => {
      if (connection === 1) {
        socket.destroy();

        return undefined;
      }

      return ':7\r\n';
    });

    await assert.rejects(kv.incr('k', 1_000), KvError);
    assert.equal(await kv.incr('k', 1_000), 7);
    assert.equal(server.connections(), 2);
  });

  it('counts and sets the expiry in one script', async () => {
    const { server, kv } = await setUp(() => ':1\r\n');

    assert.equal(await kv.incr('k', 120_000), 1);
    const [name, script, keys, key, ttl] = server.commands[0] ?? [];
    assert.deepEqual([name, keys, key, ttl], ['EVAL', '1', 'k', '120000']);
    assert.match(script ?? '', /INCR.*if n == 1 then .*PEXPIRE/);
  });

  it('rejects with KvError when nothing listens', async () => {
    const kv = createRedisKv('redis://127.0.0.1:1', { timeoutMs: 500 });
    cleanup.push(kv.close);

    await assert.rejects(kv.get('k'), KvError);
  });
});
