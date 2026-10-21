import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, describe, it } from 'node:test';
import { PGlite, types } from '@electric-sql/pglite';
import { INITDB_FILE, databaseOn, migratedDatabaseOn, newPglite, shapeOf, startPglite } from './pglite.fixture.ts';
import { type Row, journalDates, rowsOf, withoutOwnerRule } from './postgres.fixture.ts';
import { migrate } from './postgres-migrate.ts';
import type { PgDatabase } from './postgres.ts';

/**
 * The databases of `pglite.fixture.ts` are as isolated as before FRU-339, and the same databases.
 *
 * `migratedDatabaseOn` empties the tables between two cases instead of applying the migrations again.
 * These cases show that a case sees nothing that the case before it left: no row, no change of the
 * schema, no state of the session. And that the result is the database that `migrate` makes on an
 * empty one.
 */

/** The shape of `public` after `migrate` on an empty database of a new instance. */
async function shapeOfAFreshMigration(): Promise<string | undefined> {
  const instance = newPglite();
  try {
    await migrate(await databaseOn(instance));

    return await shapeOf(instance);
  } finally {
    await instance.close();
  }
}

/** The number of rows of each table of `public`, the journal included. */
async function rowsByTable(database: PgDatabase): Promise<Record<string, number>> {
  const tables = await rowsOf(database, `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`);
  const counts: Record<string, number> = {};
  for (const { tablename } of tables as { tablename: string }[]) {
    const [row] = await rowsOf(database, `SELECT count(*)::int AS n FROM "${tablename}"`);
    counts[tablename] = Number(row?.n);
  }

  return counts;
}

/** Rows in the tables of better-auth, of a workspace, of the seeds (with an identity) and of the cache. */
async function writeSomething(database: PgDatabase): Promise<Row[]> {
  await rowsOf(
    database,
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES ('u_ana', 'Ana', 'ana@example.com', true, now(), now())`,
  );
  await rowsOf(
    database,
    `INSERT INTO organization (id, name, slug, "createdAt") VALUES ('ws_acme', 'Acme', 'acme', now())`,
  );
  await rowsOf(
    database,
    `INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ('m_ana', 'ws_acme', 'u_ana', 'owner', now())`,
  );
  await rowsOf(database, `INSERT INTO kv (key, value, expires_at) VALUES ('k', 'v', 1)`);

  return rowsOf(
    database,
    `INSERT INTO seeds (page_url, stage, seed, created_at, updated_at) VALUES ('https://a.test/', 's', 'x', 1, 1) RETURNING id`,
  );
}

describe('a migrated database of PGlite, from one case to the next (FRU-339)', () => {
  const instance = newPglite();
  after(() => instance.close());
  let reference: string | undefined;

  it('is the database that migrate makes on an empty one, with every migration in its journal', async () => {
    reference = await shapeOfAFreshMigration();
    assert.notEqual(reference, undefined);

    const database = await migratedDatabaseOn(instance);
    assert.equal(await shapeOf(instance), reference);
    const journal = await rowsOf(database, 'SELECT created_at FROM __drizzle_migrations ORDER BY created_at');
    assert.deepEqual(
      journal.map((row) => Number(row.created_at)),
      journalDates(),
    );
    assert.ok(
      Object.values(await rowsByTable(database)).some((n) => n > 0),
      'the journal has rows',
    );
    await database.close();
  });

  it('gives no row of the case before, in any table, and the identities start again', async () => {
    const first = await migratedDatabaseOn(instance);
    assert.deepEqual(await writeSomething(first), [{ id: 1 }]);
    await writeSomething(first).catch(() => undefined);
    await first.close();

    const next = await migratedDatabaseOn(instance);
    const counts = await rowsByTable(next);
    const { __drizzle_migrations: journal, ...tables } = counts;
    assert.equal(journal, journalDates().length);
    assert.ok(Object.keys(tables).length > 20, `the tables of the worker: ${Object.keys(tables).join(', ')}`);
    assert.deepEqual(
      Object.entries(tables).filter(([, n]) => n !== 0),
      [],
    );
    assert.deepEqual(await writeSomething(next), [{ id: 1 }]);
    assert.equal(await shapeOf(instance), reference);
  });

  it('gives no row of a case that did not close its database', async () => {
    const left = await migratedDatabaseOn(instance);
    await writeSomething(left);

    const next = await migratedDatabaseOn(instance);
    assert.deepEqual((await rowsOf(next, 'SELECT id FROM "user"')).length, 0);
    await next.close();
  });

  for (const [what, change] of [
    ['a constraint that refuses every row', 'ALTER TABLE kv ADD CONSTRAINT refuses_every_row CHECK (false) NOT VALID'],
    ['a table that is dropped', 'DROP TABLE deliveries'],
    ['a table that is renamed', 'ALTER TABLE note_index RENAME TO note_index_gone'],
    ['a column that is added', 'ALTER TABLE kv ADD COLUMN extra text'],
    ['a default that changes', `ALTER TABLE seeds ALTER COLUMN stage SET DEFAULT 'x'`],
    ['an index that is dropped', 'DROP INDEX kv_by_expiry'],
    ['a trigger that is off', 'ALTER TABLE member DISABLE TRIGGER member_keeps_owner'],
    [
      'a function that is new',
      'CREATE FUNCTION hold_the_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$',
    ],
    [
      'a trigger that is new',
      'CREATE TRIGGER kv_again BEFORE INSERT ON kv FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger()',
    ],
    [
      'a migration that is gone from the journal',
      'DELETE FROM __drizzle_migrations WHERE id = (SELECT max(id) FROM __drizzle_migrations)',
    ],
    ['a row in the journal that is changed', `UPDATE __drizzle_migrations SET hash = 'other' WHERE id = 1`],
  ] as const) {
    it(`gives the migrated schema again after ${what}`, async () => {
      const changed = await migratedDatabaseOn(instance);
      await writeSomething(changed);
      await rowsOf(changed, change);
      assert.notEqual(await shapeOf(instance), reference, 'the shape sees the change');
      await changed.close();

      const next = await migratedDatabaseOn(instance);
      assert.equal(await shapeOf(instance), reference);
      assert.deepEqual((await rowsOf(next, 'SELECT id FROM "user"')).length, 0);
      assert.deepEqual(await writeSomething(next), [{ id: 1 }]);
    });
  }

  it('keeps the trigger of the last owner on, as the migrations leave it', async () => {
    const database = await migratedDatabaseOn(instance);
    await writeSomething(database);
    await assert.rejects(rowsOf(database, `DELETE FROM member WHERE id = 'm_ana'`));
    await withoutOwnerRule(database, `DELETE FROM member WHERE id = 'm_ana'`);
  });

  it('gives no state of the session of the case before: settings, temporary tables, advisory locks', async () => {
    const before = await migratedDatabaseOn(instance);
    await rowsOf(before, `SET session_replication_role = replica`);
    await rowsOf(before, `SET TIME ZONE 'Pacific/Kiritimati'`);
    await rowsOf(before, 'CREATE TEMPORARY TABLE scratch (n int)');
    await rowsOf(before, 'SELECT pg_advisory_lock(42)');
    await rowsOf(before, 'SET search_path TO pg_temp, public');

    const next = await migratedDatabaseOn(instance);
    const [state] = await rowsOf(
      next,
      `SELECT current_setting('session_replication_role') AS role, current_setting('TimeZone') AS zone,
              current_setting('search_path') AS path, to_regclass('pg_temp.scratch')::text AS scratch,
              (SELECT count(*)::int FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()) AS locks`,
    );
    assert.notEqual(state?.zone, 'Pacific/Kiritimati');
    assert.deepEqual(
      { ...state, zone: undefined },
      { role: 'origin', zone: undefined, path: 'public', scratch: null, locks: 0 },
    );
    // With the triggers on again, the rule of the last owner holds.
    await writeSomething(next);
    await assert.rejects(rowsOf(next, `DELETE FROM member WHERE id = 'm_ana'`));
  });

  it('leaves `public` empty for `databaseOn` after it, and is migrated again after `databaseOn`', async () => {
    const migrated = await migratedDatabaseOn(instance);
    await writeSomething(migrated);
    await migrated.close();

    const empty = await databaseOn(instance);
    assert.deepEqual(await rowsOf(empty, `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`), []);
    await empty.close();

    await migratedDatabaseOn(instance);
    assert.equal(await shapeOf(instance), reference);
  });
});

describe('an instance of PGlite from the file of `initdb` (FRU-339)', () => {
  /** What `initdb` decides: the settings, the databases, the roles, the catalogue. */
  const SETTINGS = `SELECT
      (SELECT string_agg(format('%s=%s', name, setting), ',' ORDER BY name) FROM pg_settings
        WHERE name NOT IN ('transaction_read_only')) AS settings,
      (SELECT string_agg(format('%s:%s:%s:%s', datname, pg_encoding_to_char(encoding), datcollate, datctype), ',' ORDER BY datname)
         FROM pg_database) AS databases,
      (SELECT string_agg(rolname, ',' ORDER BY rolname) FROM pg_roles) AS roles,
      (SELECT count(*)::int FROM pg_class) AS classes,
      (SELECT count(*)::int FROM pg_proc) AS functions,
      (SELECT string_agg(nspname, ',' ORDER BY nspname) FROM pg_namespace) AS schemas`;

  it('is written by the first instance, and starts as one that runs initdb', async () => {
    const started = await startPglite();
    assert.ok(existsSync(INITDB_FILE), INITDB_FILE);
    const fromFile = newPglite();
    const fromInitdb = new PGlite({ parsers: { [types.INT8]: (value: string) => Number(value) } });
    try {
      const [a, b, c] = await Promise.all(
        [started, fromFile, fromInitdb].map(async (each) => (await each.query<Row>(SETTINGS)).rows[0]),
      );
      assert.deepEqual(b, c);
      assert.deepEqual(a, c);
      assert.equal(
        (await fromFile.query<{ n: number }>(`SELECT 9007199254740991::bigint AS n`)).rows[0]?.n,
        9007199254740991,
      );
    } finally {
      await Promise.all([started.close(), fromFile.close(), fromInitdb.close()]);
    }
  });
});
