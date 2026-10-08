import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SeedStage } from '@fruitback/shared';
import { CONFIG_STORAGE_KEY, createConfigStore, type WidgetConfig } from './config.ts';

const DEFAULTS: WidgetConfig = {
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

describe('what a stored config cannot say (FRU-89)', () => {
  /**
   * The key lives in the `localStorage` of the page, and the page can write it. The worker and the
   * client id are the word of the caller of `init`, so the store does not hold them at all.
   */
  it('does not read a stored endpoint or client id, under any key', () => {
    for (const key of [CONFIG_STORAGE_KEY, 'fruitback:config:extension']) {
      const storage = fakeStorage({
        [key]: JSON.stringify({ endpoint: 'https://evil.test', clientId: 'theirs', hiddenStages: ['composted'] }),
      });

      const config = createConfigStore({ defaults: DEFAULTS, storage, key }).get();

      assert.deepEqual(config, { hiddenStages: ['composted'], screenshot: false });
    }
  });

  it('writes the preferences only, so a config stored before loses its routing on the next change', () => {
    const storage = fakeStorage({
      [CONFIG_STORAGE_KEY]: JSON.stringify({ endpoint: 'https://old.test', clientId: 'old', hiddenStages: [] }),
    });

    createConfigStore({ defaults: DEFAULTS, storage }).set({ screenshot: true });

    assert.deepEqual(JSON.parse(storage.getItem(CONFIG_STORAGE_KEY) ?? '{}'), { hiddenStages: [], screenshot: true });
  });
});

describe('createConfigStore', () => {
  it('starts from the defaults when nothing was ever stored', () => {
    const store = createConfigStore({ defaults: DEFAULTS, storage: fakeStorage() });

    assert.deepEqual(store.get(), DEFAULTS);
  });

  it('persists a change and reads it back into the next store', () => {
    const storage = fakeStorage();
    createConfigStore({ defaults: DEFAULTS, storage }).set({ hiddenStages: ['composted'] });

    const next = createConfigStore({ defaults: { ...DEFAULTS, screenshot: true }, storage });

    assert.deepEqual(next.get().hiddenStages, ['composted']);
    // The whole config was written, so the stored `screenshot` wins over the new default.
    assert.equal(next.get().screenshot, false);
  });

  it('tells its listeners, and stops when they unsubscribe', () => {
    const store = createConfigStore({ defaults: DEFAULTS, storage: fakeStorage() });
    const seen: boolean[] = [];
    const stop = store.subscribe((config) => seen.push(config.screenshot));

    store.set({ screenshot: true });
    stop();
    store.set({ screenshot: false });

    assert.deepEqual(seen, [true]);
  });

  it('ignores a stored value someone edited into nonsense', () => {
    // This is a string a human can reach in devtools, so it is parsed the way a seed is: a bad one
    // costs the reporter their preferences, never the widget.
    const storage = fakeStorage({
      [CONFIG_STORAGE_KEY]: JSON.stringify({ screenshot: 'yes', hiddenStages: ['ripe', 'banana'] }),
    });

    const store = createConfigStore({ defaults: DEFAULTS, storage });

    assert.equal(store.get().screenshot, false, 'a string is not a switch');
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

    store.set({ screenshot: true });

    assert.equal(store.get().screenshot, true);
  });

  it('runs with no storage at all', () => {
    const store = createConfigStore({ defaults: DEFAULTS, storage: null });

    store.set({ screenshot: true });

    assert.equal(store.get().screenshot, true);
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
      (config as { screenshot: boolean }).screenshot = true;
    }, TypeError);
    assert.throws(() => (config.hiddenStages as SeedStage[]).push('ripe'), TypeError);
    assert.equal(store.get().screenshot, false);
  });
});
