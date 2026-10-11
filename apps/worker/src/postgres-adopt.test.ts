import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { createPostgresAccountStore } from './accounts-postgres.ts';
import { type Database, createPgDatabase } from './postgres.ts';
import { NO_REAL_POSTGRES, createPgliteDatabase, createRealDatabase, ownDatabase, rowsOf } from './postgres.fixture.ts';
import {
  HOME_MADE_MIGRATIONS,
  THEN,
  catalogueOf,
  contentOf,
  madeByTheHomeMadeTool,
  withRows,
} from './postgres-home-made.fixture.ts';
import { APPLIED, BASELINE, HOME_MADE, migrate, migrationsFolder } from './postgres-migrate.ts';
import { createPostgresSessionStore } from './session-postgres.ts';
import { StoreError } from './store.ts';

/**
 * A database that the migration tool of before made passes under Drizzle, and nothing in it is run
 * again or lost (FRU-180).
 *
 * That tool was `migrate` of `postgres.ts` with the four migrations of `HOME_MADE`. It shipped in
 * images of `main` from FRU-141 to FRU-144, so a database of a worker can hold its tables, its rows
 * and its `schema_migrations`. `postgres-home-made.fixture.ts` makes such a database with the SQL
 * that shipped, and plants a row or more in each of the eighteen tables.
 *
 * Each case runs on PGlite, and on a real server when the run has one.
 */

const opened: Database[] = [];
afterEach(async () => {
  for (const database of opened.splice(0)) await database.close();
});

async function opening(open: () => Promise<Database>): Promise<Database> {
  const database = await open();
  opened.push(database);

  return database;
}

const folders: string[] = [];
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

/**
 * The folder with the baseline alone: what the first image of Drizzle had. The tool of before made
 * the database of the baseline, so the two are compared there, before any later migration.
 */
function baselineAlone(): string {
  const folder = mkdtempSync(join(tmpdir(), 'fruitback-adopt-'));
  folders.push(folder);
  cpSync(migrationsFolder(), folder, { recursive: true });
  const journalFile = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalFile, 'utf8')) as { entries: { tag: string }[] };
  writeFileSync(journalFile, JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }));
  for (const file of readdirSync(folder))
    if (file.endsWith('.sql') && file !== `${BASELINE}.sql`) rmSync(join(folder, file));

  return folder;
}

/** The migrations of the worker, and one more after them that adds a column. */
function withOneMoreMigration(): string {
  const folder = mkdtempSync(join(tmpdir(), 'fruitback-adopt-'));
  folders.push(folder);
  cpSync(migrationsFolder(), folder, { recursive: true });
  const journalFile = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalFile, 'utf8')) as { entries: { when: number }[] };
  const last = journal.entries.at(-1)?.when ?? 0;
  const tag = `000${journal.entries.length}_one_more`;
  journal.entries.push({ idx: journal.entries.length, version: '7', when: last + 1, tag, breakpoints: true } as never);
  writeFileSync(journalFile, JSON.stringify(journal));
  writeFileSync(join(folder, `${tag}.sql`), 'ALTER TABLE "accounts" ADD COLUMN "one_more" text;');

  return folder;
}

/** What the journal of Drizzle holds: the digest and the date of each migration it applied. */
async function drizzleJournal(database: Database): Promise<{ hash: string; created_at: number }[]> {
  const rows = await rowsOf(database, `SELECT hash, created_at FROM ${APPLIED.migrationsTable} ORDER BY id`);

  return rows.map((row) => ({ hash: String(row.hash), created_at: Number(row.created_at) }));
}

async function has(database: Database, table: string): Promise<boolean> {
  return (await rowsOf(database, sql`SELECT to_regclass(${table}) AS found`))[0]?.found !== null;
}

/** What the tool of before wrote in its journal: the number and the name of each migration. */
async function homeMadeJournal(database: Database): Promise<string[]> {
  const rows = await rowsOf(database, 'SELECT version, name FROM schema_migrations ORDER BY version');

  return rows.map((row) => `${String(row.version)} ${String(row.name)}`);
}

const FILES = readMigrationFiles({ migrationsFolder: migrationsFolder() });
const [BASELINE_FILE] = FILES;
assert.ok(BASELINE_FILE !== undefined, 'the worker has no migration');
/** The journal of a database that has every migration of the worker: the baseline first. */
const WHOLE_JOURNAL = FILES.map((file) => ({ hash: file.hash, created_at: file.folderMillis }));

const DATABASES = [
  { label: 'PGlite', open: createPgliteDatabase, skip: false },
  { label: 'a real server', open: createRealDatabase, skip: NO_REAL_POSTGRES },
] as const;

it('copies the migrations of the tool of before under the names its journal holds', () => {
  assert.deepEqual(
    HOME_MADE_MIGRATIONS.map((migration) => migration.name),
    [...HOME_MADE],
  );
});

for (const { label, open, skip } of DATABASES) {
  describe(`a database that the migration tool of before made, on ${label} (FRU-180)`, { skip }, () => {
    it('makes the database that the tool of before made, to the last name', async () => {
      const before = await opening(open);
      await madeByTheHomeMadeTool(before);
      const homeMade = await catalogueOf(before);
      await before.close();
      opened.splice(opened.indexOf(before), 1);

      const fresh = await opening(open);
      await migrate(fresh, baselineAlone());
      const drizzle = await catalogueOf(fresh);

      // Eighteen tables: a count that is not zero, so that two empty lists do not pass.
      assert.ok(homeMade.length > 150, `only ${homeMade.length} lines in the catalogue`);
      assert.deepEqual(drizzle, homeMade);
    });

    it('is adopted: nothing is run again, every row stays, and the stores read them', async () => {
      const database = await opening(open);
      await madeByTheHomeMadeTool(database);
      await withRows(database);
      const content = await contentOf(database);
      const catalogue = await catalogueOf(database);
      assert.ok(
        Object.values(content).every((each) => !each.startsWith('0 ')),
        'a table has no row, so its digest proves nothing',
      );

      // The baseline alone first: the adoption runs nothing, so nothing of the database changes.
      await migrate(database, baselineAlone());

      assert.deepEqual(await drizzleJournal(database), [
        { hash: BASELINE_FILE.hash, created_at: BASELINE_FILE.folderMillis },
      ]);
      assert.deepEqual(await contentOf(database), content);
      assert.deepEqual(await catalogueOf(database), catalogue);
      // Then the migrations that came after it, which the stores of this build read.
      await migrate(database);
      assert.deepEqual(await drizzleJournal(database), WHOLE_JOURNAL);
      // Kept as it is: an image of before reads it after a roll back.
      assert.deepEqual(await homeMadeJournal(database), [
        '1 accounts',
        '2 site_destinations',
        '3 sessions',
        '4 better-auth',
      ]);

      const accounts = createPostgresAccountStore(database);
      const alice = await accounts.signIn({ provider: 'github', subject: '42', email: 'alice@acme.dev' });
      assert.deepEqual(alice, { id: 'acc_alice', email: 'alice@acme.dev', name: 'Alice', locale: 'fr' });
      assert.deepEqual(await accounts.memberships('acc_alice'), [
        { workspace: { id: 'ws_acme', name: 'Acme' }, role: 'owner' },
      ]);
      assert.deepEqual(await accounts.sites('ws_acme'), [
        {
          id: 'site_acme',
          workspaceId: 'ws_acme',
          origin: 'https://acme.dev',
          visibility: 'members',
          destinations: [{ connector: 'con_linear', teamId: 'team-design', label: 'Linear · Design' }],
        },
      ]);
      assert.equal((await accounts.sealedKey('con_linear'))?.sealed, 'sealed-key-of-linear');
      assert.equal(await accounts.spendEmailLink('digest-of-an-email-code', THEN + 1), 'alice@acme.dev');

      const sessions = createPostgresSessionStore(database);
      assert.deepEqual(
        await sessions.rotateSession({
          tokenHash: 'digest-of-a-refresh-token',
          successorHash: 'digest-of-its-successor',
          now: THEN + 1,
          graceMs: 30_000,
        }),
        {
          outcome: 'rotated',
          identity: { subject: 'acc_alice', name: 'Alice', email: 'alice@acme.dev', workspace: 'ws_acme' },
        },
      );
    });

    it('is adopted at the first call of a store, as a worker meets it', async () => {
      const database = await opening(open);
      await madeByTheHomeMadeTool(database);
      await withRows(database);

      assert.deepEqual(await createPostgresAccountStore(database).account('acc_alice'), {
        id: 'acc_alice',
        email: 'alice@acme.dev',
        name: 'Alice',
        locale: 'fr',
      });
      assert.deepEqual(await drizzleJournal(database), WHOLE_JOURNAL);
    });

    it('then gets the migrations that come after the baseline, and only those', async () => {
      const database = await opening(open);
      await madeByTheHomeMadeTool(database);
      await withRows(database);

      await migrate(database, withOneMoreMigration());

      assert.equal((await drizzleJournal(database)).length, WHOLE_JOURNAL.length + 1);
      assert.deepEqual(await rowsOf(database, 'SELECT id, one_more FROM accounts'), [
        { id: 'acc_alice', one_more: null },
      ]);
    });

    // The control of the adoption: without it, Drizzle runs the baseline, and the first CREATE TABLE fails.
    it('fails on its first CREATE TABLE when Drizzle alone meets it, and writes no row of its journal', async () => {
      const database = await opening(open);
      await madeByTheHomeMadeTool(database);

      const failure = await database
        .alone((_, apply) => apply({ migrationsFolder: migrationsFolder(), ...APPLIED }))
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      assert.ok(failure !== undefined, 'Drizzle ran the baseline on tables that are there');
      assert.match(String((failure as { message?: unknown }).message ?? failure), /already exists/);
      assert.deepEqual(await drizzleJournal(database), []);
    });

    // What a `drizzle-kit migrate` run by hand leaves: Drizzle makes its journal before its transaction.
    it('is adopted all the same after Drizzle alone met it, and left its journal empty', async () => {
      const database = await opening(open);
      await madeByTheHomeMadeTool(database);
      await withRows(database);
      const content = await contentOf(database);
      await assert.rejects(database.alone((_, apply) => apply({ migrationsFolder: migrationsFolder(), ...APPLIED })));
      assert.deepEqual(await drizzleJournal(database), [], 'Drizzle left no empty journal: nothing is tested');

      await migrate(database, baselineAlone());

      assert.deepEqual(await drizzleJournal(database), [
        { hash: BASELINE_FILE.hash, created_at: BASELINE_FILE.folderMillis },
      ]);
      assert.deepEqual(await contentOf(database), content);
    });

    // The control on a new database: the baseline runs there, and nothing is adopted.
    it('is not adopted on a new database: there the baseline runs, and no journal of before appears', async () => {
      const database = await opening(open);

      await migrate(database);

      assert.equal(await has(database, 'public.accounts'), true);
      assert.equal(await has(database, 'public.schema_migrations'), false);
      assert.deepEqual(await drizzleJournal(database), WHOLE_JOURNAL);
    });

    it('refuses a database that the tool of before left at an earlier migration, and writes nothing', async () => {
      const database = await opening(open);
      await madeByTheHomeMadeTool(database, 3);
      const catalogue = await catalogueOf(database);

      await assert.rejects(migrate(database), (error: unknown) => {
        assert.ok(error instanceof StoreError, String(error));
        assert.match(error.message, /holds « accounts, site_destinations, sessions »/);
        assert.match(error.message, /Start an image of the worker from #143/);

        return true;
      });
      assert.equal(await has(database, `public.${APPLIED.migrationsTable}`), false);
      assert.deepEqual(await catalogueOf(database), catalogue);
    });

    it('refuses a database whose journal of before was edited', async () => {
      const database = await opening(open);
      await madeByTheHomeMadeTool(database);
      await rowsOf(database, `UPDATE schema_migrations SET name = 'better_auth' WHERE version = 4`);

      await assert.rejects(migrate(database), /holds « accounts, site_destinations, sessions, better_auth »/);
      assert.equal(await has(database, `public.${APPLIED.migrationsTable}`), false);
    });
  });
}

/**
 * Two workers that start together on a database of before: one adopts it, the other one waits for
 * the lock, then finds it adopted. Two pools on one database, as two replicas have.
 */
describe('a database of before that two workers meet at once (FRU-180)', { skip: NO_REAL_POSTGRES }, () => {
  it('is adopted once', async () => {
    const own = await ownDatabase();
    const first = createPgDatabase(own.url);
    const second = createPgDatabase(own.url);
    try {
      await madeByTheHomeMadeTool(first);
      await withRows(first);
      const content = await contentOf(first);

      await Promise.all([migrate(first), migrate(second)]);

      assert.deepEqual(await drizzleJournal(first), [
        { hash: BASELINE_FILE.hash, created_at: BASELINE_FILE.folderMillis },
      ]);
      assert.deepEqual(await contentOf(second), content);
    } finally {
      await first.close();
      await second.close();
      await own.drop();
    }
  });
});

it(`names ${BASELINE} as the first migration of the worker, the one an adoption writes`, () => {
  const { entries } = JSON.parse(readFileSync(join(migrationsFolder(), 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };

  assert.equal(entries[0]?.tag, BASELINE);
});
