import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sql } from 'drizzle-orm';
import { createPostgresAccountStore } from './accounts-postgres.ts';
import { handleRequest, sessionStoreFor } from './app.ts';
import { type WorkerEnv, hasSessions, readConfig } from './env.ts';
import { createMemoryKv } from './kv.ts';
import { type Database, closeDatabases, createPgDatabase } from './postgres.ts';
import {
  NO_REAL_POSTGRES,
  createPgliteDatabase,
  createRealDatabase,
  outcomeOnChangedStore,
  ownDatabase,
  rowsOf,
} from './postgres.fixture.ts';
import { sessionCases } from './session-conformance.fixture.ts';
import { createPostgresSessionStore } from './session-postgres.ts';
import {
  type SessionStore,
  createPairing,
  digest,
  normalizePairingCode,
  redeemPairing,
  refreshSession,
  revokeSession,
} from './session.ts';

// The database of this environment is at an address where nothing listens: a case hands its stores
// over, and the `Kv` with them, as the transport does (FRU-67).
const kv = createMemoryKv();

/**
 * What is true of the PostgreSQL session store alone (FRU-142). The rules of every `SessionStore`
 * are in `session-conformance.fixture.ts`, and `session-conformance.test.ts` runs them on this store.
 */

const run = promisify(execFile);
const SECRET = 'a-worker-secret-of-exactly-enough';
const PASSWORD = 'hunter2-not-for-a-log';
// Port 1 of this machine: nothing listens there.
const DATABASE_URL = `postgres://fruitback:${PASSWORD}@127.0.0.1:1/fruitback`;

/** A worker on a database: the accounts and the sessions are both in it. */
function envWith(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    FRUITBACK_STORE: 'memory',
    ALLOWED_ORIGINS: 'https://app.fruitback.test',
    FRUITBACK_IDENTITY_SECRET: SECRET,
    FRUITBACK_DATABASE_URL: DATABASE_URL,
    FRUITBACK_CONSOLE_URL: 'https://app.fruitback.test',
    ...overrides,
  };
}

describe('a worker whose sessions are in PostgreSQL (FRU-142)', () => {
  it('keeps its sessions in the database of its accounts, and names no session file', () => {
    const config = readConfig(envWith());

    assert.ok(config.ok, config.ok ? '' : config.missing.join(', '));
    assert.equal(config.config.sessionPath, undefined);
    assert.equal(hasSessions(config.config), true);
    assert.ok(sessionStoreFor(config.config) !== undefined);
  });

  it('refuses a session file beside the database', () => {
    const both = readConfig(envWith({ FRUITBACK_SESSION_PATH: '/data/sessions.db' }));

    assert.deepEqual(both.ok === false && both.missing, [
      'FRUITBACK_SESSION_PATH (FRUITBACK_DATABASE_URL is set, and the sessions are in that database)',
    ]);
  });

  it('leaves a worker without a database on its session file, and one without sessions with none', () => {
    const onFile = readConfig({
      FRUITBACK_STORE: 'memory',
      ALLOWED_ORIGINS: 'https://acme.dev',
      FRUITBACK_IDENTITY_SECRET: SECRET,
      FRUITBACK_SESSION_PATH: '/data/sessions.db',
    });
    assert.ok(onFile.ok, onFile.ok ? '' : onFile.missing.join(', '));
    assert.equal(onFile.config.sessionPath, '/data/sessions.db');
    assert.equal(hasSessions(onFile.config), true);

    const none = readConfig({ FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: 'https://acme.dev' });
    assert.ok(none.ok, none.ok ? '' : none.missing.join(', '));
    assert.equal(hasSessions(none.config), false);
    assert.equal(sessionStoreFor(none.config), undefined);
  });

  /**
   * The worker reads its sites before it routes a request, so a database that is down answers `502`
   * there, for every route, and the store of the sessions is never asked: that is the test of
   * FRU-141. Here the accounts answer and the sessions do not, so a request reaches the three
   * routes. The first version of this test did not give the accounts, and passed with a route that
   * does not exist. Raised in review.
   */
  it('answers the three session routes as a store that is down when the sessions do not answer', async () => {
    const answering = await createPgliteDatabase();
    const accounts = createPostgresAccountStore(answering);
    let ip = 40;
    const post = (path: string, body: Record<string, string>) => {
      ip += 1;

      return handleRequest(
        new Request(`https://worker.test${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'https://app.fruitback.test' },
          body: JSON.stringify(body),
        }),
        // The address of the sessions is one where nothing listens.
        envWith(),
        { clientIp: `192.0.2.${ip}`, kv, accounts },
      );
    };

    try {
      // The control: the request is routed. A path that is no session route answers `404` here,
      // and `502` when the accounts do not answer either.
      assert.equal((await post('/session/logout', { refreshToken: 'a'.repeat(43) })).status, 404);

      for (const [path, body] of [
        ['/session/pair', { code: 'ABCD-EFGH-JKLM' }],
        ['/session/refresh', { refreshToken: 'a'.repeat(43) }],
        ['/session/revoke', { refreshToken: 'a'.repeat(43) }],
      ] as const) {
        const response = await post(path, body);
        const said = await response.text();

        // `502` and not `401`: the extension keeps its session and tries again, as with a file on
        // a volume that is not mounted.
        assert.equal(response.status, 502, `${path}: ${said}`);
        assert.deepEqual(JSON.parse(said), { error: 'store-unavailable' });
        assert.equal(said.includes(PASSWORD), false, said);
      }
    } finally {
      await closeDatabases();
      await answering.close();
    }
  });
});

/**
 * « A copy of the database is not a way in. » The SQLite store has a test that reads the bytes of
 * its file. Here every row of every table of the schema is read, so a table that a later migration
 * adds is read too.
 */
describe('what the database holds of a session (FRU-142)', () => {
  let database: Database | undefined;

  afterEach(async () => {
    await database?.close();
    database = undefined;
  });

  /** The tables in which one of these values is written. */
  async function tablesThatHold(opened: Database, values: readonly string[]): Promise<string[]> {
    const tables = await rowsOf(
      opened,
      'SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name',
    );
    const holding: string[] = [];
    for (const { table_name: table } of tables) {
      const written = JSON.stringify(await rowsOf(opened, `SELECT * FROM ${String(table)}`));
      if (values.some((value) => written.includes(value))) holding.push(String(table));
    }

    return holding;
  }

  /** A code that was spent, a session that was refreshed, and one that was logged out. */
  async function lived(opened: Database): Promise<{ secrets: string[]; firstToken: string }> {
    const store = createPostgresSessionStore(opened);
    const { code } = await createPairing(store, { subject: 'alice', name: 'Alice Martin', email: 'alice@acme.dev' });
    const { code: unspent } = await createPairing(store, { subject: 'bob' });
    const redeemed = await redeemPairing(store, code, SECRET);
    assert.ok(redeemed.ok);
    const refreshed = await refreshSession(store, redeemed.session.refreshToken, SECRET);
    assert.ok(refreshed.ok);
    assert.equal(await revokeSession(store, refreshed.refreshToken), true);

    return {
      firstToken: redeemed.session.refreshToken,
      secrets: [
        code,
        normalizePairingCode(code),
        unspent,
        normalizePairingCode(unspent),
        redeemed.session.refreshToken,
        redeemed.session.accessToken,
        refreshed.refreshToken,
        refreshed.accessToken,
      ],
    };
  }

  it('holds no code and no token in clear, in any row of any table', async () => {
    database = await createPgliteDatabase();
    const { secrets, firstToken } = await lived(database);

    assert.deepEqual(await tablesThatHold(database, secrets), []);
    // The rows were read: the digest of a token is where it is expected, and only there.
    assert.deepEqual(await tablesThatHold(database, [await digest(firstToken)]), ['sessions']);
  });

  it('finds a token that a row holds in clear', async () => {
    database = await createPgliteDatabase();
    const { secrets, firstToken } = await lived(database);

    // A store that kept the token would write it in a column like this one.
    await rowsOf(database, sql`UPDATE sessions SET name = ${firstToken} WHERE subject = ${'alice'}`);

    assert.deepEqual(await tablesThatHold(database, secrets), ['sessions']);
  });
});

/**
 * What only a real server shows. PGlite has one connection, so two calls never overlap there. Each
 * change below is a store that is correct one call after the other: it passes on PGlite, and on a
 * server the case refuses it. `outcomeOnChangedStore` makes the two calls overlap.
 */
describe('two calls on one session at the same moment, on two connections (FRU-142)', () => {
  const outcomeOf = (
    name: string,
    change: { from: string; to: string },
    held: { table: string; when?: string },
    open: () => Promise<Database>,
  ) =>
    outcomeOnChangedStore({
      file: 'session-postgres.ts',
      factory: 'createPostgresSessionStore',
      cases: sessionCases,
      name,
      change,
      held,
      open,
    });

  // The code is read in a subquery, as a statement that never saw two connections reads it. The
  // second call waits for the row, then reads the code as it was when its statement started.
  const READS_THE_CODE_APART = {
    from: '.where(and(eq(pairings.code_hash, codeHash), isNull(pairings.redeemed_at), gt(pairings.expires_at, now)))',
    to: [
      '.where(and(eq(pairings.code_hash, codeHash), sql`EXISTS (SELECT 1 FROM pairings spent',
      '  WHERE spent.code_hash = ${codeHash} AND spent.redeemed_at IS NULL AND spent.expires_at > ${now})`))',
    ].join('\n'),
  };
  // Nothing holds the chain: two calls read the token before either writes.
  // (The text is the one of `holdChain`, by its indentation: `endSessionsOf` holds rows too.)
  const WITHOUT_THE_CHAIN = {
    from: ".orderBy(sessions.token_hash)\n    .for('update');",
    to: '.orderBy(sessions.token_hash);',
  };
  // The first call has decided, and has not written the session yet.
  const A_SESSION = { table: 'sessions' };
  const A_SUCCESSOR = { table: 'sessions', when: 'NEW.predecessor_hash IS NOT NULL' };

  const REDEEMED_TWICE = 'gives one session to two reviewers who redeem one code at the same moment';
  const REFRESHED_TWICE = 'never leaves two live successors when one token is refreshed twice at the same moment';
  const TOKEN_AND_SUCCESSOR = 'ends the session when a token and its successor are refreshed at the same moment';

  /** An assertion of the case, and not an error of the database: the store answered, and wrongly. */
  function failedOnItsAssertion(outcome: unknown): void {
    assert.ok(
      outcome instanceof assert.AssertionError,
      `the case did not fail on its assertion, on a store that loses the race: ${String(outcome)}`,
    );
  }

  it('passes on PGlite with a code that is read apart from the statement that spends it', async () => {
    assert.equal(await outcomeOf(REDEEMED_TWICE, READS_THE_CODE_APART, A_SESSION, createPgliteDatabase), 'passed');
  });

  it(
    'fails on a real server with a code that is read apart from the statement that spends it',
    { skip: NO_REAL_POSTGRES },
    async () => {
      failedOnItsAssertion(await outcomeOf(REDEEMED_TWICE, READS_THE_CODE_APART, A_SESSION, createRealDatabase));
    },
  );

  it('passes on PGlite with no lock on the chain', async () => {
    assert.equal(await outcomeOf(REFRESHED_TWICE, WITHOUT_THE_CHAIN, A_SUCCESSOR, createPgliteDatabase), 'passed');
  });

  it('fails on a real server with no lock on the chain', { skip: NO_REAL_POSTGRES }, async () => {
    failedOnItsAssertion(await outcomeOf(REFRESHED_TWICE, WITHOUT_THE_CHAIN, A_SUCCESSOR, createRealDatabase));
  });

  it('passes on PGlite with no lock on the chain, for a token and its successor', async () => {
    assert.equal(await outcomeOf(TOKEN_AND_SUCCESSOR, WITHOUT_THE_CHAIN, A_SUCCESSOR, createPgliteDatabase), 'passed');
  });

  it(
    'fails on a real server with no lock on the chain, for a token and its successor',
    { skip: NO_REAL_POSTGRES },
    async () => {
      failedOnItsAssertion(await outcomeOf(TOKEN_AND_SUCCESSOR, WITHOUT_THE_CHAIN, A_SUCCESSOR, createRealDatabase));
    },
  );
});

/**
 * A member is removed while their extension refreshes (FRU-149). The refresh holds its chain and has
 * written a successor that it did not commit yet; the end of the sessions waits for it. One statement
 * that ends the tokens it could see when it started does not see that successor, which stays live:
 * the store holds every chain of the person first, and only then reads what to end.
 */
describe('the sessions of a member end while one of them refreshes, on two connections (FRU-149)', () => {
  const IN_FLIGHT = 'ends the successor of a refresh that was in flight';
  const identity = { subject: 'alice', workspace: 'ws_acme' };
  const inFlight = (it: (name: string, run: (store: SessionStore) => Promise<void>) => void): void =>
    it(IN_FLIGHT, async (store) => {
      const now = Date.now();
      const redeemed = await redeemPairing(store, (await createPairing(store, identity, now)).code, SECRET, now);
      assert.ok(redeemed.ok);
      const [tokenHash, successorHash] = await Promise.all([
        digest(redeemed.session.refreshToken),
        digest('a-successor'),
      ]);

      const rotating = store.rotateSession({ tokenHash, successorHash, now: now + 1, graceMs: 60_000 });
      // The trigger holds the successor inside the transaction of the refresh: the end starts then.
      await new Promise((resolve) => setTimeout(resolve, 100));
      await store.endSessionsOf(identity, now + 2);

      assert.deepEqual(await rotating, { outcome: 'rotated', identity }, 'the refresh did not run first');
      const after = await store.rotateSession({
        tokenHash: successorHash,
        successorHash: await digest('another'),
        now: now + 3,
        graceMs: 60_000,
      });
      assert.notEqual(after.outcome, 'rotated', 'the successor of the refresh is live after the sessions ended');
    });
  const outcomeOf = (change: { from: string; to: string }, open: () => Promise<Database>) =>
    outcomeOnChangedStore({
      file: 'session-postgres.ts',
      factory: 'createPostgresSessionStore',
      cases: inFlight,
      name: IN_FLIGHT,
      change,
      held: { table: 'sessions', when: 'NEW.predecessor_hash IS NOT NULL' },
      open,
    });
  // The chains are read, and not held.
  const WITHOUT_THE_HOLD = {
    from: ".orderBy(sessions.token_hash)\n          .for('update');",
    to: '.orderBy(sessions.token_hash);',
  };
  // The store as it is, through the same machinery: the case can pass.
  const AS_IT_IS = { from: 'A code that nobody redeemed yet', to: 'A code that nobody has redeemed yet' };

  it('passes on PGlite with no hold on the chains of the person', async () => {
    assert.equal(await outcomeOf(WITHOUT_THE_HOLD, createPgliteDatabase), 'passed');
  });

  it('fails on a real server with no hold on the chains of the person', { skip: NO_REAL_POSTGRES }, async () => {
    const outcome = await outcomeOf(WITHOUT_THE_HOLD, createRealDatabase);

    assert.ok(outcome instanceof assert.AssertionError, `the case did not fail on its assertion: ${String(outcome)}`);
    assert.match(outcome.message, /the successor of the refresh is live/);
  });

  it('passes on a real server with the store as it is', { skip: NO_REAL_POSTGRES }, async () => {
    assert.equal(await outcomeOf(AS_IT_IS, createRealDatabase), 'passed');
  });
});

/**
 * `node server.mjs pair` on a worker that has a database. It runs as a process of its own: what is
 * held is that the code is written where the worker reads it, and that the command ends.
 */
describe('the pair command of a worker on a database (FRU-142)', () => {
  let database: Database | undefined;

  afterEach(async () => {
    await database?.close();
    database = undefined;
  });

  it('writes the digest of its code in the database, and ends', { skip: NO_REAL_POSTGRES }, async () => {
    // The worker takes one address: the database of this test, which the command migrates itself.
    const own = await ownDatabase();
    database = createPgDatabase(own.url, { max: 1 });
    const opened = database;
    database = { ...opened, close: async () => opened.close().then(own.drop) };

    // Less than the ten seconds an idle connection of the pool lives: a command that leaves the
    // pool open is still running when this gives up.
    const { stdout } = await run(process.execPath, ['src/main.ts', 'pair', '--subject', 'alice'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { PATH: process.env.PATH, ...envWith({ FRUITBACK_DATABASE_URL: own.url }) },
      timeout: 8_000,
    });

    const code = /^ {4}(\S+)$/m.exec(stdout)?.[1];
    assert.ok(code !== undefined, stdout);
    assert.match(stdout, /^pairing code for alice:/);
    assert.deepEqual(await rowsOf(database, 'SELECT subject, code_hash, redeemed_at FROM pairings'), [
      { subject: 'alice', code_hash: await digest(normalizePairingCode(code)), redeemed_at: null },
    ]);
  });
});
