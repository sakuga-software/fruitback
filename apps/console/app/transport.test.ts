import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { isReachable, onReachability, reach } from './transport.ts';

// FRU-516: a screen that mounts after a call failed must read the cause at once, before any change.
describe('the reachability of the worker', () => {
  afterEach(() => mock.restoreAll());

  it('is read at once after a call with no answer, and told at once to a late listener', async () => {
    mock.method(globalThis, 'fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    assert.equal(await reach('/console/me', {}), undefined);
    assert.equal(isReachable(), false);

    const told: boolean[] = [];
    const stop = onReachability((now) => told.push(now));
    assert.deepEqual(told, [false]);
    stop();
  });

  it('is reachable again after an answer that is an error: a 500 is an answer', async () => {
    mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 500 }));
    const answered = await reach('/console/me', {});
    assert.equal(answered?.status, 500);
    assert.equal(isReachable(), true);
  });
});
