import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { storage } from './session-storage.fixture.ts';

/**
 * `requestWorkerAccess` on a fake `chrome.permissions` (FRU-511). `wxt/browser` reads
 * `globalThis.chrome` when it is imported, so the global is set before the import.
 */
const asked: unknown[] = [];
(globalThis as { chrome?: unknown }).chrome = {
  runtime: { id: 'fruitback' },
  storage: { local: storage().area, session: storage().area },
  permissions: {
    request: async (wanted: unknown) => {
      asked.push(wanted);

      return true;
    },
  },
};
const { requestWorkerAccess } = await import('./connect-browser.ts');

describe('the access to a worker, asked in the click (FRU-511)', () => {
  it('asks for the origin of the worker alone, before anything is awaited', async () => {
    const granted = requestWorkerAccess('https://api.fruitback.test/v1');
    // Asked in the same turn as the click: the gesture is still there.
    assert.deepEqual(asked, [{ origins: ['https://api.fruitback.test/*'] }]);
    assert.equal(await granted, true);
  });

  it('rejects, and does not throw in the click, on an endpoint that does not parse', async () => {
    let answer: Promise<boolean> | undefined;
    assert.doesNotThrow(() => {
      answer = requestWorkerAccess('not an address');
    });
    await assert.rejects(answer as Promise<boolean>);
  });
});
