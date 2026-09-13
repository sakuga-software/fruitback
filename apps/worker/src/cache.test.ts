import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CACHE_TTL_MS, cached, invalidate, resetCacheState } from './cache.ts';
import { type Kv, KvError, createMemoryKv } from './kv.ts';

const PAGE = 'https://preview.acme.test/pricing';
const OTHER_PAGE = 'https://preview.acme.test/features';

let clock: number;
let kv: Kv;

beforeEach(() => {
  resetCacheState();
  clock = 1_770_000_000_000;
  kv = createMemoryKv({ now: () => clock });
});

function counting() {
  const seen = { loads: 0 };
  const load = async () => {
    seen.loads += 1;

    return seen.loads;
  };

  return { seen, load };
}

/** A load that waits until the test lets it finish. */
function held<T>(value: T) {
  let release = () => {};
  const load = () =>
    new Promise<T>((resolve) => {
      release = () => resolve(value);
    });

  return { load, release: () => release() };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('cached', () => {
  it('loads once and serves the same value within the window', async () => {
    const { seen, load } = counting();

    assert.equal(await cached(kv, PAGE, 'k', load), 1);
    clock += CACHE_TTL_MS - 1;
    assert.equal(await cached(kv, PAGE, 'k', load), 1);
    assert.equal(seen.loads, 1);
  });

  it('reloads once the entry has expired', async () => {
    const { load } = counting();

    await cached(kv, PAGE, 'k', load);
    clock += CACHE_TTL_MS;
    assert.equal(await cached(kv, PAGE, 'k', load), 2);
  });

  it('keeps keys apart', async () => {
    assert.equal(await cached(kv, PAGE, 'a', async () => 'first'), 'first');
    assert.equal(await cached(kv, PAGE, 'b', async () => 'second'), 'second');
  });

  it('collapses concurrent misses into a single load', async () => {
    // Ten visitors on one replica must cost one provider call, not ten.
    const { seen, load } = counting();

    const results = await Promise.all(Array.from({ length: 10 }, () => cached(kv, PAGE, 'k', load)));

    assert.deepEqual(
      results,
      Array.from({ length: 10 }, () => 1),
    );
    assert.equal(seen.loads, 1);
  });

  it('does not serve a failure for the rest of the window', async () => {
    // An outage that lasted a second must not blank out the pins for fifteen.
    let loads = 0;
    const load = async () => {
      loads += 1;
      if (loads === 1) throw new Error('Linear is down');

      return 'recovered';
    };

    await assert.rejects(cached(kv, PAGE, 'k', load));
    assert.equal(await cached(kv, PAGE, 'k', load), 'recovered');
  });

  it('keeps the answer in the Kv, where another replica reads it', async () => {
    // What SKG-542 moved. A value kept in this process would pass every test above.
    const written: string[] = [];
    const recording: Kv = { ...kv, set: (key, value, ttl) => (written.push(value), kv.set(key, value, ttl)) };

    await cached(recording, PAGE, 'k', async () => [{ id: 'issue_1' }]);

    assert.deepEqual(written, [JSON.stringify([{ id: 'issue_1' }])]);
  });

  it('still answers the read when the Kv does not', async () => {
    const down = async () => {
      throw new KvError('Redis is down');
    };
    const broken: Kv = { ...kv, get: down, set: down, incr: down };

    assert.equal(await cached(broken, PAGE, 'k', async () => 'from the store'), 'from the store');
  });

  it('still collapses concurrent misses when the Kv does not answer', async () => {
    // An outage is when the provider quota needs the single flight most. Raised in review.
    const down = async () => {
      throw new KvError('Redis is down');
    };
    const broken: Kv = { ...kv, get: down, set: down, incr: down };
    const { seen, load } = counting();

    const results = await Promise.all(Array.from({ length: 10 }, () => cached(broken, PAGE, 'k', load)));

    assert.deepEqual(
      results,
      Array.from({ length: 10 }, () => 1),
    );
    assert.equal(seen.loads, 1);
  });
});

describe('invalidate', () => {
  it('makes the next read of that page load again', async () => {
    const { load } = counting();

    await cached(kv, PAGE, 'k', load);
    await invalidate(kv, PAGE);
    assert.equal(await cached(kv, PAGE, 'k', load), 2);
  });

  it('reaches every key of the page, and no other page', async () => {
    const a = counting();
    const b = counting();
    const other = counting();

    await cached(kv, PAGE, 'client a', a.load);
    await cached(kv, PAGE, 'client b', b.load);
    await cached(kv, OTHER_PAGE, 'client a', other.load);
    await invalidate(kv, PAGE);

    assert.equal(await cached(kv, PAGE, 'client a', a.load), 2);
    assert.equal(await cached(kv, PAGE, 'client b', b.load), 2);
    assert.equal(await cached(kv, OTHER_PAGE, 'client a', other.load), 1);
  });

  it('does not let a load in flight during a write store its stale answer for the next reader', async () => {
    // The read started before the pin was planted. It finishes after, and the answer it holds does
    // not have the pin. Stored where the next reader looks, the pin reads as lost for a whole TTL.
    const slow = held('before the write');
    const inFlight = cached(kv, PAGE, 'k', slow.load);
    await settle();

    await invalidate(kv, PAGE);
    slow.release();

    assert.equal(await inFlight, 'before the write');
    assert.equal(await cached(kv, PAGE, 'k', async () => 'after the write'), 'after the write');
  });

  it('does not let a reader after the write join a load that started before it', async () => {
    const slow = held('before the write');
    const inFlight = cached(kv, PAGE, 'k', slow.load);
    await settle();

    await invalidate(kv, PAGE);
    const fresh = cached(kv, PAGE, 'k', async () => 'after the write');
    slow.release();

    assert.equal(await fresh, 'after the write');
    await inFlight;
  });
});
