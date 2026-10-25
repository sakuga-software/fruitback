import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { DATABASES, databasesOfACase } from './auth.fixture.ts';
import { migrationsThrough, rowsOf } from './postgres.fixture.ts';
import { migrate } from './postgres-migrate.ts';

/**
 * `0030_note_names` (FRU-378) on a database that holds notes, replies, rows of the index and files,
 * made by the migrations of before. Every table, column, sequence, index and key takes the name of a
 * note; every row stays as it was; the numbers go on; the file can run twice; and REVERSE_SQL below
 * gives the old names back, which is the rollback.
 */

const { opening } = databasesOfACase();

/** The rollback of `0030_note_names`, to run before a worker of before FRU-378 starts again. */
const REVERSE_SQL = [
  'ALTER TABLE "note_comments" RENAME CONSTRAINT "note_comments_note_id_fkey" TO "seed_comments_seed_id_fkey"',
  'ALTER TABLE "note_comments" RENAME CONSTRAINT "note_comments_pkey" TO "seed_comments_pkey"',
  'ALTER TABLE "notes" RENAME CONSTRAINT "notes_pkey" TO "seeds_pkey"',
  'ALTER INDEX "note_comments_by_note" RENAME TO "seed_comments_by_seed"',
  'ALTER INDEX "notes_by_client" RENAME TO "seeds_by_client"',
  'ALTER INDEX "notes_by_page" RENAME TO "seeds_by_page"',
  'ALTER SEQUENCE "note_comments_id_seq" RENAME TO "seed_comments_id_seq"',
  'ALTER SEQUENCE "notes_id_seq" RENAME TO "seeds_id_seq"',
  'ALTER TABLE "screenshots" RENAME COLUMN "note_id" TO "seed_id"',
  'ALTER TABLE "note_index" RENAME COLUMN "note_id" TO "seed_id"',
  'ALTER TABLE "note_comments" RENAME COLUMN "note_id" TO "seed_id"',
  'ALTER TABLE "notes" RENAME COLUMN "payload" TO "seed"',
  'ALTER TABLE "note_comments" RENAME TO "seed_comments"',
  'ALTER TABLE "notes" RENAME TO "seeds"',
];

const BEFORE = [
  `INSERT INTO organization (id, name, slug, "createdAt") VALUES ('ws_acme', 'Acme', 'ws_acme', now())`,
  `INSERT INTO sites (id, workspace_id, origin, visibility, created_at) VALUES ('site_a', 'ws_acme', 'https://a.acme.dev', 'members', 1)`,
  `INSERT INTO seeds (client_id, page_url, stage, seed, created_at, updated_at) VALUES
     ('site_a', 'https://a.acme.dev/', 'new', '{"id":"sd_one"}', 1, 1),
     ('site_a', 'https://a.acme.dev/', 'done', '{"id":"sd_two"}', 2, 2)`,
  `INSERT INTO seed_comments (seed_id, author, body, created_at) VALUES (1, 'Alice', 'Seen.', 3), (2, NULL, 'Fixed.', 4)`,
  `INSERT INTO note_index (site_id, seed_id, workspace_id, page_url, excerpt, stage, author_kind, place, created_at, checked_at)
     VALUES ('site_a', 'sd_one', 'ws_acme', 'https://a.acme.dev/', 'One', 'new', 'visitor', 'fruitback', 1, 1)`,
  `INSERT INTO screenshots (id, workspace_id, account_id, content, created_at, seed_id)
     VALUES ('shot_1', 'ws_acme', 'acc_alice', '\\x89504e47'::bytea, 1, 'sd_one')`,
];

/**
 * The names of the database that are about notes, in a sorted list. Not the NOT NULL constraints:
 * PostgreSQL 18 names them and 17 does not. `seedNames` checks those.
 */
async function names(database: Awaited<ReturnType<typeof opening>>): Promise<string[]> {
  const rows = await rowsOf(
    database,
    `SELECT 'relation ' || c.relname AS name FROM pg_class c
       WHERE c.relnamespace = current_schema()::regnamespace AND (c.relname LIKE '%seed%' OR c.relname LIKE 'note%')
     UNION ALL
     SELECT 'column ' || table_name || '.' || column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND (column_name LIKE '%seed%' OR column_name IN ('payload', 'note_id'))
     UNION ALL
     SELECT 'constraint ' || conname FROM pg_constraint
       WHERE connamespace = current_schema()::regnamespace AND contype <> 'n'
         AND (conname LIKE '%seed%' OR conname LIKE 'note%')`,
  );

  return rows.map((row) => String(row.name)).sort();
}

const AFTER_NAMES = [
  'column note_comments.note_id',
  'column note_index.note_id',
  'column notes.payload',
  'column screenshots.note_id',
  'constraint note_comments_note_id_fkey',
  'constraint note_comments_pkey',
  'constraint note_index_author_account_id_fkey',
  'constraint note_index_connector_id_fkey',
  'constraint note_index_pkey',
  'constraint note_index_site_id_fkey',
  'constraint note_index_workspace_id_fkey',
  'constraint notes_pkey',
  'relation note_comments',
  'relation note_comments_by_note',
  'relation note_comments_id_seq',
  'relation note_comments_pkey',
  'relation note_index',
  'relation note_index_by_author',
  'relation note_index_by_date',
  'relation note_index_by_workspace',
  'relation note_index_pkey',
  'relation notes',
  'relation notes_by_client',
  'relation notes_by_page',
  'relation notes_id_seq',
  'relation notes_pkey',
];

/** Every name of a constraint that still says « seed », the NOT NULL of PostgreSQL 18 included. */
async function seedNames(database: Awaited<ReturnType<typeof opening>>): Promise<string[]> {
  const rows = await rowsOf(
    database,
    `SELECT conname FROM pg_constraint WHERE connamespace = current_schema()::regnamespace AND conname LIKE '%seed%'`,
  );

  return rows.map((row) => String(row.conname));
}

/** The rows of the four tables, read by their new names. */
async function rows(database: Awaited<ReturnType<typeof opening>>) {
  return {
    notes: await rowsOf(database, 'SELECT id::int AS id, client_id, stage, payload FROM notes ORDER BY id'),
    comments: await rowsOf(
      database,
      'SELECT id::int AS id, note_id::int AS note_id, author, body FROM note_comments ORDER BY id',
    ),
    index: await rowsOf(database, 'SELECT site_id, note_id, excerpt FROM note_index'),
    files: await rowsOf(database, 'SELECT id, note_id FROM screenshots'),
  };
}

for (const { label, open, skip } of DATABASES) {
  describe(`the names of the notes in the database, on ${label} (FRU-378)`, { skip: skip !== false }, () => {
    it('renames every table, column, sequence, index and key, and keeps every row', async () => {
      const database = await opening(open);
      await migrate(database, migrationsThrough('0029_connector_name'));
      for (const statement of BEFORE) await rowsOf(database, statement);

      await migrate(database);

      assert.deepEqual(await names(database), AFTER_NAMES);
      assert.deepEqual(await seedNames(database), []);
      assert.deepEqual(await rows(database), {
        notes: [
          { id: 1, client_id: 'site_a', stage: 'new', payload: '{"id":"sd_one"}' },
          { id: 2, client_id: 'site_a', stage: 'done', payload: '{"id":"sd_two"}' },
        ],
        comments: [
          { id: 1, note_id: 1, author: 'Alice', body: 'Seen.' },
          { id: 2, note_id: 2, author: null, body: 'Fixed.' },
        ],
        index: [{ site_id: 'site_a', note_id: 'sd_one', excerpt: 'One' }],
        files: [{ id: 'shot_1', note_id: 'sd_one' }],
      });
    });

    it('gives the next note and the next reply the numbers after the last ones', async () => {
      const database = await opening(open);
      await migrate(database, migrationsThrough('0029_connector_name'));
      for (const statement of BEFORE) await rowsOf(database, statement);
      await migrate(database);

      const [note] = await rowsOf(
        database,
        `INSERT INTO notes (client_id, page_url, stage, payload, created_at, updated_at)
           VALUES ('site_a', 'https://a.acme.dev/', 'new', '{}', 5, 5) RETURNING id`,
      );
      const [reply] = await rowsOf(
        database,
        `INSERT INTO note_comments (note_id, body, created_at) VALUES (${Number(note?.id)}, 'Later.', 6) RETURNING id`,
      );

      assert.equal(Number(note?.id), 3);
      assert.equal(Number(reply?.id), 3);
      // The key still holds: a reply of a note that is deleted goes with it.
      await rowsOf(database, 'DELETE FROM notes WHERE id = 1');
      assert.deepEqual(
        (await rowsOf(database, 'SELECT note_id FROM note_comments ORDER BY id')).map((row) => Number(row.note_id)),
        [2, 3],
      );
    });

    it('changes nothing when it runs a second time', async () => {
      const database = await opening(open);
      await migrate(database, migrationsThrough('0029_connector_name'));
      for (const statement of BEFORE) await rowsOf(database, statement);
      await migrate(database);
      const once = { names: await names(database), rows: await rows(database) };

      const file = readFileSync(new URL('../drizzle/0030_note_names.sql', import.meta.url), 'utf8');
      for (const statement of file.split('--> statement-breakpoint')) await rowsOf(database, statement);

      assert.deepEqual({ names: await names(database), rows: await rows(database) }, once);
    });

    it('gives the old names back with REVERSE_SQL, the rollback', async () => {
      const database = await opening(open);
      await migrate(database, migrationsThrough('0029_connector_name'));
      for (const statement of BEFORE) await rowsOf(database, statement);
      const before = await names(database);
      await migrate(database);

      for (const statement of REVERSE_SQL) await rowsOf(database, statement);

      assert.deepEqual(await names(database), before);
      assert.deepEqual(
        (await rowsOf(database, 'SELECT id, seed FROM seeds ORDER BY id')).map((row) => row.seed),
        ['{"id":"sd_one"}', '{"id":"sd_two"}'],
      );
    });
  });
}
