import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  ACCESS_TTL_SECONDS,
  PAIRING_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
  ROTATION_GRACE_SECONDS,
  createPairing,
  createPairingCode,
  createRefreshToken,
  digest,
  normalizePairingCode,
  redeemPairing,
  refreshSession,
  revokeSession,
} from './session.ts';
import { closeSessionConnections, createSqliteSessionStore } from './session-sqlite.ts';
import { verifyIdentityToken } from './identity.ts';

const SECRET = 'a-worker-secret-nobody-else-has';
const ALICE = { subject: 'alice', name: 'Alice Martin', email: 'alice@acme.dev' };

const directories: string[] = [];

/** A real file rather than `:memory:`, because one test reads the bytes SQLite actually wrote. */
function storeOnDisk() {
  const directory = mkdtempSync(join(tmpdir(), 'fruitback-session-'));
  directories.push(directory);
  const path = join(directory, 'sessions.db');

  return { store: createSqliteSessionStore(path), path };
}

afterEach(() => {
  closeSessionConnections();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('pairing', () => {
  it('opens a session for the person the operator named, not for whoever redeemed', async () => {
    const { store } = storeOnDisk();
    const { code } = await createPairing(store, ALICE);

    const redeemed = await redeemPairing(store, code, SECRET);

    assert.ok(redeemed.ok);
    assert.deepEqual(redeemed.session.identity, ALICE);
  });

  it('spends the code, so a second reviewer with the same code gets nothing', async () => {
    const { store } = storeOnDisk();
    const { code } = await createPairing(store, ALICE);

    assert.ok((await redeemPairing(store, code, SECRET)).ok);

    const again = await redeemPairing(store, code, SECRET);
    assert.equal(again.ok, false);
    assert.equal(again.ok === false && again.reason, 'code-spent-or-expired');
  });

  // There is deliberately no test that redeems one code concurrently. `DatabaseSync` is synchronous
  // and the store awaits nothing between its read and its write, so two redemptions cannot interleave
  // in this process — a `Promise.all` over three of them passes against a read-then-write store too,
  // which was measured. See the note on `redeemPairing` in `session-sqlite.ts`.

  it('refuses a code past its expiry', async () => {
    const { store } = storeOnDisk();
    const minted = Date.now();
    const { code } = await createPairing(store, ALICE, minted);

    const late = await redeemPairing(store, code, SECRET, minted + PAIRING_TTL_SECONDS * 1000 + 1);

    assert.equal(late.ok, false);
  });

  it('answers the same way for a code that never existed as for one already spent', async () => {
    const { store } = storeOnDisk();
    const { code } = await createPairing(store, ALICE);
    await redeemPairing(store, code, SECRET);

    const spent = await redeemPairing(store, code, SECRET);
    const invented = await redeemPairing(store, 'ZZZZ-ZZZZ-ZZZZ', SECRET);

    // Telling the two apart is how a caller enumerates which codes existed.
    assert.deepEqual(spent, invented);
  });

  it('reads a code back the way a person retypes it', async () => {
    const { store } = storeOnDisk();
    const { code } = await createPairing(store, ALICE);

    const retyped = ` ${code.toLowerCase().replaceAll('-', ' ')} `;

    assert.ok((await redeemPairing(store, retyped, SECRET)).ok);
  });

  it('maps the letters its alphabet leaves out, so a misread 1 or 0 still works', () => {
    assert.equal(normalizePairingCode('abcd-ILO1-2345'), 'ABCD11012345');
  });

  /**
   * What makes the substitution above safe rather than lossy.
   *
   * `I`, `L` and `O` are mapped onto `1` and `0`, so a code containing one of them could otherwise
   * normalise onto a *different* valid code. It cannot, because the alphabet never emits them. `U`
   * is left out of the alphabet too and is deliberately **not** substituted — it is confusable with
   * nothing, and it is absent so a random code cannot spell something unfortunate.
   */
  it('never emits a character its own normalisation would rewrite', () => {
    const drawn = Array.from({ length: 200 }, () => createPairingCode()).join('');

    assert.equal(/[ILOU]/.test(drawn), false, `the alphabet emitted a rewritten letter: ${drawn}`);
    assert.equal(normalizePairingCode(drawn), drawn.replaceAll('-', ''));
  });
});

describe('the access token', () => {
  it('is an ordinary identity token, so the read and write paths need no new check', async () => {
    const { store } = storeOnDisk();
    const { code } = await createPairing(store, ALICE);
    const redeemed = await redeemPairing(store, code, SECRET);

    assert.ok(redeemed.ok);
    const verified = await verifyIdentityToken(redeemed.session.accessToken, SECRET);

    assert.ok(verified.ok);
    // The whole point of the ticket: `verified` is the worker's word, on a session an operator opened.
    assert.deepEqual(verified.reporter, { id: 'alice', name: 'Alice Martin', email: 'alice@acme.dev', verified: true });
  });

  it('does not verify against another worker secret', async () => {
    const { store } = storeOnDisk();
    const { code } = await createPairing(store, ALICE);
    const redeemed = await redeemPairing(store, code, SECRET);

    assert.ok(redeemed.ok);
    const verified = await verifyIdentityToken(redeemed.session.accessToken, 'a-different-secret');

    assert.equal(verified.ok, false);
  });

  it('expires on its own, well before the refresh token does', async () => {
    const { store } = storeOnDisk();
    const opened = Date.now();
    const { code } = await createPairing(store, ALICE, opened);
    const redeemed = await redeemPairing(store, code, SECRET, opened);

    assert.ok(redeemed.ok);
    assert.equal(redeemed.session.expiresIn, ACCESS_TTL_SECONDS);
    assert.ok(ACCESS_TTL_SECONDS < REFRESH_TTL_SECONDS);

    const expired = await verifyIdentityToken(
      redeemed.session.accessToken,
      SECRET,
      opened + (ACCESS_TTL_SECONDS + 120) * 1000,
    );
    assert.equal(expired.ok, false);
    assert.equal(expired.ok === false && expired.reason, 'expired');
  });
});

describe('refresh', () => {
  it('mints a new access token while the session is live', async () => {
    const { store } = storeOnDisk();
    const { code } = await createPairing(store, ALICE);
    const redeemed = await redeemPairing(store, code, SECRET);
    assert.ok(redeemed.ok);

    const refreshed = await refreshSession(store, redeemed.session.refreshToken, SECRET);

    assert.ok(refreshed.ok);
    assert.deepEqual(refreshed.identity, ALICE);
    assert.ok((await verifyIdentityToken(refreshed.accessToken, SECRET)).ok);
  });

  it('refuses a refresh token that was never issued', async () => {
    const { store } = storeOnDisk();

    const refreshed = await refreshSession(store, 'not-a-token-this-worker-minted', SECRET);

    assert.equal(refreshed.ok, false);
  });

  it('refuses a session past its expiry', async () => {
    const { store } = storeOnDisk();
    const opened = Date.now();
    const { code } = await createPairing(store, ALICE, opened);
    const redeemed = await redeemPairing(store, code, SECRET, opened);
    assert.ok(redeemed.ok);

    const late = await refreshSession(
      store,
      redeemed.session.refreshToken,
      SECRET,
      opened + REFRESH_TTL_SECONDS * 1000 + 1,
    );

    assert.equal(late.ok, false);
  });
});

describe('logging out', () => {
  /** The ticket's requirement, and the one a local-only logout silently fails to meet. */
  it('revokes on the worker, so the refresh token stops working everywhere', async () => {
    const { store } = storeOnDisk();
    const { code } = await createPairing(store, ALICE);
    const redeemed = await redeemPairing(store, code, SECRET);
    assert.ok(redeemed.ok);

    assert.equal(await revokeSession(store, redeemed.session.refreshToken), true);

    const after = await refreshSession(store, redeemed.session.refreshToken, SECRET);
    assert.equal(after.ok, false);
    assert.equal(after.ok === false && after.reason, 'session-revoked-or-expired');
  });

  it('treats a second logout as a no-op rather than an error', async () => {
    const { store } = storeOnDisk();
    const { code } = await createPairing(store, ALICE);
    const redeemed = await redeemPairing(store, code, SECRET);
    assert.ok(redeemed.ok);

    assert.equal(await revokeSession(store, redeemed.session.refreshToken), true);
    assert.equal(await revokeSession(store, redeemed.session.refreshToken), false);
  });

  it('leaves every other session alone', async () => {
    const { store } = storeOnDisk();
    const first = await redeemPairing(store, (await createPairing(store, ALICE)).code, SECRET);
    const second = await redeemPairing(store, (await createPairing(store, ALICE)).code, SECRET);
    assert.ok(first.ok && second.ok);

    await revokeSession(store, first.session.refreshToken);

    assert.ok((await refreshSession(store, second.session.refreshToken, SECRET)).ok);
  });
});

describe('what is on the disk', () => {
  /**
   * A copy of this file must not be a set of working logins.
   *
   * It reads every file SQLite wrote, not just the `.db`: in WAL mode a row that was just written is
   * in `sessions.db-wal` and nowhere else, which is the same trap the seed store's backup note
   * records. Checking only the `.db` would pass against a store that wrote the code in the clear.
   */
  it('holds neither the pairing code nor the refresh token in the clear', async () => {
    const { store, path } = storeOnDisk();
    const { code } = await createPairing(store, ALICE);
    const redeemed = await redeemPairing(store, code, SECRET);
    assert.ok(redeemed.ok);

    const written = readdirSync(join(path, '..'))
      .map((name) => readFileSync(join(path, '..', name)).toString('latin1'))
      .join('\n');

    assert.ok(written.includes('alice@acme.dev'), 'expected the database to hold the identity it vouches for');
    assert.equal(written.includes(normalizePairingCode(code)), false, 'the pairing code is stored in the clear');
    assert.equal(written.includes(redeemed.session.refreshToken), false, 'the refresh token is stored in the clear');
  });
});

describe('a store that fails mid-redemption', () => {
  /**
   * The reason the spend and the session are one transaction.
   *
   * Marking the code spent and then failing to write the session burns the only code the reviewer
   * has: the retry answers `code-spent-or-expired`, which is true and leaves them with nothing.
   *
   * The failure is injected through the real store rather than a stub, and it is a real one:
   * `sessions.token_hash` is the primary key, so reusing a digest already on file makes the INSERT
   * throw *inside* the transaction — which is where a full volume or a locked file would throw too.
   * Unlike the atomicity of the spend itself, this guard is observable, because it is not a race.
   */
  it('leaves the code spendable when the session cannot be written', async () => {
    const { store } = storeOnDisk();

    // A session already on file. Its digest is what the failed redemption will collide with.
    const first = await redeemPairing(store, (await createPairing(store, ALICE)).code, SECRET);
    assert.ok(first.ok);
    const taken = await digest(first.session.refreshToken);

    const { code } = await createPairing(store, ALICE);
    const codeHash = await digest(normalizePairingCode(code));
    await assert.rejects(() =>
      store.redeemPairing({
        codeHash,
        tokenHash: taken,
        expiresAt: Date.now() + 60_000,
        now: Date.now(),
      }),
    );

    // The rollback is what makes this pass. Without it the code is gone and so is the reviewer.
    const retried = await redeemPairing(store, code, SECRET);
    assert.ok(retried.ok, 'the pairing code was burned by a failed attempt');
    assert.deepEqual(retried.session.identity, ALICE);
  });
});

describe('a row nobody can trust', () => {
  /**
   * `A row is parsed, never trusted` — the rule this repo already states for the seed store. The file
   * sits on a volume an operator can edit and a restore can be older than the code.
   *
   * **SQLite narrows what can actually arrive, and the first version of this test got that wrong.**
   * The column has `TEXT` affinity, so an integer or a float written into it comes back as a string
   * (`42` reads as `"42.0"`) and never reaches the guard as a non-string. Measured. What does reach
   * it is a **BLOB**, which keeps its type and arrives as an object, and an empty string, which a
   * `NOT NULL` column happily holds. Those are the two cases below.
   */
  for (const [label, subject] of [
    ['a blob, which keeps its type through TEXT affinity', Buffer.from('alice')],
    ['an empty string, which NOT NULL does not stop', ''],
  ] as const) {
    it(`refuses a pairing whose subject is ${label}`, async () => {
      const { store } = storeOnDisk();
      const code = createPairingCode();

      await store.createPairing({
        codeHash: await digest(normalizePairingCode(code)),
        identity: { subject } as unknown as Parameters<typeof store.createPairing>[0]['identity'],
        expiresAt: Date.now() + 60_000,
      });

      const redeemed = await redeemPairing(store, code, SECRET);

      assert.equal(redeemed.ok, false, 'a malformed row minted a session');
    });
  }
});

/**
 * Rotation, and the grace that keeps a lost answer from locking a reviewer out (SKG-600).
 *
 * A refresh token that never changes is a thirty-day password: a copy taken from a browser profile
 * stays good for the rest of the month and nothing observes the theft. Every test below is about one
 * of the two things rotation buys — shortening what a copy is worth, and making its use visible.
 */
describe('rotation', () => {
  /** A session opened now, and the token it was handed. */
  async function opened(at = Date.now()) {
    const { store, path } = storeOnDisk();
    const { code } = await createPairing(store, ALICE, at);
    const redeemed = await redeemPairing(store, code, SECRET, at);
    assert.ok(redeemed.ok);

    return { store, path, token: redeemed.session.refreshToken, at };
  }

  it('hands back a new refresh token, and the new one works', async () => {
    const { store, token } = await opened();

    const first = await refreshSession(store, token, SECRET);
    assert.ok(first.ok);
    assert.notEqual(first.refreshToken, token);

    const second = await refreshSession(store, first.refreshToken, SECRET);
    assert.ok(second.ok);
    assert.deepEqual(second.identity, ALICE);
  });

  /**
   * The mechanism, and it uses no clock: what retires a predecessor is its successor being used,
   * because that is the proof the client received it. Until then the client may still be holding
   * only the old one — its answer may never have arrived.
   */
  it('keeps the old token usable until the new one is used', async () => {
    const { store, token } = await opened();
    const first = await refreshSession(store, token, SECRET);
    assert.ok(first.ok);

    const retry = await refreshSession(store, token, SECRET);

    assert.ok(retry.ok, 'a client that never received the answer has nothing else to send');
    assert.notEqual(retry.refreshToken, first.refreshToken);
  });

  /**
   * The ceiling allows more than one retry, and only this says so.
   *
   * `SECURITY.md` promises that inside the ceiling the spent token may be presented **more than
   * once**, each time replacing the successor nobody received. Every other test here presents it
   * twice, so removing `keep` from the grace branch — which revokes the presenting token along with
   * the orphans — failed nothing at all. The property was written down and guarded by nothing.
   */
  it('takes a third presentation inside the ceiling, not just a second', async () => {
    const { store, token, at } = await opened();
    assert.ok((await refreshSession(store, token, SECRET, at)).ok);
    assert.ok((await refreshSession(store, token, SECRET, at + 60_000)).ok);

    const third = await refreshSession(store, token, SECRET, at + 120_000);

    assert.ok(third.ok, 'the spent token was retired by a retry rather than by its successor');
    assert.ok((await refreshSession(store, third.refreshToken, SECRET, at + 180_000)).ok);
  });

  /** And the successor nobody received goes, so one token never has two live successors. */
  it('drops the successor that was never received', async () => {
    const { store, token } = await opened();
    const lost = await refreshSession(store, token, SECRET);
    assert.ok(lost.ok);
    assert.ok((await refreshSession(store, token, SECRET)).ok);

    assert.equal((await refreshSession(store, lost.refreshToken, SECRET)).ok, false);
  });

  /**
   * And presenting that orphan ends the chain, because two parties are holding one.
   *
   * This test asserted the opposite until a reviewer reproduced what the opposite costs: a thief
   * presents the predecessor inside the grace, the client's own successor is revoked under it, and
   * the client then presents a token that is revoked and never rotated. Answering `gone` there left
   * the thief refreshing for the remaining thirty days while the reviewer, locked out, re-paired —
   * and nothing anywhere recorded that a chain had two holders.
   *
   * The discriminator is now the chain rather than the row: revoked, with something still live in
   * the same chain, is the leak signal. A chain with nothing live left is an ended session.
   *
   * The trade, which is the reason this was a decision and not a fix: whoever intercepts one answer
   * in flight can end the session whenever they choose. Reading a response body already implies a
   * position from which the session can be taken outright, so this buys detection with a capability
   * an attacker who has it does not need.
   */
  it('ends the chain when an orphan is presented and something in it is still live', async () => {
    const { store, token } = await opened();
    const lost = await refreshSession(store, token, SECRET);
    assert.ok(lost.ok);
    const kept = await refreshSession(store, token, SECRET);
    assert.ok(kept.ok);

    assert.equal((await refreshSession(store, lost.refreshToken, SECRET)).ok, false);

    assert.equal(
      (await refreshSession(store, kept.refreshToken, SECRET)).ok,
      false,
      'the live branch outlived a second holder showing up on its chain',
    );
  });

  /**
   * And a chain with nothing live left is an ended session, not a replay.
   *
   * Asserted on `rotateSession`'s own outcome, because `refreshSession` folds `gone` and `reused`
   * into one `ok: false` — the caller is deliberately told nothing apart. The first version of this
   * test checked `ok` and so passed with the discriminator removed, which is the kind of test this
   * file is supposed to catch. Raised in review.
   */
  it('answers a token from a chain that is entirely revoked without calling it a replay', async () => {
    const { store, token } = await opened();
    const successor = await refreshSession(store, token, SECRET);
    assert.ok(successor.ok);
    assert.equal(await revokeSession(store, successor.refreshToken), true);

    const presented = async (refreshToken: string) =>
      (
        await store.rotateSession({
          tokenHash: await digest(refreshToken),
          successorHash: await digest(createRefreshToken()),
          now: Date.now(),
          graceMs: ROTATION_GRACE_SECONDS * 1000,
        })
      ).outcome;

    assert.equal(await presented(token), 'gone', 'an ended session was reported as a leak');
    assert.equal(await presented(successor.refreshToken), 'gone');
  });

  it('retires the old token the moment the new one is used', async () => {
    const { store, token } = await opened();
    const first = await refreshSession(store, token, SECRET);
    assert.ok(first.ok);

    assert.ok((await refreshSession(store, first.refreshToken, SECRET)).ok);
    assert.equal((await refreshSession(store, token, SECRET)).ok, false, 'the predecessor is spent');
  });

  /**
   * The reason rotation is worth having at all.
   *
   * A token presented after its successor was used cannot be the client's — the client moved on. So
   * it is a copy, and the copy proves the session is compromised: every live token in the chain
   * goes, not only the one that was replayed. The reviewer is logged out and has to pair again,
   * which is the point: a silent thirty-day theft becomes a visible one.
   */
  it('revokes the whole chain when a retired token is replayed', async () => {
    const { store, token } = await opened();
    const first = await refreshSession(store, token, SECRET);
    assert.ok(first.ok);
    const second = await refreshSession(store, first.refreshToken, SECRET);
    assert.ok(second.ok);

    // The leaked copy, replayed after the real client had moved on twice.
    assert.equal((await refreshSession(store, token, SECRET)).ok, false);

    assert.equal(
      (await refreshSession(store, second.refreshToken, SECRET)).ok,
      false,
      'the live token must go with the chain, or the theft costs the thief nothing',
    );
  });

  it('gives up on a rotated token once the grace has run out, and takes the chain with it', async () => {
    const { store, token, at } = await opened();
    const lost = await refreshSession(store, token, SECRET, at);
    assert.ok(lost.ok);

    const late = at + ROTATION_GRACE_SECONDS * 1000 + 1;

    assert.equal((await refreshSession(store, token, SECRET, late)).ok, false);
    assert.equal((await refreshSession(store, lost.refreshToken, SECRET, late)).ok, false);
  });

  it('still accepts the retry the grace exists for, at the last moment it covers', async () => {
    const { store, token, at } = await opened();
    assert.ok((await refreshSession(store, token, SECRET, at)).ok);

    const last = at + ROTATION_GRACE_SECONDS * 1000;

    assert.ok((await refreshSession(store, token, SECRET, last)).ok);
  });

  /**
   * Rotation shortens what a leaked token is worth; it does not lengthen a session. A successor that
   * started its own thirty days would make a refreshing client immortal, and `SECURITY.md` says
   * thirty days.
   */
  it('does not extend the session it rotates', async () => {
    const { store, token, at } = await opened();
    const halfway = at + (REFRESH_TTL_SECONDS / 2) * 1000;
    const refreshed = await refreshSession(store, token, SECRET, halfway);
    assert.ok(refreshed.ok);

    const past = at + REFRESH_TTL_SECONDS * 1000 + 1;

    assert.equal((await refreshSession(store, refreshed.refreshToken, SECRET, past)).ok, false);
  });

  /** A logout is not a leak. It revokes without rotating, so a replay of it is an ordinary refusal. */
  it('tells a logged-out token apart from a replayed one', async () => {
    const { store, token } = await opened();
    assert.ok(await revokeSession(store, token));

    assert.equal((await refreshSession(store, token, SECRET)).ok, false);
  });

  /**
   * The ceiling is a ceiling, and a retry must not push it away.
   *
   * `rotated_at` marks the first rotation only. Written afresh on every retry it slides, and
   * whoever holds this token re-presents it just inside each window for ever, minting a successor
   * every time — the lost-answer allowance turned into an unbounded lease. Raised in review.
   */
  it('does not extend the grace by retrying inside it', async () => {
    const { store, token, at } = await opened();
    const grace = ROTATION_GRACE_SECONDS * 1000;
    assert.ok((await refreshSession(store, token, SECRET, at)).ok);

    // Re-presented just inside the window, the way a caller stretching it would.
    assert.ok((await refreshSession(store, token, SECRET, at + grace - 1_000)).ok);

    const past = await refreshSession(store, token, SECRET, at + grace + 1_000);

    assert.equal(past.ok, false, 'the grace is measured from the first rotation, not from the last retry');
  });

  /**
   * Log out ends the session, and rotation made a session a chain.
   *
   * A refresh whose answer was lost leaves the client holding a token that has already issued a
   * successor. A logout with that token used to revoke it alone, and the successor stayed live for
   * the rest of the thirty days — held by nobody, revocable by nobody. Raised in review.
   */
  it('ends the whole chain on log out, not only the token it was handed', async () => {
    const { store, token } = await opened();
    const successor = await refreshSession(store, token, SECRET);
    assert.ok(successor.ok);

    assert.equal(await revokeSession(store, token), true);

    assert.equal((await refreshSession(store, successor.refreshToken, SECRET)).ok, false);
  });

  /**
   * The other direction, and the half the first fix missed.
   *
   * A rotation does not revoke the token it rotated — only that token's successor being *used*
   * retires it. So after `A -> B` the client holds B while A is live and rotated, and a logout with
   * B left A usable for the rest of its grace. Whoever copied A presented it and got a fresh
   * successor: the log out ended nothing. Measured before the fix. Raised in review.
   */
  it('ends a chain from any link, including the token nobody is holding', async () => {
    const { store, token } = await opened();
    const successor = await refreshSession(store, token, SECRET);
    assert.ok(successor.ok);

    assert.equal(await revokeSession(store, successor.refreshToken), true);

    const copy = await refreshSession(store, token, SECRET);
    assert.equal(copy.ok, false, 'a copy of the predecessor outlived the log out');
  });

  /**
   * A head carries no chain name, so revoking by chain alone cannot reach it.
   *
   * `redeemPairing` writes no `root_hash` — every head has NULL there, and so does every row written
   * before migration #2 added the column. That is why `revokeChain` names the head directly instead
   * of relying on `WHERE root_hash = ?`, and why a session open across the upgrade needs nothing
   * special: its shape is the shape of every head.
   *
   * The case has to be built with care, and two earlier versions of this test did not. A head is
   * normally retired by the ordinary path — using its successor revokes it — so in most chains it is
   * already revoked and the naming clause never shows. What is needed is a head that is still
   * **live**: one whose successor was minted and never used. A grace retry produces exactly that,
   * and leaves an orphan branch as well.
   *
   * The first version added a hand-written `root_hash = NULL` on the head to look like an upgraded
   * row; the head was already NULL, so it built no fixture the ordinary path does not. The second
   * dropped that but kept a chain whose head was retired, and passed with the naming clause removed.
   * Both raised in review — the second by running the mutation rather than trusting the rename.
   */
  it('reaches the live head of a forked chain when the log out comes from a leaf', async () => {
    const { store, token, at } = await opened();
    const orphan = await refreshSession(store, token, SECRET, at);
    assert.ok(orphan.ok);

    // A retry inside the grace: the head is now rotated twice and still live, because neither
    // successor has been used to refresh.
    const live = await refreshSession(store, token, SECRET, at + 1_000);
    assert.ok(live.ok);

    assert.equal(await revokeSession(store, live.refreshToken, at + 2_000), true);

    assert.equal(
      (await refreshSession(store, token, SECRET, at + 3_000)).ok,
      false,
      'the live head outlived a log out from its own chain',
    );
    assert.equal((await refreshSession(store, orphan.refreshToken, SECRET, at + 3_000)).ok, false);
  });

  /** And the boolean still describes the row it was handed, so a second log out reads as nothing live. */
  it('answers false on a token already revoked, whatever the chain did', async () => {
    const { store, token } = await opened();
    assert.ok((await refreshSession(store, token, SECRET)).ok);
    assert.equal(await revokeSession(store, token), true);

    assert.equal(await revokeSession(store, token), false);
  });

  /**
   * The other half of the chain revocation, checked rather than assumed: a rotation revokes the
   * predecessor it retires and must **not** revoke that predecessor's descendants. Its stale
   * successors are already gone, revoked by the grace branch, and the only live one is the token
   * the client just received.
   */
  it('leaves the token a client just received alone when its predecessor is retired', async () => {
    const { store, token, at } = await opened();
    assert.ok((await refreshSession(store, token, SECRET, at)).ok);
    const second = await refreshSession(store, token, SECRET, at + 1_000);
    assert.ok(second.ok);

    const third = await refreshSession(store, second.refreshToken, SECRET, at + 2_000);

    assert.ok(third.ok, 'retiring the predecessor took the successor that retired it');
  });

  /**
   * A replay walks forward only, and this is what says that is enough.
   *
   * I claimed in review that the token presented on a replay is always an ancestor of the live tip,
   * so the forward walk reaches everything. That was an assertion, and the two defects before it
   * were both a direction nobody had tested. So: a deep chain with a fork in it — a grace retry
   * leaves an orphan branch — replayed from the **root**, which is the furthest the walk has to go.
   */
  it('revokes a forked chain to its tip when the root is replayed', async () => {
    const { store, token, at } = await opened();
    const orphaned = await refreshSession(store, token, SECRET, at);
    assert.ok(orphaned.ok);
    const second = await refreshSession(store, token, SECRET, at + 1_000);
    assert.ok(second.ok);
    const third = await refreshSession(store, second.refreshToken, SECRET, at + 2_000);
    assert.ok(third.ok);
    const tip = await refreshSession(store, third.refreshToken, SECRET, at + 3_000);
    assert.ok(tip.ok);

    // The root is revoked and rotated by now, so presenting it is the `reused` case.
    assert.equal((await refreshSession(store, token, SECRET, at + 4_000)).ok, false);

    for (const [name, dead] of [
      ['the orphan branch', orphaned.refreshToken],
      ['the middle of the chain', second.refreshToken],
      ['the tip', tip.refreshToken],
    ] as const) {
      assert.equal(
        (await refreshSession(store, dead, SECRET, at + 5_000)).ok,
        false,
        `${name} survived a replay of the root`,
      );
    }
  });

  /**
   * What the grace costs, measured and kept rather than described.
   *
   * Inside it the predecessor has two possible holders and the worker cannot tell them apart. Each
   * presentation revokes the successor the one before it minted, so it is the **last** presenter who
   * holds the live chain and every earlier holder who is locked out. A thief who presents after the
   * reviewer takes the session, and the reviewer pairs again.
   *
   * The first version of this test was named for the *first* presenter, which is the opposite of
   * what the code does and of what the run printed. Raised in review, twice over: the same inversion
   * was in `SECURITY.md`, `docs/decisions/worker.md` and `CLAUDE.md`.
   *
   * The win is only silent until the earlier holder comes back. Their token is revoked and its chain
   * still has a live one, so their failed refresh ends the chain and takes the winner's session with
   * it. That is what makes the theft cost the thief something rather than only the victim.
   *
   * Delete `keep` from the grace branch's `revokeChain` and this test tells you what you changed.
   */
  it('serves whoever presents last inside the grace, until the earlier holder comes back', async () => {
    const { store, token } = await opened();
    const held = await refreshSession(store, token, SECRET);
    assert.ok(held.ok);

    const other = await refreshSession(store, token, SECRET);

    assert.ok(other.ok, 'the later presenter is served, because nothing distinguishes it from a retry');
    assert.equal(
      (await refreshSession(store, held.refreshToken, SECRET)).ok,
      false,
      'the earlier holder kept a working session, so both of them have one',
    );
    assert.equal(
      (await refreshSession(store, other.refreshToken, SECRET)).ok,
      false,
      'the winner kept the chain after the earlier holder had surfaced on it',
    );
  });

  /**
   * The property the whole file rests on, re-checked on the tokens a rotation adds: a copy of this
   * database is not a set of working logins. A successor that had to be answered twice would have to
   * be stored in the clear, which is why a retry inside the grace mints a fresh one instead.
   */
  it('writes no rotated token into the database in the clear', async () => {
    const { store, path, token } = await opened();
    const first = await refreshSession(store, token, SECRET);
    assert.ok(first.ok);
    const second = await refreshSession(store, first.refreshToken, SECRET);
    assert.ok(second.ok);

    const bytes = readdirSync(join(path, '..'))
      .map((name) => readFileSync(join(path, '..', name)).toString('latin1'))
      .join('');

    for (const secret of [token, first.refreshToken, second.refreshToken]) {
      assert.equal(bytes.includes(secret), false, 'a refresh token is in the file the operator backs up');
    }
  });
});

/**
 * The grace is the extension's worst case, read out of the extension rather than restated here.
 *
 * `ROTATION_GRACE_SECONDS` exists to cover one lost answer, and how long that takes is decided
 * entirely on the other side: the margin before a token is due, plus the wait after a failed
 * attempt. Either of those moving without this one leaves a window that is too short to catch the
 * retry it was written for — and nothing else in either suite would notice, because both halves go
 * on passing on their own. The same cross-package reading `security.test.ts` does.
 */
describe('the rotation grace is derived, not chosen', () => {
  const EXTENSION_SESSION = readFileSync(
    fileURLToPath(new URL('../../extension/src/session.ts', import.meta.url)),
    'utf8',
  );

  /** Reads `const NAME = 2 * 60 * 1000;` by multiplying its factors, never by running it. */
  function millisecondsIn(name: string): number {
    const match = new RegExp(`const ${name} = ([\\d_* ]+);`).exec(EXTENSION_SESSION);
    const expression = match?.[1];
    assert.ok(
      expression !== undefined,
      `${name} is gone from the extension's session.ts, or is no longer a product of literals`,
    );

    const factors = expression.split('*').map((factor) => Number(factor.trim().replaceAll('_', '')));
    assert.ok(
      factors.length > 0 && factors.every((factor) => Number.isFinite(factor) && factor > 0),
      `${name} reads as ${JSON.stringify(expression)}, which is not a product of positive literals`,
    );

    return factors.reduce((product, factor) => product * factor, 1);
  }

  it('is the margin before a refresh plus the wait after a failed one', () => {
    const margin = millisecondsIn('REFRESH_MARGIN_MS');
    const retry = millisecondsIn('RETRY_DELAY_MS');

    assert.equal(
      ROTATION_GRACE_SECONDS * 1000,
      margin + retry,
      'the extension changed how long it waits; this grace has to follow it',
    );
  });
});

/**
 * The upgrade path, which a test on a fresh file never walks (SKG-600).
 *
 * Every other test here creates an empty database, so both migrations run together and
 * `ALTER TABLE ... ADD COLUMN` is applied to a table with no rows in it. What ships is the opposite:
 * a volume holding sessions somebody is using, opened by a worker one version newer. This builds the
 * version-1 schema by hand, puts a live session in it, and then lets the store open it.
 */
describe('the rotation migration', () => {
  it('adds its columns to a database that already holds a session', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fruitback-session-'));
    directories.push(directory);
    const path = join(directory, 'sessions.db');

    const token = createRefreshToken();
    const before = new DatabaseSync(path);
    before.exec(`
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        name TEXT,
        email TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE TABLE pairings (
        code_hash TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        name TEXT,
        email TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        redeemed_at INTEGER
      );
      PRAGMA user_version = 1;
    `);
    before
      .prepare('INSERT INTO sessions (token_hash, subject, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(await digest(token), ALICE.subject, Date.now(), Date.now() + REFRESH_TTL_SECONDS * 1000);
    before.close();

    const store = createSqliteSessionStore(path);
    const refreshed = await refreshSession(store, token, SECRET);

    assert.ok(refreshed.ok, 'a session opened before rotation existed must survive the upgrade');
    assert.ok((await refreshSession(store, refreshed.refreshToken, SECRET)).ok);
    assert.equal((await refreshSession(store, token, SECRET)).ok, false, 'and it rotates from then on');
  });
});
