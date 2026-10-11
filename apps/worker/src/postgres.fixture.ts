import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after } from 'node:test';
import { PGlite, types } from '@electric-sql/pglite';
import { type SQL, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate as migrateOnPglite } from 'drizzle-orm/pglite/migrator';
import { type Cases, type Subject, collect, mutatedModule } from './conformance.fixture.ts';
import { type Database, type PgDatabase, type PgPool, causeOfQueryError, createPgDatabase } from './postgres.ts';
import { migrated, migrationsFolder } from './postgres-migrate.ts';

/**
 * A PostgreSQL for the tests (FRU-141), in two forms.
 *
 * **PGlite** is a PostgreSQL in the process: `node --test` needs no service. It has one connection,
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

/** The PGlite of this process. It takes a second to start, so the cases share it. */
let shared: PGlite | undefined;

function pglite(): PGlite {
  shared ??= new PGlite({ parsers: { [types.INT8]: (value: string) => Number(value) } });

  return shared;
}

// An open instance keeps the process of a test file alive for ten seconds after its last test (measured).
after(async () => {
  await shared?.close();
  shared = undefined;
});

const EMPTY_PUBLIC = 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;';

/**
 * A pool of `pg`, as Kysely's PostgreSQL dialect uses one, on PGlite: what better-auth takes (FRU-144).
 *
 * PGlite is one connection, so one client is out at a time: a transaction of better-auth is `begin`
 * and `commit` on the client it holds, and no other client may come between the two.
 */
function poolOver(instance: PGlite): PgPool {
  let tail: Promise<void> = Promise.resolve();

  const pool = {
    async connect() {
      let release = (): void => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      const before = tail;
      tail = before.then(() => held);
      await before;

      return {
        async query(text: string, values?: readonly unknown[]) {
          const answer = await instance.query<Row>(text, values === undefined ? [] : [...values]);

          return {
            command: (text.trim().split(/\s+/)[0] ?? '').toUpperCase(),
            rowCount: answer.affectedRows ?? answer.rows.length,
            rows: answer.rows,
          };
        },
        release,
      };
    },
    async end() {},
  };

  return pool as unknown as PgPool;
}

/** An empty database on PGlite: the one database of the shared instance, with nothing in `public`. */
export async function createPgliteDatabase(): Promise<PgDatabase> {
  const instance = pglite();
  await instance.exec(EMPTY_PUBLIC);
  const db = drizzle({ client: instance });

  /** The error of PGlite, and not the one of Drizzle around it: a test reads its code. */
  const plain = async <T>(work: Promise<T>): Promise<T> => {
    try {
      return await work;
    } catch (error) {
      throw causeOfQueryError(error) ?? error;
    }
  };

  return {
    run: (work) => plain(work(db)),
    transaction: (work) => plain(db.transaction((transaction) => work(transaction))),
    alone: (work) => plain(work(db, (config) => migrateOnPglite(db, config))),
    pool: async () => poolOver(instance),
    async close() {
      await instance.exec(EMPTY_PUBLIC);
    },
  };
}

/**
 * A new empty database on the real server, and its address. `drop` removes it.
 *
 * For a test that gives the address to another process. Any other test takes `createRealDatabase`.
 */
export async function ownDatabase(): Promise<{ url: string; drop(): Promise<void> }> {
  if (TEST_DATABASE_URL === undefined) throw new Error('FRUITBACK_TEST_DATABASE_URL is not set');
  const name = databaseName();
  const admin = createPgDatabase(TEST_DATABASE_URL, { max: 1 });
  // `template0`: a copy of `template1` is refused while another session is on it.
  await rowsOf(admin, `CREATE DATABASE ${name} TEMPLATE template0`);
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;

  return {
    url: url.href,
    async drop() {
      await rowsOf(admin, `DROP DATABASE ${name} WITH (FORCE)`);
      await admin.close();
    },
  };
}

/** An empty database on the real server: a new one, and a pool on it. `close` drops it. */
export async function createRealDatabase(): Promise<PgDatabase> {
  const own = await ownDatabase();
  const database = createPgDatabase(own.url);

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
  change: { from: string; to: string };
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
