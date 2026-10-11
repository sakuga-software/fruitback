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

/**
 * What `session.ts` does above any store, and what is true of the SQLite file alone.
 *
 * The rules of every `SessionStore` are in `session-conformance.fixture.ts`, and
 * `session-conformance.test.ts` runs them on this store: pairing, rotation, log out and the purge.
 */
describe('pairing', () => {
  // The store refuses a late code by its own comparison: that is a case of the conformance suite.
  // Here the code is late for `redeemPairing`, which purges first.
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

describe('a row nobody can trust', () => {
  /**
   * `A row is parsed, never trusted` — the rule this repo already states for the seed store. The file
   * sits on a volume an operator can edit and a restore can be older than the code.
   *
   * **SQLite narrows what can actually arrive, and the first version of this test got that wrong.**
   * The column has `TEXT` affinity, so an integer or a float written into it comes back as a string
   * (`42` reads as `"42.0"`) and never reaches the guard as a non-string. Measured. What does reach
   * it is a **BLOB**, which keeps its type and arrives as an object, and an empty string, which a
   * `NOT NULL` column happily holds. The blob is the case below; the empty string is a case of the
   * conformance suite, because every store can hold one.
   */
  it('refuses a pairing whose subject is a blob, which keeps its type through TEXT affinity', async () => {
    const { store } = storeOnDisk();
    const code = createPairingCode();

    await store.createPairing({
      codeHash: await digest(normalizePairingCode(code)),
      identity: { subject: Buffer.from('alice') } as unknown as Parameters<typeof store.createPairing>[0]['identity'],
      expiresAt: Date.now() + 60_000,
    });

    const redeemed = await redeemPairing(store, code, SECRET);

    assert.equal(redeemed.ok, false, 'a malformed row minted a session');
  });
});

/**
 * Rotation (FRU-61), in the file. What a rotation answers is in the conformance suite.
 */
describe('rotation', () => {
  /**
   * The property the whole file rests on, re-checked on the tokens a rotation adds: a copy of this
   * database is not a set of working logins. A successor that had to be answered twice would have to
   * be stored in the clear, which is why a retry inside the grace mints a fresh one instead.
   */
  it('writes no rotated token into the database in the clear', async () => {
    const { store, path } = storeOnDisk();
    const redeemed = await redeemPairing(store, (await createPairing(store, ALICE)).code, SECRET);
    assert.ok(redeemed.ok);
    const token = redeemed.session.refreshToken;
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
 * The upgrade path, which a test on a fresh file never walks (FRU-61).
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
