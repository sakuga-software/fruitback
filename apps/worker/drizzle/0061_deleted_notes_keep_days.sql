ALTER TABLE "note_index" ADD COLUMN "erased_at" bigint;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "deleted_notes_keep_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
CREATE INDEX "note_index_by_removal" ON "note_index" USING btree ("removed_at") WHERE "removed_at" IS NOT NULL AND "erased_at" IS NULL;