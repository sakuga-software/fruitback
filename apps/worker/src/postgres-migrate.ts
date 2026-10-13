import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { Database, Db } from './postgres.ts';
import { BASELINE_CATALOGUE } from './postgres-baseline-catalogue.ts';
import { StoreError } from './store.ts';

/**
 * The migrations of the PostgreSQL database of a worker, applied by Drizzle (FRU-180).
 *
 * `drizzle-kit generate` writes them in `drizzle/`, from `postgres-schema.ts`, and they are
 * committed. The worker applies them at its first call to the database: the image has no `npx` and
 * no `drizzle-kit`, and its host has no step before a deployment.
 *
 * **This file applies them itself, as `migrate` of Drizzle does** (FRU-219), and `readMigrationFiles`
 * of Drizzle still reads the folder: one row for each migration in `__drizzle_migrations`, with the
 * digest of its file and its date, and every migration that is not applied in one transaction. Two
 * things made it leave `migrate`: Drizzle sends `CREATE SCHEMA IF NOT EXISTS`, which PostgreSQL
 * refuses to a role that cannot create in its database even when the schema is there, and it runs a
 * file as it is written, where a schema that is not `public` needs another name in the foreign keys
 * (`inSchema`).
 *
 * **`migrate` of Drizzle does three things that this file never left to it.** Read on
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

/**
 * Where what is applied is written, for a database in `public`: beside the tables, as
 * `drizzle.config.ts` names it. In another schema the journal has the same name, in that schema:
 * `migrate` reads `database.schema`, and this object is for a call to `migrate` of Drizzle itself.
 */
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

/** The two journals: `schema_migrations` of the tool of before, and the one of Drizzle. */
const JOURNALS = ['schema_migrations', APPLIED.migrationsTable] as const;

/**
 * The catalogue of `public`, one line for each column (with its place, its type, its default and
 * « not null »), each constraint (with its name and its definition) and each index, in the order of
 * their text. The journals of the two tools are left out.
 *
 * The lines are the same on PostgreSQL 16, 17 and 18 (measured on 16.x, 17.11 and 18.3, FRU-189),
 * with one thing left out: from 18 on, `pg_constraint` holds a row for each « not null » (`contype`
 * `n`), 85 of them for the baseline. The line of a column says « not null » already.
 */
export async function catalogueOf(db: Db, schema: string = APPLIED.migrationsSchema): Promise<string[]> {
  return (await catalogueWithTables(db, schema)).map((entry) => entry.line);
}

/** Each line of the catalogue, with the table it is about. */
async function catalogueWithTables(db: Db, schema: string): Promise<{ table: string; line: string }[]> {
  // An index names its table with its schema, whatever the search path: the lines of the baseline
  // say `public`, so the name of another schema is read as that one.
  const elsewhere = ` ON ${schema}.`;
  const rows = rowsOf(
    await db.execute(
      sql`SELECT t, line FROM (
            SELECT table_name AS t, 'column ' || table_name || '.' || column_name || ' #' || ordinal_position || ' ' ||
                   data_type || ' null:' || is_nullable || ' default:' || coalesce(column_default, '') AS line
              FROM information_schema.columns WHERE table_schema = ${schema}
            UNION ALL
            SELECT t.relname, 'constraint ' || t.relname || ' ' || c.conname || ': ' || pg_get_constraintdef(c.oid)
              FROM pg_constraint c
              JOIN pg_class t ON t.oid = c.conrelid
              JOIN pg_namespace n ON n.oid = c.connamespace
             WHERE n.nspname = ${schema} AND c.contype <> 'n'
            UNION ALL
            SELECT tablename, 'index ' || indexname || ': ' || replace(indexdef, ${elsewhere}, ' ON public.')
              FROM pg_indexes WHERE schemaname = ${schema}
          ) AS catalogue
          WHERE t NOT IN (${sql.join(
            JOURNALS.map((name) => sql`${name}`),
            sql`, `,
          )})
          ORDER BY line COLLATE "C"`,
    ),
  );

  return rows.map((row) => ({ table: String(row.t), line: String(row.line) }));
}

/** The tables that the baseline makes: each one has a column, and a line of a column starts with its table. */
const BASELINE_TABLES = new Set(
  BASELINE_CATALOGUE.filter((line) => line.startsWith('column ')).map((line) =>
    line.slice('column '.length, line.indexOf('.')),
  ),
);

/**
 * Refuses a database of the tool of before whose tables are not the ones that the baseline makes
 * (FRU-189), before the adoption writes anything.
 *
 * The adoption runs nothing: it says that the baseline is applied. That is true only when the
 * database is what the baseline would have made. A column that somebody dropped by hand, an index or
 * a constraint that is gone, and a later migration fails in its middle, or the worker runs without a
 * `UNIQUE` that its stores count on. So each line of `BASELINE_CATALOGUE` must be in the catalogue
 * of the database, and each line of the database about a table of the baseline must be in
 * `BASELINE_CATALOGUE`. A table that the baseline does not make is another application's, and is
 * left alone.
 *
 * The message names the first line that is missing and the first one that is not expected: a
 * column of another type is both. It quotes the catalogue only, never a row.
 */
async function refuseACatalogueThatIsNotTheBaseline(db: Db, schema: string): Promise<void> {
  const expected = new Set(BASELINE_CATALOGUE);
  const found = await catalogueWithTables(db, schema);
  const here = new Set(found.map((entry) => entry.line));

  const missing = BASELINE_CATALOGUE.find((line) => !here.has(line));
  const unexpected = found.find((entry) => BASELINE_TABLES.has(entry.table) && !expected.has(entry.line))?.line;
  if (missing === undefined && unexpected === undefined) return;

  const gaps = [
    missing === undefined ? undefined : `it does not have « ${missing} »`,
    unexpected === undefined ? undefined : `it has « ${unexpected} », which that migration does not make`,
  ].filter((gap) => gap !== undefined);
  throw new StoreError(
    `This database was made by the migration tool of before, and its tables are not the ones that « ${BASELINE} » makes: ` +
      `${gaps.join(', and ')}. Nothing was written. Change the database by hand until it is what the image of ` +
      'before made, then start this one again (docs/decisions/worker.md, FRU-189)',
  );
}

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
 * migration of that tool, one whose list was edited, or one whose tables are not the ones that the
 * baseline makes (`refuseACatalogueThatIsNotTheBaseline`). `schema_migrations` is kept as it is. An
 * image of before reads it, so a roll back to such an image still finds its database.
 *
 * The caller holds the lock: two processes do not adopt one database twice.
 */
async function adoptWhatTheHomeMadeToolMade(db: Db, folder: string, schema: string): Promise<void> {
  const [found] = rowsOf(
    await db.execute(
      sql`SELECT to_regclass(${`${schema}.${APPLIED.migrationsTable}`}) AS drizzle,
                 to_regclass(${`${schema}.schema_migrations`}) AS home_made`,
    ),
  );
  // A database that the tool of before never touched.
  if (found === undefined || found.home_made === null) return;
  const journal = journalIn(schema);
  // A database under Drizzle already: its journal holds a row.
  if (found.drizzle !== null && rowsOf(await db.execute(sql`SELECT 1 FROM ${journal} LIMIT 1`)).length > 0) return;

  const rows = rowsOf(
    await db.execute(sql`SELECT version, name FROM ${sql.identifier(schema)}.schema_migrations ORDER BY version`),
  );
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

  await refuseACatalogueThatIsNotTheBaseline(db, schema);

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

/** The journal of a schema, as a statement names it. */
function journalIn(schema: string) {
  return sql`${sql.identifier(schema)}.${sql.identifier(APPLIED.migrationsTable)}`;
}

/**
 * Makes the schema of the worker when it is not there, and refuses a role that cannot write in it.
 *
 * - **The schema is there**: the role needs `CREATE` on it, for the tables and for the journal, and
 *   nothing on the database. `CREATE SCHEMA IF NOT EXISTS` is not sent: PostgreSQL checks the
 *   privilege on the database before it looks for the schema (measured on 17.11: « permission denied
 *   for database », for a role that can create tables in the schema). So a role that an operator
 *   gave one schema of a database that is not theirs is enough.
 * - **The schema is not there**: the role needs `CREATE` on the database, to make it. The role
 *   that owns its database has it.
 *
 * Without this check the worker says that the database did not answer.
 *
 * WARNING: the message names no role and no database. Both are in the address. It names the schema:
 * that one is in `FRUITBACK_DATABASE_SCHEMA`, and is no secret.
 */
async function ensureTheSchema(db: Db, schema: string): Promise<void> {
  const [row] = rowsOf(
    await db.execute(
      sql`SELECT to_regnamespace(${schema}) IS NOT NULL AS there,
                 has_database_privilege(current_user, current_database(), 'CREATE') AS in_database,
                 CASE WHEN to_regnamespace(${schema}) IS NULL THEN NULL
                      ELSE has_schema_privilege(current_user, ${schema}, 'CREATE')
                       AND has_schema_privilege(current_user, ${schema}, 'USAGE') END AS in_schema`,
    ),
  );

  if (row?.there !== true) {
    if (row?.in_database !== true) {
      throw new StoreError(
        `The schema « ${schema} » is not in the database, and the role of FRUITBACK_DATABASE_URL cannot create ` +
          'in its database to make it: make the schema and grant that role CREATE and USAGE on it, or make that role ' +
          'the owner of the database (docs/self-hosting.md)',
      );
    }
    // Under the lock of the caller: two workers that start together do not both make it.
    await db.execute(sql`CREATE SCHEMA ${sql.identifier(schema)}`);

    return;
  }
  if (row.in_schema === true) return;

  // Both rights, asked together (raised in review). With `CREATE` and no `USAGE`, PostgreSQL leaves
  // the schema out of the search path and `current_schema()` is NULL: the guard that comes next
  // would say that a pooler lost the session, which sends an operator to the wrong place.
  throw new StoreError(
    `The role of FRUITBACK_DATABASE_URL cannot create in the schema « ${schema} », or cannot use it, and the ` +
      'worker needs both: grant that role CREATE and USAGE on the schema, or make it the owner of the database ' +
      '(docs/self-hosting.md)',
  );
}

/**
 * Refuses a connection whose tables would not go in the schema of the worker.
 *
 * A migration makes a table where the search path says. `postgres.ts` sets the search path of every
 * connection to the schema alone, so this holds: it is asked once more here, on the connection that
 * is about to write, because a table in the schema of another application is not taken back. A
 * `Database` that is not the one of `postgres.ts` (a test, a pooler that lost the state of the
 * session) is what it stops.
 */
async function refuseASearchPathThatIsNotTheSchema(db: Db, schema: string): Promise<void> {
  const [row] = rowsOf(await db.execute(sql`SELECT current_schema() AS first`));
  if (row?.first === schema) return;

  throw new StoreError(
    `The tables of the worker are in the schema « ${schema} », and this connection would write elsewhere: ` +
      'its search path is not the one the worker set. A pooler that shares one session between clients loses it: ' +
      'give FRUITBACK_DATABASE_URL an address that keeps a session (docs/self-hosting.md)',
  );
}

/**
 * A statement of a migration, for the schema of the worker.
 *
 * `drizzle-kit` names `"public"` wherever a statement names a schema: in every foreign key
 * (`REFERENCES "public"."organization"`). A table that names no schema goes where the search path
 * says. So for another schema that one name is written again, in the text that is sent and not in
 * the file: **the digest of the journal is the one of the file as it is written**, the same in every
 * schema, and the check on a migration that was edited compares it.
 *
 * Regenerating the migrations with no schema was the other way (no database of production holds
 * them yet). `drizzle-kit` 0.31 has no option to leave the schema out of a foreign key, and a schema
 * written in `postgres-schema.ts` is one name for every worker.
 *
 * test:`names « public » in the migrations only where a statement names a schema` holds the form:
 * a migration that writes the word in a string or a comment is refused before a merge.
 */
export function inSchema(statement: string, schema: string): string {
  return schema === APPLIED.migrationsSchema ? statement : statement.replaceAll('"public".', `"${schema}".`);
}

/**
 * Applies what the journal of the database does not hold yet, in one transaction: what
 * `PgDialect.migrate` of drizzle-orm 0.45.4 does, with the statements of `inSchema` and with no
 * `CREATE SCHEMA`. The table is the one Drizzle makes, to the last word, so a `drizzle-kit migrate`
 * that somebody runs by hand reads this journal.
 *
 * The caller holds the lock, made the schema, and refused what the comparison of the dates would
 * skip in silence.
 */
async function applyWhatIsNotApplied(db: Db, folder: string, schema: string): Promise<void> {
  const journal = journalIn(schema);
  await db.execute(
    sql`CREATE TABLE IF NOT EXISTS ${journal} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
  );
  const [last] = rowsOf(await db.execute(sql`SELECT created_at FROM ${journal} ORDER BY created_at DESC LIMIT 1`));
  const pending = readMigrationFiles({ migrationsFolder: folder }).filter(
    (migration) => last === undefined || Number(last.created_at) < migration.folderMillis,
  );
  if (pending.length === 0) return;

  await db.transaction(async (transaction) => {
    for (const migration of pending) {
      for (const statement of migration.sql) await transaction.execute(sql.raw(inSchema(statement, schema)));
      await transaction.execute(
        sql`INSERT INTO ${journal} ("hash", "created_at") VALUES (${migration.hash}, ${migration.folderMillis})`,
      );
    }
  });
}

/**
 * Refuses a folder that Drizzle would apply in part, or not at all, without a word.
 *
 * Drizzle names a migration by its date: `when` in the journal, `created_at` in the database. So a
 * row and an entry of one date are one migration, and their digests must be the same.
 */
async function refuseWhatDrizzleWouldSkip(db: Db, folder: string, schema: string): Promise<void> {
  const journal = journalIn(schema);
  const name = `${schema}.${APPLIED.migrationsTable}`;
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
/**
 * Refuses an empty schema when the tool of before left its database in another one (FRU-219).
 *
 * That tool made its tables wherever the search path said, and the worker sets the search path
 * itself now: such a database, reached with `options=-c search_path=<schema>`, would get the baseline
 * in `public`, and a worker with no account. FRU-181 refused that path with an explanation; this says
 * what replaced it. Raised in review. Only an empty schema is concerned: a schema that holds a
 * journal is a worker that started there already, and so is a schema of the tool that a worker
 * adopted. A `schema_migrations` of another application
 * is not taken for one of the tool: its first row must be the first migration of that tool.
 */
async function refuseTheToolOfBeforeInAnotherSchema(db: Db, schema: string): Promise<void> {
  const [mine] = rowsOf(
    await db.execute(
      sql`SELECT to_regclass(${`${schema}.${APPLIED.migrationsTable}`}) AS drizzle,
                 to_regclass(${`${schema}.schema_migrations`}) AS home_made`,
    ),
  );
  if (mine?.drizzle !== null || mine?.home_made !== null) return;

  const elsewhere = rowsOf(
    await db.execute(
      sql`SELECT schemaname FROM pg_tables
           WHERE tablename = 'schema_migrations' AND schemaname <> ${schema}
             AND schemaname NOT IN ('pg_catalog', 'information_schema')
             -- Adopted already: a worker of this build runs there, and this one is a second worker.
             AND to_regclass(quote_ident(schemaname) || '.' || ${APPLIED.migrationsTable}) IS NULL
           ORDER BY schemaname`,
    ),
  ).map((row) => String(row.schemaname));
  for (const other of elsewhere) {
    const [first] = rowsOf(
      await db
        .execute(sql`SELECT name FROM ${sql.identifier(other)}.schema_migrations ORDER BY version LIMIT 1`)
        // A table of that name with other columns is not one of the tool.
        .catch(() => ({ rows: [] })),
    );
    if (first?.name === HOME_MADE[0]) {
      throw new StoreError(
        `The schema « ${schema} » is empty, and the migration tool of before left this database in the schema ` +
          `« ${other} »: the worker sets its search path itself now, and the one of the address has no effect. ` +
          `Set FRUITBACK_DATABASE_SCHEMA=${other} to keep it there, or move its tables to « ${schema} » by hand ` +
          '(docs/self-hosting.md). Nothing was written',
      );
    }
  }
}

export async function migrate(database: Database, folder: string = migrationsFolder()): Promise<void> {
  refuseTwoMigrationsOfOneDate(folder);
  const { schema } = database;
  await database.alone(async (db) => {
    // One lock for the database, whatever the schema: two workers of two schemas wait for each other.
    await db.execute(sql`SELECT pg_advisory_lock(${MIGRATION_LOCK})`);
    try {
      await ensureTheSchema(db, schema);
      await refuseASearchPathThatIsNotTheSchema(db, schema);
      await refuseTheToolOfBeforeInAnotherSchema(db, schema);
      await adoptWhatTheHomeMadeToolMade(db, folder, schema);
      await refuseWhatDrizzleWouldSkip(db, folder, schema);
      await applyWhatIsNotApplied(db, folder, schema);
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
