import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { refresh } from './session-of-before.ts';

afterEach(() => mock.restoreAll());

/**
 * The session of before (FRU-98), for a worker that does not serve better-auth yet. FRU-150 removes
 * it, with this file.
 */
describe('the refresh of the session of before', () => {
  it('answers signed out when the worker does not answer, and does not reject', async () => {
    mock.method(globalThis, 'fetch', async () => {
      throw new TypeError('Failed to fetch');
    });

    assert.equal(await refresh(), false);
  });

  it('spends the cookie once for two callers at the same moment', async () => {
    const fetched = mock.method(globalThis, 'fetch', async () => Response.json({ accessToken: 'a-token' }));

    assert.deepEqual(await Promise.all([refresh(), refresh()]), [true, true]);
    assert.equal(fetched.mock.calls.length, 1);
  });
});
