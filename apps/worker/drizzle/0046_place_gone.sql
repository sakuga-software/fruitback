-- FRU-640. Whether the tracker refused the place of a destination when a note went there, and since when.
-- drizzle-kit wrote every statement. A row of before reads as a place with no trouble.
ALTER TABLE "site_destinations" ADD COLUMN "attention" text;--> statement-breakpoint
ALTER TABLE "site_destinations" ADD COLUMN "attention_at" bigint;