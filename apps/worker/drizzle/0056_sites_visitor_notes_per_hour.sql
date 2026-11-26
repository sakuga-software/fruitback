-- FRU-704. The notes a visitor with no account leaves on a site in an hour, 0 for no limit.
-- Every site takes 10, the value of the mockup, those of before included: Fruitback has no users yet.
ALTER TABLE "sites" ADD COLUMN "visitor_notes_per_hour" integer DEFAULT 10 NOT NULL;