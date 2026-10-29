import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BRIDGE_FILE, PAGE_FILE, publicPath } from './registration.ts';
import { injectIntoOpenTabs, type ScriptFile, tabLoaded } from './tab-injection.ts';

function scripting(tabs: { id?: number }[], failOn: number[] = []) {
  const queries: string[] = [];
  const calls: string[] = [];

  return {
    queries,
    calls,
    query: async (matchPattern: string) => {
      queries.push(matchPattern);

      return tabs;
    },
    execute: async (tabId: number, file: ScriptFile, world: 'MAIN' | 'ISOLATED') => {
      if (failOn.includes(tabId)) throw new Error('Cannot access contents of the page');
      calls.push(`${tabId} ${file} ${world}`);
    },
  };
}

describe('injectIntoOpenTabs', () => {
  it('asks for the tabs on the pattern and puts the page script, then the bridge, into each', async () => {
    const fake = scripting([{ id: 1 }, { id: 2 }, {}]);

    await injectIntoOpenTabs(fake, 'https://*.staging.acme.dev');

    assert.deepEqual(fake.queries, ['https://*.staging.acme.dev/*']);
    assert.deepEqual(fake.calls, [
      `1 ${publicPath(PAGE_FILE)} MAIN`,
      `2 ${publicPath(PAGE_FILE)} MAIN`,
      `1 ${publicPath(BRIDGE_FILE)} ISOLATED`,
      `2 ${publicPath(BRIDGE_FILE)} ISOLATED`,
    ]);
  });

  it('keeps going past a tab the browser refuses, and never rejects', async () => {
    const fake = scripting([{ id: 1 }, { id: 2 }], [1]);

    await injectIntoOpenTabs(fake, 'https://acme.dev');

    assert.deepEqual(fake.calls, [`2 ${publicPath(PAGE_FILE)} MAIN`, `2 ${publicPath(BRIDGE_FILE)} ISOLATED`]);
    await injectIntoOpenTabs(
      {
        query: async () => {
          throw new Error('no permission');
        },
        execute: async () => undefined,
      },
      'https://acme.dev',
    );
  });
});

describe('tabLoaded waits for the load of a tab that just opened (FRU-486)', () => {
  function tabs(status: string | undefined, failGet = false) {
    const listeners = new Set<(tabId: number, change: { status?: string }) => void>();

    return {
      listeners,
      fire: (tabId: number, change: { status?: string }) => {
        for (const listener of [...listeners]) listener(tabId, change);
      },
      get: async () => {
        if (failGet) throw new Error('No tab with id');

        return { status };
      },
      onUpdated: {
        addListener: (listener: (tabId: number, change: { status?: string }) => void) => void listeners.add(listener),
        removeListener: (listener: (tabId: number, change: { status?: string }) => void) =>
          void listeners.delete(listener),
      },
    };
  }

  it('resolves at the load of that tab, not of another one, and stops listening', async () => {
    const seam = tabs('loading');
    let resolved = false;
    const loaded = tabLoaded(seam, 7).then(() => (resolved = true));
    await new Promise((resolve) => setImmediate(resolve));
    seam.fire(8, { status: 'complete' });
    seam.fire(7, { status: 'loading' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(resolved, false);
    seam.fire(7, { status: 'complete' });
    await loaded;
    assert.equal(seam.listeners.size, 0);
  });

  it('resolves at once for a tab that loaded already, or that is gone', async () => {
    const loaded = tabs('complete');
    await tabLoaded(loaded, 7);
    assert.equal(loaded.listeners.size, 0);
    const gone = tabs(undefined, true);
    await tabLoaded(gone, 7);
    assert.equal(gone.listeners.size, 0);
  });

  it('resolves after its time when the tab never says it loaded', async () => {
    const seam = tabs('loading');
    await tabLoaded(seam, 7, 20);
    assert.equal(seam.listeners.size, 0);
  });
});
