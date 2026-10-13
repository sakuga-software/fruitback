import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type Cases,
  type Subject,
  type Violation,
  describeConformance,
  describeControls,
  factoriesOf,
  mutatedModule,
  turn,
} from './conformance.fixture.ts';
import type { ConnectStore } from './connect.ts';
import { type ConnectSubject, connectCases } from './connect-conformance.fixture.ts';
import type { Database } from './postgres.ts';
import {
  NO_REAL_POSTGRES,
  createPgliteDatabase,
  createRealDatabase,
  outcomeOnChangedStore,
  rowsOf,
} from './postgres.fixture.ts';
import { createPostgresConnectStore } from './session-postgres.ts';

/**
 * The store of the requests of the extension (FRU-238), against its cases, on PGlite and on a server,
 * and on a store that breaks one rule for each case.
 *
 * A race is planted twice. On PGlite, by a store that reads a row, lets a turn of the event loop go,
 * and writes what it decided: PGlite has one connection, and the real store never interleaves there.
 * On a server, by the real store with its statement changed, and the row held by a trigger
 * (`outcomeOnChangedStore`): the case fails there, on its assertion.
 */

function on(label: string, open: () => Promise<Database>, skip: string | false = false): Subject<ConnectSubject> {
  let database: Database | undefined;

  return {
    factory: 'createPostgresConnectStore',
    label,
    ...(skip === false ? {} : { skip }),
    async open() {
      database = await open();

      return { store: createPostgresConnectStore(database), database };
    },
    async close() {
      await database?.close();
      database = undefined;
    },
  };
}

const PGLITE = on('the PostgreSQL connect store, on PGlite', createPgliteDatabase);
const SUBJECTS = [
  PGLITE,
  // The same store on a server, where two answers and two claims are two connections.
  on('the PostgreSQL connect store, on a real server', createRealDatabase, NO_REAL_POSTGRES),
];

for (const subject of SUBJECTS) describeConformance('ConnectStore', connectCases, subject);

describe('the ConnectStore conformance suite', () => {
  it('runs for every implementation the worker exports', () => {
    assert.deepEqual([...new Set(SUBJECTS.map((subject) => subject.factory))].sort(), factoriesOf('ConnectStore'));
  });
});

/** A row of a request, read with no lock, as a store that never saw two connections reads it. */
async function requestRow(database: Database, where: string): Promise<Record<string, unknown> | undefined> {
  return (await rowsOf(database, `SELECT * FROM connect_requests WHERE ${where}`))[0];
}

/**
 * The real store, with its answers, its claims and its words decided on a read and written a turn
 * later. One call after the other it answers as the real one does.
 */
function decidesThenWaits({ store, database }: ConnectSubject): ConnectSubject {
  return {
    database,
    store: {
      ...store,
      async answer({ requestHash, account, outcome, now }) {
        const row = await requestRow(database, `request_hash = '${requestHash}'`);
        if (row === undefined) return { ok: false, reason: 'unknown' };
        if (row.outcome !== null) return { ok: false, reason: 'already' };
        await turn();
        await rowsOf(
          database,
          `UPDATE connect_requests SET outcome = '${outcome}', account_id = '${account}', answered_at = ${now}
             WHERE request_hash = '${requestHash}'`,
        );

        return { ok: true };
      },
      async claim(claim) {
        const row = await requestRow(database, `claim_hash = '${claim.claimHash}'`);
        if (row?.outcome !== 'approved' || row.claimed_at !== null) return store.claim(claim);
        await turn();
        await rowsOf(
          database,
          `UPDATE connect_requests SET claimed_at = ${claim.now} WHERE claim_hash = '${claim.claimHash}'`,
        );
        await rowsOf(
          database,
          `INSERT INTO sessions (token_hash, subject, created_at, expires_at, account_id, browser, connection_id)
             VALUES ('${claim.tokenHash}', '${String(row.account_id)}', ${claim.now}, ${claim.expiresAt},
                     '${String(row.account_id)}', 'A browser', '${claim.connectionId}')`,
        );

        return { state: 'claimed', account: String(row.account_id), browser: String(row.browser) };
      },
      async miss(requestHash, now, max) {
        const row = await requestRow(database, `request_hash = '${requestHash}'`);
        if (row === undefined || row.outcome !== null) return undefined;
        const misses = Number(row.misses) + 1;
        await turn();
        await rowsOf(
          database,
          `UPDATE connect_requests SET misses = ${misses}${misses >= max ? `, outcome = 'refused', answered_at = ${now}` : ''}
             WHERE request_hash = '${requestHash}'`,
        );

        return max - misses;
      },
    },
  };
}

const WHERE_LIVE =
  'and(isNull(connect_requests.outcome), isNull(connect_requests.claimed_at), gt(connect_requests.expires_at, now))';
const CLAIMED_ONCE = 'and(eq(connect_requests.claim_hash, claimHash), isNull(connect_requests.claimed_at))';

const VIOLATIONS: Violation<ConnectSubject>[] = [
  {
    breaks: 'keeps a request as it was made, and reads it by the digest of its id only',
    by: 'reads a request by its claim too',
    replace: {
      after: 'async readRequest(requestHash)',
      from: '.where(eq(connect_requests.request_hash, requestHash))',
      to: '.where(or(eq(connect_requests.request_hash, requestHash), eq(connect_requests.claim_hash, requestHash)))',
    },
  },
  {
    breaks: 'answers a request once: a second answer of either kind, by anybody, changes nothing',
    by: 'answers a request that was answered',
    replace: { from: 'and(isNull(connect_requests.outcome), isNull', to: 'and(isNull' },
  },
  {
    breaks: 'gives one answer to an approval and a refusal at the same moment',
    by: 'reads a request, waits, then answers what it decided',
    wrap: decidesThenWaits,
  },
  {
    breaks: 'refuses an answer at the expiry of the request, and after',
    by: 'answers a request at the instant it expires',
    replace: {
      from: WHERE_LIVE,
      to: WHERE_LIVE.replace('gt(connect_requests.expires_at, now)', 'gt(connect_requests.expires_at, now - 1)'),
    },
  },
  {
    breaks: 'answers pending before an answer and refused after a refusal, and writes no session for either',
    by: 'answers a request that waits as one that is gone',
    replace: {
      from: "if (row.outcome !== 'approved' || row.account_id === null) return { state: 'pending' };",
      to: "if (row.outcome !== 'approved' || row.account_id === null) return { state: 'gone' };",
    },
  },
  {
    breaks: 'answers pending before an answer and refused after a refusal, and writes no session for either',
    by: 'answers a refused request as one that waits',
    replace: {
      from: "if (row.outcome === 'refused') return { state: 'refused' };",
      to: "if (row.outcome === 'refused') return { state: 'pending' };",
    },
  },
  {
    breaks: 'claims an approved request once, and writes a session of the account, of no workspace',
    by: 'claims a request that was claimed',
    replace: { from: CLAIMED_ONCE, to: 'eq(connect_requests.claim_hash, claimHash)' },
  },
  {
    breaks: 'claims an approved request once, and writes a session of the account, of no workspace',
    by: 'writes the session of a claim with no account',
    replace: {
      from: '          account_id: claimed.account_id,\n          browser',
      to: '          account_id: null,\n          browser',
    },
  },
  {
    breaks: 'gives one session to two claims of one request at the same moment',
    by: 'reads a claim, waits, then writes what it decided',
    wrap: decidesThenWaits,
  },
  {
    breaks: 'refuses a claim at the expiry of the request, approved or not',
    by: 'claims a request past its expiry',
    replace: {
      after: 'async claim({',
      from: 'if (row === undefined || row.expires_at <= now)',
      to: 'if (row === undefined)',
    },
  },
  {
    breaks: 'refuses a claim at the expiry of the request, approved or not',
    by: 'claims a request at the instant it expires',
    replace: {
      after: 'async claim({',
      from: 'if (row === undefined || row.expires_at <= now)',
      to: 'if (row === undefined || row.expires_at < now)',
    },
  },
  {
    breaks: 'leaves the request to claim when the session cannot be written',
    by: 'spends the claim apart from the session',
    replace: {
      after: 'async claim({',
      from: 'return transaction(async (tx) => {',
      to: 'return run(async (tx) => {',
    },
  },
  {
    breaks: 'opens nothing for an account that is gone at the claim',
    by: 'opens a session for an account that is gone',
    replace: {
      from: 'const person = await open(claimed.account_id);',
      to: 'const person = (await open(claimed.account_id)) ?? {};',
    },
  },
  {
    breaks: 'counts the wrong words of a waiting request, and refuses it at the last one allowed',
    by: 'never refuses a request for its words',
    replace: { from: ">= ${max} THEN 'refused'", to: '>= ${max} THEN NULL' },
  },
  {
    breaks: 'refuses a request at the last word allowed when the words come at the same moment',
    by: 'reads the words, waits, then writes what it counted',
    wrap: decidesThenWaits,
  },
  {
    breaks: 'stops at the requests allowed to wait, and counts no answered, claimed or expired one',
    by: 'never stops',
    replace: { from: "if ((waiting?.count ?? 0) >= maxLive) return 'busy';", to: '' },
  },
  {
    breaks: 'stops at the requests allowed to wait, and counts no answered, claimed or expired one',
    by: 'counts every request it holds',
    replace: { from: '.from(connect_requests).where(live(now));', to: '.from(connect_requests);' },
  },
  {
    breaks: 'lists the browsers of an account, one by connection, live ones only, and of no other account',
    by: 'lists the connections that ended',
    replace: {
      from: '.having(sql`bool_or(${sessions.revoked_at} IS NULL AND ${sessions.expires_at} > ${now})`)',
      to: '.having(sql`true`)',
    },
  },
  {
    breaks: 'lists the browsers of an account, one by connection, live ones only, and of no other account',
    by: 'lists the browsers of every account',
    replace: { from: '.where(eq(sessions.account_id, account))\n          .groupBy', to: '.groupBy' },
  },
  {
    breaks: 'ends a connection of its own account only, every token of it, and says when it ended none',
    by: 'ends a connection of another account',
    replace: {
      from: 'const theirs = and(eq(sessions.account_id, account), eq(sessions.connection_id, connectionId));',
      to: 'const theirs = eq(sessions.connection_id, connectionId);',
    },
  },
  {
    breaks: 'ends a connection of its own account only, every token of it, and says when it ended none',
    by: 'says it ended a connection that had ended',
    replace: { from: 'return ended.length > 0;', to: 'return true;' },
  },
  {
    breaks: 'drops the requests that expired, and none that lives',
    by: 'drops every request',
    replace: { from: '.where(lte(connect_requests.expires_at, now))', to: '' },
  },
];

describeControls('ConnectStore', connectCases, VIOLATIONS, PGLITE, async (change) => {
  const mutant = await mutatedModule('session-postgres.ts', change);
  let database: Database | undefined;

  return {
    factory: 'createPostgresConnectStore',
    label: 'a changed PostgreSQL connect store',
    async open() {
      database = await createPgliteDatabase();
      const create = mutant.module.createPostgresConnectStore as (database: Database) => ConnectStore;

      return { store: create(database), database };
    },
    async close() {
      await database?.close();
      database = undefined;
      mutant.remove();
    },
  };
});

/**
 * Two claims of one request, on two connections of a server (FRU-238). The first claim has spent the
 * request and has not written its session yet: a trigger holds the row. A store that reads the claim
 * apart from the statement that spends it gives the second claim a session too.
 */
describe('two claims of one request at the same moment, on two connections (FRU-238)', () => {
  const storeOnly: Cases<ConnectStore> = (declare) =>
    connectCases((name, run) => declare(name, (store) => run({ store, database: undefined as unknown as Database })));
  const READS_THE_CLAIM_APART = {
    from: CLAIMED_ONCE,
    to: 'and(eq(connect_requests.claim_hash, claimHash), sql`EXISTS (SELECT 1 FROM connect_requests apart WHERE apart.claim_hash = ${claimHash} AND apart.claimed_at IS NULL)`)',
  };
  const outcomeOf = (open: () => Promise<Database>) =>
    outcomeOnChangedStore({
      file: 'session-postgres.ts',
      factory: 'createPostgresConnectStore',
      cases: storeOnly,
      name: 'gives one session to two claims of one request at the same moment',
      change: READS_THE_CLAIM_APART,
      held: { table: 'sessions' },
      open,
    });

  it('passes on PGlite with a claim that is read apart from the statement that spends it', async () => {
    assert.equal(await outcomeOf(createPgliteDatabase), 'passed');
  });

  it(
    'fails on a real server with a claim that is read apart from the statement that spends it',
    { skip: NO_REAL_POSTGRES },
    async () => {
      const outcome = await outcomeOf(createRealDatabase);
      assert.ok(
        outcome instanceof assert.AssertionError,
        `the case did not fail on its assertion, on a store that loses the race: ${String(outcome)}`,
      );
    },
  );
});
