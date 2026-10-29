import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite, types } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate as migrateOnPglite } from 'drizzle-orm/pglite/migrator';
import { migrate } from './postgres-migrate.ts';
import { type PgDatabase, type PgPool, causeOfQueryError } from './postgres.ts';

/**
 * A `PgDatabase` on a PGlite instance: a PostgreSQL in the process, with one connection (FRU-141).
 *
 * This file imports nothing of vitest, so a runner that is not vitest can use it: the
 * Playwright spec of the console (FRU-148) serves a worker on it. `postgres.fixture.ts` keeps the
 * instance that the cases of a test file share.
 */

type Row = Record<string, unknown>;

const PARSERS = { [types.INT8]: (value: string) => Number(value) };

/** The version of PGlite. Its `exports` do not give its `package.json`: it is beside `dist/`. */
const PGLITE_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.resolve('@electric-sql/pglite')), 'utf8')) as {
    version: string;
  }
).version;

/**
 * The data folder of a new instance, as PGlite makes it at its first start (FRU-339).
 *
 * That start runs `initdb`: 0.5 s of the 0.7 s of a new instance (measured). An instance that
 * loads this file starts in 0.2 s. The file has the version of PGlite in its name, so another
 * version makes its own file. It is in `node_modules/.cache`, which git ignores.
 */
export const INITDB_FILE = fileURLToPath(
  new URL(`../node_modules/.cache/fruitback-pglite/initdb-${PGLITE_VERSION}.tar`, import.meta.url),
);

function initdbOnDisk(): Blob | undefined {
  try {
    return new Blob([readFileSync(INITDB_FILE)]);
  } catch {
    return undefined;
  }
}

/**
 * A new instance. A `BIGINT` is a number, as the schema of Drizzle reads one.
 *
 * It starts from `INITDB_FILE` when that file is there, and runs `initdb` when it is not.
 * `startPglite` writes the file.
 */
export function newPglite(): PGlite {
  const loadDataDir = initdbOnDisk();

  return new PGlite({ parsers: PARSERS, ...(loadDataDir === undefined ? {} : { loadDataDir }) });
}

/**
 * `newPglite`, ready. When `INITDB_FILE` is missing, it writes the file from this instance first,
 * before any statement runs on it.
 *
 * Several test processes can write the file at the same moment. Each one writes its own temporary
 * file and renames it, so no process reads a file that is only partly written.
 */
export async function startPglite(): Promise<PGlite> {
  const fromDisk = initdbOnDisk() !== undefined;
  const instance = newPglite();
  await instance.waitReady;
  if (fromDisk) return instance;

  const dump = await instance.dumpDataDir('none');
  const part = `${INITDB_FILE}.${process.pid}.${Date.now()}.part`;
  try {
    mkdirSync(join(INITDB_FILE, '..'), { recursive: true });
    writeFileSync(part, new Uint8Array(await dump.arrayBuffer()));
    renameSync(part, INITDB_FILE);
  } catch {
    // Without the file, the next instance runs `initdb` again: slower, and the same database.
    rmSync(part, { force: true });
  }

  return instance;
}

export const EMPTY_PUBLIC = 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;';

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

/** The `PgDatabase` of the one connection of `instance`, in `schema`. `close` runs `onClose`. */
function wrap(instance: PGlite, schema: string, onClose: () => Promise<unknown>): PgDatabase {
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
    schema,
    run: (work) => plain(work(db)),
    transaction: (work) => plain(db.transaction((transaction) => work(transaction))),
    alone: (work) => plain(work(db, (config) => migrateOnPglite(db, config))),
    pool: async () => poolOver(instance),
    async close() {
      await onClose();
    },
  };
}

/**
 * The database of `instance`, with nothing in `public`. `close` empties it, and leaves the instance open.
 *
 * `schema` is the one of the worker (FRU-219): the one connection of the instance has it alone in its
 * search path, as each connection of a pool of `postgres.ts` has. A schema that is not `public` is
 * dropped with it, before and after.
 */
export async function databaseOn(instance: PGlite, schema = 'public'): Promise<PgDatabase> {
  const empty = `${EMPTY_PUBLIC}${schema === 'public' ? '' : ` DROP SCHEMA IF EXISTS "${schema}" CASCADE;`}`;
  await instance.exec(`RESET search_path; ${empty} SET search_path TO "${schema}";`);

  return wrap(instance, schema, () => instance.exec(`RESET search_path; ${empty}`));
}

/**
 * What a database holds besides the rows of its tables: the tables and their columns, the indexes,
 * sequences, views, constraints, triggers (and whether they are on), functions, schemas, and the
 * journal of the migrations, rows included (FRU-339). Two databases with the same answer have the
 * same schema. With no row in any table but the journal, they are the same database.
 */
const SHAPE = `
  SELECT md5(string_agg(line, ',' ORDER BY line)) AS shape FROM (
    SELECT format('class:%s:%s:%s', c.oid::regclass, c.relkind,
             (SELECT string_agg(format('%s/%s/%s/%s/%s', a.attname, a.atttypid::regtype, a.atttypmod, a.attnotnull,
                                       pg_get_expr(d.adbin, d.adrelid)), ';' ORDER BY a.attnum)
                FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
               WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped)) AS line
      FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace
    UNION ALL
    SELECT format('index:%s:%s', i.indexrelid::regclass, pg_get_indexdef(i.indexrelid))
      FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE c.relnamespace = 'public'::regnamespace
    UNION ALL
    SELECT format('constraint:%s:%s:%s', k.conrelid::regclass, k.conname, pg_get_constraintdef(k.oid))
      FROM pg_constraint k WHERE k.connamespace = 'public'::regnamespace
    UNION ALL
    SELECT CASE WHEN t.tgisinternal
             -- The trigger of a foreign key is named by an OID, which another migration run changes.
             THEN format('internal trigger:%s:%s:%s', t.tgrelid::regclass, t.tgenabled, t.tgfoid::regproc)
             ELSE format('trigger:%s:%s:%s', t.tgrelid::regclass, t.tgenabled, pg_get_triggerdef(t.oid)) END
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'public'::regnamespace
    UNION ALL
    SELECT format('function:%s:%s', p.oid::regprocedure, md5(p.prosrc))
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
    UNION ALL
    SELECT format('type:%s:%s', t.oid::regtype, t.typtype)
      FROM pg_type t WHERE t.typnamespace = 'public'::regnamespace AND t.typtype IN ('e', 'd', 'c')
    UNION ALL
    SELECT format('label:%s:%s:%s', e.enumtypid::regtype, e.enumsortorder, e.enumlabel) FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typnamespace = 'public'::regnamespace
    UNION ALL
    SELECT format('schema:%s', n.nspname) FROM pg_namespace n
     WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
    UNION ALL
    SELECT format('migration:%s:%s', m.hash, m.created_at) FROM public.__drizzle_migrations m
  ) AS lines`;

/**
 * What `migratedDatabaseOn` knows of the migrated database of an instance: the statements that empty
 * its tables, and the rows of its journal.
 */
type Migrated = { empty: string; journal: string };

const migratedOf = new WeakMap<PGlite, Migrated>();

/**
 * The setting that says the schema of an instance is still the one `migrate` made (FRU-480). Its
 * value is a token that only this file writes: the event trigger of `UNTOUCHED_ON_DDL` sets it to
 * `''` at the end of any command that changes the schema, and `RESET ALL` sets it back to nothing.
 * Each of the two then reads as « changed ».
 */
const UNTOUCHED = 'fruitback_test.untouched';
const UNTOUCHED_TOKEN = 'migrated';

/**
 * The event trigger that marks the schema as changed, on any instance it is created on.
 *
 * It fires at the end of every command that an event trigger sees: `CREATE`, `ALTER`, `DROP`,
 * `COMMENT`, `GRANT` and `REVOKE`, on any object of the database. Not on `TRUNCATE`, which changes
 * no schema. `ENABLE ALWAYS`: it fires under `session_replication_role = replica` too. A setting set
 * in a transaction that rolls back goes back with it, as the change of the schema does. Its function
 * is in `pg_catalog`, which no `DROP SCHEMA` of a case removes and no catalogue of `public` reads.
 */
const UNTOUCHED_ON_DDL = `
  CREATE OR REPLACE FUNCTION pg_catalog.fruitback_test_untouched_no_more() RETURNS event_trigger
    LANGUAGE plpgsql AS $$ BEGIN PERFORM set_config('${UNTOUCHED}', '', false); END $$;
  DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_event_trigger WHERE evtname = 'fruitback_test_untouched_no_more') THEN
      CREATE EVENT TRIGGER fruitback_test_untouched_no_more ON ddl_command_end
        EXECUTE FUNCTION pg_catalog.fruitback_test_untouched_no_more();
      ALTER EVENT TRIGGER fruitback_test_untouched_no_more ENABLE ALWAYS;
    END IF;
  END $$;`;

/** The rows of the journal of the migrations, in one line. */
const JOURNAL = `SELECT coalesce(string_agg(format('%s:%s:%s', id, hash, created_at), ',' ORDER BY id), '') AS journal
  FROM public.__drizzle_migrations`;

/**
 * The statements that empty `tables` and start their identities again, as
 * `TRUNCATE … RESTART IDENTITY CASCADE` does, in 1 ms instead of 20 (measured on PGlite 0.5.11, 36
 * tables). `TRUNCATE` gives each table a new file; `DELETE` of a few rows writes little.
 *
 * The triggers are off while it runs (`session_replication_role = replica`): every table is emptied,
 * so no foreign key and no rule of the last owner has a row to hold. Each sequence that a table owns
 * starts again from its first value; `setval` changes no catalogue.
 */
async function emptyingOf(instance: PGlite, tables: string[]): Promise<string> {
  const { rows } = await instance.query<{ restart: string }>(
    `SELECT format('SELECT setval(%L, %s, false);', s.seqrelid::regclass, s.seqstart) AS restart
       FROM pg_sequence s
       JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = s.seqrelid AND d.deptype IN ('a', 'i')
       JOIN pg_class t ON t.oid = d.refobjid
      WHERE t.relnamespace = 'public'::regnamespace AND t.relname <> '__drizzle_migrations'
      ORDER BY 1`,
  );

  return [
    'SET session_replication_role = replica;',
    ...tables.map((table) => `DELETE FROM ${table};`),
    'SET session_replication_role = DEFAULT;',
    ...rows.map((row) => row.restart),
  ].join(' ');
}

/** The tables of `public` but the journal, quoted. */
async function tablesOf(instance: PGlite): Promise<string[]> {
  const { rows } = await instance.query<{ name: string }>(
    `SELECT quote_ident(tablename) AS name FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '__drizzle_migrations' ORDER BY tablename`,
  );

  return rows.map((row) => row.name);
}

/** The shape of `public`, or `undefined` when it has no journal of the migrations. */
export async function shapeOf(instance: PGlite): Promise<string | undefined> {
  const { rows } = await instance.query<{ journal: string | null }>(
    `SELECT to_regclass('public.__drizzle_migrations')::text AS journal`,
  );
  if (rows[0]?.journal === null || rows[0]?.journal === undefined) return undefined;

  return (await instance.query<{ shape: string }>(SHAPE)).rows[0]?.shape;
}

/** Whether a table of `tables` has a row. */
async function anyRow(instance: PGlite, tables: string[]): Promise<boolean> {
  if (tables.length === 0) return false;
  const { rows } = await instance.query<{ some: boolean }>(
    `SELECT ${tables.map((table) => `EXISTS (SELECT FROM ${table})`).join(' OR ')} AS some`,
  );

  return rows[0]?.some === true;
}

/**
 * The database of `instance` in `public`, with every migration of the worker applied and no row
 * in any table (FRU-339). For a case whose subject is not the migrations: a case on an empty
 * database takes `databaseOn`.
 *
 * Applying the migrations takes 50 ms on PGlite, and emptying `public` 14 ms more (measured): most
 * of a case on a store. So the first call applies them with `migrate` of `postgres-migrate.ts`, on an
 * empty `public`. Each call after empties the tables (`emptyingOf`) and keeps the journal: about 1 ms.
 *
 * A case may change the schema: add a constraint, rename or drop a table, turn a trigger off. An
 * event trigger then marks the instance (`UNTOUCHED_ON_DDL`), and the next call empties `public` and
 * applies the migrations again. The same when a case changes a row of the journal, which no event
 * trigger sees: the call reads the journal and compares it. And when a migration leaves a row in a
 * table: no call then empties the tables alone. FRU-480: the check read the whole catalogue of
 * `public` before (`shapeOf`, 7 ms a call); the tests of `pglite-isolation.test.ts` still compare it.
 *
 * The state of the session goes back too: `RESET ALL`, its temporary tables, its advisory locks.
 * `close` leaves the tables as they are: the next call empties them, whichever kind it is.
 */
export async function migratedDatabaseOn(instance: PGlite): Promise<PgDatabase> {
  const known = migratedOf.get(instance);
  const { rows } = await instance.query<{ untouched: boolean }>(
    `SELECT current_setting('${UNTOUCHED}', true) IS NOT DISTINCT FROM '${UNTOUCHED_TOKEN}' AS untouched`,
  );
  await instance.exec('RESET ALL; DISCARD TEMP; SELECT pg_advisory_unlock_all(); SET search_path TO "public";');
  if (known !== undefined && rows[0]?.untouched === true && (await journalOf(instance)) === known.journal) {
    await instance.exec(`${known.empty} SELECT set_config('${UNTOUCHED}', '${UNTOUCHED_TOKEN}', false);`);

    return wrap(instance, 'public', async () => {});
  }

  migratedOf.delete(instance);
  const fresh = await databaseOn(instance);
  await migrate(fresh);
  const tables = await tablesOf(instance);
  if (tables.length > 0 && !(await anyRow(instance, tables))) {
    await instance.exec(UNTOUCHED_ON_DDL);
    migratedOf.set(instance, { empty: await emptyingOf(instance, tables), journal: await journalOf(instance) });
    await instance.exec(`SELECT set_config('${UNTOUCHED}', '${UNTOUCHED_TOKEN}', false);`);
  }

  return wrap(instance, 'public', async () => {});
}

/** The rows of the journal of `instance`, in one line, or `undefined` when it has no journal. */
async function journalOf(instance: PGlite): Promise<string | undefined> {
  try {
    return (await instance.query<{ journal: string }>(JOURNAL)).rows[0]?.journal;
  } catch {
    return undefined;
  }
}
