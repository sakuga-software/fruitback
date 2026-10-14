import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { AccountStore } from './accounts.ts';
import { REMEMBER_MS, dayOf, forgetSeen, forgetSeenOf, seen } from './last-seen.ts';

/** A store that counts the days it is asked to write. Nothing else of it is called. */
function counting(): { store: AccountStore; written: string[] } {
  const written: string[] = [];
  const store = {
    markSeen: async (workspace: string, account: string, day: string) => {
      written.push(`${workspace} ${account} ${day}`);
    },
  } as unknown as AccountStore;

  return { store, written };
}

const NOON = Date.UTC(2026, 9, 14, 12, 0, 0);

describe('the day a member was last seen, as one process writes it (FRU-249)', () => {
  beforeEach(() => forgetSeen());

  it('writes the day of UTC, and not again within ten minutes of the same day', async () => {
    const { store, written } = counting();

    await seen(store, 'ws_acme', 'acc_alice', NOON);
    await seen(store, 'ws_acme', 'acc_alice', NOON + REMEMBER_MS - 1);

    assert.deepEqual(written, ['ws_acme acc_alice 2026-10-14']);
    assert.equal(dayOf(NOON), '2026-10-14');
  });

  it('writes again after ten minutes, so a membership made again on another replica is seen', async () => {
    const { store, written } = counting();

    await seen(store, 'ws_acme', 'acc_alice', NOON);
    // The member left and came back the same day, and another replica handled the departure: this
    // process was told nothing, and writes again once its memory is older than ten minutes.
    await seen(store, 'ws_acme', 'acc_alice', NOON + REMEMBER_MS);

    assert.equal(written.length, 2);
  });

  it('writes again at once when this process saw the departure, and on a new day', async () => {
    const { store, written } = counting();

    await seen(store, 'ws_acme', 'acc_alice', NOON);
    forgetSeenOf('ws_acme', 'acc_alice');
    await seen(store, 'ws_acme', 'acc_alice', NOON + 1);
    await seen(store, 'ws_acme', 'acc_alice', NOON + 12 * 60 * 60 * 1000);

    assert.deepEqual(written, [
      'ws_acme acc_alice 2026-10-14',
      'ws_acme acc_alice 2026-10-14',
      'ws_acme acc_alice 2026-10-15',
    ]);
  });

  it('keeps people and workspaces apart', async () => {
    const { store, written } = counting();

    await seen(store, 'ws_acme', 'acc_alice', NOON);
    await seen(store, 'ws_acme', 'acc_bob', NOON);
    await seen(store, 'ws_other', 'acc_alice', NOON);

    assert.equal(written.length, 3);
  });
});
