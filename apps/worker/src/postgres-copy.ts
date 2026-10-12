import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getTableColumns, getTableName, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { ACCOUNTS_FILE_VERSION } from './accounts-sqlite.ts';
import type { Database, Db } from './postgres.ts';
import { migrated } from './postgres-migrate.ts';
import {
  accounts,
  connectors,
  deliveries,
  email_links,
  logins,
  members,
  pairings,
  sessions,
  site_destinations,
  sites,
  workspaces,
} from './postgres-schema.ts';
import { SESSIONS_FILE_VERSION } from './session-sqlite.ts';

/**
 * The accounts and the sessions of the two SQLite files, copied into PostgreSQL (FRU-145).
 *
 * This is the copy of the switch n° 1: the code is the same before and after, so the digests of the
 * tokens are copied as they are, and nobody signs in again and no extension pairs again.
 *
 * - **The two files are never opened.** Each file is copied with its `-wal` into a folder of its own,
 *   and the copy is read. SQLite applies the journal to the copy, and writes nothing beside the
 *   files, not even the `-shm` of a reader. The files are the way back.
 * - **The target is the schema of Drizzle**, applied by `migrated` before the copy. The columns of
 *   each table are compared on both sides before a row is written: a column on one side only is
 *   refused, where a copy would lose it.
 * - **One transaction, and a lock.** An interruption leaves nothing. A target that already holds
 *   exactly these rows is a run that went to its end: nothing is written again. Any other target with
 *   a row is refused.
 * - **The end is a count and a digest of each table, source against target**, read again inside the
 *   transaction. A difference rolls it back. `dryRun` does everything and rolls back.
 *
 * The sign-in links are not copied: they live 15 minutes.
 */

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

/** Every table of the worker. A target with a row in any of them is not empty. */
const EVERY_TABLE: readonly PgTable[] = [...COPIED.map((copied) => copied.table), email_links];

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
): Promise<{ same: boolean; lines: string[]; empty: boolean; targetCounts: Map<PgTable, number> }> {
  const lines: string[] = [];
  let same = true;
  const targetCounts = new Map<PgTable, number>();
  for (const table of EVERY_TABLE) {
    const columns = columnsOf(table);
    const there = tallyOf(await targetRows(db, table), columns);
    targetCounts.set(table, there.count);
    const rows = source.get(table);
    if (rows === undefined) continue;

    const here = tallyOf(rows, columns);
    const equal = here.count === there.count && here.digest === there.digest;
    same &&= equal;
    lines.push(
      `  ${getTableName(table).padEnd(18)} ${String(here.count).padStart(7)} ${String(there.count).padStart(7)}  ` +
        `${equal ? 'same' : 'DIFFERENT'}  ${there.digest.slice(0, 16)}`,
    );
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

    await migrated(input.database);

    return await input.database.alone(async (db) => {
      await db.execute(sql`BEGIN`);
      try {
        // Inside the transaction: two copies at the same moment wait for each other.
        await db.execute(sql`SELECT pg_advisory_xact_lock(${COPY_LOCK})`);
        const before = await compare(db, source);

        if (!before.empty) {
          if (before.same) {
            lines.push('PostgreSQL already holds exactly these rows: nothing is written.', HEADER, ...before.lines);
            await db.execute(sql`ROLLBACK`);

            return { ok: true, lines };
          }
          const held = EVERY_TABLE.filter((table) => (before.targetCounts.get(table) ?? 0) > 0).map(getTableName);
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
          lines.push('copied: the counts are equal.');
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
