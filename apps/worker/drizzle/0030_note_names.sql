-- FRU-378. A note was a « seed »: its tables, columns, sequences, indexes and constraints take the
-- name of a note (plan E of FRU-445). Written by hand into the empty file of
-- `drizzle-kit generate --custom`.
--
-- Names only: no row is read or written, so the file takes the time of a lock and no more. Each
-- statement acts only when the old name is still there and the new one is not, so the file can run
-- twice, and on a database that the tool of before made with other names of constraints.
--
-- seeds -> notes, seeds.seed -> notes.payload, seed_comments -> note_comments,
-- seed_comments.seed_id -> note_id, note_index.seed_id -> note_id, screenshots.seed_id -> note_id,
-- with the sequences, the indexes and every constraint whose name says « seed ».
--
-- Rollback: REVERSE_SQL in note-names-migration.test.ts, which runs it. Run it before a worker of
-- before FRU-378 starts again.
DO $$
DECLARE
  r record;
BEGIN
  IF to_regclass('seeds') IS NOT NULL AND to_regclass('notes') IS NULL THEN
    ALTER TABLE "seeds" RENAME TO "notes";
  END IF;
  IF to_regclass('seed_comments') IS NOT NULL AND to_regclass('note_comments') IS NULL THEN
    ALTER TABLE "seed_comments" RENAME TO "note_comments";
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
              AND table_name = 'notes' AND column_name = 'seed') THEN
    ALTER TABLE "notes" RENAME COLUMN "seed" TO "payload";
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
              AND table_name = 'note_comments' AND column_name = 'seed_id') THEN
    ALTER TABLE "note_comments" RENAME COLUMN "seed_id" TO "note_id";
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
              AND table_name = 'note_index' AND column_name = 'seed_id') THEN
    ALTER TABLE "note_index" RENAME COLUMN "seed_id" TO "note_id";
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
              AND table_name = 'screenshots' AND column_name = 'seed_id') THEN
    ALTER TABLE "screenshots" RENAME COLUMN "seed_id" TO "note_id";
  END IF;

  IF to_regclass('seeds_id_seq') IS NOT NULL AND to_regclass('notes_id_seq') IS NULL THEN
    ALTER SEQUENCE "seeds_id_seq" RENAME TO "notes_id_seq";
  END IF;
  IF to_regclass('seed_comments_id_seq') IS NOT NULL AND to_regclass('note_comments_id_seq') IS NULL THEN
    ALTER SEQUENCE "seed_comments_id_seq" RENAME TO "note_comments_id_seq";
  END IF;

  IF to_regclass('seeds_by_page') IS NOT NULL AND to_regclass('notes_by_page') IS NULL THEN
    ALTER INDEX "seeds_by_page" RENAME TO "notes_by_page";
  END IF;
  IF to_regclass('seeds_by_client') IS NOT NULL AND to_regclass('notes_by_client') IS NULL THEN
    ALTER INDEX "seeds_by_client" RENAME TO "notes_by_client";
  END IF;
  IF to_regclass('seed_comments_by_seed') IS NOT NULL AND to_regclass('note_comments_by_note') IS NULL THEN
    ALTER INDEX "seed_comments_by_seed" RENAME TO "note_comments_by_note";
  END IF;

  -- Every constraint of the four tables whose name says « seed »: the primary keys (which rename
  -- their index with them), the foreign key, and the NOT NULL that PostgreSQL 18 names.
  FOR r IN
    SELECT c.conrelid::regclass AS tbl, c.conname AS old,
           replace(replace(replace(replace(c.conname, 'seed_comments', 'note_comments'), 'seeds_', 'notes_'),
                           'seed_id', 'note_id'), '_seed_', '_payload_') AS new
      FROM pg_constraint c
     WHERE c.connamespace = current_schema()::regnamespace
       AND c.conrelid IN (to_regclass('notes'), to_regclass('note_comments'), to_regclass('note_index'),
                          to_regclass('screenshots'))
       AND c.conname LIKE '%seed%'
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = r.tbl AND conname = r.new) THEN
      EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', r.tbl, r.old, r.new);
    END IF;
  END LOOP;
END
$$;
