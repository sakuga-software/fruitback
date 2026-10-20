-- FRU-331. The table of the pictures of FRU-44 holds the files of the notes in transit, on their way
-- to the ticket of the tracker: Fruitback stores no file (decision of 2026-10-20 on FRU-198).
--
-- drizzle-kit wrote every statement of this file but the last three, which move no table and change
-- the rows that were kept before. A row of before names no note: the note named the address of the
-- picture, GET /screenshot/<id>, which this change removes. So:
-- 1. A row that a note kept by the worker names (its id is in "seeds"."seed"), and that no delivery
--    still waits to send, goes now: its note is written, and nothing reads the picture again.
-- 2. Every other row ends 7 days after it came, as a file in transit does.
-- 3. A row already past that end goes now.
ALTER TABLE "screenshots" ALTER COLUMN "width" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "screenshots" ALTER COLUMN "height" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "screenshots" ADD COLUMN "name" text DEFAULT 'screenshot.png' NOT NULL;--> statement-breakpoint
ALTER TABLE "screenshots" ADD COLUMN "content_type" text DEFAULT 'image/png' NOT NULL;--> statement-breakpoint
ALTER TABLE "screenshots" ADD COLUMN "expires_at" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "screenshots" ADD COLUMN "seed_id" text;--> statement-breakpoint
CREATE INDEX "screenshots_by_expiry" ON "screenshots" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "screenshots_by_account" ON "screenshots" USING btree ("account_id");--> statement-breakpoint
DELETE FROM "screenshots" AS "s" WHERE EXISTS (SELECT 1 FROM "seeds" AS "n" WHERE strpos("n"."seed", "s"."id") > 0) AND NOT EXISTS (SELECT 1 FROM "deliveries" AS "d" WHERE strpos("d"."body", "s"."id") > 0);--> statement-breakpoint
UPDATE "screenshots" SET "expires_at" = "created_at" + 604800000;--> statement-breakpoint
DELETE FROM "screenshots" WHERE "expires_at" <= (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
