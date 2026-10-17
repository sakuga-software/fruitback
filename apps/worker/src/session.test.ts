import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ACCESS_TTL_SECONDS,
  CODE_ALPHABET,
  PAIRING_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
  ROTATION_GRACE_SECONDS,
  createPairing,
  createPairingCode,
  normalizePairingCode,
  redeemPairing,
  refreshSession,
} from './session.ts';
import type { PgDatabase } from './postgres.ts';
import { createPgliteDatabase, rowsOf } from './postgres.fixture.ts';
import { createPostgresSessionStore } from './session-postgres.ts';
import { verifyIdentityToken } from './identity.ts';

const SECRET = 'a-worker-secret-nobody-else-has';
const ALICE = { subject: 'alice', name: 'Alice Martin', email: 'alice@acme.dev' };

const databases: PgDatabase[] = [];

/** The store of the worker, on an empty PGlite database. */
async function storeOnDatabase() {
  const database = await createPgliteDatabase();
  databases.push(database);

  return { store: createPostgresSessionStore(database), database };
}

afterEach(async () => {
  for (const database of databases.splice(0)) await database.close();
});

/**
 * What `session.ts` does above any store.
 *
 * The rules of every `SessionStore` are in `session-conformance.fixture.ts`, and
 * `session-conformance.test.ts` runs them on the store of the worker: pairing, rotation, log out and
 * the purge. `session-postgres.test.ts` holds what the database keeps of a session.
 */
describe('pairing', () => {
  // The store refuses a late code by its own comparison: that is a case of the conformance suite.
  // Here the code is late for `redeemPairing`, which purges first.
  it('refuses a code past its expiry', async () => {
    const { store } = await storeOnDatabase();
    const minted = Date.now();
    const { code } = await createPairing(store, ALICE, minted);

    const late = await redeemPairing(store, code, SECRET, minted + PAIRING_TTL_SECONDS * 1000 + 1);

    assert.equal(late.ok, false);
  });

  it('answers the same way for a code that never existed as for one already spent', async () => {
    const { store } = await storeOnDatabase();
    const { code } = await createPairing(store, ALICE);
    await redeemPairing(store, code, SECRET);

    const spent = await redeemPairing(store, code, SECRET);
    const invented = await redeemPairing(store, 'ZZZZ-ZZZZ-ZZZZ', SECRET);

    // Telling the two apart is how a caller enumerates which codes existed.
    assert.deepEqual(spent, invented);
  });

  it('reads a code back the way a person retypes it', async () => {
    const { store } = await storeOnDatabase();
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

describe('the pairing code, as it is drawn', () => {
  it('is three groups of four characters, each from the alphabet', () => {
    for (const code of Array.from({ length: 50 }, () => createPairingCode())) {
      assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    }
  });

  it('draws from the 32 symbols of Crockford base32, and from all of them', () => {
    assert.equal(CODE_ALPHABET, '0123456789ABCDEFGHJKMNPQRSTVWXYZ');

    // 24 000 characters. The chance that one of 32 symbols never comes is under 1e-300.
    const drawn = new Set(
      Array.from({ length: 2000 }, () => createPairingCode())
        .join('')
        .replaceAll('-', ''),
    );

    assert.deepEqual([...drawn].sort().join(''), CODE_ALPHABET);
  });

  it('does not draw the same code twice', () => {
    const codes = Array.from({ length: 200 }, () => createPairingCode());

    assert.equal(new Set(codes).size, codes.length);
  });
});

describe('the lifetimes of a session', () => {
  it('are a quarter of an hour for a pairing code, ten minutes for an access token, thirty days for a refresh token', () => {
    // In seconds, written out. SECURITY.md and docs/reviewing.md state the same durations, and
    // security.test.ts holds them to these constants.
    assert.equal(PAIRING_TTL_SECONDS, 900);
    assert.equal(ACCESS_TTL_SECONDS, 600);
    assert.equal(REFRESH_TTL_SECONDS, 2_592_000);
  });
});

describe('the access token', () => {
  it('is an ordinary identity token, so the read and write paths need no new check', async () => {
    const { store } = await storeOnDatabase();
    const { code } = await createPairing(store, ALICE);
    const redeemed = await redeemPairing(store, code, SECRET);

    assert.ok(redeemed.ok);
    const verified = await verifyIdentityToken(redeemed.session.accessToken, SECRET);

    assert.ok(verified.ok);
    // The whole point of the ticket: `verified` is the worker's word, on a session an operator opened.
    assert.deepEqual(verified.reporter, { id: 'alice', name: 'Alice Martin', email: 'alice@acme.dev', verified: true });
  });

  it('does not verify against another worker secret', async () => {
    const { store } = await storeOnDatabase();
    const { code } = await createPairing(store, ALICE);
    const redeemed = await redeemPairing(store, code, SECRET);

    assert.ok(redeemed.ok);
    const verified = await verifyIdentityToken(redeemed.session.accessToken, 'a-different-secret');

    assert.equal(verified.ok, false);
  });

  it('expires on its own, well before the refresh token does', async () => {
    const { store } = await storeOnDatabase();
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
    const { store } = await storeOnDatabase();
    const { code } = await createPairing(store, ALICE);
    const redeemed = await redeemPairing(store, code, SECRET);
    assert.ok(redeemed.ok);

    const refreshed = await refreshSession(store, redeemed.session.refreshToken, SECRET);

    assert.ok(refreshed.ok);
    assert.deepEqual(refreshed.identity, ALICE);
    assert.ok((await verifyIdentityToken(refreshed.accessToken, SECRET)).ok);
  });
});

/**
 * Rotation (FRU-61), in the database. What a rotation answers is in the conformance suite.
 */
describe('rotation', () => {
  /**
   * The property the store rests on, checked again on the tokens a rotation adds: a copy of the
   * database is not a set of working logins. A successor that had to be answered twice would have to
   * be stored in the clear, which is why a retry inside the grace mints a fresh one instead.
   */
  it('writes no rotated token into the database in the clear', async () => {
    const { store, database } = await storeOnDatabase();
    const redeemed = await redeemPairing(store, (await createPairing(store, ALICE)).code, SECRET);
    assert.ok(redeemed.ok);
    const token = redeemed.session.refreshToken;
    const first = await refreshSession(store, token, SECRET);
    assert.ok(first.ok);
    const second = await refreshSession(store, first.refreshToken, SECRET);
    assert.ok(second.ok);

    const tables = await rowsOf(
      database,
      'SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()',
    );
    let bytes = '';
    for (const { table_name: table } of tables)
      bytes += JSON.stringify(await rowsOf(database, `SELECT * FROM "${String(table)}"`));
    assert.ok(bytes.includes('alice@acme.dev'), 'the rows were read: they hold the identity of the session');

    for (const secret of [token, first.refreshToken, second.refreshToken]) {
      assert.equal(bytes.includes(secret), false, 'a refresh token is in the database the operator backs up');
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
