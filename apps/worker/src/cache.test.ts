import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CACHE_TTL_MS, cached, resetCacheState } from './cache.ts';

const NOW = 1_770_000_000_000;

beforeEach(() => {
  resetCacheState();
});

describe('cached', () => {
  it('loads once and serves the same value within the window', async () => {
    let loads = 0;
    const load = async () => {
      loads += 1;
      return loads;
    };

    assert.equal(await cached('page', load, NOW), 1);
    assert.equal(await cached('page', load, NOW + CACHE_TTL_MS - 1), 1);
    assert.equal(loads, 1);
  });

  it('reloads once the entry has expired', async () => {
    let loads = 0;
    const load = async () => {
      loads += 1;
      return loads;
    };

    await cached('page', load, NOW);
    assert.equal(await cached('page', load, NOW + CACHE_TTL_MS), 2);
  });

  it('keeps keys apart', async () => {
    assert.equal(await cached('a', async () => 'first', NOW), 'first');
    assert.equal(await cached('b', async () => 'second', NOW), 'second');
  });

  it('collapses concurrent misses into a single load', async () => {
    // Ten visitors opening the same page at once must cost one Linear call, not ten.
    let loads = 0;
    const load = async () => {
      loads += 1;
      return loads;
    };

    const results = await Promise.all(Array.from({ length: 10 }, () => cached('page', load, NOW)));

    assert.deepEqual(
      results,
      Array.from({ length: 10 }, () => 1),
    );
    assert.equal(loads, 1);
  });

  it('does not serve a failure for the rest of the window', async () => {
    // An outage that lasted a second must not blank out the pins for fifteen.
    let loads = 0;
    const load = async () => {
      loads += 1;
      if (loads === 1) throw new Error('Linear is down');
      return 'recovered';
    };

    await assert.rejects(cached('page', load, NOW));
    assert.equal(await cached('page', load, NOW), 'recovered');
  });
});
