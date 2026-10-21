import { beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { CACHE_TTL_MS, PAGE_VERSION_TTL_MS, cached, invalidate, resetCacheState } from './cache.ts';
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

  it('keeps two pages apart when they share a key', async () => {
    // `app.ts` puts the URL in the key too, but `cached` takes the page on its own. Raised in review.
    assert.equal(await cached(kv, PAGE, 'k', async () => 'pricing'), 'pricing');
    assert.equal(await cached(kv, OTHER_PAGE, 'k', async () => 'features'), 'features');
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
    // What FRU-49 moved. A value kept in this process would pass every test above.
    const written: string[] = [];
    const recording: Kv = { ...kv, set: (key, value, ttl) => (written.push(value), kv.set(key, value, ttl)) };

    await cached(recording, PAGE, 'k', async () => [{ id: 'issue_1' }]);

    assert.deepEqual(written, [JSON.stringify([{ id: 'issue_1' }])]);
  });

  it('still answers the read when the Kv does not', async () => {
    const down = async () => {
      throw new KvError('the store is down');
    };
    const broken: Kv = { ...kv, get: down, set: down, incr: down };

    assert.equal(await cached(broken, PAGE, 'k', async () => 'from the store'), 'from the store');
  });

  it('still collapses concurrent misses when the Kv does not answer', async () => {
    // An outage is when the provider quota needs the single flight most. Raised in review.
    const down = async () => {
      throw new KvError('the store is down');
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

  it('does not swallow an error that is not from the Kv, when it reads the version of the page', async () => {
    // Only `KvError` means « the cache does not answer ». A defect in the Kv code must be seen.
    const defect = new TypeError('a defect, not an outage');
    const broken: Kv = {
      ...kv,
      get: async () => {
        throw defect;
      },
    };
    const { seen, load } = counting();

    await assert.rejects(cached(broken, PAGE, 'k', load), (error) => error === defect);
    assert.equal(seen.loads, 0);
  });

  it('does not swallow an error that is not from the Kv, when it reads or writes an entry', async () => {
    const defect = new TypeError('a defect, not an outage');
    const isEntry = (key: string) => key.startsWith('fruitback:read:');
    const brokenRead: Kv = {
      ...kv,
      get: async (key) => {
        if (isEntry(key)) throw defect;

        return kv.get(key);
      },
    };
    const brokenWrite: Kv = {
      ...kv,
      set: async (key, value, ttl) => {
        if (isEntry(key)) throw defect;

        return kv.set(key, value, ttl);
      },
    };

    await assert.rejects(
      cached(brokenRead, PAGE, 'k', async () => 'never'),
      (error) => error === defect,
    );
    await assert.rejects(
      cached(brokenWrite, PAGE, 'k', async () => 'loaded'),
      (error) => error === defect,
    );
  });

  it('reads an entry that is not JSON as a miss, and replaces it', async () => {
    // The first read writes the entry. Then something else corrupts it in the store.
    const keys: string[] = [];
    const recording: Kv = { ...kv, set: (key, value, ttl) => (keys.push(key), kv.set(key, value, ttl)) };
    await cached(recording, PAGE, 'k', async () => 'first');
    const entryKey = keys[0];
    assert.ok(entryKey !== undefined);
    await kv.set(entryKey, '{"cut off', CACHE_TTL_MS);

    assert.equal(await cached(kv, PAGE, 'k', async () => 'second'), 'second');
    assert.equal(await kv.get(entryKey), JSON.stringify('second'));
    assert.equal(await cached(kv, PAGE, 'k', async () => 'third'), 'second');
  });

  it('writes an entry for the time of the cache window, under a key that names the page and the key', async () => {
    const sets: { key: string; ttl: number }[] = [];
    const recording: Kv = { ...kv, set: (key, value, ttl) => (sets.push({ key, ttl }), kv.set(key, value, ttl)) };

    await cached(recording, PAGE, 'k', async () => 'value');

    assert.deepEqual(sets, [{ key: `fruitback:read:${JSON.stringify(['none', PAGE, 'k'])}`, ttl: CACHE_TTL_MS }]);
    assert.equal(CACHE_TTL_MS, 15_000);
  });

  it('touches no entry of the Kv when the version of the page cannot be read', async () => {
    // With no version, an answer cannot be filed under the version a reader uses.
    const touched: string[] = [];
    const noVersion: Kv = {
      ...kv,
      get: async (key) => {
        if (key.startsWith('fruitback:page:')) throw new KvError('the store is down');
        touched.push(`get ${key}`);

        return kv.get(key);
      },
      set: async (key, value, ttl) => {
        touched.push(`set ${key}`);

        return kv.set(key, value, ttl);
      },
    };
    const { seen, load } = counting();

    assert.equal(await cached(noVersion, PAGE, 'k', load), 1);
    assert.equal(await cached(noVersion, PAGE, 'k', load), 2);
    assert.deepEqual(touched, []);
    assert.equal(seen.loads, 2);
  });

  it('does not let a read join a load that has already settled', async () => {
    // The shared load is for concurrent misses only. After it settles, the next miss loads again.
    const down = async () => {
      throw new KvError('the store is down');
    };
    const broken: Kv = { ...kv, get: down, set: down, incr: down };
    const first = held('first');

    const pending = cached(broken, PAGE, 'k', first.load);
    await settle();
    first.release();
    assert.equal(await pending, 'first');
    await settle();

    assert.equal(await cached(broken, PAGE, 'k', async () => 'second'), 'second');
  });

  it('does not let a load that settles drop the newer load of the same key', async () => {
    // `resetCacheState` forgets a load that still runs, and the next read starts a newer one. When the
    // older load settles, the newer one stays in flight, and a read that comes then joins it (FRU-345).
    const down = async () => {
      throw new KvError('the store is down');
    };
    const broken: Kv = { ...kv, get: down, set: down, incr: down };
    const first = held('first');
    const second = held('second');

    const older = cached(broken, PAGE, 'k', first.load);
    await settle();
    resetCacheState();
    const newer = cached(broken, PAGE, 'k', second.load);
    await settle();
    first.release();
    assert.equal(await older, 'first');
    await settle();

    const joining = cached(broken, PAGE, 'k', async () => 'a third load');
    second.release();
    assert.equal(await joining, 'second');
    assert.equal(await newer, 'second');
  });

  it('does not share a load between two pages, nor between two keys, when the Kv does not answer', async () => {
    const down = async () => {
      throw new KvError('the store is down');
    };
    const broken: Kv = { ...kv, get: down, set: down, incr: down };

    const results = await Promise.all([
      cached(broken, PAGE, 'k', async () => 'pricing k'),
      cached(broken, OTHER_PAGE, 'k', async () => 'features k'),
      cached(broken, PAGE, 'other', async () => 'pricing other'),
    ]);

    assert.deepEqual(results, ['pricing k', 'features k', 'pricing other']);
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

  it('keeps the version of a page for a day, far longer than the cache window', async () => {
    // A version that expires during a slow load lets that load write a stale answer for the next reader.
    const sets: { key: string; ttl: number }[] = [];
    const recording: Kv = { ...kv, set: (key, value, ttl) => (sets.push({ key, ttl }), kv.set(key, value, ttl)) };

    await invalidate(recording, PAGE);

    assert.deepEqual(sets, [{ key: `fruitback:page:${PAGE}`, ttl: 24 * 60 * 60 * 1000 }]);
    assert.equal(PAGE_VERSION_TTL_MS, 86_400_000);
    assert.ok(PAGE_VERSION_TTL_MS > CACHE_TTL_MS * 100);
  });

  it('writes a new version each time', async () => {
    const versions: string[] = [];
    const recording: Kv = { ...kv, set: (key, value, ttl) => (versions.push(value), kv.set(key, value, ttl)) };

    await invalidate(recording, PAGE);
    await invalidate(recording, PAGE);

    assert.equal(versions.length, 2);
    assert.notEqual(versions[0], versions[1]);
  });

  it('rejects when the Kv does not answer, so the caller knows the page is not invalidated', async () => {
    const down = async () => {
      throw new KvError('the store is down');
    };

    await assert.rejects(invalidate({ ...kv, set: down }, PAGE), KvError);
  });
});
