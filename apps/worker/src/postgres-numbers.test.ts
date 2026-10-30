import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'vitest';
import { type PgColumn, type PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { pendingDeliveryOf } from './account-rows.ts';
import { createPostgresAccountStore } from './accounts-postgres.ts';
import { startAuth } from './auth.ts';
import { optionsOn, signUp, withTestSignUp } from './auth.fixture.ts';
import * as authSchema from './auth-schema.ts';
import type { PgDatabase } from './postgres.ts';
import {
  NO_REAL_POSTGRES,
  TEST_DATABASE_URL,
  createPgliteDatabase,
  createRealDatabase,
  migrationsThrough,
  rowsOf,
} from './postgres.fixture.ts';
import { BEFORE_THE_MOVE, THEN, withRows } from './postgres-home-made.fixture.ts';
import { migrate } from './postgres-migrate.ts';
import * as schema from './postgres-schema.ts';
import { createPostgresConnectStore, createPostgresSessionStore } from './session-postgres.ts';

/**
 * What a `BIGINT` is when a store reads it (FRU-180).
 *
 * Until FRU-180 the pool of `postgres.ts` had a parser: every `BIGINT` that the driver answered was
 * a number, for any statement. Drizzle gives its own parsers to each statement, so that parser was
 * not read, and it is gone. A column is now a number because the schema says so
 * (`bigint(…, { mode: 'number' })`), and only when it is read through the schema.
 *
 * It matters because a row is parsed, never trusted: `account-rows.ts` reads an instant that is not
 * a number as no instant, and writes 1970 with no error. So every `BIGINT` of the schema is read
 * here, at the values where a number breaks.
 */

/** 2^31 and 2^32 are where an `INTEGER` ends, signed and not. The last one is the last exact number. */
const VALUES = [2 ** 31, 2 ** 32 + 1, Date.UTC(2026, 9, 11, 12, 30, 45, 678), Number.MAX_SAFE_INTEGER];

type Bigint = { table: PgTable; column: PgColumn; name: string; nullable: boolean };

function bigintsOf(tables: Record<string, unknown>): Bigint[] {
  return Object.values(tables).flatMap((table) => {
    const { name, columns } = getTableConfig(table as PgTable);

    return columns
      .filter((column) => column.getSQLType() === 'bigint')
      .map((column) => ({
        table: table as PgTable,
        column,
        name: `${name}.${column.name}`,
        nullable: !column.notNull,
      }));
  });
}

const BIGINTS = bigintsOf(schema);

const opened: PgDatabase[] = [];
afterEach(async () => {
  for (const database of opened.splice(0)) await database.close();
});

/**
 * A database with the schema of the worker, and a row or more in each of its tables: the rows of a
 * worker of before the accounts moved (FRU-146), then the migrations after it.
 */
async function withEveryTableFilled(open: () => Promise<PgDatabase>): Promise<PgDatabase> {
  const database = await open();
  opened.push(database);
  await migrate(database, migrationsThrough(BEFORE_THE_MOVE));
  await withRows(database);
  await migrate(database);
  // The tables that came after the move (FRU-103, FRU-44, FRU-67): `withRows` writes the schema of before it.
  await rowsOf(
    database,
    `INSERT INTO domains (id, workspace_id, domain, created_at, verified_at, lost_at, checked_at, previews_site_id) VALUES ('dom_1', 'ws_acme', 'acme.dev', 1, 1, 1, 1, 'site_acme')`,
  );
  await rowsOf(
    database,
    `INSERT INTO screenshots (id, workspace_id, account_id, content, width, height, created_at)
       VALUES ('shot_1', 'ws_acme', 'acc_alice', '\\x89504e47'::bytea, 1, 1, 1)`,
  );
  // One note and one reply (FRU-218). Their numbers are BIGINT too, and `write` puts one value in a
  // column at a time: the key from the reply to its note is taken off, or the two could not differ
  // for the time of one statement.
  await rowsOf(
    database,
    `INSERT INTO notes (client_id, page_url, stage, payload, created_at, updated_at) VALUES ('site_1', 'https://acme.dev/', 'new', '{}', 1, 1)`,
  );
  await rowsOf(database, `INSERT INTO note_comments (note_id, body, created_at) VALUES (1, 'a reply', 1)`);
  await rowsOf(database, 'ALTER TABLE note_comments DROP CONSTRAINT note_comments_note_id_fkey');
  await rowsOf(database, `INSERT INTO kv (key, value, expires_at) VALUES ('fruitback:test:count', '1', 1)`);
  // A site shared with a guest (FRU-250).
  await rowsOf(
    database,
    `INSERT INTO site_shares (workspace_id, account_id, site_id, created_at) VALUES ('ws_acme', 'acc_alice', 'site_acme', 1)`,
  );
  // An agent key, and a site it names (FRU-461).
  await rowsOf(
    database,
    `INSERT INTO agent_keys (id, workspace_id, name, key_hash, can_write, verified_only, created_by, created_at, expires_at, last_used_at)
       VALUES ('agk_1', 'ws_acme', 'CI', 'digest-of-a-key', false, true, 'acc_alice', 1, 1, 1)`,
  );
  await rowsOf(database, `INSERT INTO agent_key_sites (key_id, site_id) VALUES ('agk_1', 'site_acme')`);
  // A client of OAuth, and a token of a connection (FRU-467). The key above stands for the connection.
  await rowsOf(
    database,
    `INSERT INTO oauth_clients (id, name, redirect_uris, secret_hash, created_at)
       VALUES ('fbo_1', 'Claude', '["https://claude.ai/cb"]', NULL, 1)`,
  );
  await rowsOf(
    database,
    `INSERT INTO oauth_tokens (token_hash, kind, key_id, expires_at, used_at) VALUES ('digest-of-a-token', 'refresh', 'agk_1', 1, 1)`,
  );
  // The trigger of a site that starts an agent (FRU-468). Its connector is the one of the rows of
  // before: the database checks no kind.
  await rowsOf(
    database,
    `INSERT INTO site_agent_triggers (site_id, workspace_id, connector_id, moment, enabled, updated_at)
       VALUES ('site_acme', 'ws_acme', 'con_linear', 'verified-note', false, 1)`,
  );
  // A write of that key (FRU-464).
  await rowsOf(
    database,
    `INSERT INTO agent_writes (id, workspace_id, key_id, key_name, site_id, note_id, action, status, at)
       VALUES ('agw_1', 'ws_acme', 'agk_1', 'CI', 'site_acme', 'sd_1', 'reply', NULL, 1)`,
  );
  // A request of the extension, answered and claimed (FRU-238).
  await rowsOf(
    database,
    `INSERT INTO connect_requests (request_hash, claim_hash, word, browser, created_at, expires_at, outcome, account_id, answered_at, claimed_at)
       VALUES ('digest-of-a-request', 'digest-of-a-claim', 'PLUM 47', 'Chrome on macOS', 1, 1, 'approved', 'acc_alice', 1, 1)`,
  );
  // FRU-237: one row of the index of the notes.
  await rowsOf(
    database,
    `INSERT INTO note_index (site_id, note_id, workspace_id, page_url, excerpt, stage, author_kind, place, created_at, checked_at)
       VALUES ('site_acme', 'sd_1', 'ws_acme', 'https://acme.dev/', 'A note', 'new', 'visitor', 'fruitback', 1, 1)`,
  );
  // FRU-261: one read of an administrator of the instance.
  await rowsOf(
    database,
    `INSERT INTO admin_reads (id, workspace_id, admin_account_id, admin_email, what, at)
       VALUES ('adr_1', 'ws_acme', 'acc_alice', 'alice@acme.dev', 'workspace', 1)`,
  );
  // FRU-280: one action of an administrator of the instance.
  await rowsOf(
    database,
    `INSERT INTO admin_actions (id, at, actor_account_id, actor_email, action, target_account_id, target_email)
       VALUES ('ada_1', 1, 'acc_alice', 'alice@acme.dev', 'admin-named', 'acc_alice', 'alice@acme.dev')`,
  );
  // FRU-282: one workspace that an administrator of the instance suspended. Not `ws_acme`: its
  // deliveries would wait, and a case below reads them.
  await rowsOf(
    database,
    `INSERT INTO organization (id, name, slug, "createdAt") VALUES ('ws_unpaid', 'Unpaid', 'ws_unpaid', now())`,
  );
  await rowsOf(
    database,
    `INSERT INTO workspace_suspensions (workspace_id, since, reason) VALUES ('ws_unpaid', 1, 'impayé')`,
  );
  // FRU-428: the logo of a workspace.
  await rowsOf(
    database,
    `INSERT INTO workspace_logos (workspace_id, content_type, content, updated_at)
       VALUES ('ws_acme', 'image/png', '\\x89504e47'::bytea, 1)`,
  );
  // FRU-450: another address of an account, that Fruitback verified.
  await rowsOf(
    database,
    `INSERT INTO account_emails (email, account_id, verified_at, created_at)
       VALUES ('alice@home.example', 'acc_alice', 1, 1)`,
  );

  return database;
}

/** Writes `value` in every row of the column, with a statement that names no parameter. */
async function write({ table, column }: Bigint, database: PgDatabase, value: number | null): Promise<void> {
  await rowsOf(database, `UPDATE "${getTableConfig(table).name}" SET "${column.name}" = ${String(value)}`);
}

it('knows the fifty BIGINT columns of the worker, and that better-auth has none', () => {
  assert.deepEqual(BIGINTS.map(({ name }) => name).toSorted(), [
    'account_emails.created_at',
    'account_emails.verified_at',
    'admin_actions.at',
    'admin_reads.at',
    'agent_keys.created_at',
    'agent_keys.expires_at',
    'agent_keys.last_used_at',
    'agent_writes.at',
    'connect_requests.answered_at',
    'connect_requests.claimed_at',
    'connect_requests.created_at',
    'connect_requests.expires_at',
    'connectors.attention_at',
    'connectors.created_at',
    'deliveries.created_at',
    'deliveries.last_at',
    'deliveries.next_at',
    'domains.checked_at',
    'domains.created_at',
    'domains.lost_at',
    'domains.verified_at',
    'email_links.created_at',
    'email_links.expires_at',
    'email_links.spent_at',
    'kv.expires_at',
    'note_comments.created_at',
    'note_comments.id',
    'note_comments.note_id',
    'note_index.checked_at',
    'note_index.created_at',
    'notes.created_at',
    'notes.id',
    'notes.updated_at',
    'oauth_clients.created_at',
    'oauth_tokens.expires_at',
    'oauth_tokens.used_at',
    'pairings.created_at',
    'pairings.expires_at',
    'pairings.redeemed_at',
    'screenshots.created_at',
    'screenshots.expires_at',
    'sessions.created_at',
    'sessions.expires_at',
    'sessions.revoked_at',
    'sessions.rotated_at',
    'site_agent_triggers.updated_at',
    'site_shares.created_at',
    'sites.created_at',
    'workspace_logos.updated_at',
    'workspace_suspensions.since',
  ]);
  // better-auth reads its tables on the same pool, with no parser of ours: it has no BIGINT to read.
  assert.deepEqual(bigintsOf(authSchema), []);
});

for (const { label, open, skip } of [
  { label: 'PGlite', open: createPgliteDatabase, skip: false },
  { label: 'a real server', open: createRealDatabase, skip: NO_REAL_POSTGRES },
] as const) {
  describe(`a BIGINT that a store reads, on ${label} (FRU-180)`, { skip: skip !== false }, () => {
    it('is the number that was written, in every column, at 2^31, past 2^32 and at the last exact integer', async () => {
      const database = await withEveryTableFilled(open);
      const wrong: string[] = [];
      let read = 0;

      for (const value of VALUES) {
        for (const each of BIGINTS) {
          await write(each, database, value);
          const rows = await database.run((db) => db.select({ value: each.column }).from(each.table));
          read += rows.length;
          for (const row of rows) {
            if (row.value !== value) wrong.push(`${each.name}: wrote ${value}, read ${typeof row.value} ${row.value}`);
          }
        }
      }

      assert.ok(read >= VALUES.length * BIGINTS.length, `only ${read} values read: a table has no row`);
      assert.deepEqual(wrong, []);
    });

    it('is null when the column holds no instant, and never 0', async () => {
      const database = await withEveryTableFilled(open);
      const nullable = BIGINTS.filter((each) => each.nullable);
      const wrong: string[] = [];

      for (const each of nullable) {
        await write(each, database, null);
        for (const row of await database.run((db) => db.select({ value: each.column }).from(each.table))) {
          if (row.value !== null) wrong.push(`${each.name}: read ${typeof row.value} ${String(row.value)}`);
        }
      }

      assert.equal(nullable.length, 15);
      assert.deepEqual(wrong, []);
    });

    it('reaches the console as the instant that was given, through the store of the accounts', async () => {
      const database = await withEveryTableFilled(open);
      const accounts = createPostgresAccountStore(database);
      // Every instant that a date of JavaScript can hold: the last one is its last day.
      const instants = [2 ** 31, 2 ** 32 + 1, Date.UTC(2026, 9, 11, 12, 30, 45, 678), 8_640_000_000_000_000];

      for (const instant of instants) {
        const written = new Date(instant).toISOString();
        const id = await accounts.enqueueDelivery('con_linear', '{"title":"A note"}', instant);
        const delivery = (await accounts.deliveries('ws_acme', 'con_linear')).find((each) => each.id === id);
        assert.deepEqual(delivery, { id, createdAt: written, attempts: 0, nextAt: written });
        // Due at its own instant, and not one millisecond before.
        const due = async (now: number) => (await accounts.dueDeliveries(now, 100)).filter((each) => each.id === id);
        assert.deepEqual(await due(instant - 1), []);
        assert.deepEqual(await due(instant), [
          { id, connectorId: 'con_linear', body: '{"title":"A note"}', attempts: 0 },
        ]);

        // A refusal of another kind each time: a refusal of the same kind keeps its first moment.
        await accounts.noteConnector('con_linear', undefined, instant);
        await accounts.noteConnector('con_linear', 'key-refused', instant);
        const [connector] = await accounts.connectors('ws_acme');
        assert.deepEqual(connector?.attention, { reason: 'key-refused', since: written });
        assert.equal(connector?.createdAt, new Date(THEN).toISOString());

        // No more attempt: `next_at` is NULL, and the console must read « nobody will try again ».
        await accounts.settleDelivery(id, { delivered: false, attempts: 0, at: instant, status: 503 });
        const given = (await accounts.deliveries('ws_acme', 'con_linear')).find((each) => each.id === id);
        assert.deepEqual(given, { id, createdAt: written, attempts: 1, lastStatus: 503 });
      }
    });

    it('decides a pairing and a session by their instants, on each side of 2^32', async () => {
      const database = await withEveryTableFilled(open);
      const sessions = createPostgresSessionStore(database);
      const edge = 2 ** 32;
      const identity = { subject: 'acc_alice', workspace: 'ws_acme' };

      await sessions.createPairing({ codeHash: 'digest-late', identity, expiresAt: edge - 1 });
      await sessions.createPairing({ codeHash: 'digest-in-time', identity, expiresAt: edge + 1 });
      await sessions.createPairing({ codeHash: 'digest-in-time-too', identity, expiresAt: edge + 1 });
      const redeem = (codeHash: string, tokenHash: string) =>
        sessions.redeemPairing({ codeHash, tokenHash, expiresAt: edge + 10, now: edge });

      assert.equal(
        await redeem('digest-late', 'digest-of-a-token-1'),
        undefined,
        'a code that expired opened a session',
      );
      assert.deepEqual(await redeem('digest-in-time', 'digest-of-a-token-2'), identity);
      assert.deepEqual(await redeem('digest-in-time-too', 'digest-of-a-token-3'), identity);

      const rotate = (tokenHash: string, now: number) =>
        sessions.rotateSession({ tokenHash, successorHash: `successor-of-${tokenHash}-at-${now}`, now, graceMs: 5 });

      // `rotated_at`, plus the grace, is a sum of two numbers: the ceiling is 2^32 + 2 + 5.
      assert.deepEqual(await rotate('digest-of-a-token-2', edge + 2), { outcome: 'rotated', identity });
      assert.deepEqual(await rotate('digest-of-a-token-2', edge + 7), { outcome: 'rotated', identity });
      assert.deepEqual(await rotate('digest-of-a-token-2', edge + 8), { outcome: 'gone' });

      // `expires_at` is 2^32 + 10: live one millisecond before, gone at that instant.
      assert.deepEqual(await rotate('digest-of-a-token-3', edge + 9), { outcome: 'rotated', identity });
      assert.deepEqual(await rotate('digest-of-a-token-3', edge + 10), { outcome: 'gone' });
    });

    it('lists the browsers of an account by their instants, on each side of 2^32', async () => {
      const database = await withEveryTableFilled(open);
      const connect = createPostgresConnectStore(database);
      const sessions = createPostgresSessionStore(database);
      const edge = 2 ** 32;
      await connect.createRequest({
        requestHash: 'digest-of-request-2',
        claimHash: 'digest-of-claim-2',
        word: 'PEAR 12',
        browser: 'Firefox on Linux',
        now: edge,
        expiresAt: edge + 100,
        maxLive: 10,
      });
      assert.deepEqual(
        await connect.answer({
          requestHash: 'digest-of-request-2',
          account: 'acc_alice',
          outcome: 'approved',
          now: edge + 1,
        }),
        { ok: true },
      );
      const claimed = await connect.claim({
        claimHash: 'digest-of-claim-2',
        now: edge + 2,
        tokenHash: 'digest-of-a-token-of-alice',
        connectionId: 'connection-of-alice-0001',
        expiresAt: edge + 1000,
        open: async () => ({ name: 'Alice' }),
      });
      assert.deepEqual(claimed, { state: 'claimed', account: 'acc_alice', browser: 'Firefox on Linux' });
      const rotation = await sessions.rotateSession({
        tokenHash: 'digest-of-a-token-of-alice',
        successorHash: 'digest-of-its-successor',
        now: edge + 5,
        graceMs: 5,
      });
      assert.equal(rotation.outcome, 'rotated');

      assert.deepEqual(await connect.browsersOf('acc_alice', edge + 6), [
        { id: 'connection-of-alice-0001', browser: 'Firefox on Linux', connectedAt: edge + 2, usedAt: edge + 5 },
      ]);
      // Past its expiry, no token of it is live: it is not listed.
      assert.deepEqual(await connect.browsersOf('acc_alice', edge + 1000), []);
    });
  });
}

/**
 * The driver, before and after. PGlite cannot show it: its instance has a parser of its own.
 */
describe('the driver that ships, before and after FRU-180', { skip: NO_REAL_POSTGRES !== false }, () => {
  /** The pool as `postgres.ts` built it until FRU-180: `BIGINT` (type 20) is a number, for any statement. */
  function poolOfBefore(url: string): pg.Pool {
    return new pg.Pool({
      connectionString: url,
      max: 1,
      types: {
        getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
          oid === 20 ? Number : pg.types.getTypeParser(oid, format as 'text')) as typeof pg.types.getTypeParser,
      },
    });
  }

  it('answered a number for a raw statement, and now answers a string for it and a number through the schema', async () => {
    const database = await withEveryTableFilled(createRealDatabase);
    const value = 2 ** 32 + 1;
    const address = new URL(TEST_DATABASE_URL ?? '');
    address.pathname = `/${String((await rowsOf(database, 'SELECT current_database() AS name'))[0]?.name)}`;
    const before = poolOfBefore(address.href);
    const answers: Record<string, unknown[]> = {};

    try {
      for (const each of BIGINTS) {
        await write(each, database, value);
        const raw = `SELECT "${each.column.name}" AS value FROM "${getTableConfig(each.table).name}" LIMIT 1`;

        answers[each.name] = [
          (await before.query<{ value: unknown }>(raw)).rows[0]?.value,
          (await rowsOf(database, raw))[0]?.value,
          (await database.run((db) => db.select({ value: each.column }).from(each.table).limit(1)))[0]?.value,
        ];
      }
    } finally {
      await before.end();
    }

    assert.deepEqual(answers, Object.fromEntries(BIGINTS.map(({ name }) => [name, [value, String(value), value]])));
  });

  // The pool is the one better-auth takes, and `count(*)` is a BIGINT whatever the tables are.
  it('gives better-auth a count as a string, which better-auth reads as a number', async () => {
    const database = await createRealDatabase();
    opened.push(database);
    const { options } = await optionsOn(database);
    const auth = await startAuth(withTestSignUp(options));
    await signUp(auth, 'alice@acme.dev');
    await signUp(auth, 'bob@acme.dev');

    const pool = await database.pool();
    assert.deepEqual((await pool.query('SELECT count(*) AS people FROM "user"')).rows, [{ people: '2' }]);
    assert.equal(await (await auth.$context).adapter.count({ model: 'user' }), 2);
  });
});

describe('why the type of an instant matters (FRU-180)', () => {
  // The control of this file: the parser of a row does not fail on a string, it writes 1970.
  it('reads an instant that is a string as no instant, and says 1970 with no error', () => {
    const instant = Date.UTC(2026, 9, 11);

    assert.equal(
      pendingDeliveryOf({ id: 'dlv_1', created_at: String(instant) })?.createdAt,
      '1970-01-01T00:00:00.000Z',
    );
    assert.equal(pendingDeliveryOf({ id: 'dlv_1', created_at: instant })?.createdAt, '2026-10-11T00:00:00.000Z');
  });

  it('sends no raw statement from a store: a column is read through the schema, where it is a number', () => {
    const stores = {
      'accounts-postgres.ts': readFileSync(new URL('./accounts-postgres.ts', import.meta.url), 'utf8'),
      'session-postgres.ts': readFileSync(new URL('./session-postgres.ts', import.meta.url), 'utf8'),
    };

    for (const [file, source] of Object.entries(stores)) {
      assert.equal(source.includes('.execute('), false, `${file} sends a raw statement: its BIGINT is a string`);
      assert.match(source, /from '\.\/postgres-schema\.ts'/, `${file} no longer reads the schema`);
    }
    // A raw fragment is a string too when it is selected. Each one of today is in a `where` or a `set`
    // (the site of a delivery, FRU-194, is one), but three of the browsers of an account (FRU-238): `max` of a text, and `min` and `max` of an
    // instant, read through `mapWith` of the column, which test:`lists the browsers of an account by
    // their instants, on each side of 2^32` holds. Read a new one, then change its count here.
    // `sql<number>` too: a type between the tag and its text is still a raw fragment (FRU-238). One
    // more is selected: the key of the status of a note (FRU-386), `COALESCE` of two texts, a text.
    // Seven more for the other addresses of an account (FRU-450), each in a `where` or a `set`. Two
    // more for the calls of a trigger of a site that wait (FRU-468): the site of a delivery, in a `where`.
    // Two more for a page of sites (FRU-497): no site for a guest of none, and the host of an address,
    // each in a `where`.
    const fragments = (source: string): number => source.match(/\bsql(<[^>`]*>)?`/g)?.length ?? 0;
    assert.deepEqual(
      { accounts: fragments(stores['accounts-postgres.ts']), sessions: fragments(stores['session-postgres.ts']) },
      { accounts: 18, sessions: 9 },
    );
  });
});
