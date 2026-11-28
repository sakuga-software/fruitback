-- FRU-672. A task written by hand may have no site: it belongs to its workspace only, and its row of
-- the index has `site_id` '' (`NO_SITE`). No site has that id, so the foreign key to `sites` moves
-- to `site_ref`, the site id or NULL, which PostgreSQL computes from `site_id`. A row of a site still
-- goes with its site; a row with no site goes with its workspace (`note_index_workspace_id_fkey`).
-- No row is changed: every row of before has a site, so its `site_ref` is its `site_id`.
ALTER TABLE "note_index" DROP CONSTRAINT "note_index_site_id_fkey";
--> statement-breakpoint
ALTER TABLE "note_index" ADD COLUMN "site_ref" text GENERATED ALWAYS AS (NULLIF(site_id, '')) STORED;--> statement-breakpoint
ALTER TABLE "note_index" ADD CONSTRAINT "note_index_site_ref_fkey" FOREIGN KEY ("site_ref") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_index_by_site_ref" ON "note_index" USING btree ("site_ref");