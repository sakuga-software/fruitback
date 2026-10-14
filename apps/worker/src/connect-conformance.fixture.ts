import assert from 'node:assert/strict';
import type { Declare } from './conformance.fixture.ts';
import type { ConnectStore } from './connect.ts';
import type { Database } from './postgres.ts';
import { rowsOf } from './postgres.fixture.ts';

/**
 * What the store of the requests of the extension promises (FRU-238), state by state, with the
 * instant of each call given: the store never reads its clock.
 *
 * `connect-postgres.test.ts` runs these cases on PGlite and on a server, and on stores that break one
 * rule each: every case has a store that fails it, on an assertion of the case.
 *
 * A case reads the rows of its database to see the sessions a claim wrote: `database` is the one the
 * store is on.
 */

export const NOW = 1_800_000_000_000;
export const TTL = 15 * 60 * 1000;
export const ALICE = 'acc_alice';
export const BOB = 'acc_bob';

/** A request, made at `now`, with digests named after `name`. */
export async function made(
  store: ConnectStore,
  name: string,
  at: number = NOW,
  more: { maxLive?: number; browser?: string } = {},
): Promise<{ requestHash: string; claimHash: string }> {
  const requestHash = `digest-of-request-${name}`;
  const claimHash = `digest-of-claim-${name}`;
  const created = await store.createRequest({
    requestHash,
    claimHash,
    word: 'PLUM 47',
    browser: more.browser ?? 'Chrome on macOS',
    now: at,
    expiresAt: at + TTL,
    maxLive: more.maxLive ?? 1000,
  });
  assert.equal(created, 'created');

  return { requestHash, claimHash };
}

/** A claim of the request, opening a session for whatever account approved it. */
export function claimed(
  store: ConnectStore,
  claimHash: string,
  at: number,
  token = `digest-of-token-at-${at}-${Math.random()}`,
  open: (account: string) => Promise<{ name?: string; email?: string } | undefined> = async () => ({
    name: 'Alice Martin',
    email: 'alice@acme.dev',
  }),
) {
  return store.claim({
    claimHash,
    now: at,
    tokenHash: token,
    connectionId: `connection-${token.slice(-12)}`,
    expiresAt: at + 30 * 24 * 60 * 60 * 1000,
    open,
  });
}

export type ConnectSubject = { store: ConnectStore; database: Database };

export function connectCases(it: Declare<ConnectSubject>): void {
  it('keeps a request as it was made, and reads it by the digest of its id only', async ({ store }) => {
    const { requestHash, claimHash } = await made(store, 'one', NOW, { browser: 'Firefox on Linux' });

    assert.deepEqual(await store.readRequest(requestHash), {
      word: 'PLUM 47',
      browser: 'Firefox on Linux',
      createdAt: NOW,
      expiresAt: NOW + TTL,
      misses: 0,
    });
    // The claim is not a name of the request: whoever holds only the claim reads nothing here.
    assert.equal(await store.readRequest(claimHash), undefined);
    assert.equal(await store.readRequest('digest-of-request-nobody'), undefined);
  });

  it('answers a request once: a second answer of either kind, by anybody, changes nothing', async ({ store }) => {
    const { requestHash } = await made(store, 'one');

    assert.deepEqual(await store.answer({ requestHash, account: ALICE, outcome: 'approved', now: NOW + 1 }), {
      ok: true,
    });
    for (const [account, outcome] of [
      [ALICE, 'approved'],
      [BOB, 'approved'],
      [ALICE, 'refused'],
      [BOB, 'refused'],
    ] as const) {
      assert.deepEqual(await store.answer({ requestHash, account, outcome, now: NOW + 2 }), {
        ok: false,
        reason: 'already',
      });
    }
    const row = await store.readRequest(requestHash);
    assert.deepEqual([row?.outcome, row?.account, row?.answeredAt], ['approved', ALICE, NOW + 1]);
    assert.deepEqual(
      await store.answer({ requestHash: 'digest-of-nothing', account: BOB, outcome: 'approved', now: NOW }),
      {
        ok: false,
        reason: 'unknown',
      },
    );
  });

  /**
   * On a store that waits between its read and its write, two answers interleave, and this case is
   * what refuses a read followed by a write.
   */
  it('gives one answer to an approval and a refusal at the same moment', async ({ store }) => {
    const { requestHash } = await made(store, 'one');

    const answers = await Promise.all([
      store.answer({ requestHash, account: ALICE, outcome: 'approved', now: NOW + 1 }),
      store.answer({ requestHash, account: BOB, outcome: 'refused', now: NOW + 1 }),
      store.answer({ requestHash, account: BOB, outcome: 'approved', now: NOW + 1 }),
    ]);

    assert.equal(answers.filter((answer) => answer.ok).length, 1, JSON.stringify(answers));
    const row = await store.readRequest(requestHash);
    const winner = answers.findIndex((answer) => answer.ok);
    assert.deepEqual(
      [row?.outcome, row?.account],
      [
        ['approved', ALICE],
        ['refused', BOB],
        ['approved', BOB],
      ][winner],
    );
  });

  it('refuses an answer at the expiry of the request, and after', async ({ store }) => {
    const late = await made(store, 'late');
    const later = await made(store, 'later');
    const inTime = await made(store, 'in-time');

    assert.deepEqual(
      await store.answer({ requestHash: late.requestHash, account: ALICE, outcome: 'approved', now: NOW + TTL }),
      { ok: false, reason: 'expired' },
    );
    assert.deepEqual(
      await store.answer({ requestHash: later.requestHash, account: ALICE, outcome: 'refused', now: NOW + TTL + 1 }),
      { ok: false, reason: 'expired' },
    );
    assert.deepEqual(
      await store.answer({ requestHash: inTime.requestHash, account: ALICE, outcome: 'approved', now: NOW + TTL - 1 }),
      { ok: true },
    );
    assert.equal((await store.readRequest(late.requestHash))?.outcome, undefined);
  });

  it('answers pending before an answer and refused after a refusal, and writes no session for either', async ({
    store,
    database,
  }) => {
    const { requestHash, claimHash } = await made(store, 'one');

    assert.deepEqual(await claimed(store, claimHash, NOW + 1), { state: 'pending' });
    await store.answer({ requestHash, account: ALICE, outcome: 'refused', now: NOW + 2 });
    assert.deepEqual(await claimed(store, claimHash, NOW + 3), { state: 'refused' });
    // A refused request stays refused: an approval after it changes nothing, and no claim opens it.
    assert.deepEqual(await store.answer({ requestHash, account: ALICE, outcome: 'approved', now: NOW + 4 }), {
      ok: false,
      reason: 'already',
    });
    assert.deepEqual(await claimed(store, claimHash, NOW + 5), { state: 'refused' });
    assert.deepEqual(await rowsOf(database, 'SELECT token_hash FROM sessions'), []);
  });

  it('claims an approved request once, and writes a session of the account, of no workspace', async ({
    store,
    database,
  }) => {
    const { requestHash, claimHash } = await made(store, 'one', NOW, { browser: 'Safari on iOS' });
    await store.answer({ requestHash, account: ALICE, outcome: 'approved', now: NOW + 1 });

    assert.deepEqual(await claimed(store, claimHash, NOW + 2, 'digest-of-the-first-token'), {
      state: 'claimed',
      account: ALICE,
      browser: 'Safari on iOS',
    });
    assert.deepEqual(await claimed(store, claimHash, NOW + 3, 'digest-of-a-second-token'), { state: 'gone' });

    assert.deepEqual(
      await rowsOf(
        database,
        'SELECT token_hash, subject, name, email, workspace, account_id, browser, created_at::text AS created FROM sessions',
      ),
      [
        {
          token_hash: 'digest-of-the-first-token',
          subject: ALICE,
          name: 'Alice Martin',
          email: 'alice@acme.dev',
          workspace: null,
          account_id: ALICE,
          browser: 'Safari on iOS',
          created: String(NOW + 2),
        },
      ],
    );
    assert.equal((await store.readRequest(requestHash))?.claimedAt, NOW + 2);
  });

  /**
   * On a store that waits between its read and its write, two claims interleave, and this case is
   * what refuses a read followed by a write.
   */
  it('gives one session to two claims of one request at the same moment', async ({ store }) => {
    const { requestHash, claimHash } = await made(store, 'one');
    await store.answer({ requestHash, account: ALICE, outcome: 'approved', now: NOW + 1 });

    const answers = await Promise.all(
      ['a', 'b', 'c'].map((each) => claimed(store, claimHash, NOW + 2, `digest-of-token-${each}`)),
    );

    assert.equal(answers.filter((answer) => answer.state === 'claimed').length, 1, JSON.stringify(answers));
    // Read through the store: a planted race on a server builds the store alone, with no database.
    assert.equal((await store.browsersOf(ALICE, NOW + 3)).length, 1);
  });

  it('refuses a claim at the expiry of the request, approved or not', async ({ store, database }) => {
    const approved = await made(store, 'approved');
    const waiting = await made(store, 'waiting');
    const inTime = await made(store, 'in-time');
    await store.answer({ requestHash: approved.requestHash, account: ALICE, outcome: 'approved', now: NOW + 1 });
    await store.answer({ requestHash: inTime.requestHash, account: ALICE, outcome: 'approved', now: NOW + 1 });

    assert.deepEqual(await claimed(store, approved.claimHash, NOW + TTL), { state: 'gone' });
    assert.deepEqual(await claimed(store, approved.claimHash, NOW + TTL + 1), { state: 'gone' });
    assert.deepEqual(await claimed(store, waiting.claimHash, NOW + TTL), { state: 'gone' });
    assert.equal((await rowsOf(database, 'SELECT token_hash FROM sessions')).length, 0);
    assert.equal((await claimed(store, inTime.claimHash, NOW + TTL - 1)).state, 'claimed');
  });

  /**
   * The reason the claim and the session are one transaction: a session that cannot be written must
   * not spend the only claim the extension has. The failure is a real one: a token digest already on
   * file.
   */
  it('leaves the request to claim when the session cannot be written', async ({ store }) => {
    const first = await made(store, 'first');
    const second = await made(store, 'second');
    for (const { requestHash } of [first, second]) {
      await store.answer({ requestHash, account: ALICE, outcome: 'approved', now: NOW + 1 });
    }
    assert.equal((await claimed(store, first.claimHash, NOW + 2, 'digest-taken')).state, 'claimed');

    await assert.rejects(() => claimed(store, second.claimHash, NOW + 3, 'digest-taken'));

    assert.equal((await store.readRequest(second.requestHash))?.claimedAt, undefined);
    assert.equal((await claimed(store, second.claimHash, NOW + 4, 'digest-free')).state, 'claimed');
  });

  it('opens nothing for an account that is gone at the claim', async ({ store, database }) => {
    const { requestHash, claimHash } = await made(store, 'one');
    await store.answer({ requestHash, account: ALICE, outcome: 'approved', now: NOW + 1 });

    assert.deepEqual(await claimed(store, claimHash, NOW + 2, 'digest-of-a-token', async () => undefined), {
      state: 'gone',
    });
    assert.deepEqual(await rowsOf(database, 'SELECT token_hash FROM sessions'), []);
  });

  it('counts the wrong words of a waiting request, and refuses it at the last one allowed', async ({ store }) => {
    const { requestHash, claimHash } = await made(store, 'one');

    assert.equal(await store.miss(requestHash, NOW + 1, 3), 2);
    assert.equal(await store.miss(requestHash, NOW + 2, 3), 1);
    assert.equal((await store.readRequest(requestHash))?.outcome, undefined);
    assert.equal(await store.miss(requestHash, NOW + 3, 3), 0);

    const row = await store.readRequest(requestHash);
    assert.deepEqual([row?.outcome, row?.account, row?.misses], ['refused', undefined, 3]);
    assert.equal(await store.miss(requestHash, NOW + 4, 3), undefined);
    assert.deepEqual(await store.answer({ requestHash, account: ALICE, outcome: 'approved', now: NOW + 5 }), {
      ok: false,
      reason: 'already',
    });
    assert.deepEqual(await claimed(store, claimHash, NOW + 6), { state: 'refused' });
  });

  it('refuses a request at the last word allowed when the words come at the same moment', async ({ store }) => {
    const { requestHash } = await made(store, 'one');

    const left = await Promise.all([1, 2, 3, 4, 5, 6].map(() => store.miss(requestHash, NOW + 1, 3)));

    assert.deepEqual(
      left.filter((each) => each !== undefined).sort(),
      [0, 1, 2],
      `more words were counted than allowed: ${JSON.stringify(left)}`,
    );
    assert.equal((await store.readRequest(requestHash))?.outcome, 'refused');
  });

  it('stops at the requests allowed to wait, and counts no answered, claimed or expired one', async ({ store }) => {
    const answered = await made(store, 'answered', NOW, { maxLive: 3 });
    await made(store, 'expired', NOW - TTL, { maxLive: 3 });
    await made(store, 'waiting', NOW, { maxLive: 3 });
    await store.answer({ requestHash: answered.requestHash, account: ALICE, outcome: 'refused', now: NOW });
    await made(store, 'second-waiting', NOW, { maxLive: 3 });
    await made(store, 'third-waiting', NOW, { maxLive: 3 });

    assert.equal(
      await store.createRequest({
        requestHash: 'digest-of-request-one-too-many',
        claimHash: 'digest-of-claim-one-too-many',
        word: 'PEAR 01',
        browser: 'A browser',
        now: NOW,
        expiresAt: NOW + TTL,
        maxLive: 3,
      }),
      'busy',
    );
    assert.equal(await store.readRequest('digest-of-request-one-too-many'), undefined);
  });

  it('lists the browsers of an account, one by connection, live ones only, and of no other account', async ({
    store,
  }) => {
    const connect = async (name: string, account: string, browser: string, at: number) => {
      const { requestHash, claimHash } = await made(store, name, at, { browser });
      await store.answer({ requestHash, account, outcome: 'approved', now: at });
      const answer = await store.claim({
        claimHash,
        now: at,
        tokenHash: `digest-of-token-${name}`,
        connectionId: `connection-${name}`,
        expiresAt: at + 1000,
        open: async () => ({}),
      });
      assert.equal(answer.state, 'claimed');
    };
    await connect('chrome', ALICE, 'Chrome on macOS', NOW);
    await connect('firefox', ALICE, 'Firefox on Linux', NOW + 10);
    await connect('bobs', BOB, 'Edge on Windows', NOW + 20);
    await connect('short', ALICE, 'Arc on macOS', NOW - 2000);

    assert.deepEqual(await store.browsersOf(ALICE, NOW + 100), [
      { id: 'connection-firefox', browser: 'Firefox on Linux', connectedAt: NOW + 10, usedAt: NOW + 10 },
      { id: 'connection-chrome', browser: 'Chrome on macOS', connectedAt: NOW, usedAt: NOW },
    ]);
    assert.deepEqual(await store.browsersOf('acc_nobody', NOW), []);
  });

  it('ends a connection of its own account only, every token of it, and says when it ended none', async ({
    store,
    database,
  }) => {
    const { requestHash, claimHash } = await made(store, 'one');
    await store.answer({ requestHash, account: ALICE, outcome: 'approved', now: NOW });
    await store.claim({
      claimHash,
      now: NOW,
      tokenHash: 'digest-of-the-token',
      connectionId: 'connection-of-alice',
      expiresAt: NOW + 1000,
      open: async () => ({}),
    });

    assert.equal(await store.endBrowser(BOB, 'connection-of-alice', NOW + 1), false);
    assert.deepEqual(await rowsOf(database, 'SELECT revoked_at FROM sessions'), [{ revoked_at: null }]);
    assert.equal(await store.endBrowser(ALICE, 'connection-of-alice', NOW + 1), true);
    assert.equal(await store.endBrowser(ALICE, 'connection-of-alice', NOW + 2), false);
    assert.deepEqual(await store.browsersOf(ALICE, NOW + 3), []);
    assert.deepEqual(await rowsOf(database, 'SELECT revoked_at::text AS revoked FROM sessions'), [
      { revoked: String(NOW + 1) },
    ]);
  });

  it('drops the requests that expired, and none that lives', async ({ store }) => {
    const old = await made(store, 'old', NOW - TTL);
    const live = await made(store, 'live', NOW);

    await store.purge(NOW);

    assert.equal(await store.readRequest(old.requestHash), undefined);
    assert.notEqual(await store.readRequest(live.requestHash), undefined);
    // And a claim of a request that is gone opens nothing.
    assert.deepEqual(await claimed(store, old.claimHash, NOW), { state: 'gone' });
  });
}
