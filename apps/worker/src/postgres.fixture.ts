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

/**
 * The reason a subject on PGlite is skipped, or `false` (FRU-720).
 *
 * `test:postgres`, the script of the CI job `postgres`, sets `FRUITBACK_TEST_POSTGRES=required`.
 * That job runs the cases on a real server. The jobs `test` run every file, so they run the cases on
 * PGlite. Run again in `postgres`, the cases on PGlite took 29 % of its time, on a runner whose 4
 * cores were busy. `test-discovery.test.ts` holds that only `test:postgres` sets the variable, and
 * that only a subject on PGlite takes this reason.
 */
export const PGLITE_ELSEWHERE: string | false =
  process.env.FRUITBACK_TEST_POSTGRES === 'required'
    ? 'the CI jobs « test » run the cases on PGlite: the job « postgres » runs the cases on a server'
    : false;

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
 * `ownDatabase`, a copy of the migrated template of this process (FRU-720). For a case that opens
 * its own pools on one database, two replicas for instance, and whose subject is not the migrations.
 * A copy takes about 50 ms; the migrations on an empty database about 330 ms (measured locally).
 */
export async function ownMigratedDatabase(): ReturnType<typeof ownDatabase> {
  if (TEST_DATABASE_URL === undefined) throw new Error('FRUITBACK_TEST_DATABASE_URL is not set');
  migratedTemplate ??= makeMigratedTemplate();
  const template = await migratedTemplate.catch((error: unknown) => {
    migratedTemplate = undefined;
    throw error;
  });

  return ownDatabase(template.name);
}

/**
 * A new database on the real server, with every migration of the worker applied and no row
 * (FRU-480), and a pool on it. `close` drops it. For a case whose subject is not the migrations, as
 * `createMigratedPgliteDatabase` is on PGlite.
 *
 * Each case gets a copy of one migrated database of the process (`CREATE DATABASE … TEMPLATE`),
 * instead of an empty one where the store applies the 39 migrations again.
 */
export async function createMigratedRealDatabase(): Promise<PgDatabase> {
  const own = await ownMigratedDatabase();
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
 * Where a case on two connections makes the first call wait, and lets it go (FRU-719).
 *
 * A time is not an order. The cases of FRU-149, FRU-238 and FRU-249 started the second call 100 ms
 * after the first and held the first for `HOLD_SECONDS`. The second call must start its statements
 * inside that window. On a CI worker whose event loop stopped for 200 ms or more, the first call
 * committed first, and the control of FRU-149 passed on the store that loses the race (run
 * 45688980102). A hold waits for a state of the server, and not for a time:
 *
 * - `reached` resolves when the first call waits at the gate, in the trigger of the held row. It
 *   holds the rows it locked, and it committed nothing.
 * - `release` opens the gate when another call waits for the held one (`pg_blocking_pids`): for a
 *   row that the held call locked. Or when `other` has ended.
 */
export type Hold = {
  reached(): Promise<void>;
  release(other: Promise<unknown>): Promise<void>;
};

/** The key of the advisory lock that the gate holds. The trigger waits for it. */
const GATE_KEY = 719;
/** How long a hold waits for a state before it gives up. A bound on a bug, never a time that orders. */
const GATE_PATIENCE_MS = 10_000;

/**
 * The first row of `statement`, asked again every 10 ms until there is one. `undefined` when `stop`
 * says so first. It throws once `GATE_PATIENCE_MS` have passed, with `what` in its message.
 */
async function untilRow(
  database: Database,
  statement: string,
  what: string,
  stop: () => boolean = () => false,
): Promise<Row | undefined> {
  const giveUp = Date.now() + GATE_PATIENCE_MS;
  while (!stop()) {
    const [row] = await rowsOf(database, statement);
    if (row !== undefined) return row;
    if (Date.now() > giveUp) throw new Error(`${what}, after ${GATE_PATIENCE_MS} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  return undefined;
}

/**
 * A gate on each new row of `held` (FRU-719): see `Hold`. `close` opens it, for a case that ended
 * before it did.
 *
 * PGlite has one connection. A transaction that held the gate there would hold every call back, and
 * no second call can run inside the first one. There the trigger is not made: `reached` lets the
 * first call take the one connection, and `release` does nothing.
 */
export async function holdRows(
  database: Database,
  held: { table: string; when?: string },
): Promise<Hold & { close(): Promise<void> }> {
  const [{ version } = {}] = await rowsOf(database, 'SELECT version() AS version');
  if (String(version).includes('PGlite')) {
    return {
      reached: () => new Promise((resolve) => setTimeout(resolve, 0)),
      release: async () => {},
      close: async () => {},
    };
  }

  await rowsOf(
    database,
    `CREATE FUNCTION hold_the_row() RETURNS trigger LANGUAGE plpgsql
       AS $$ BEGIN PERFORM pg_advisory_xact_lock_shared(${GATE_KEY}); RETURN NEW; END $$`,
  );
  await rowsOf(
    database,
    `CREATE TRIGGER hold_the_row BEFORE INSERT ON ${held.table} FOR EACH ROW
       ${held.when === undefined ? '' : `WHEN (${held.when})`} EXECUTE FUNCTION hold_the_row()`,
  );

  // The gate is a transaction on a connection of its own, which holds the lock until it is opened.
  let open = (): void => {};
  const opening = new Promise<void>((resolve) => {
    open = resolve;
  });
  let closed = false;
  const gate = new Promise<void>((locked, failed) => {
    database
      .transaction(async (tx) => {
        await tx.execute(sql.raw(`SELECT pg_advisory_xact_lock(${GATE_KEY})`));
        locked();
        await opening;
      })
      .then(
        () => {
          closed = true;
        },
        (error: unknown) => {
          closed = true;
          failed(error);
        },
      );
  });
  await gate;
  const openGate = async () => {
    open();
    const giveUp = Date.now() + GATE_PATIENCE_MS;
    while (!closed && Date.now() < giveUp) await new Promise((resolve) => setTimeout(resolve, 5));
  };
  // The two connections of the case are open before it starts, so the second call waits for none.
  // The caller gets no `close` when this fails: the gate is opened here, or its transaction stays.
  await Promise.all([rowsOf(database, 'SELECT 1'), rowsOf(database, 'SELECT 1')]).catch(async (error: unknown) => {
    await openGate();
    throw error;
  });

  // The backend of the call that waits at the gate, once `reached` has seen it.
  let heldPid: number | undefined;

  return {
    async reached() {
      // The call that asks for the lock of the gate, in this database: a key of one `bigint` is
      // `classid` 0, `objid` the key, `objsubid` 1.
      const row = await untilRow(
        database,
        `SELECT pid FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted AND classid = 0 AND objid = ${GATE_KEY} AND objsubid = 1
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
        'no call waited at the gate',
      );
      heldPid = Number(row?.pid);
    },
    async release(other) {
      let ended = false;
      void other.then(
        () => (ended = true),
        () => (ended = true),
      );
      try {
        if (heldPid === undefined) throw new Error('`release` before `reached`: no call is held');
        // A call that waits for the held one: for a row that it locked, and not for anything else.
        await untilRow(
          database,
          `SELECT pid FROM pg_stat_activity
            WHERE datname = current_database() AND ${heldPid} = ANY(pg_blocking_pids(pid))`,
          'no call waited for the held call',
          () => ended,
        );
      } finally {
        await openGate();
      }
    },
    close: openGate,
  };
}

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
 *
 * A case that orders its two calls itself gets a `Hold` instead (`gated`): the row waits at a gate
 * until the case opens it, and not for a time. See `Hold`.
 */
export async function outcomeOnChangedStore<Store>(input: {
  /** The file of the store, and the function of it that builds one. */
  file: string;
  factory: string;
  cases: Cases<Store> | { gated: (hold: Hold) => Cases<Store> };
  /** The name of the case to run. */
  name: string;
  change: { after?: string; from: string; to: string };
  held: { table: string; when?: string };
  open: () => Promise<Database>;
}): Promise<unknown> {
  const mutant = await mutatedModule(input.file, input.change);
  const opened = await input.open();
  const create = mutant.module[input.factory] as (database: Database) => Store;
  let hold: (Hold & { close(): Promise<void> }) | undefined;
  try {
    await migrated(opened);
    let cases: Cases<Store>;
    if (typeof input.cases === 'function') {
      cases = input.cases;
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
    } else {
      hold = await holdRows(opened, input.held);
      cases = input.cases.gated(hold);
    }
    const runCase = collect(cases).get(input.name);
    assert.ok(runCase !== undefined, 'the case is gone');

    return await runCase(create(opened)).then(
      () => 'passed',
      (error: unknown) => error,
    );
  } finally {
    await hold?.close();
    await opened.close();
    mutant.remove();
  }
}
