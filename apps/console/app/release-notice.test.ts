import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { dismissRelease, dismissedRelease, releaseToAnnounce } from './release-notice.ts';

const release = { version: '0.7.0', url: 'https://github.com/sakuga-software/fruitback/releases/tag/v0.7.0' };

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

function memoryStorage(): Storage {
  const kept = new Map<string, string>();

  return {
    getItem: (key) => kept.get(key) ?? null,
    setItem: (key, value) => void kept.set(key, value),
  } as Storage;
}

describe('the banner of a newer release (FRU-520)', () => {
  it('says a release until this browser dismisses that version, and says the next one', () => {
    assert.deepEqual(releaseToAnnounce(release, null), release);
    assert.equal(releaseToAnnounce(release, '0.7.0'), null);
    assert.deepEqual(releaseToAnnounce({ ...release, version: '0.8.0' }, '0.7.0'), { ...release, version: '0.8.0' });
    assert.equal(releaseToAnnounce(null, null), null);
  });

  it('keeps the dismissed version in the storage of the browser', () => {
    (globalThis as { localStorage?: Storage }).localStorage = memoryStorage();
    assert.equal(dismissedRelease(), null);
    dismissRelease('0.7.0');
    assert.equal(dismissedRelease(), '0.7.0');
  });

  it('shows the banner when the browser refuses its storage, and throws nothing', () => {
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: () => {
        throw new Error('refused');
      },
      setItem: () => {
        throw new Error('refused');
      },
    } as unknown as Storage;
    assert.doesNotThrow(() => dismissRelease('0.7.0'));
    assert.equal(dismissedRelease(), null);
  });
});
