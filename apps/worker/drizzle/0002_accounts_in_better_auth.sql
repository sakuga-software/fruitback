-- FRU-146. The people, their ways to sign in, the workspaces and their members move to the tables
-- of better-auth: accounts -> "user", logins -> "account", workspaces -> "organization",
-- members -> "member". The ids stay (acc_, ws_).
--
-- drizzle-kit wrote every statement of this file but the four INSERT, from postgres-schema.ts and
-- auth-schema.ts. It writes no copy of rows, and it dropped the tables first, with CASCADE, which
-- takes the two foreign keys it then drops by name. So the statements are in another order here:
-- the columns the rows need, the rows, the foreign keys, and the tables last, with no CASCADE: a
-- thing that still depends on one of them fails the migration, and the transaction of the run
-- leaves the database as it was. docs/decisions/worker.md says what each value is, and why.
ALTER TABLE "user" ADD COLUMN "locale" text;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_providerId_accountId_key" UNIQUE("providerId","accountId");--> statement-breakpoint
INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt", "locale")
SELECT "id", COALESCE("name", ''), "email", true,
       'epoch'::timestamptz + "created_at" * interval '1 millisecond',
       'epoch'::timestamptz + "created_at" * interval '1 millisecond',
       "locale"
  FROM "accounts";--> statement-breakpoint
INSERT INTO "account" ("id", "accountId", "providerId", "userId", "createdAt", "updatedAt")
SELECT 'lgn_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 20), "subject", "provider", "account_id",
       'epoch'::timestamptz + "created_at" * interval '1 millisecond',
       'epoch'::timestamptz + "created_at" * interval '1 millisecond'
  FROM "logins";--> statement-breakpoint
INSERT INTO "organization" ("id", "name", "slug", "createdAt")
SELECT "id", "name", "id", 'epoch'::timestamptz + "created_at" * interval '1 millisecond'
  FROM "workspaces";--> statement-breakpoint
INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt")
SELECT 'mem_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 20), "workspace_id", "account_id", "role",
       'epoch'::timestamptz + "created_at" * interval '1 millisecond'
  FROM "members";--> statement-breakpoint
ALTER TABLE "connectors" DROP CONSTRAINT "connectors_workspace_id_fkey";
--> statement-breakpoint
ALTER TABLE "sites" DROP CONSTRAINT "sites_workspace_id_fkey";
--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logins" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "members" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspaces" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "accounts" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "logins";--> statement-breakpoint
DROP TABLE "members";--> statement-breakpoint
DROP TABLE "workspaces";--> statement-breakpoint
DROP TABLE "accounts";
