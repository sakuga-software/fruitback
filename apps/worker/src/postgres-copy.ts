import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseNote } from '@fruitback/shared';
import { getTableColumns, getTableName, sql } from 'drizzle-orm';
import { type PgTable, bigint, foreignKey, index, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import type { Database, Db } from './postgres.ts';
import { migrate, migrationsFolder } from './postgres-migrate.ts';
import { deliveries, email_links, note_comments, pairings } from './postgres-schema.ts';

/**
 * The `user_version` of each file of the last worker that wrote one: the one version this command
 * copies. The stores that wrote the files are gone (FRU-226). `postgres-copy.fixture.ts` writes the
 * files as they left them, and a test holds these numbers to it.
 */
export const ACCOUNTS_FILE_VERSION = 8;
export const SESSIONS_FILE_VERSION = 3;
export const NOTES_FILE_VERSION = 1;

/**
 * The accounts and the sessions of the two SQLite files, copied into PostgreSQL (FRU-145).
 *
 * This is the copy of the switch n° 1: the code is the same before and after, so the digests of the
 * tokens are copied as they are, and nobody signs in again and no extension pairs again.
 *
 * - **The two files are never opened.** Each file is copied with its `-wal` into a folder of its own,
 *   and the copy is read. SQLite applies the journal to the copy, and writes nothing beside the
 *   files, not even the `-shm` of a reader. The files are the way back.
 * - **The target is the schema of Drizzle as it was at `COPY_SCHEMA`**, the last migration whose
 *   tables are the ones of the two files (FRU-146). The copy applies the migrations up to that one,
 *   and no further. The worker applies the ones after it when it starts, as on any database: they
 *   move the people and the workspaces into the tables of better-auth. One statement moves a row,
 *   whether the copy or a worker of before wrote it.
 * - The columns of each table are compared on both sides before a row is written: a column on one
 *   side only is refused, where a copy would lose it.
 * - **One transaction, and a lock.** An interruption leaves nothing. A target that already holds
 *   exactly these rows is a run that went to its end: nothing is written again. Any other target with
 *   a row is refused.
 * - **The end is a count and a digest of each table, source against target**, read again inside the
 *   transaction. A difference rolls it back. `dryRun` does everything and rolls back.
 *
 * The sign-in links are not copied: they live 15 minutes.
 */

/**
 * The last migration whose tables are the ones of the two files. The copy stops the database there.
 */
export const COPY_SCHEMA = '0001_connector_settings';

/**
 * The four tables that `0002_accounts_in_better_auth` moves and drops, as `COPY_SCHEMA` has them: they
 * are in `postgres-schema.ts` no more. The other tables of the copy are the ones of that file.
 *
 * WARNING: a later migration that changes a table of the copy makes the schema of that file differ
 * from `COPY_SCHEMA`, and `postgres-copy.test.ts` then fails. Write that table here as it was.
 */
const instant = (name: string) => bigint(name, { mode: 'number' });

const accounts = pgTable('accounts', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique('accounts_email_key'),
  name: text('name'),
  locale: text('locale'),
  created_at: instant('created_at').notNull(),
});

const logins = pgTable(
  'logins',
  {
    provider: text('provider').notNull(),
    subject: text('subject').notNull(),
    account_id: text('account_id').notNull(),
    created_at: instant('created_at').notNull(),
  },
  (table) => [
    primaryKey({ name: 'logins_pkey', columns: [table.provider, table.subject] }),
    foreignKey({ name: 'logins_account_id_fkey', columns: [table.account_id], foreignColumns: [accounts.id] }).onDelete(
      'cascade',
    ),
  ],
);

const workspaces = pgTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  created_at: instant('created_at').notNull(),
});

const members = pgTable(
  'members',
  {
    workspace_id: text('workspace_id').notNull(),
    account_id: text('account_id').notNull(),
    role: text('role').notNull(),
    created_at: instant('created_at').notNull(),
  },
  (table) => [
    primaryKey({ name: 'members_pkey', columns: [table.workspace_id, table.account_id] }),
    foreignKey({
      name: 'members_workspace_id_fkey',
      columns: [table.workspace_id],
      foreignColumns: [workspaces.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'members_account_id_fkey',
      columns: [table.account_id],
      foreignColumns: [accounts.id],
    }).onDelete('cascade'),
    index('members_by_account').on(table.account_id),
  ],
);

/**
 * `connectors` as `COPY_SCHEMA` has it: FRU-360 added `installation`, which no file holds. Each
 * connector copied here has NULL there: no file holds a connector of the GitHub App.
 */
const connectors = pgTable('connectors', {
  id: text('id').primaryKey(),
  workspace_id: text('workspace_id').notNull(),
  kind: text('kind').notNull(),
  label: text('label').notNull(),
  sealed: text('sealed').notNull(),
  created_at: instant('created_at').notNull(),
  attention: text('attention'),
  attention_at: instant('attention_at'),
  settings: text('settings').notNull().default('{}'),
});

/**
 * `sites` as `COPY_SCHEMA` has it: FRU-330 added `writers`, which no file holds. `0021_sites_writers`
 * gives each site copied here `anyone`: it took a note from anybody in the worker that wrote the file.
 */
const sites = pgTable('sites', {
  id: text('id').primaryKey(),
  workspace_id: text('workspace_id').notNull(),
  origin: text('origin').notNull(),
  visibility: text('visibility').notNull(),
  created_at: instant('created_at').notNull(),
  connector_id: text('connector_id'),
  team_id: text('team_id'),
  project_id: text('project_id'),
});

/**
 * `site_destinations` as `COPY_SCHEMA` has it: FRU-382 added `private`, which no file holds. A
 * destination copied here keeps it NULL, not known, until it is written again or a note goes there.
 */
const site_destinations = pgTable('site_destinations', {
  site_id: text('site_id').notNull(),
  position: integer('position').notNull(),
  connector_id: text('connector_id').notNull(),
  team_id: text('team_id'),
  project_id: text('project_id'),
  label: text('label'),
});

/**
 * `sessions` as `COPY_SCHEMA` has it: FRU-238 added three columns to it, for a session of an account,
 * which no file holds. The worker adds them when it starts, NULL on every row copied here.
 */
const sessions = pgTable(
  'sessions',
  {
    token_hash: text('token_hash').primaryKey(),
    subject: text('subject').notNull(),
    name: text('name'),
    email: text('email'),
    workspace: text('workspace'),
    created_at: instant('created_at').notNull(),
    expires_at: instant('expires_at').notNull(),
    revoked_at: instant('revoked_at'),
    rotated_at: instant('rotated_at'),
    predecessor_hash: text('predecessor_hash'),
    root_hash: text('root_hash'),
  },
  (table) => [index('sessions_by_expiry').on(table.expires_at), index('sessions_by_root').on(table.root_hash)],
);

/** A table to copy, and the file that holds it. The order is the one of the foreign keys. */
const COPIED: readonly { file: 'accounts' | 'sessions'; table: PgTable }[] = [
  { file: 'accounts', table: accounts },
  { file: 'accounts', table: logins },
  { file: 'accounts', table: workspaces },
  { file: 'accounts', table: members },
  { file: 'accounts', table: connectors },
  { file: 'accounts', table: sites },
  { file: 'accounts', table: site_destinations },
  { file: 'accounts', table: deliveries },
  { file: 'sessions', table: pairings },
  { file: 'sessions', table: sessions },
];

/** Every table of the worker at `COPY_SCHEMA`. A target with a row in any of them is not empty. */
const EVERY_TABLE: readonly PgTable[] = [...COPIED.map((copied) => copied.table), email_links];

/**
 * Where the migrations after `COPY_SCHEMA` put the people and the workspaces: four tables of
 * better-auth, which are empty until then. A row in one of them is a row that the files do not have.
 * They are counted by their name: the schema of `auth-schema.ts` has columns that they do not have yet.
 */
const FILLED_LATER = ['user', 'account', 'organization', 'member'] as const;

/** Any number that no other advisory lock of the database uses. The migrations take another one. */
const COPY_LOCK = 1_450_145;

/** PostgreSQL takes 65,535 values in one statement. */
const VALUES_IN_ONE_INSERT = 60_000;

export type CopyInput = {
  accountsPath: string;
  sessionsPath: string;
  database: Database;
  dryRun: boolean;
};

export type CopyOutcome = { ok: boolean; lines: string[] };

type Row = Record<string, unknown>;

/** The count of a table, and the digest of its rows in a canonical order. */
type Tally = { count: number; digest: string };

class Refused extends Error {}

/** The names of the columns of a table, in the order of the schema. */
function columnsOf(table: PgTable): string[] {
  return Object.values(getTableColumns(table)).map((column) => column.name);
}

/**
 * The digest of these rows, whatever their order. A row is the list of its values in the order of
 * `columns`: a row of SQLite and a row of the schema of Drizzle give the same line.
 */
function tallyOf(rows: readonly Row[], columns: readonly string[]): Tally {
  const lines = rows.map((row) => JSON.stringify(columns.map((column) => row[column] ?? null))).sort();
  const digest = createHash('sha256').update(lines.join('\n')).digest('hex');

  return { count: rows.length, digest };
}

/** A copy of `path` with its journal, in `folder`. The file itself is only read. */
function snapshotOf(path: string, folder: string, name: string): string {
  const copy = join(folder, name);
  copyFileSync(path, copy);
  if (existsSync(`${path}-wal`)) copyFileSync(`${path}-wal`, `${copy}-wal`);

  return copy;
}

/** The rows of every copied table of one file, read from its copy. */
function readFile(copy: string, file: 'accounts' | 'sessions', version: number): Map<PgTable, Row[]> {
  const source = new DatabaseSync(copy);
  try {
    const found = (source.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (found !== version) {
      throw new Refused(
        `the ${file} file is at version ${found}, and this worker writes version ${version}: ` +
          'start the worker of this image on the files once, stop it, and run the copy again',
      );
    }

    const rows = new Map<PgTable, Row[]>();
    for (const { table } of COPIED.filter((copied) => copied.file === file)) {
      const name = getTableName(table);
      const expected = columnsOf(table);
      const present = (source.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map(
        (column) => column.name,
      );
      const missing = expected.filter((column) => !present.includes(column));
      const extra = present.filter((column) => !expected.includes(column));
      if (missing.length > 0 || extra.length > 0) {
        throw new Refused(
          `the table ${name} differs: ` +
            [
              ...missing.map((column) => `${column} is not in the ${file} file`),
              ...extra.map((column) => `${column} is not in PostgreSQL`),
            ].join(', '),
        );
      }
      const list = expected.map((column) => `"${column}"`).join(', ');
      rows.set(table, source.prepare(`SELECT ${list} FROM ${name}`).all() as Row[]);
    }

    return rows;
  } finally {
    source.close();
  }
}

/**
 * A folder with the migrations of the worker up to `COPY_SCHEMA`, in `into`: what `migrate` reads.
 */
function migrationsOfTheCopy(into: string): string {
  const all = migrationsFolder();
  const journal = JSON.parse(readFileSync(join(all, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  const last = journal.entries.findIndex((entry) => entry.tag === COPY_SCHEMA);
  if (last === -1) throw new Error(`The migrations of the worker have no « ${COPY_SCHEMA} »`);

  const entries = journal.entries.slice(0, last + 1);
  mkdirSync(join(into, 'meta'), { recursive: true });
  for (const { tag } of entries) copyFileSync(join(all, `${tag}.sql`), join(into, `${tag}.sql`));
  writeFileSync(join(into, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));

  return into;
}

/** Whether the database still has the tables of `COPY_SCHEMA`: no worker moved their rows yet. */
async function hasTheTablesOfTheCopy(db: Db): Promise<boolean> {
  const answer = await db.execute(sql`SELECT to_regclass('accounts') AS accounts`);

  return (answer as unknown as { rows: Row[] }).rows[0]?.accounts !== null;
}

/** The rows of `table` in the target, read through the schema: a `BIGINT` is a number there. */
async function targetRows(db: Db, table: PgTable): Promise<Row[]> {
  return (await db.select().from(table)) as Row[];
}

async function insertAll(db: Db, table: PgTable, rows: readonly Row[]): Promise<void> {
  const size = Math.max(1, Math.floor(VALUES_IN_ONE_INSERT / columnsOf(table).length));
  for (let start = 0; start < rows.length; start += size) {
    await db.insert(table).values(rows.slice(start, start + size) as never);
  }
}

/** One line for each table, and whether the two sides are the same. */
async function compare(
  db: Db,
  source: Map<PgTable, Row[]>,
): Promise<{ same: boolean; lines: string[]; empty: boolean; targetCounts: Map<string, number> }> {
  const lines: string[] = [];
  let same = true;
  const targetCounts = new Map<string, number>();
  for (const table of EVERY_TABLE) {
    const columns = columnsOf(table);
    const there = tallyOf(await targetRows(db, table), columns);
    targetCounts.set(getTableName(table), there.count);
    const rows = source.get(table);
    if (rows === undefined) {
      // A table that is not copied: a row in it is a row that the files do not have.
      same &&= there.count === 0;
      continue;
    }

    const here = tallyOf(rows, columns);
    const equal = here.count === there.count && here.digest === there.digest;
    same &&= equal;
    lines.push(
      `  ${getTableName(table).padEnd(18)} ${String(here.count).padStart(7)} ${String(there.count).padStart(7)}  ` +
        `${equal ? 'same' : 'DIFFERENT'}  ${there.digest.slice(0, 16)}`,
    );
  }
  for (const name of FILLED_LATER) {
    const answer = await db.execute(sql`SELECT count(*) AS count FROM ${sql.identifier(name)}`);
    const count = Number((answer as unknown as { rows: Row[] }).rows[0]?.count);
    targetCounts.set(name, count);
    same &&= count === 0;
  }
  const empty = [...targetCounts.values()].every((count) => count === 0);

  return { same, lines, empty, targetCounts };
}

const HEADER = `  ${'table'.padEnd(18)} ${'sqlite'.padStart(7)} ${'pg'.padStart(7)}  state  digest of the rows`;

export async function copySqliteFiles(input: CopyInput): Promise<CopyOutcome> {
  const folder = mkdtempSync(join(tmpdir(), 'fruitback-copy-'));
  const lines: string[] = [];
  try {
    const source = new Map<PgTable, Row[]>();
    for (const [file, path, version] of [
      ['accounts', input.accountsPath, ACCOUNTS_FILE_VERSION],
      ['sessions', input.sessionsPath, SESSIONS_FILE_VERSION],
    ] as const) {
      const copy = snapshotOf(path, folder, `${file}.db`);
      for (const [table, rows] of readFile(copy, file, version)) source.set(table, rows);
    }

    // Not `migrated`: the tables of the files are the ones of `COPY_SCHEMA`. A database that holds
    // later migrations is left as it is, and refused below.
    await migrate(input.database, migrationsOfTheCopy(join(folder, 'migrations')));

    return await input.database.alone(async (db) => {
      await db.execute(sql`BEGIN`);
      try {
        // Inside the transaction: two copies at the same moment wait for each other.
        await db.execute(sql`SELECT pg_advisory_xact_lock(${COPY_LOCK})`);
        if (!(await hasTheTablesOfTheCopy(db))) {
          throw new Refused(
            'a worker already started on this database, and moved the accounts into the tables of better-auth: ' +
              'the copy goes into an empty database only',
          );
        }
        const before = await compare(db, source);

        if (!before.empty) {
          if (before.same) {
            lines.push('PostgreSQL already holds exactly these rows: nothing is written.', HEADER, ...before.lines);
            await db.execute(sql`ROLLBACK`);

            return { ok: true, lines };
          }
          const held = [...before.targetCounts].filter(([, count]) => count !== 0).map(([name]) => name);
          throw new Refused(
            `PostgreSQL is not empty, and does not hold these rows: rows in ${held.join(', ')}. ` +
              'The copy goes into an empty database only',
          );
        }

        for (const { table } of COPIED) await insertAll(db, table, source.get(table) ?? []);

        const after = await compare(db, source);
        lines.push(HEADER, ...after.lines);
        if (!after.same) throw new Refused('a table of PostgreSQL differs from its file after the copy');

        if (input.dryRun) {
          await db.execute(sql`ROLLBACK`);
          lines.push('dry run: the counts are equal, and nothing was kept.');
        } else {
          await db.execute(sql`COMMIT`);
          lines.push(
            'copied: the counts are equal. The worker moves the accounts into the tables of better-auth when it starts.',
          );
        }

        return { ok: true, lines };
      } catch (error) {
        await db.execute(sql`ROLLBACK`).catch(() => undefined);
        throw error;
      }
    });
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    lines.push(`refused: ${error.message}. Nothing was written.`);

    return { ok: false, lines };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/**
 * The notes of the SQLite file of a worker, copied into PostgreSQL (FRU-220).
 *
 * The switch n° 1 bis: `FRUITBACK_STORE=sqlite` kept the notes in one file, and the store of the
 * database (FRU-218) starts empty. This copies the notes and their replies, and keeps their numbers:
 * a pin a page already shows is `FB-12`, and must find its note.
 *
 * - **The file is never opened**, as for the accounts: its copy is read, with its `-wal`.
 * - **The target is the database of a worker of this image.** Every migration is applied first, as
 *   the worker does when it starts. So it runs after the copy of the accounts, never before: that
 *   one goes into a database that no worker started on.
 * - **A note keeps its number, its text and its dates.** The `seed` of the file is copied into
 *   `payload` as it is, byte for byte.
 * - **A file that holds a note this worker cannot read is refused** (FRU-449). The SQLite store wrote
 *   the kind of before 0.4.0, and `rewrite-notes`, which read it, is gone: such a file is copied, and
 *   rewritten, by the worker 0.4.0.
 *   The file writes a date as ISO text, and the database as milliseconds: a date that does not come
 *   back to the same text is refused, with the number of its row.
 * - **The numbers go on after the largest one the file ever gave**, a note that was deleted since
 *   included: SQLite keeps that number in `sqlite_sequence`, and never gives it twice.
 * - **`clients` renames the site of a note.** A worker of `FRUITBACK_CLIENTS` named its sites
 *   itself, and a site of the console has an id of its own. `null` as a key is the notes that name
 *   no client, which a worker with one client wrote. A note whose site is no site of the database
 *   is copied, and said: no page reads it until then.
 * - **One transaction, a lock, a count and a digest of each table**, as for the accounts. A target
 *   that holds exactly these rows is a run that went to its end. Any other row in the two tables is
 *   refused. `dryRun` does everything and rolls back.
 */
export type NotesCopyInput = {
  notesPath: string;
  /** The site of a note, by the client it names in the file. `null`: the notes that name none. */
  clients: ReadonlyMap<string | null, string>;
  database: Database;
  dryRun: boolean;
};

/**
 * `notes` as the file can fill it: FRU-365 added `status_key`, which no file holds. A note copied
 * here keeps it NULL, the built-in status of its stage, as every note of before.
 */
const notes = pgTable('notes', {
  id: bigint('id', { mode: 'number' }).primaryKey(),
  client_id: text('client_id'),
  page_url: text('page_url').notNull(),
  stage: text('stage').notNull(),
  payload: text('payload').notNull(),
  created_at: instant('created_at').notNull(),
  updated_at: instant('updated_at').notNull(),
});

/**
 * The two tables of the file, with the table of the database each one goes to. The file keeps the
 * names of before FRU-378: `inFile` gives the name of a column of the database there.
 */
const NOTE_TABLES: readonly {
  name: string;
  table: PgTable;
  dates: readonly string[];
  inFile: Readonly<Record<string, string>>;
}[] = [
  { name: 'seeds', table: notes, dates: ['created_at', 'updated_at'], inFile: { payload: 'seed' } },
  { name: 'comments', table: note_comments, dates: ['created_at'], inFile: { note_id: 'seed_id' } },
];

/** The date of a row of the file, as the database keeps it. */
function instantOf(text: unknown, where: string): number {
  const instant = typeof text === 'string' ? Date.parse(text) : Number.NaN;
  if (Number.isNaN(instant) || new Date(instant).toISOString() !== text) {
    throw new Refused(`${where} holds a date that the database would not give back as it is written`);
  }

  return instant;
}

/** Whether a payload of the file reads as a note of now (FRU-449). */
function readsAsNote(payload: unknown): boolean {
  if (typeof payload !== 'string') return false;
  try {
    return parseNote(JSON.parse(payload)).ok;
  } catch {
    return false;
  }
}

/** The rows of the two tables of the file, as the database takes them, and the last number each table gave. */
function readNotesFile(
  copy: string,
  clients: ReadonlyMap<string | null, string>,
): { rows: Map<PgTable, Row[]>; last: Map<PgTable, number>; byClient: Map<string | null, number> } {
  const source = new DatabaseSync(copy);
  try {
    const found = (source.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (found !== NOTES_FILE_VERSION) {
      throw new Refused(
        `the seeds file is at version ${found}, and this worker reads version ${NOTES_FILE_VERSION}: ` +
          'it is not a file that the SQLite store of a worker of before FRU-225 wrote',
      );
    }

    const rows = new Map<PgTable, Row[]>();
    const last = new Map<PgTable, number>();
    const byClient = new Map<string | null, number>();
    const unread: unknown[] = [];
    const given = new Map(
      (source.prepare('SELECT name, seq FROM sqlite_sequence').all() as { name: string; seq: number }[]).map(
        (row) => [row.name, row.seq] as const,
      ),
    );
    for (const { name, table, dates, inFile } of NOTE_TABLES) {
      const columns = columnsOf(table);
      const expected = columns.map((column) => inFile[column] ?? column);
      const present = (source.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map(
        (column) => column.name,
      );
      const missing = expected.filter((column) => !present.includes(column));
      const extra = present.filter((column) => !expected.includes(column));
      if (missing.length > 0 || extra.length > 0) {
        throw new Refused(
          `the table ${name} differs: ` +
            [
              ...missing.map((column) => `${column} is not in the seeds file`),
              ...extra.map((column) => `${column} is not in PostgreSQL`),
            ].join(', '),
        );
      }
      const list = expected.map((column) => `"${column}"`).join(', ');
      const read = source.prepare(`SELECT ${list} FROM ${name} ORDER BY id`).all() as Row[];
      const taken = read.map((row) => {
        const kept: Row = Object.fromEntries(columns.map((column) => [column, row[inFile[column] ?? column]]));
        for (const date of dates) kept[date] = instantOf(row[date], `the row ${String(row.id)} of ${name}`);
        if (table === notes) {
          if (!readsAsNote(kept.payload)) unread.push(row.id);
          const before = (row.client_id ?? null) as string | null;
          byClient.set(before, (byClient.get(before) ?? 0) + 1);
          const site = clients.get(before);
          if (site !== undefined) kept.client_id = site;
        }

        return kept;
      });
      rows.set(table, taken);
      // Not `Math.max(...ids)`: a file of a hundred thousand notes is that many arguments.
      last.set(
        table,
        taken.reduce((largest, row) => Math.max(largest, Number(row.id)), given.get(name) ?? 0),
      );
    }
    if (unread.length > 0) {
      const shown = unread.slice(0, 5).map(String).join(', ') + (unread.length > 5 ? ', …' : '');
      throw new Refused(
        `${unread.length} note(s) of the file (row ${shown}) are not a note that this worker reads, ` +
          'the kind of before 0.4.0: copy this file with the worker 0.4.0, and run rewrite-notes there ' +
          '(docs/self-hosting/upgrade.md)',
      );
    }
    const unknown = [...clients.keys()].filter((before) => !byClient.has(before));
    if (unknown.length > 0) {
      throw new Refused(
        `no note of the file names ${unknown.map((before) => (before === null ? 'no client' : `« ${before} »`)).join(', ')}: ` +
          `the file names ${[...byClient.keys()].map((before) => (before === null ? 'no client' : `« ${before} »`)).join(', ') || 'nothing'}`,
      );
    }

    return { rows, last, byClient };
  } finally {
    source.close();
  }
}

/** One line for each of the two tables, and whether the two sides are the same. */
async function compareNotes(
  db: Db,
  source: Map<PgTable, Row[]>,
): Promise<{ same: boolean; empty: boolean; lines: string[] }> {
  const lines: string[] = [];
  let same = true;
  let empty = true;
  for (const { table } of NOTE_TABLES) {
    const columns = columnsOf(table);
    const there = tallyOf(await targetRows(db, table), columns);
    const here = tallyOf(source.get(table) ?? [], columns);
    const equal = here.count === there.count && here.digest === there.digest;
    same &&= equal;
    empty &&= there.count === 0;
    lines.push(
      `  ${getTableName(table).padEnd(18)} ${String(here.count).padStart(7)} ${String(there.count).padStart(7)}  ` +
        `${equal ? 'same' : 'DIFFERENT'}  ${there.digest.slice(0, 16)}`,
    );
  }

  return { same, empty, lines };
}

export async function copyNotesFile(input: NotesCopyInput): Promise<CopyOutcome> {
  const folder = mkdtempSync(join(tmpdir(), 'fruitback-copy-'));
  const lines: string[] = [];
  try {
    const source = readNotesFile(snapshotOf(input.notesPath, folder, 'seeds.db'), input.clients);

    // Every migration, as a worker applies them when it starts: the two tables are in the last ones.
    await migrate(input.database);

    return await input.database.alone(async (db) => {
      await db.execute(sql`BEGIN`);
      try {
        await db.execute(sql`SELECT pg_advisory_xact_lock(${COPY_LOCK})`);

        // What each client of the file becomes, and whether the database has that site.
        const known = new Set(
          ((await db.select({ id: sites.id }).from(sites)) as { id: string }[]).map((site) => site.id),
        );
        const sitesLines = [...source.byClient].map(([before, count]) => {
          const site = input.clients.get(before) ?? before;
          const from = before === null ? 'no client' : `« ${before} »`;
          const to = site === null ? 'no site' : `« ${site} »`;
          const read = site !== null && known.has(site);

          return (
            `  ${String(count).padStart(7)} note(s) of ${from} go to ${to}` +
            (read ? '' : ': NOT A SITE of this database, so no page reads them')
          );
        });

        const before = await compareNotes(db, source.rows);
        if (!before.empty) {
          if (before.same) {
            lines.push('PostgreSQL already holds exactly these notes: nothing is written.', HEADER, ...before.lines);
            await db.execute(sql`ROLLBACK`);

            return { ok: true, lines };
          }
          throw new Refused(
            'PostgreSQL already holds notes, and they are not the ones of the file. ' +
              'The copy goes into a database that holds no note',
          );
        }

        for (const { table } of NOTE_TABLES) await insertAll(db, table, source.rows.get(table) ?? []);

        const after = await compareNotes(db, source.rows);
        lines.push(HEADER, ...after.lines, 'the site of each note:', ...sitesLines);
        if (!after.same) throw new Refused('a table of PostgreSQL differs from the file after the copy');

        const next = (source.last.get(notes) ?? 0) + 1;
        if (input.dryRun) {
          await db.execute(sql`ROLLBACK`);
          lines.push(`dry run: the counts are equal, and nothing was kept. The next note would be FB-${next}.`);

          return { ok: true, lines };
        }
        // A sequence is outside the transaction: it goes forward for good, which is harmless if the
        // commit fails. `false` for a table that gave no number: its first one is 1.
        for (const { table } of NOTE_TABLES) {
          const last = source.last.get(table) ?? 0;
          await db.execute(
            sql`SELECT setval(pg_get_serial_sequence(${getTableName(table)}, 'id'), ${Math.max(last, 1)}, ${last > 0})`,
          );
        }
        await db.execute(sql`COMMIT`);
        lines.push(`copied: the counts are equal. The next note is FB-${next}.`);

        return { ok: true, lines };
      } catch (error) {
        await db.execute(sql`ROLLBACK`).catch(() => undefined);
        throw error;
      }
    });
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    lines.push(`refused: ${error.message}. Nothing was written.`);

    return { ok: false, lines };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
