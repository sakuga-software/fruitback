import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { type SQL, sql } from 'drizzle-orm';
import { type Cases, type Subject, collect, mutatedModule } from './conformance.fixture.ts';
import { type Database, type PgDatabase, createPgDatabase } from './postgres.ts';
import { databaseOn, migratedDatabaseOn, startPglite } from './pglite.fixture.ts';
import { migrated, migrationsFolder } from './postgres-migrate.ts';

/**
 * A PostgreSQL for the tests (FRU-141), in two forms.
 *
 * **PGlite** is a PostgreSQL in the process: the tests need no service. It has one connection,
 * so a transaction holds every other call back, and no race can show there.
 *
 * **A real server** is the address in `FRUITBACK_TEST_DATABASE_URL`. There the calls of a case run
 * on several connections of a pool, and the code that ships (`createPgDatabase`) is what answers.
 * The CI job `postgres` sets the address, and fails when it is missing.
 *
 * **An empty database is a database, not a schema** (FRU-180). The migrations that `drizzle-kit`
 * writes name `public` in every foreign key, so the tables of a case cannot live in a schema of its
 * own. better-auth also reads the tables of every schema of its database (FRU-144): a schema that
 * another file dropped between two of its reads failed a case in CI. On a server each case makes a
 * database and drops it. PGlite has one database: a case empties `public`, so one process holds one
 * PGlite database at a time.
 */

export const TEST_DATABASE_URL = process.env.FRUITBACK_TEST_DATABASE_URL || undefined;

/** The reason a subject on a real server is skipped, or `false`. */
export const NO_REAL_POSTGRES: string | false =
  TEST_DATABASE_URL === undefined ? 'FRUITBACK_TEST_DATABASE_URL is not set: the CI job « postgres » sets it' : false;

export type Row = Record<string, unknown>;

let counter = 0;

/** A name for a database that no other case, and no other process on the same server, has. */
export function databaseName(): string {
  counter += 1;

  return `t_${process.pid}_${Date.now().toString(36)}_${counter}`;
}

/**
 * The rows that one statement answers, on either database.
 *
 * For what a test reads or plants beside a store. A store writes its statements with Drizzle.
 */
export async function rowsOf(database: Database, statement: SQL | string): Promise<Row[]> {
  const answer = await database.run((db) => db.execute(typeof statement === 'string' ? sql.raw(statement) : statement));

  return (answer as { rows?: Row[] }).rows ?? [];
}

/**
 * `rowsOf` with the trigger of the last owner off (FRU-324), and on again after. For a case that
 * removes a member or an account by hand, to plant a person who is no longer of a workspace, and
 * leaves that workspace with no owner. No route of the worker and no route of better-auth does it.
 */
export async function withoutOwnerRule(database: Database, statement: SQL | string): Promise<Row[]> {
  await rowsOf(database, 'ALTER TABLE member DISABLE TRIGGER member_keeps_owner');
  try {
    return await rowsOf(database, statement);
  } finally {
    await rowsOf(database, 'ALTER TABLE member ENABLE TRIGGER member_keeps_owner');
  }
}

/** The dates of the migrations that `database` applied, in order. Drizzle names a migration by its date. */
export async function appliedDates(database: Database): Promise<number[]> {
  const rows = await rowsOf(database, 'SELECT created_at FROM __drizzle_migrations ORDER BY created_at');

  return rows.map((row) => Number(row.created_at));
}

/** The dates of the migrations of the worker, in the order of its journal. */
export function journalDates(): number[] {
  const journal = JSON.parse(readFileSync(`${migrationsFolder()}meta/_journal.json`, 'utf8')) as {
    entries: { when: number }[];
  };

  return journal.entries.map((entry) => entry.when);
}

/** The names of the migrations of the worker, in the order of its journal. */
export function journalTags(): string[] {
  const journal = JSON.parse(readFileSync(`${migrationsFolder()}meta/_journal.json`, 'utf8')) as {
    entries: { tag: string }[];
  };

  return journal.entries.map((entry) => entry.tag);
}

const folders: string[] = [];
afterAll(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/**
 * A folder with the migrations of the worker up to `tag`, and none after it: what an image of
 * before had. `migrate(database, folder)` makes the database of that image, and `migrate(database)`
 * then applies the rest, as the worker of this build does when it starts on it.
 */
export function migrationsThrough(tag: string): string {
  const folder = mkdtempSync(join(tmpdir(), 'fruitback-migrations-'));
  folders.push(folder);
  cpSync(migrationsFolder(), folder, { recursive: true });
  const journalFile = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalFile, 'utf8')) as { entries: { tag: string }[] };
  const last = journal.entries.findIndex((entry) => entry.tag === tag);
  assert.ok(last >= 0, `the worker has no migration « ${tag} »`);
  const kept = journal.entries.slice(0, last + 1);
  writeFileSync(journalFile, JSON.stringify({ ...journal, entries: kept }));
  for (const file of readdirSync(folder)) {
    if (file.endsWith('.sql') && !kept.some((entry) => `${entry.tag}.sql` === file)) rmSync(join(folder, file));
  }

  return folder;
}

/** The PGlite of this process. It takes 0.2 s to start from `INITDB_FILE`, 0.7 s without it: the cases share it. */
let shared: Promise<PGlite> | undefined;

function pglite(): Promise<PGlite> {
  shared ??= startPglite();

  return shared;
}

// An open instance keeps the process of a test file alive for ten seconds after its last test (measured).
afterAll(async () => {
  const instance = shared;
  shared = undefined;
  await (await instance)?.close();
});

/** An empty database on PGlite: the one database of the shared instance, with nothing in `public`. */
export async function createPgliteDatabase(schema = 'public'): Promise<PgDatabase> {
  return databaseOn(await pglite(), schema);
}

/**
 * A migrated database on PGlite, with no row (FRU-339): the one database of the shared instance.
 * For a case whose subject is not the migrations. See `migratedDatabaseOn`.
 */
export async function createMigratedPgliteDatabase(): Promise<PgDatabase> {
  return migratedDatabaseOn(await pglite());
}

/** How long `drop` waits for the connections of a database to end, before it drops it all the same. */
const LEFT_PATIENCE_MS = 2_000;

/**
 * Waits until the server holds no connection of a client on `name`, at most `patienceMs`.
 *
 * **A pool that has ended still has its connections on the server for a moment** (FRU-196).
 * `pool.end()` of pg-pool 3.14 answers when it has asked its clients to end, not when they have:
 * `pg_stat_activity` still listed the backend 0.2 to 1 ms later (measured on 17.11). A
 * `DROP DATABASE … WITH (FORCE)` sent then ends that backend, and the client reads « terminating
 * connection due to administrator command » on a socket it was closing. A pool of `postgres.ts`
 * writes one line for it. A pool with no listener, like the one of `postgres-numbers.test.ts`, throws
 * it as an unhandled error, in the `afterEach` of the test that made it: that test failed in CI.
 *
 * The workers of the autovacuum are not clients: they go by themselves, and `FORCE` ends them.
 */
async function noClientLeftOn(admin: Database, name: string, patienceMs: number): Promise<void> {
  const until = Date.now() + patienceMs;
  for (;;) {
    const [row] = await rowsOf(
      admin,
      sql`SELECT count(*)::int AS left FROM pg_stat_activity WHERE datname = ${name} AND backend_type = 'client backend'`,
    );
    if (Number(row?.left) === 0 || Date.now() >= until) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * A new database on the real server, a copy of `template` (empty by default), and its address.
 * `drop` removes it.
 *
 * `drop` first waits for the connections on the database to end, see `noClientLeftOn`. `FORCE` stays
 * for what does not end by itself: a process that a test killed. `dropAtOnce` does not wait: it is
 * what `drop` was, kept for the test that shows the difference.
 *
 * For a test that gives the address to another process. Any other test takes `createRealDatabase`.
 */
export async function ownDatabase(
  template = 'template0',
): Promise<{ url: string; drop(): Promise<void>; dropAtOnce(): Promise<void> }> {
  if (TEST_DATABASE_URL === undefined) throw new Error('FRUITBACK_TEST_DATABASE_URL is not set');
  const name = databaseName();
  const admin = createPgDatabase(TEST_DATABASE_URL, 'public', { max: 1 });
  // `template0` by default: a copy of `template1` is refused while another session is on it.
  await rowsOf(admin, `CREATE DATABASE ${name} TEMPLATE ${template}`);
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;

  const dropAtOnce = async (): Promise<void> => {
    await rowsOf(admin, `DROP DATABASE ${name} WITH (FORCE)`);
    await admin.close();
  };

  return {
    url: url.href,
    async drop() {
      await noClientLeftOn(admin, name, LEFT_PATIENCE_MS);
      await dropAtOnce();
    },
    dropAtOnce,
  };
}

/** An empty database on the real server: a new one, and a pool on it. `close` drops it. */
export async function createRealDatabase(schema = 'public'): Promise<PgDatabase> {
  const own = await ownDatabase();
  const database = createPgDatabase(own.url, schema);

  return {
    ...database,
    async close() {
      await database.close();
      await own.drop();
    },
  };
}

/**
 * The migrated database of this process on the real server, made once (FRU-480): the template of
 * `createMigratedRealDatabase`. Nothing stays connected to it, as `CREATE DATABASE … TEMPLATE`
 * requires. `afterAll` drops it.
 */
let migratedTemplate: Promise<{ name: string; drop(): Promise<void> }> | undefined;

/**
 * A new database on the real server with `apply` done on it (the migrations of the worker), and
 * nothing connected to it. On a failure it drops that database before it throws: nothing else holds
 * its name (review of #683).
 */
export async function makeMigratedTemplate(
  apply: (database: Database) => Promise<void> = migrated,
): Promise<{ name: string; drop(): Promise<void> }> {
  const own = await ownDatabase();
  const name = new URL(own.url).pathname.slice(1);
  try {
    const database = createPgDatabase(own.url, 'public');
    try {
      await apply(database);
    } finally {
      await database.close();
    }
    // The pool has ended, and its connections may still be on the server for a moment (FRU-196). A
    // copy refuses a template that has one, after it waited up to 5 s for it to go. So the first copy
    // starts when they are gone, and depends on no wait of PostgreSQL.
    const admin = createPgDatabase(TEST_DATABASE_URL as string, 'public', { max: 1 });
    try {
      await noClientLeftOn(admin, name, LEFT_PATIENCE_MS);
    } finally {
      await admin.close();
    }
  } catch (error) {
    await own.dropAtOnce();
    throw error;
  }

  return { name, drop: own.drop };
}

afterAll(async () => {
  const template = migratedTemplate;
  migratedTemplate = undefined;
  await (await template?.catch(() => undefined))?.drop();
});

/**
 * A new database on the real server, with every migration of the worker applied and no row
 * (FRU-480), and a pool on it. `close` drops it. For a case whose subject is not the migrations, as
 * `createMigratedPgliteDatabase` is on PGlite.
 *
 * Each case gets a copy of one migrated database of the process (`CREATE DATABASE … TEMPLATE`),
 * instead of an empty one where the store applies the 39 migrations again.
 */
export async function createMigratedRealDatabase(): Promise<PgDatabase> {
  if (TEST_DATABASE_URL === undefined) throw new Error('FRUITBACK_TEST_DATABASE_URL is not set');
  migratedTemplate ??= makeMigratedTemplate();
  const template = await migratedTemplate.catch((error: unknown) => {
    migratedTemplate = undefined;
    throw error;
  });
  const own = await ownDatabase(template.name);
  const database = createPgDatabase(own.url, 'public');

  return {
    ...database,
    async close() {
      await database.close();
      await own.drop();
    },
  };
}

/** A store on a new empty database for each case. */
export function onDatabase<Store>(
  label: string,
  factory: string,
  open: () => Promise<Database>,
  create: (database: Database) => Store,
  skip: string | false = false,
): Subject<Store> {
  let database: Database | undefined;

  return {
    factory,
    label,
    ...(skip === false ? {} : { skip }),
    async open() {
      database = await open();

      return create(database);
    },
    async close() {
      await database?.close();
      database = undefined;
    },
  };
}

/** How long the database holds a new row before it writes it, in the tests that plant a race. */
const HOLD_SECONDS = 0.3;

/**
 * What a case answers on a store with one change, on this database: `'passed'`, or its failure.
 *
 * **A race that is left to chance is a control that fails one run in a few.** Two calls overlap only
 * when the scheduler lets them, and a store that loses the race then passes. CI showed it: the same
 * control passed on one head and failed on the next one, which changed one line of a document. So
 * the overlap is made here, as `pg_sleep` makes it for the migrations of two processes:
 *
 * - a trigger holds each new row of `held` for `HOLD_SECONDS` before it is written, inside the
 *   transaction, so the first call has not committed when the second one reads;
 * - the two connections are open before the case starts, so the second call does not wait for one.
 */
export async function outcomeOnChangedStore<Store>(input: {
  /** The file of the store, and the function of it that builds one. */
  file: string;
  factory: string;
  cases: Cases<Store>;
  /** The name of the case to run. */
  name: string;
  change: { after?: string; from: string; to: string };
  held: { table: string; when?: string };
  open: () => Promise<Database>;
}): Promise<unknown> {
  const mutant = await mutatedModule(input.file, input.change);
  const opened = await input.open();
  const create = mutant.module[input.factory] as (database: Database) => Store;
  try {
    const runCase = collect(input.cases).get(input.name);
    assert.ok(runCase !== undefined, 'the case is gone');

    await migrated(opened);
    await rowsOf(
      opened,
      `CREATE FUNCTION hold_the_row() RETURNS trigger LANGUAGE plpgsql
         AS $$ BEGIN PERFORM pg_sleep(${HOLD_SECONDS}); RETURN NEW; END $$`,
    );
    await rowsOf(
      opened,
      `CREATE TRIGGER hold_the_row BEFORE INSERT ON ${input.held.table} FOR EACH ROW
         ${input.held.when === undefined ? '' : `WHEN (${input.held.when})`} EXECUTE FUNCTION hold_the_row()`,
    );
    await Promise.all([rowsOf(opened, 'SELECT 1'), rowsOf(opened, 'SELECT 1')]);

    return await runCase(create(opened)).then(
      () => 'passed',
      (error: unknown) => error,
    );
  } finally {
    await opened.close();
    mutant.remove();
  }
}
