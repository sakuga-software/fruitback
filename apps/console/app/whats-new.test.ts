import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import { CONSOLE_VERSION, RELEASES, hasNews, markSeen, seenVersion } from './whats-new.ts';

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

describe('« What’s new » at the foot of the bar (FRU-684)', () => {
  it('has its dot until this browser opened it with this version, and again with the next one', () => {
    assert.equal(hasNews('0.7.0', null), true);
    assert.equal(hasNews('0.7.0', '0.7.0'), false);
    assert.equal(hasNews('0.8.0', '0.7.0'), true);
    // No version written in the build: no dot that nothing can take away.
    assert.equal(hasNews(undefined, null), false);
  });

  it('keeps the version it was opened with in the storage of the browser', () => {
    (globalThis as { localStorage?: Storage }).localStorage = memoryStorage();
    assert.equal(seenVersion(), null);
    markSeen('0.7.0');
    assert.equal(seenVersion(), '0.7.0');
  });

  it('shows the dot when the browser refuses its storage, and throws nothing', () => {
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: () => {
        throw new Error('refused');
      },
      setItem: () => {
        throw new Error('refused');
      },
    } as unknown as Storage;
    assert.equal(seenVersion(), null);
    assert.doesNotThrow(() => markSeen('0.7.0'));
  });

  it('leads to the releases of the public repository, and the build writes the version of the console', () => {
    assert.equal(RELEASES, 'https://github.com/sakuga-software/fruitback/releases');
    // `node --test` builds nothing: the version is absent here, and Vite writes the one of `package.json`.
    assert.equal(CONSOLE_VERSION, undefined);
    const config = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
    assert.match(config, /__FRUITBACK_CONSOLE_VERSION__: JSON\.stringify\(version\)/);
  });
});
