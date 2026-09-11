import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SeedStage } from '@fruitback/shared';
import { CONFIG_STORAGE_KEY, createConfigStore, type WidgetConfig } from './config.ts';

const DEFAULTS: WidgetConfig = {
  endpoint: 'http://localhost:8788',
  clientId: 'playground',
  hiddenStages: [],
  screenshot: false,
};

/** Enough of `Storage` for the store, plus a way to make it misbehave. */
function fakeStorage(seed: Record<string, string> = {}): Storage & { throwOnWrite?: boolean } {
  const map = new Map(Object.entries(seed));

  return {
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem(key: string, value: string) {
      if ((this as { throwOnWrite?: boolean }).throwOnWrite === true) throw new Error('quota');
      map.set(key, value);
    },
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
  } as Storage;
}

describe('a config the caller owns', () => {
  /**
   * The store's key lives in the page's own `localStorage`, and the page can write it. For an
   * ordinary embed that is the feature. For the extension it is not: the endpoint comes from the
   * reviewer's popup, and a stored one winning would route the notes somewhere nobody chose.
   */
  it('does not let a stored value replace a pinned one', () => {
    const storage = fakeStorage({
      'fruitback:config:extension': JSON.stringify({ endpoint: 'https://evil.test', clientId: 'theirs' }),
    });

    const store = createConfigStore({
      defaults: DEFAULTS,
      storage,
      key: 'fruitback:config:extension',
      pinned: ['endpoint', 'clientId'],
    });

    assert.equal(store.get().endpoint, DEFAULTS.endpoint);
    assert.equal(store.get().clientId, DEFAULTS.clientId);
  });

  it('still restores the preferences that are not pinned', () => {
    const storage = fakeStorage({
      'fruitback:config:extension': JSON.stringify({ endpoint: 'https://evil.test', hiddenStages: ['composted'] }),
    });

    const store = createConfigStore({
      defaults: DEFAULTS,
      storage,
      key: 'fruitback:config:extension',
      pinned: ['endpoint', 'clientId'],
    });

    assert.deepEqual(store.get().hiddenStages, ['composted']);
  });

  it('restores everything when nothing is pinned, which is what an ordinary embed wants', () => {
    const storage = fakeStorage({
      [CONFIG_STORAGE_KEY]: JSON.stringify({ endpoint: 'https://theirs.test' }),
    });

    assert.equal(createConfigStore({ defaults: DEFAULTS, storage }).get().endpoint, 'https://theirs.test');
  });
});

describe('createConfigStore', () => {
  it('starts from the defaults when nothing was ever stored', () => {
    const store = createConfigStore({ defaults: DEFAULTS, storage: fakeStorage() });

    assert.deepEqual(store.get(), DEFAULTS);
  });

  it('persists a change and reads it back into the next store', () => {
    const storage = fakeStorage();
    createConfigStore({ defaults: DEFAULTS, storage }).set({
      clientId: 'acme',
      hiddenStages: ['composted'],
      screenshot: false,
    });

    const next = createConfigStore({ defaults: DEFAULTS, storage });

    assert.equal(next.get().clientId, 'acme');
    assert.deepEqual(next.get().hiddenStages, ['composted']);
    // Untouched fields still come from the defaults rather than from an empty string.
    assert.equal(next.get().endpoint, DEFAULTS.endpoint);
  });

  it('tells its listeners, and stops when they unsubscribe', () => {
    const store = createConfigStore({ defaults: DEFAULTS, storage: fakeStorage() });
    const seen: string[] = [];
    const stop = store.subscribe((config) => seen.push(config.clientId));

    store.set({ clientId: 'one' });
    stop();
    store.set({ clientId: 'two' });

    assert.deepEqual(seen, ['one']);
  });

  it('ignores a stored value someone edited into nonsense', () => {
    // This is a string a human can reach in devtools, so it is parsed the way a seed is: a bad one
    // costs the reporter their preferences, never the widget.
    const storage = fakeStorage({
      [CONFIG_STORAGE_KEY]: JSON.stringify({ endpoint: 42, clientId: 'acme', hiddenStages: ['ripe', 'banana'] }),
    });

    const store = createConfigStore({ defaults: DEFAULTS, storage });

    assert.equal(store.get().endpoint, DEFAULTS.endpoint, 'a number is not an endpoint');
    assert.equal(store.get().clientId, 'acme');
    assert.deepEqual(store.get().hiddenStages, ['ripe'], 'and `banana` is not a stage');
  });

  it('survives a storage that is not JSON at all', () => {
    const store = createConfigStore({
      defaults: DEFAULTS,
      storage: fakeStorage({ [CONFIG_STORAGE_KEY]: 'not json' }),
    });

    assert.deepEqual(store.get(), DEFAULTS);
  });

  it('keeps working when the browser refuses to store anything', () => {
    // Safari in private browsing throws on write. The preference has to apply to this page even when
    // it cannot outlive it.
    const storage = fakeStorage();
    (storage as { throwOnWrite?: boolean }).throwOnWrite = true;
    const store = createConfigStore({ defaults: DEFAULTS, storage });

    store.set({ clientId: 'acme' });

    assert.equal(store.get().clientId, 'acme');
  });

  it('runs with no storage at all', () => {
    const store = createConfigStore({ defaults: DEFAULTS, storage: null });

    store.set({ clientId: 'acme' });

    assert.equal(store.get().clientId, 'acme');
  });
});

describe('the config is nobody else’s to mutate', () => {
  it('does not alias the array it was given', () => {
    // The caller keeps their array and pushes to it later. Without a copy, the store's state would
    // change with nothing persisted and nobody told.
    const store = createConfigStore({ defaults: DEFAULTS, storage: fakeStorage() });
    const stages: SeedStage[] = ['ripe'];

    store.set({ hiddenStages: stages });
    stages.push('composted');

    assert.deepEqual(store.get().hiddenStages, ['ripe']);
  });

  it('refuses a write to what `get` handed out, loudly', () => {
    // Frozen rather than copied on the way out: `get` runs once per pin, and a silent no-op would be
    // worse than a `TypeError` at the line that made the mistake.
    const store = createConfigStore({ defaults: DEFAULTS, storage: fakeStorage() });
    const config = store.get();

    assert.throws(() => {
      (config as { endpoint: string }).endpoint = 'https://elsewhere.test';
    }, TypeError);
    assert.throws(() => (config.hiddenStages as SeedStage[]).push('ripe'), TypeError);
    assert.equal(store.get().endpoint, DEFAULTS.endpoint);
  });
});
