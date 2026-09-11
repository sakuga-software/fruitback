import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACCESS_TTL_SECONDS,
  PAIRING_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
  createPairing,
  createPairingCode,
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
