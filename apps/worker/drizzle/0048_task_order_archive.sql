-- FRU-665. Where a task sits in its column, and when it was archived, in `notes` and in the index.
-- drizzle-kit wrote every statement. A row of before sits by its date, and is not archived.
ALTER TABLE "note_index" ADD COLUMN "archived_at" bigint;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "position" double precision;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "archived_at" bigint;