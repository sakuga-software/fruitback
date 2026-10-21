-- FRU-331. The table of the pictures of FRU-44 holds the files of the notes in transit, on their way
-- to the ticket of the tracker: Fruitback stores no file (decision of 2026-10-20 on FRU-198).
--
-- drizzle-kit wrote every statement of this file but the last two, which move no table and change
-- the rows that were kept before. A row of before names no note: the note named the address of the
-- picture, GET /screenshot/<id>, which this change removes. Only the rows whose note is delivered go
-- (arbitration of 2026-10-21 on the review of #427):
-- 1. A row that a note kept by the worker names (its id is in "seeds"."seed"), and that no delivery
--    still waits to send, goes now: its note is delivered, and nothing reads the picture again.
-- 2. Every row that stays ends 7 days after this migration, whatever its age: a note still on its
--    way is delivered with it until then. A waiting delivery whose seed names the address of the
--    picture carries it (withSignedFiles of rest-connector.ts), and so does a note of before sent
--    again by a widget (legacyFileOf of app.ts).
ALTER TABLE "screenshots" ALTER COLUMN "width" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "screenshots" ALTER COLUMN "height" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "screenshots" ADD COLUMN "name" text DEFAULT 'screenshot.png' NOT NULL;--> statement-breakpoint
ALTER TABLE "screenshots" ADD COLUMN "content_type" text DEFAULT 'image/png' NOT NULL;--> statement-breakpoint
ALTER TABLE "screenshots" ADD COLUMN "expires_at" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "screenshots" ADD COLUMN "seed_id" text;--> statement-breakpoint
CREATE INDEX "screenshots_by_expiry" ON "screenshots" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "screenshots_by_account" ON "screenshots" USING btree ("account_id");--> statement-breakpoint
DELETE FROM "screenshots" AS "s" WHERE EXISTS (SELECT 1 FROM "seeds" AS "n" WHERE strpos("n"."seed", "s"."id") > 0) AND NOT EXISTS (SELECT 1 FROM "deliveries" AS "d" WHERE strpos("d"."body", "s"."id") > 0);--> statement-breakpoint
UPDATE "screenshots" SET "expires_at" = (extract(epoch FROM clock_timestamp()) * 1000)::bigint + 604800000;
