import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { type Kv, KvError, createMemoryKv } from './kv.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What every `Kv` must answer. It runs against the memory store here, and a shared store (SKG-606)
 * must pass it too.
 *
 * Every other test runs on the memory store, so it answers the way Redis answers: its integer rules
 * were measured against redis:7. A fake that answers differently passes whatever is written next.
 */
function contract(name: string, connect: () => Kv) {
  describe(`the ${name} Kv`, () => {
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

  it('drops expired entries under a workload that only counts a known address', async () => {
    const { kv, advance } = await filled();

    advance(5_000);
    await kv.incr('address', 600_000);

    assert.equal(kv.size(), 1);
  });
});
