-- FRU-331. The table of the pictures of FRU-44 holds the files of the notes in transit, on their way
-- to the ticket of the tracker: Fruitback stores no file (decision of 2026-10-20 on FRU-198).
--
-- drizzle-kit wrote every statement of this file but the last one, which moves no table and changes
-- the rows that were kept before. **It deletes nothing** (arbitration of 2026-10-21 on the reviews of
-- #427): every row of before ends 7 days after this migration, whatever its age, and the sweep of
-- the transit removes it then, as it removes every file whose transit ended. Until then a note still
-- on its way is delivered with its picture: a waiting delivery whose seed names it carries it
-- (withSignedFiles of rest-connector.ts), and so does a note of before sent again by its sender
-- (legacyFileOf of app.ts).
ALTER TABLE "screenshots" ALTER COLUMN "width" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "screenshots" ALTER COLUMN "height" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "screenshots" ADD COLUMN "name" text DEFAULT 'screenshot.png' NOT NULL;--> statement-breakpoint
ALTER TABLE "screenshots" ADD COLUMN "content_type" text DEFAULT 'image/png' NOT NULL;--> statement-breakpoint
ALTER TABLE "screenshots" ADD COLUMN "expires_at" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "screenshots" ADD COLUMN "seed_id" text;--> statement-breakpoint
CREATE INDEX "screenshots_by_expiry" ON "screenshots" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "screenshots_by_account" ON "screenshots" USING btree ("account_id");--> statement-breakpoint
UPDATE "screenshots" SET "expires_at" = (extract(epoch FROM clock_timestamp()) * 1000)::bigint + 604800000;
