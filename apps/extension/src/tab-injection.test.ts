import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BRIDGE_FILE, PAGE_FILE, publicPath } from './registration.ts';
import { injectIntoOpenTabs, type ScriptFile } from './tab-injection.ts';

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
