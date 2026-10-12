import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type Kv, KvError, createMemoryKv } from './kv.ts';
import { closeSharedKvs, kvFor, readKvConfig } from './kvs.ts';
import { createRedisKv } from './redis.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What every `Kv` must answer: one suite for the memory store and for Redis (FRU-67).
 *
 * Every other test runs on the memory store, so it answers the way Redis answers: its integer rules
 * were measured against redis:7. A fake that answers differently passes whatever is written next.
 * **The Redis half runs against a real Redis**, named by `FRUITBACK_TEST_REDIS_URL`: the job
 * « postgres » of CI sets it, and without it the half is skipped, and says so.
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

    it('counts a batch by its size, from nothing and from a count', async () => {
      const kv = open();
      const k = key();

      assert.equal(await kv.incr(k, 60, 4), 4);
      assert.equal(await kv.incr(k, 60), 5);
      assert.equal(await kv.incr(k, 60, 3), 8);
      await sleep(120);
      assert.equal(await kv.incr(k, 60, 2), 2, 'a count that starts above one has its expiry too');
    });

    it('refuses an increment that is not a positive integer, and counts nothing', async () => {
      const kv = open();
      const k = key();

      for (const by of [0, -1, 1.5, Number.NaN]) await assert.rejects(kv.incr(k, 10_000, by), KvError, String(by));
      assert.equal(await kv.get(k), undefined);
    });

    it('gives an expiry to a count that starts from a stored zero, and keeps the one of a stored value', async () => {
      // « The count equals the increment » is not « the key is new »: a key that held `0` would get
      // a second expiry, and one that held `-1` and counts 2 would get none.
      const kv = open();
      const k = key();

      await kv.set(k, '0', 150);
      assert.equal(await kv.incr(k, 10_000), 1);
      await sleep(250);
      assert.equal(await kv.get(k), undefined, 'the count outlived the expiry of the value it started from');
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

    it('refuses to count past 2^53 rather than answer a wrong number', async () => {
      // Redis holds 2^53 + 1 after this INCR, and a JavaScript number reads it back as 2^53. Raised in
      // review.
      const kv = open();
      const k = key();

      await kv.set(k, '9007199254740992', 10_000);
      await assert.rejects(kv.incr(k, 10_000), KvError);
    });

    it('refuses a stored count below -2^53 rather than round it', async () => {
      // `Number()` reads -(2^53 + 1) as -2^53, and adding one gives a safe integer one too high.
      // Raised in review.
      const kv = open();
      const k = key();

      await kv.set(k, '-9007199254740993', 10_000);
      await assert.rejects(kv.incr(k, 10_000), KvError);
    });
  });
}

const memory = createMemoryKv();
contract('memory', () => ({ ...memory, close: async () => {} }));

const redisUrl = process.env.FRUITBACK_TEST_REDIS_URL;
// `test:redis` sets this, and CI runs it: with no address the Redis half would be skipped, and a suite
// that is skipped proves nothing.
if (process.env.FRUITBACK_TEST_REDIS === 'required' && redisUrl === undefined) {
  throw new Error('FRUITBACK_TEST_REDIS=required, and FRUITBACK_TEST_REDIS_URL names no Redis');
}
contract(
  'redis',
  () => createRedisKv(redisUrl as string),
  redisUrl === undefined ? 'FRUITBACK_TEST_REDIS_URL is not set: the CI job « postgres » sets it' : undefined,
);

describe('which Kv a worker runs on (FRU-67)', () => {
  after(closeSharedKvs);

  it('keeps the state in memory when nothing is set, as before', () => {
    assert.deepEqual(readKvConfig({}), { ok: true, config: { provider: 'memory' } });
    assert.deepEqual(readKvConfig({ FRUITBACK_KV: ' memory ' }), { ok: true, config: { provider: 'memory' } });
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
      // Both used to pass the boot check and fail on every request.
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
      { FRUITBACK_KV: 'redis', FRUITBACK_REDIS_URL: 'redis://:hunter2-password@kv.internal/x' },
    ]) {
      const result = readKvConfig(env);
      assert.ok(!result.ok && !result.missing.join(' ').includes('hunter2'));
    }
  });

  it('loads the client of Redis only for a worker that asked for it: no file of every worker imports it', () => {
    // A worker on memory runs none of that code. `kvs.ts` imports `redis.ts` when it is first called.
    for (const file of ['kvs.ts', 'kv.ts', 'env.ts', 'app.ts', 'server.ts', 'redis-url.ts']) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      assert.doesNotMatch(source, /from '\.\/redis\.ts'/, `${file} imports the client of Redis when it loads`);
      assert.doesNotMatch(source, /from 'node:(net|tls)'/, `${file} loads a socket`);
    }
    assert.match(readFileSync(new URL('./kvs.ts', import.meta.url), 'utf8'), /import\('\.\/redis\.ts'\)/);
  });

  it('gives one instance for one configuration, and the memory of the process for memory', () => {
    const redis = { provider: 'redis', url: 'redis://127.0.0.1:1' } as const;

    assert.equal(kvFor(redis), kvFor({ ...redis }));
    assert.notEqual(kvFor(redis), kvFor({ provider: 'redis', url: 'redis://127.0.0.1:2' }));
    assert.equal(kvFor({ provider: 'memory' }), kvFor({ provider: 'memory' }));
    assert.notEqual(kvFor({ provider: 'memory' }), kvFor(redis));
  });
});

describe('the memory Kv, bounded', () => {
  /** A hundred entries that expire after one second, and a counter that does not. */
  async function filled() {
    let clock = 0;
    const kv = createMemoryKv({ now: () => clock });

    for (let index = 0; index < 100; index += 1) await kv.set(`page ${index}`, 'answer', 1_000);
    await kv.incr('address', 600_000);

    return { kv, advance: (to: number) => (clock = to) };
  }

  it('drops expired entries under a workload that only reads', async () => {
    // A page served from the cache calls `get` and nothing else. Sweeping only on a write kept every
    // expired entry for as long as the reads went on. Raised in review.
    const { kv, advance } = await filled();

    advance(5_000);
    await kv.get('page 0');

    assert.equal(kv.size(), 1);
  });

  /**
   * The sweep is a walk of every entry, so it runs at most once in `SWEEP_INTERVAL_MS` (one second),
   * whatever the number of calls. `size()` counts an expired entry until the sweep that drops it.
   *
   * These three cases hold the two lines of that rule (FRU-190). Before them the mutants « always
   * sweep » (`if (false) return`, `nextSweep = at - SWEEP_INTERVAL_MS`) and « one millisecond late »
   * (`at <= nextSweep`) passed every test: a mutation run counted them killed only when it ran out of
   * time.
   */
  it('does not sweep again within a second of the last sweep: an expired entry stays until then', async () => {
    let clock = 0;
    const kv = createMemoryKv({ now: () => clock });
    // The first call sweeps, at 0: the next sweep is due at 1 000.
    await kv.set('short', 'answer', 10);
    await kv.set('long', 'answer', 600_000);

    clock = 999;
    await kv.get('long');
    await kv.set('other', 'answer', 600_000);
    await kv.incr('address', 600_000);

    // « short » expired at 10 and no call asked for it: only a sweep drops it.
    assert.equal(kv.size(), 4);
  });

  it('sweeps at the instant the second ends, not one millisecond later', async () => {
    let clock = 0;
    const kv = createMemoryKv({ now: () => clock });
    await kv.set('short', 'answer', 10);
    await kv.set('long', 'answer', 600_000);

    clock = 1_000;
    await kv.get('long');

    assert.equal(kv.size(), 1);
  });

  it('counts the second from the last sweep, each time', async () => {
    let clock = 0;
    const kv = createMemoryKv({ now: () => clock });
    await kv.set('long', 'answer', 600_000);

    // A sweep at 1 500: the next one is due at 2 500, not at 2 000.
    clock = 1_500;
    await kv.set('short', 'answer', 10);
    clock = 2_499;
    await kv.get('long');
    assert.equal(kv.size(), 2);

    clock = 2_500;
    await kv.get('long');
    assert.equal(kv.size(), 1);
  });

  it('drops expired entries under a workload that only counts a known address', async () => {
    const { kv, advance } = await filled();

    advance(5_000);
    await kv.incr('address', 600_000);

    assert.equal(kv.size(), 1);
  });
});
