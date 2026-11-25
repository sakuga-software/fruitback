-- FRU-703. What a visitor may do to a note of their own, and « Read only ».
-- drizzle-kit wrote the two columns, with `never` for every site that exists: no site changes. The last
-- statement is not generated: `writers` now decides on every site, and a site that everyone read took a
-- note from anybody, whatever it said. So it says `anyone`, and still does.
ALTER TABLE "sites" ADD COLUMN "visitor_edit" text DEFAULT 'never' NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "visitor_delete" text DEFAULT 'never' NOT NULL;--> statement-breakpoint
UPDATE "sites" SET "writers" = 'anyone' WHERE "visibility" = 'everyone';
