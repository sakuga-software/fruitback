-- FRU-633. The workspace of Linear of a `linear` connector made with OAuth, NULL for every other one.
-- Linear keeps one pair of tokens for each workspace of Linear: the connectors with one value share it.
-- drizzle-kit wrote every statement. A row of before gets its value at the next consent (`linear-oauth.ts`).
ALTER TABLE "connectors" ADD COLUMN "linear_organization" text;--> statement-breakpoint
CREATE INDEX "connectors_by_linear_organization" ON "connectors" USING btree ("linear_organization");