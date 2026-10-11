import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { Database, Db } from './postgres.ts';
import { StoreError } from './store.ts';

/**
 * The migrations of the PostgreSQL database of a worker, applied by Drizzle (FRU-180).
 *
 * `drizzle-kit generate` writes them in `drizzle/`, from `postgres-schema.ts`, and they are
 * committed. The worker applies them at its first call to the database: the image has no `npx` and
 * no `drizzle-kit`, and its host has no step before a deployment.
 *
 * **`migrate` of Drizzle does three things that this file does not leave to it.** Read on
 * drizzle-orm 0.45.4, `pg-core/dialect.js`:
 *
 * - **It takes no lock.** Two processes that start together on an empty database both read « nothing
 *   applied », and both run `CREATE TABLE`. Here one connection holds an advisory lock of the session
 *   while Drizzle works on that connection. The second process waits, then reads that all is applied.
 * - **It skips, in silence, a migration dated before the last one the database applied.** It reads
 *   one row, the latest, and applies what is dated after it. A pull request that was rebased after
 *   another one merged its migration has such a date. The command ends well, and the column is not
 *   there. `refuseWhatDrizzleWouldSkip` reads every row first, and refuses.
 * - **It never reads again the digest it wrote.** A migration that was edited after it shipped is
 *   not run again on a database that has it, and nothing says so. The same check refuses it.
 *
 * A database that holds more migrations than this build is left alone: that is the image of before,
 * after a roll back.
 *
 * **A database that the tool of before made is adopted, and nothing in it is run again.** See
 * `adoptWhatTheHomeMadeToolMade`.
 */

/** Where Drizzle writes what it applied: in `public`, beside the tables. `drizzle.config.ts` names the same. */
export const APPLIED = { migrationsSchema: 'public', migrationsTable: '__drizzle_migrations' } as const;

/** Any number that no other application of the same database uses for an advisory lock. */
const MIGRATION_LOCK = 0x4652_5542;

/**
 * The folder that `drizzle-kit` writes: beside the bundle in the image, and beside `src/` and
 * `dist/` in the repository.
 */
export function migrationsFolder(): string {
  const found = [new URL('./drizzle/', import.meta.url), new URL('../drizzle/', import.meta.url)].find((folder) =>
    existsSync(new URL('meta/_journal.json', folder)),
  );
  if (found === undefined) {
    throw new StoreError('The migrations of the database are not beside the worker: no drizzle/meta/_journal.json');
  }

  return fileURLToPath(found);
}

/** The rows of an answer, whichever driver gave it. */
function rowsOf(answer: unknown): Record<string, unknown>[] {
  return (answer as { rows: Record<string, unknown>[] }).rows;
}

/** The entries of the journal of `folder`, in order. */
function journalOf(folder: string): { tag: string; when: number }[] {
  return (
    JSON.parse(readFileSync(`${folder}/meta/_journal.json`, 'utf8')) as { entries: { tag: string; when: number }[] }
  ).entries;
}

/**
 * The migrations that the tool of before wrote in `schema_migrations`, in order (FRU-141, FRU-142,
 * FRU-144). That tool was `migrate` of `postgres.ts`, with the list of `postgres-migrations.ts`, until
 * FRU-180 removed both.
 */
export const HOME_MADE = ['accounts', 'site_destinations', 'sessions', 'better-auth'] as const;

/**
 * The first migration of the journal. It makes the tables that the four migrations of `HOME_MADE`
 * make, with the same columns in the same order, the same constraints under the same names, and the
 * same indexes: test:`makes the database that the tool of before made, to the last name` compares
 * the two catalogues.
 */
export const BASELINE = '0000_baseline';

/**
 * Puts a database that the tool of before made under Drizzle, and runs nothing of the baseline.
 *
 * Such a database has `public.schema_migrations`, and no row in the journal of Drizzle. Drizzle alone
 * would run the baseline on it, and fail on its first `CREATE TABLE`: the tables are there. So when
 * the four rows of `schema_migrations` are the four migrations of `HOME_MADE`, in order, this writes
 * the row of the baseline in the journal, as Drizzle writes it (its digest and its date), in one
 * transaction with the journal itself. Drizzle then applies what comes after the baseline, as on any
 * database.
 *
 * The journal can be there, and empty: Drizzle makes it before its transaction, so a
 * `drizzle-kit migrate` that somebody ran by hand on such a database failed and left one. An empty
 * journal says that Drizzle applied nothing, so the database is adopted all the same.
 *
 * Anything else is refused before any write, with what to do: a database stopped at an earlier
 * migration of that tool, or one whose list was edited. `schema_migrations` is kept as it is. An
 * image of before reads it, so a roll back to such an image still finds its database.
 *
 * The caller holds the lock: two processes do not adopt one database twice.
 */
async function adoptWhatTheHomeMadeToolMade(db: Db, folder: string): Promise<void> {
  const [found] = rowsOf(
    await db.execute(
      sql`SELECT to_regclass(${`${APPLIED.migrationsSchema}.${APPLIED.migrationsTable}`}) AS drizzle,
                 to_regclass('public.schema_migrations') AS home_made`,
    ),
  );
  // A database that the tool of before never touched.
  if (found === undefined || found.home_made === null) return;
  const journal = sql`${sql.identifier(APPLIED.migrationsSchema)}.${sql.identifier(APPLIED.migrationsTable)}`;
  // A database under Drizzle already: its journal holds a row.
  if (found.drizzle !== null && rowsOf(await db.execute(sql`SELECT 1 FROM ${journal} LIMIT 1`)).length > 0) return;

  const rows = rowsOf(await db.execute(sql`SELECT version, name FROM public.schema_migrations ORDER BY version`));
  const names = rows.map((row) => String(row.name));
  const expected = HOME_MADE.map((name, index) => ({ version: index + 1, name }));
  const same =
    rows.length === expected.length &&
    rows.every((row, index) => Number(row.version) === expected[index]?.version && row.name === expected[index]?.name);
  if (!same) {
    throw new StoreError(
      `This database was made by the migration tool of before, and it holds « ${names.join(', ')} »: ` +
        `this build adopts only a database that holds « ${HOME_MADE.join(', ')} ». ` +
        'Start an image of the worker from #143 (FRU-144) to before Drizzle on it once, then this one ' +
        '(docs/decisions/worker.md, FRU-180)',
    );
  }

  const [entry] = journalOf(folder);
  const [baseline] = readMigrationFiles({ migrationsFolder: folder });
  if (entry?.tag !== BASELINE || baseline === undefined) {
    throw new StoreError(`The first migration of the journal is « ${entry?.tag ?? 'none'} », and not « ${BASELINE} »`);
  }

  await db.transaction(async (transaction) => {
    // The table that `migrate` of Drizzle makes, to the last word (pg-core/dialect.js of 0.45.4).
    await transaction.execute(
      sql`CREATE TABLE IF NOT EXISTS ${journal} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
    );
    await transaction.execute(
      sql`INSERT INTO ${journal} ("hash", "created_at") VALUES (${baseline.hash}, ${baseline.folderMillis})`,
    );
  });
}

/**
 * Refuses a folder in which two migrations have one date.
 *
 * Drizzle names a migration by its date. With one date for two, a database that has the first one
 * never gets the second one. `postgres-journal.test.ts` refuses such a folder before a merge: this
 * holds an image that was built past it.
 */
function refuseTwoMigrationsOfOneDate(folder: string): void {
  const seen = new Map<number, string>();
  for (const entry of journalOf(folder)) {
    const first = seen.get(entry.when);
    if (first !== undefined) {
      throw new StoreError(
        `The migrations « ${first} » and « ${entry.tag} » have one date, and Drizzle names a migration by its date: ` +
          'generate the second one again',
      );
    }
    seen.set(entry.when, entry.tag);
  }
}

/**
 * Refuses a connection whose tables would not go in the schema `public`, and says what to change.
 *
 * A migration that `drizzle-kit` writes makes a table where the search path says, and names
 * `"public"` in every foreign key. So with another schema first in the search path, the baseline
 * fails in its middle on a relation of `public` that does not exist, and a database that the tool of
 * before made in that schema fails on its first `CREATE TABLE` (both measured on 17.11). The tool of
 * before made its tables wherever the search path said. A search path comes from `options` in the
 * address, from the role, from the database, or from a schema that has the name of the role.
 *
 * WARNING: the message does not name the schema. It can be the name of the role, which is in the address.
 */
async function refuseASearchPathThatIsNotPublic(db: Db): Promise<void> {
  const [row] = rowsOf(await db.execute(sql`SELECT current_schema() AS first`));
  if (row?.first === 'public') return;

  throw new StoreError(
    'The tables of the worker are in the schema « public », and the search path of FRUITBACK_DATABASE_URL ' +
      'puts another schema first: take the search path out of the address, of the role and of the database, ' +
      'and move to « public » the tables that an earlier image made elsewhere (docs/self-hosting.md)',
  );
}

/**
 * Refuses a role that cannot create in its database, and says what to grant.
 *
 * `migrate` of Drizzle sends `CREATE SCHEMA IF NOT EXISTS "public"` before anything else, and
 * PostgreSQL checks the privilege on the database before it looks for the schema (measured on 17.11:
 * « permission denied for database », for a role that can create tables in `public`). The role that
 * owns its database has that privilege. Without this check the worker says that the database did not
 * answer.
 *
 * WARNING: the message names no role and no database. Both are in the address.
 */
async function refuseARoleThatCannotCreate(db: Db): Promise<void> {
  const [row] = rowsOf(
    await db.execute(sql`SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS allowed`),
  );
  if (row?.allowed === true) return;

  throw new StoreError(
    'The role of FRUITBACK_DATABASE_URL cannot create in its database, and the migrations of the worker need it: ' +
      'make that role the owner of the database, or grant it CREATE on the database (docs/self-hosting.md)',
  );
}

/**
 * Refuses a folder that Drizzle would apply in part, or not at all, without a word.
 *
 * Drizzle names a migration by its date: `when` in the journal, `created_at` in the database. So a
 * row and an entry of one date are one migration, and their digests must be the same.
 */
async function refuseWhatDrizzleWouldSkip(db: Db, folder: string): Promise<void> {
  const journal = sql`${sql.identifier(APPLIED.migrationsSchema)}.${sql.identifier(APPLIED.migrationsTable)}`;
  const name = `${APPLIED.migrationsSchema}.${APPLIED.migrationsTable}`;
  // An empty database has no journal yet. Drizzle makes it, inside the lock that the caller holds.
  if (rowsOf(await db.execute(sql`SELECT to_regclass(${name}) AS journal`))[0]?.journal === null) return;

  const applied = new Map(
    rowsOf(await db.execute(sql`SELECT hash, created_at FROM ${journal}`)).map((row) => [
      Number(row.created_at),
      String(row.hash),
    ]),
  );
  const last = Math.max(...applied.keys());

  const entries = journalOf(folder);
  for (const [index, migration] of readMigrationFiles({ migrationsFolder: folder }).entries()) {
    const tag = entries[index]?.tag ?? String(index);
    const hash = applied.get(migration.folderMillis);

    if (hash === undefined && migration.folderMillis <= last) {
      throw new StoreError(
        `The migration « ${tag} » is dated before the last one that the database applied, and it is not applied: ` +
          'Drizzle would skip it in silence. Generate it again, after the migrations of the base',
      );
    }
    if (hash !== undefined && hash !== migration.hash) {
      throw new StoreError(
        `The migration « ${tag} » is not the one that the database applied under its date: ` +
          'a migration that shipped is never edited, a new one is added',
      );
    }
  }
}

/** Applies the migrations of `folder` that the database does not have yet, in order. */
export async function migrate(database: Database, folder: string = migrationsFolder()): Promise<void> {
  refuseTwoMigrationsOfOneDate(folder);
  await database.alone(async (db, apply) => {
    await refuseASearchPathThatIsNotPublic(db);
    await refuseARoleThatCannotCreate(db);
    await db.execute(sql`SELECT pg_advisory_lock(${MIGRATION_LOCK})`);
    try {
      await adoptWhatTheHomeMadeToolMade(db, folder);
      await refuseWhatDrizzleWouldSkip(db, folder);
      await apply({ migrationsFolder: folder, ...APPLIED });
    } finally {
      await db.execute(sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK})`);
    }
  });
}

/**
 * The database with its schema, once for each `Database`.
 *
 * A failure is not kept: the database may answer the next request, and that request tries again.
 */
const applied = new WeakMap<Database, Promise<void>>();

export function migrated(database: Database): Promise<void> {
  const known = applied.get(database);
  if (known !== undefined) return known;

  const running = migrate(database);
  applied.set(database, running);
  running.catch(() => applied.delete(database));

  return running;
}
