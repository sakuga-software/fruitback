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

  const { entries } = JSON.parse(readFileSync(`${folder}/meta/_journal.json`, 'utf8')) as {
    entries: { tag: string }[];
  };
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
  await database.alone(async (db, apply) => {
    await db.execute(sql`SELECT pg_advisory_lock(${MIGRATION_LOCK})`);
    try {
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
