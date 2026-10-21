-- FRU-360. The fingerprint of the installation of a `github` connector, NULL for every other kind.
-- Its unique constraint makes one installation of the GitHub App feed one connector of the instance.
-- drizzle-kit wrote every statement. No row of before holds an installation: FRU-359 wrote none.
ALTER TABLE "connectors" ADD COLUMN "installation" text;--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_installation_key" UNIQUE("installation");