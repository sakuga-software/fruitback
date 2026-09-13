import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { type Kv, KvError, createMemoryKv } from './kv.ts';
import { readKvConfig } from './kvs.ts';
import { createRedisKv } from './redis.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One suite for both implementations.
 *
 * Every other test runs on the memory store, so it must answer the way Redis answers. A fake that
 * answers differently passes whatever is written against it next. CI has no Redis: set
 * `FRUITBACK_TEST_REDIS_URL` to run the Redis half.
 */
function contract(name: string, connect: () => Kv, skip?: string) {
  describe(`the ${name} Kv`, { skip }, () => {
    const opened: Kv[] = [];
    const open = () => {
      const kv = connect();
      opened.push(kv);

      return kv;
    };
    const key = () => `fruitback:test:${randomUUID()}`;

    after(async () => {
      await Promise.all(opened.map((kv) => kv.close()));
    });

    it('answers undefined for a key nobody wrote', async () => {
      assert.equal(await open().get(key()), undefined);
    });

    it('gives back the exact string, with multibyte characters and protocol bytes in it', async () => {
      const kv = open();
      const k = key();
      const value = 'é\r\n*3\r\n$-1\r\n🌱';

      await kv.set(k, value, 10_000);
      assert.equal(await kv.get(k), value);
    });

    it('forgets a value after its expiry', async () => {
      const kv = open();
      const k = key();

      await kv.set(k, 'x', 30);
      await sleep(80);
      assert.equal(await kv.get(k), undefined);
    });

    it('counts from 1, and starts again after the expiry', async () => {
      const kv = open();
      const k = key();

      assert.equal(await kv.incr(k, 60), 1);
      assert.equal(await kv.incr(k, 60), 2);
      await sleep(120);
      assert.equal(await kv.incr(k, 60), 1);
    });

    it('keeps the first expiry when it counts again', async () => {
      // A counter whose expiry moved on every request would never expire for a steady caller, and
      // the address it counts would be refused for ever.
      const kv = open();
      const k = key();

      await kv.incr(k, 300);
      await sleep(150);
      assert.equal(await kv.incr(k, 300), 2);
      await sleep(225);
      assert.equal(await kv.incr(k, 300), 1);
    });

    it('shares a count between two clients of one store', async () => {
      const k = key();

      await open().incr(k, 10_000);
      assert.equal(await open().incr(k, 10_000), 2);
      assert.equal(await open().get(k), '2');
    });

    it('refuses to count a value that is not an integer', async () => {
      const kv = open();
      const k = key();

      await kv.set(k, 'not a number', 10_000);
      await assert.rejects(kv.incr(k, 10_000), KvError);
    });

    it('refuses every value Redis refuses to count, and counts a negative one', async () => {
      // Measured against redis:7. `Number()` accepts every one of these, which is how the memory
      // store answered differently from Redis. Raised in review.
      const kv = open();

      for (const value of ['1.0', '', ' 1', '01', '+1', '-0']) {
        const k = key();
        await kv.set(k, value, 10_000);
        await assert.rejects(kv.incr(k, 10_000), KvError, `counted ${JSON.stringify(value)}`);
      }

      const k = key();
      await kv.set(k, '-5', 10_000);
      assert.equal(await kv.incr(k, 10_000), -4);
    });
  });
}

const memory = createMemoryKv();
contract('memory', () => ({ ...memory, close: async () => {} }));

const redisUrl = process.env.FRUITBACK_TEST_REDIS_URL;
contract(
  'redis',
  () => createRedisKv(redisUrl as string),
  redisUrl === undefined ? 'FRUITBACK_TEST_REDIS_URL is not set' : undefined,
);

describe('readKvConfig', () => {
  it('keeps the state in memory when nothing is set, as before SKG-542', () => {
    assert.deepEqual(readKvConfig({}), { ok: true, config: { provider: 'memory' } });
  });

  it('reads the Redis URL when FRUITBACK_KV=redis', () => {
    const env = { FRUITBACK_KV: 'redis', FRUITBACK_REDIS_URL: 'rediss://kv.internal:6380/2' };

    assert.deepEqual(readKvConfig(env), {
      ok: true,
      config: { provider: 'redis', url: 'rediss://kv.internal:6380/2' },
    });
  });

  it('names the variable an operator has to fix', () => {
    const cases = [
      { env: { FRUITBACK_KV: 'memcached' }, names: 'FRUITBACK_KV' },
      { env: { FRUITBACK_KV: 'redis' }, names: 'FRUITBACK_REDIS_URL' },
      { env: { FRUITBACK_KV: 'redis', FRUITBACK_REDIS_URL: 'http://kv.internal' }, names: 'FRUITBACK_REDIS_URL' },
      { env: { FRUITBACK_KV: 'redis', FRUITBACK_REDIS_URL: 'not a url' }, names: 'FRUITBACK_REDIS_URL' },
      // Both used to pass the boot check and fail on every request. Raised in review.
      {
        env: { FRUITBACK_KV: 'redis', FRUITBACK_REDIS_URL: 'redis://kv.internal/not-a-db' },
        names: 'FRUITBACK_REDIS_URL',
      },
      { env: { FRUITBACK_KV: 'redis', FRUITBACK_REDIS_URL: 'redis://:%zz@kv.internal' }, names: 'FRUITBACK_REDIS_URL' },
      // The mistake that leaves two replicas with two limits and no message anywhere.
      { env: { FRUITBACK_REDIS_URL: 'redis://kv.internal' }, names: 'FRUITBACK_KV' },
    ];

    for (const { env, names } of cases) {
      const result = readKvConfig(env);
      assert.ok(!result.ok && result.missing.some((name) => name.startsWith(names)), JSON.stringify(env));
    }
  });

  it('never quotes the URL, which can carry a password', () => {
    for (const env of [
      { FRUITBACK_REDIS_URL: 'redis://:hunter2-password@kv.internal' },
      { FRUITBACK_KV: 'memory', FRUITBACK_REDIS_URL: 'redis://:hunter2-password@kv.internal' },
    ]) {
      const result = readKvConfig(env);
      assert.ok(!result.ok && !result.missing.join(' ').includes('hunter2'));
    }
  });
});
