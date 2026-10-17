import assert from 'node:assert/strict';
import type { Declare } from './conformance.fixture.ts';
import {
  PAIRING_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
  ROTATION_GRACE_SECONDS,
  type SessionStore,
  createPairing,
  createPairingCode,
  createRefreshToken,
  digest,
  normalizePairingCode,
  redeemPairing,
  refreshSession,
  revokeSession,
} from './session.ts';

/**
 * What every `SessionStore` promises, whatever holds the sessions (FRU-140).
 *
 * `session-conformance.test.ts` runs these cases on each implementation, and on stores that break one
 * rule each. The cases went out of `session.test.ts`, with their names and their reasons: what is
 * true of `session.ts` alone, or of one file format, stays there.
 */

const SECRET = 'a-worker-secret-nobody-else-has';
const ALICE = { subject: 'alice', name: 'Alice Martin', email: 'alice@acme.dev' };
const GRACE = ROTATION_GRACE_SECONDS * 1000;

/** A session opened now, and the token it was handed. */
async function opened(store: SessionStore, at = Date.now()) {
  const { code } = await createPairing(store, ALICE, at);
  const redeemed = await redeemPairing(store, code, SECRET, at);
  assert.ok(redeemed.ok);

  return { token: redeemed.session.refreshToken, at };
}

/** What the store itself answers for a token. `refreshSession` folds `gone` and `reused` into one refusal. */
async function presented(store: SessionStore, refreshToken: string, now = Date.now()) {
  const rotation = await store.rotateSession({
    tokenHash: await digest(refreshToken),
    successorHash: await digest(createRefreshToken()),
    now,
    graceMs: GRACE,
  });

  return rotation.outcome;
}

export function sessionCases(it: Declare<SessionStore>): void {
  // --- Pairing

  it('opens a session for the person the operator named, not for whoever redeemed', async (store) => {
    const { code } = await createPairing(store, ALICE);

    const redeemed = await redeemPairing(store, code, SECRET);

    assert.ok(redeemed.ok);
    assert.deepEqual(redeemed.session.identity, ALICE);
  });

  it('spends the code, so a second reviewer with the same code gets nothing', async (store) => {
    const { code } = await createPairing(store, ALICE);

    assert.ok((await redeemPairing(store, code, SECRET)).ok);

    const again = await redeemPairing(store, code, SECRET);
    assert.equal(again.ok, false);
    assert.equal(again.ok === false && again.reason, 'code-spent-or-expired');
  });

  /**
   * On a store that waits between its read and its write, two redemptions interleave, and this case
   * is what refuses a read followed by a write. On PGlite, one connection, nothing interleaves, so
   * the case proves nothing there: its control is a store that waits.
   */
  it('gives one session to two reviewers who redeem one code at the same moment', async (store) => {
    const { code } = await createPairing(store, ALICE);
    const now = Date.now();
    const codeHash = await digest(normalizePairingCode(code));
    const tokens = await Promise.all([1, 2, 3].map(() => digest(createRefreshToken())));

    // The digests are made first, so the three calls reach the store in one turn of the event loop.
    // Through `redeemPairing` of `session.ts` each call waits for its own digests, and the order in
    // which they reach the store changes from one run to the next.
    const answers = await Promise.all(
      tokens.map((tokenHash) =>
        store.redeemPairing({ codeHash, tokenHash, expiresAt: now + REFRESH_TTL_SECONDS * 1000, now }),
      ),
    );

    assert.deepEqual(
      answers.filter((answer) => answer !== undefined),
      [ALICE],
    );
  });

  /**
   * The store is asked directly. `redeemPairing` of `session.ts` purges before it redeems, so an
   * expired code is gone before the store reads its expiry, and the comparison is never reached.
   */
  it('refuses a code at its expiry, and after, with no purge before', async (store) => {
    const minted = Date.now();
    const { code, expiresAt } = await createPairing(store, ALICE, minted);
    assert.equal(expiresAt, minted + PAIRING_TTL_SECONDS * 1000);
    const redeem = async (now: number) =>
      store.redeemPairing({
        codeHash: await digest(normalizePairingCode(code)),
        tokenHash: await digest(createRefreshToken()),
        expiresAt: now + REFRESH_TTL_SECONDS * 1000,
        now,
      });

    assert.equal(await redeem(expiresAt + 1), undefined);
    assert.equal(await redeem(expiresAt), undefined);
    assert.deepEqual(await redeem(expiresAt - 1), ALICE);
  });

  /**
   * The reason the spend and the session are one transaction.
   *
   * Marking the code spent and then failing to write the session burns the only code the reviewer
   * has: the retry answers `code-spent-or-expired`, which is true and leaves them with nothing.
   *
   * The failure is a real one: a token digest already on file makes the write of the session fail
   * inside the transaction, where a full volume or a lost connection would fail too.
   */
  it('leaves the code spendable when the session cannot be written', async (store) => {
    // A session already on file. Its digest is what the failed redemption will collide with.
    const first = await redeemPairing(store, (await createPairing(store, ALICE)).code, SECRET);
    assert.ok(first.ok);
    const taken = await digest(first.session.refreshToken);

    const { code } = await createPairing(store, ALICE);
    const codeHash = await digest(normalizePairingCode(code));
    await assert.rejects(() =>
      store.redeemPairing({ codeHash, tokenHash: taken, expiresAt: Date.now() + 60_000, now: Date.now() }),
    );

    // The rollback is what makes this pass. Without it the code is gone and so is the reviewer.
    const retried = await redeemPairing(store, code, SECRET);
    assert.ok(retried.ok, 'the pairing code was burned by a failed attempt');
    assert.deepEqual(retried.session.identity, ALICE);
  });

  /** A row is parsed, never trusted: a `NOT NULL` column holds an empty string. */
  it('refuses a pairing whose subject is an empty string', async (store) => {
    const code = createPairingCode();
    await store.createPairing({
      codeHash: await digest(normalizePairingCode(code)),
      identity: { subject: '' },
      expiresAt: Date.now() + 60_000,
    });

    const redeemed = await redeemPairing(store, code, SECRET);

    assert.equal(redeemed.ok, false, 'a malformed row minted a session');
  });

  it('keeps the workspace of a pairing through every rotation', async (store) => {
    const identity = { ...ALICE, workspace: 'ws_acme' };
    const redeemed = await redeemPairing(store, (await createPairing(store, identity)).code, SECRET);
    assert.ok(redeemed.ok);
    assert.deepEqual(redeemed.session.identity, identity);

    const first = await refreshSession(store, redeemed.session.refreshToken, SECRET);
    assert.ok(first.ok);
    const second = await refreshSession(store, first.refreshToken, SECRET);
    assert.ok(second.ok);

    assert.deepEqual(first.identity, identity);
    assert.deepEqual(second.identity, identity);
  });

  // --- Refresh, and log out

  it('refuses a refresh token that was never issued', async (store) => {
    await opened(store);

    const refreshed = await refreshSession(store, 'not-a-token-this-worker-minted', SECRET);

    assert.equal(refreshed.ok, false);
  });

  it('refuses a session past its expiry', async (store) => {
    const { token, at } = await opened(store);

    assert.equal(await presented(store, token, at + REFRESH_TTL_SECONDS * 1000 + 1), 'gone');
    assert.equal(await presented(store, token, at + REFRESH_TTL_SECONDS * 1000), 'gone');
    assert.equal(await presented(store, token, at + REFRESH_TTL_SECONDS * 1000 - 1), 'rotated');
  });

  it('answers rotated, gone and reused for the three things a token can be', async (store) => {
    const { token } = await opened(store);

    const rotation = await store.rotateSession({
      tokenHash: await digest(token),
      successorHash: await digest('the-successor'),
      now: Date.now(),
      graceMs: GRACE,
    });
    assert.deepEqual(rotation, { outcome: 'rotated', identity: ALICE });

    assert.equal(await presented(store, 'a-token-nobody-minted'), 'gone');

    // The successor is used, so the first token is retired. Presented again, it is a copy.
    assert.equal(await presented(store, 'the-successor'), 'rotated');
    assert.equal(await presented(store, token), 'reused');
  });

  /** The ticket's requirement, and the one a local-only logout silently fails to meet. */
  it('revokes on the worker, so the refresh token stops working everywhere', async (store) => {
    const { token } = await opened(store);

    assert.equal(await revokeSession(store, token), true);

    const after = await refreshSession(store, token, SECRET);
    assert.equal(after.ok, false);
    assert.equal(after.ok === false && after.reason, 'session-revoked-or-expired');
  });

  it('treats a second logout as a no-op rather than an error', async (store) => {
    const { token } = await opened(store);

    assert.equal(await revokeSession(store, token), true);
    assert.equal(await revokeSession(store, token), false);
    assert.equal(await revokeSession(store, 'a-token-nobody-minted'), false);
  });

  it('leaves every other session alone', async (store) => {
    const first = await opened(store);
    const second = await opened(store);

    await revokeSession(store, first.token);

    assert.ok((await refreshSession(store, second.token, SECRET)).ok);
  });

  // --- Rotation, and the grace that keeps a lost answer from locking a reviewer out (FRU-61)

  it('hands back a new refresh token, and the new one works', async (store) => {
    const { token } = await opened(store);

    const first = await refreshSession(store, token, SECRET);
    assert.ok(first.ok);
    assert.notEqual(first.refreshToken, token);
    assert.deepEqual(first.identity, ALICE);

    const second = await refreshSession(store, first.refreshToken, SECRET);
    assert.ok(second.ok);
    assert.deepEqual(second.identity, ALICE);
  });

  /**
   * The mechanism, and it uses no clock: what retires a predecessor is its successor being used,
   * because that is the proof the client received it. Until then the client may still be holding
   * only the old one — its answer may never have arrived.
   */
  it('keeps the old token usable until the new one is used', async (store) => {
    const { token } = await opened(store);
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
  it('takes a third presentation inside the ceiling, not just a second', async (store) => {
    const { token, at } = await opened(store);
    assert.ok((await refreshSession(store, token, SECRET, at)).ok);
    assert.ok((await refreshSession(store, token, SECRET, at + 60_000)).ok);

    const third = await refreshSession(store, token, SECRET, at + 120_000);

    assert.ok(third.ok, 'the spent token was retired by a retry rather than by its successor');
    assert.ok((await refreshSession(store, third.refreshToken, SECRET, at + 180_000)).ok);
  });

  /** And the successor nobody received goes, so one token never has two live successors. */
  it('drops the successor that was never received', async (store) => {
    const { token } = await opened(store);
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
  it('ends the chain when an orphan is presented and something in it is still live', async (store) => {
    const { token } = await opened(store);
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
  it('answers a token from a chain that is entirely revoked without calling it a replay', async (store) => {
    const { token } = await opened(store);
    const successor = await refreshSession(store, token, SECRET);
    assert.ok(successor.ok);
    assert.equal(await revokeSession(store, successor.refreshToken), true);

    assert.equal(await presented(store, token), 'gone', 'an ended session was reported as a leak');
    assert.equal(await presented(store, successor.refreshToken), 'gone');
  });

  it('retires the old token the moment the new one is used', async (store) => {
    const { token } = await opened(store);
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
  it('revokes the whole chain when a retired token is replayed', async (store) => {
    const { token } = await opened(store);
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

  it('gives up on a rotated token once the grace has run out, and takes the chain with it', async (store) => {
    const { token, at } = await opened(store);
    const lost = await refreshSession(store, token, SECRET, at);
    assert.ok(lost.ok);

    const late = at + GRACE + 1;

    assert.equal((await refreshSession(store, token, SECRET, late)).ok, false);
    assert.equal((await refreshSession(store, lost.refreshToken, SECRET, late)).ok, false);
  });

  it('still accepts the retry the grace exists for, at the last moment it covers', async (store) => {
    const { token, at } = await opened(store);
    assert.ok((await refreshSession(store, token, SECRET, at)).ok);

    assert.ok((await refreshSession(store, token, SECRET, at + GRACE)).ok);
  });

  /**
   * Rotation shortens what a leaked token is worth; it does not lengthen a session. A successor that
   * started its own thirty days would make a refreshing client immortal, and `SECURITY.md` says
   * thirty days.
   */
  it('does not extend the session it rotates', async (store) => {
    const { token, at } = await opened(store);
    const halfway = at + (REFRESH_TTL_SECONDS / 2) * 1000;
    const refreshed = await refreshSession(store, token, SECRET, halfway);
    assert.ok(refreshed.ok);

    const past = at + REFRESH_TTL_SECONDS * 1000 + 1;

    assert.equal((await refreshSession(store, refreshed.refreshToken, SECRET, past)).ok, false);
  });

  /**
   * A logout is not a leak. It revokes without rotating, so a replay of it is an ordinary refusal:
   * asked of the store, because `refreshSession` answers a leak and a logout alike.
   */
  it('tells a logged-out token apart from a replayed one', async (store) => {
    const { token } = await opened(store);
    assert.ok(await revokeSession(store, token));

    assert.equal((await refreshSession(store, token, SECRET)).ok, false);
    assert.equal(await presented(store, token), 'gone');
  });

  /**
   * The ceiling is a ceiling, and a retry must not push it away.
   *
   * `rotated_at` marks the first rotation only. Written afresh on every retry it slides, and
   * whoever holds this token re-presents it just inside each window for ever, minting a successor
   * every time — the lost-answer allowance turned into an unbounded lease. Raised in review.
   */
  it('does not extend the grace by retrying inside it', async (store) => {
    const { token, at } = await opened(store);
    assert.ok((await refreshSession(store, token, SECRET, at)).ok);

    // Re-presented just inside the window, the way a caller stretching it would.
    assert.ok((await refreshSession(store, token, SECRET, at + GRACE - 1_000)).ok);

    const past = await refreshSession(store, token, SECRET, at + GRACE + 1_000);

    assert.equal(past.ok, false, 'the grace is measured from the first rotation, not from the last retry');
  });

  /**
   * Log out ends the session, and rotation made a session a chain.
   *
   * A refresh whose answer was lost leaves the client holding a token that has already issued a
   * successor. A logout with that token used to revoke it alone, and the successor stayed live for
   * the rest of the thirty days — held by nobody, revocable by nobody. Raised in review.
   */
  it('ends the whole chain on log out, not only the token it was handed', async (store) => {
    const { token } = await opened(store);
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
  it('ends a chain from any link, including the token nobody is holding', async (store) => {
    const { token } = await opened(store);
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
  it('reaches the live head of a forked chain when the log out comes from a leaf', async (store) => {
    const { token, at } = await opened(store);
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
  it('answers false on a token already revoked, whatever the chain did', async (store) => {
    const { token } = await opened(store);
    const successor = await refreshSession(store, token, SECRET);
    assert.ok(successor.ok);
    assert.equal(await revokeSession(store, token), true);

    assert.equal(await revokeSession(store, token), false);
    // The successor went with the chain, and not by a call that named it.
    assert.equal(await revokeSession(store, successor.refreshToken), false);
  });

  /**
   * The other half of the chain revocation, checked rather than assumed: a rotation revokes the
   * predecessor it retires and must **not** revoke that predecessor's descendants. Its stale
   * successors are already gone, revoked by the grace branch, and the only live one is the token
   * the client just received.
   */
  it('leaves the token a client just received alone when its predecessor is retired', async (store) => {
    const { token, at } = await opened(store);
    assert.ok((await refreshSession(store, token, SECRET, at)).ok);
    const second = await refreshSession(store, token, SECRET, at + 1_000);
    assert.ok(second.ok);

    const third = await refreshSession(store, second.refreshToken, SECRET, at + 2_000);

    assert.ok(third.ok, 'retiring the predecessor took the successor that retired it');
    // The answer says nothing of the row: the token it carries must work too.
    assert.ok((await refreshSession(store, third.refreshToken, SECRET, at + 3_000)).ok);
  });

  /**
   * A replay walks forward only, and this is what says that is enough.
   *
   * I claimed in review that the token presented on a replay is always an ancestor of the live tip,
   * so the forward walk reaches everything. That was an assertion, and the two defects before it
   * were both a direction nobody had tested. So: a deep chain with a fork in it — a grace retry
   * leaves an orphan branch — replayed from the **root**, which is the furthest the walk has to go.
   */
  it('revokes a forked chain to its tip when the root is replayed', async (store) => {
    const { token, at } = await opened(store);
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
  it('serves whoever presents last inside the grace, until the earlier holder comes back', async (store) => {
    const { token } = await opened(store);
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

  // --- Purge

  /**
   * The clock of the second half goes back, on purpose: it is the only way to ask the interface
   * whether a row is still there. A row that the purge left would answer at an instant before its
   * expiry.
   */
  // --- Two calls at the same moment

  it('never leaves two live successors when one token is refreshed twice at the same moment', async (store) => {
    const { token, at } = await opened(store);
    const [one, two] = [createRefreshToken(), createRefreshToken()];
    const [tokenHash, oneHash, twoHash] = (await Promise.all([token, one, two].map((value) => digest(value)))) as [
      string,
      string,
      string,
    ];

    // The digests are made first, so the two calls reach the store in one turn of the event loop.
    const answers = await Promise.all(
      [oneHash, twoHash].map((successorHash) =>
        store.rotateSession({ tokenHash, successorHash, now: at + 1000, graceMs: GRACE }),
      ),
    );
    // Both are answered: the second one is the retry that the grace exists for.
    assert.deepEqual(
      answers.map((answer) => answer.outcome),
      ['rotated', 'rotated'],
    );

    // The successor of the call that came first is the one nobody is known to hold, and it was
    // dropped. Which one it is changes from one run to the next, so both are used, one after the
    // other: with one dropped, exactly one of the two answers is a replay. Two live successors
    // both rotate, and no answer is.
    const after = [await presented(store, one, at + 2000), await presented(store, two, at + 3000)];
    assert.equal(
      after.filter((outcome) => outcome === 'reused').length,
      1,
      `the two successors answered ${after.join(' and ')}`,
    );
  });

  it('ends the session when a token and its successor are refreshed at the same moment', async (store) => {
    const { token: first, at } = await opened(store);
    const [second, afterFirst, afterSecond] = [createRefreshToken(), createRefreshToken(), createRefreshToken()];
    const [firstHash, secondHash, afterFirstHash, afterSecondHash] = (await Promise.all(
      [first, second, afterFirst, afterSecond].map((value) => digest(value)),
    )) as [string, string, string, string];
    const rotation = (tokenHash: string, successorHash: string, now: number) =>
      store.rotateSession({ tokenHash, successorHash, now, graceMs: GRACE });
    assert.equal((await rotation(firstHash, secondHash, at + 1000)).outcome, 'rotated');

    // The old token is inside its grace, and the new one was never used: a client can hold either.
    // Whichever call comes first, the other one then presents a token that the first call revoked,
    // in a chain that is still live. That is a replay, and the chain goes.
    const outcomes = (
      await Promise.all([
        rotation(firstHash, afterFirstHash, at + 2000),
        rotation(secondHash, afterSecondHash, at + 2000),
      ])
    ).map((answer) => answer.outcome);
    assert.deepEqual(outcomes.toSorted(), ['reused', 'rotated']);

    // Nothing of the chain is left to use, the successor of the call that came first included.
    assert.equal(await presented(store, afterFirst, at + 3000), 'gone');
    assert.equal(await presented(store, afterSecond, at + 3000), 'gone');
  });

  // --- A person who is removed from a workspace (FRU-149)

  /** A session of `identity`, refreshed `times` times: every token it was handed, oldest first. */
  const chainOf = async (store: SessionStore, identity: typeof ALICE & { workspace?: string }, times: number) => {
    const at = Date.now();
    const redeemed = await redeemPairing(store, (await createPairing(store, identity, at)).code, SECRET, at);
    assert.ok(redeemed.ok);
    const tokens = [redeemed.session.refreshToken];
    for (let turnOf = 1; turnOf <= times; turnOf += 1) {
      const next = await refreshSession(store, tokens.at(-1) as string, SECRET, at + turnOf);
      assert.ok(next.ok);
      tokens.push(next.refreshToken);
    }

    return { tokens, at: at + times };
  };
  const BOB = { subject: 'bob', name: 'Bob Durand', email: 'bob@acme.dev' };

  it('ends every session of a person in a workspace, from any link of each chain', async (store) => {
    const alice = { ...ALICE, workspace: 'ws_acme' };
    const laptop = await chainOf(store, alice, 2);
    const desktop = await chainOf(store, alice, 0);

    await store.endSessionsOf({ subject: 'alice', workspace: 'ws_acme' }, laptop.at + 10);

    // `gone`, and not `reused`: nothing of these chains is live, so no token of them is a replay.
    for (const token of [...laptop.tokens, ...desktop.tokens]) {
      assert.equal(await presented(store, token, laptop.at + 20), 'gone');
    }
  });

  it('leaves the same person in another workspace, and another person in the same one', async (store) => {
    const elsewhere = await chainOf(store, { ...ALICE, workspace: 'ws_other' }, 1);
    const colleague = await chainOf(store, { ...BOB, workspace: 'ws_acme' }, 1);
    const alone = await chainOf(store, ALICE, 0);
    await chainOf(store, { ...ALICE, workspace: 'ws_acme' }, 0);

    await store.endSessionsOf({ subject: 'alice', workspace: 'ws_acme' }, elsewhere.at + 10);

    assert.equal(await presented(store, elsewhere.tokens.at(-1) as string, elsewhere.at + 20), 'rotated');
    assert.equal(await presented(store, colleague.tokens.at(-1) as string, colleague.at + 20), 'rotated');
    assert.equal(await presented(store, alone.tokens.at(-1) as string, alone.at + 20), 'rotated');
  });

  it('writes the name a person chose on their live sessions and codes, and on nobody else (FRU-249)', async (store) => {
    const alice = await chainOf(store, { ...ALICE, workspace: 'ws_acme' }, 1);
    const bob = await chainOf(store, { ...BOB, workspace: 'ws_acme' }, 0);
    const waiting = await createPairing(store, { ...ALICE, workspace: 'ws_other' }, alice.at);

    await store.renameSessionsOf('alice', 'A. Martin', alice.at + 1);

    const next = await refreshSession(store, alice.tokens.at(-1) as string, SECRET, alice.at + 2);
    assert.ok(next.ok);
    assert.equal(next.identity.name, 'A. Martin');
    const theirs = await refreshSession(store, bob.tokens[0] as string, SECRET, alice.at + 2);
    assert.ok(theirs.ok);
    assert.equal(theirs.identity.name, 'Bob Durand');
    const redeemed = await redeemPairing(store, waiting.code, SECRET, alice.at + 3);
    assert.ok(redeemed.ok);
    assert.equal(redeemed.session.identity.name, 'A. Martin');
  });

  it('ends every session of a workspace when no person is named, and of a person when no workspace is', async (store) => {
    const alice = await chainOf(store, { ...ALICE, workspace: 'ws_acme' }, 1);
    const bob = await chainOf(store, { ...BOB, workspace: 'ws_acme' }, 0);
    const elsewhere = await chainOf(store, { ...ALICE, workspace: 'ws_other' }, 0);
    const alone = await chainOf(store, ALICE, 0);
    const other = await chainOf(store, { ...BOB, workspace: 'ws_other' }, 0);

    await store.endSessionsOf({ workspace: 'ws_acme' }, alice.at + 10);

    assert.equal(await presented(store, alice.tokens.at(-1) as string, alice.at + 20), 'gone');
    assert.equal(await presented(store, bob.tokens[0] as string, alice.at + 20), 'gone');

    await store.endSessionsOf({ subject: 'alice' }, alice.at + 30);

    assert.equal(await presented(store, elsewhere.tokens[0] as string, alice.at + 40), 'gone');
    // A session that names no workspace is the person's too.
    assert.equal(await presented(store, alone.tokens[0] as string, alice.at + 40), 'gone');
    assert.equal(await presented(store, other.tokens[0] as string, alice.at + 40), 'rotated');
  });

  it('spends the codes minted for the person in the workspace, and no other code', async (store) => {
    const theirs = await createPairing(store, { ...ALICE, workspace: 'ws_acme' });
    const elsewhere = await createPairing(store, { ...ALICE, workspace: 'ws_other' });
    const colleague = await createPairing(store, { ...BOB, workspace: 'ws_acme' });

    await store.endSessionsOf({ subject: 'alice', workspace: 'ws_acme' }, Date.now());

    assert.equal(
      (await redeemPairing(store, theirs.code, SECRET)).ok,
      false,
      'the code of a removed member opened a session',
    );
    assert.ok((await redeemPairing(store, elsewhere.code, SECRET)).ok);
    assert.ok((await redeemPairing(store, colleague.code, SECRET)).ok);
  });

  it('ends nothing, and throws, when neither a person nor a workspace is named', async (store) => {
    const { token, at } = await opened(store);

    await assert.rejects(
      store.endSessionsOf({ subject: '' } as never, at + 1),
      /names neither a person nor a workspace/,
    );
    await assert.rejects(
      store.endSessionsOf({ workspace: '' } as never, at + 1),
      /names neither a person nor a workspace/,
    );
    await assert.rejects(store.endSessionsOf({} as never, at + 1), /names neither a person nor a workspace/);

    assert.equal(await presented(store, token, at + 2), 'rotated');
  });

  /**
   * A refresh in flight when the member is removed. Whichever runs first, nothing of the chain is
   * live after both: a store that reads the live tokens, then ends the ones it read, misses the
   * successor that the refresh wrote meanwhile. On one connection nothing interleaves, and the case
   * holds a server and its control.
   */
  it('leaves no live successor when a refresh and the end of the sessions run at the same moment', async (store) => {
    const alice = { ...ALICE, workspace: 'ws_acme' };
    const { tokens, at } = await chainOf(store, alice, 0);
    const successor = createRefreshToken();
    // Digested before: the two calls below start in the same turn.
    const [tokenHash, successorHash] = await Promise.all([digest(tokens[0] as string), digest(successor)]);

    const [rotation] = await Promise.all([
      store.rotateSession({ tokenHash, successorHash, now: at + 1, graceMs: GRACE }),
      store.endSessionsOf({ subject: 'alice', workspace: 'ws_acme' }, at + 1),
    ]);

    assert.notEqual(rotation.outcome, 'reused');
    assert.notEqual(await presented(store, successor, at + 2), 'rotated', 'the successor of the refresh is live');
    assert.notEqual(await presented(store, tokens[0] as string, at + 3), 'rotated');
  });

  // --- Whether anybody paired (FRU-108)

  it('holds no session until a code is spent, and holds one after, ended or not', async (store) => {
    assert.equal(await store.holdsSession(), false);
    await createPairing(store, ALICE);
    assert.equal(await store.holdsSession(), false, 'a code that nobody spent is not a session');

    const { token, at } = await opened(store);
    assert.equal(await store.holdsSession(), true);
    await store.endSessionsOf({ subject: ALICE.subject }, at + 1);
    assert.notEqual(await presented(store, token, at + 2), 'rotated', 'the session ended');
    assert.equal(await store.holdsSession(), true, 'a session that ended is still a reviewer who paired');
  });

  // --- The chain a write reads again (FRU-238)

  it('names the chain of a token, the head for the first and every successor alike', async (store) => {
    const { token, at } = await opened(store);
    const head = await digest(token);
    const successor = await digest(createRefreshToken());
    await store.rotateSession({ tokenHash: head, successorHash: successor, now: at + 1, graceMs: GRACE });

    assert.equal(await store.chainOf(head), head);
    assert.equal(await store.chainOf(successor), head);
    assert.equal(await store.chainOf(await digest('a-token-nobody-has')), undefined);
  });

  it('answers the person of a chain while one of its tokens lives, and nobody once it ended or expired', async (store) => {
    const { token, at } = await opened(store);
    const chain = await digest(token);
    const successor = await digest(createRefreshToken());
    await store.rotateSession({ tokenHash: chain, successorHash: successor, now: at + 1, graceMs: GRACE });
    // The successor is live and the head is too, inside the grace: either keeps the person.
    assert.deepEqual(await store.liveIdentity(chain, at + 2), ALICE);
    assert.equal(await store.liveIdentity(chain, at + REFRESH_TTL_SECONDS * 1000), undefined, 'expired');

    await store.revokeSession(successor, at + 3);
    assert.equal(await store.liveIdentity(chain, at + 4), undefined, 'logged out');
    assert.equal(await store.liveIdentity(await digest('a-token-nobody-has'), at), undefined);

    const other = await opened(store, at);
    await store.endSessionsOf({ subject: ALICE.subject }, at + 5);
    assert.equal(await store.liveIdentity(await digest(other.token), at + 6), undefined, 'its person was removed');
  });

  // --- The purge

  it('drops the codes and the sessions that are expired, and nothing that is not', async (store) => {
    const at = Date.now();
    const spent = await opened(store, at);
    const { code } = await createPairing(store, ALICE, at);
    const codeHash = await digest(normalizePairingCode(code));
    const redeem = (now: number) =>
      store.redeemPairing({ codeHash, tokenHash: 'a-digest', expiresAt: now + REFRESH_TTL_SECONDS * 1000, now });

    await store.purge(at + PAIRING_TTL_SECONDS * 1000 - 1);
    assert.equal(await presented(store, spent.token, at), 'rotated', 'the purge took a session that is live');

    await store.purge(at + PAIRING_TTL_SECONDS * 1000);
    assert.equal(await redeem(at), undefined, 'a code past its expiry is still on file');

    await store.purge(at + REFRESH_TTL_SECONDS * 1000);
    assert.equal(await presented(store, spent.token, at), 'gone', 'a session past its expiry is still on file');
  });

  /**
   * Deleting a revoked session the moment it is revoked would make a replayed token read as unknown:
   * the leak signal is lost, and the chain of the thief stays live.
   */
  it('keeps a revoked session until it expires, so a replay of it still ends the chain', async (store) => {
    const { token, at } = await opened(store);
    const first = await refreshSession(store, token, SECRET, at);
    assert.ok(first.ok);
    const second = await refreshSession(store, first.refreshToken, SECRET, at + 1_000);
    assert.ok(second.ok);

    await store.purge(at + 2_000);

    assert.equal(await presented(store, token, at + 3_000), 'reused');
    assert.equal((await refreshSession(store, second.refreshToken, SECRET, at + 4_000)).ok, false);
  });
}
