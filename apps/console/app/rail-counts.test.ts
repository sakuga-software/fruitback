import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

afterEach(() => mock.restoreAll());

let loads = 0;
async function loaded(): Promise<typeof import('./api.ts')> {
  loads += 1;

  return (await import(`./api.ts?rail=${loads}`)) as typeof import('./api.ts');
}

/** A worker that answers every request with `answer`. */
function answering(answer: () => Response): void {
  mock.method(globalThis, 'fetch', async () => answer());
}

describe('the read of the counts of the bar (FRU-711)', () => {
  it('keeps the counts the worker gave, and leaves out the ones it did not give', async () => {
    const api = await loaded();
    answering(() => Response.json({ sites: 4, notes: 12, failing: 2, views: { assigned: 4 } }));
    assert.deepEqual(await api.railCounts('ws_1'), { sites: 4, notes: 12, failing: 2, views: { assigned: 4 } });

    // A guest: no `failing`. An index that did not answer: no `notes`, no `views`.
    answering(() => Response.json({ sites: 1 }));
    assert.deepEqual(await api.railCounts('ws_1'), { sites: 1, views: {} });
  });

  it('reads a field that is not a count as no count, never as a zero', async () => {
    const api = await loaded();
    answering(() =>
      Response.json({ sites: '4', notes: -1, failing: 2.5, views: { assigned: null, other: 3, more: 1e20 } }),
    );
    assert.deepEqual(await api.railCounts('ws_1'), { views: { other: 3 } });
  });

  it('answers nothing for a refusal or a worker that does not answer, and says no session ended', async () => {
    const api = await loaded();
    let told = 0;
    api.onSignedOut(() => void (told += 1));
    for (const status of [401, 403, 404, 503]) {
      answering(() => Response.json({ error: 'a-refusal' }, { status }));
      assert.equal(await api.railCounts('ws_1'), undefined);
    }
    answering(() => {
      throw new TypeError('Failed to fetch');
    });
    assert.equal(await api.railCounts('ws_1'), undefined);
    // Quiet: the bar is not the screen, and it does not say a second time that a session ended.
    assert.equal(told, 0);
  });
});
