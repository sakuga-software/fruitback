-- FRU-715. A workspace gets a short name, the `acme` of `/w/acme` in the console: it is
-- "organization"."slug", which better-auth already holds unique and which held a value that nothing
-- read (an id, or `newId('slug')`). The names that a workspace leaves wait 30 days in
-- "workspace_former_slugs".
--
-- drizzle-kit wrote the table, its key and its index. The two UPDATE at the end are not generated:
-- they give each workspace of before the short name read in its name, as `slugFromName` of
-- `src/workspace-slug.ts` reads it for a new workspace (the accents of Latin-1 go, anything else that
-- is not a letter or a digit becomes one `-`, 35 characters at most). A name that gives less than 3
-- characters or a reserved word, and every workspace after the oldest one that reads the same name,
-- get 8 characters of the md5 of their id after it. The first UPDATE writes the id, which holds a `_`
-- that no short name holds: the second one then meets no value of before on the unique constraint.
-- `workspace-slugs-migration.test.ts` holds the list of reserved words to `RESERVED_SLUGS`.
CREATE TABLE "workspace_former_slugs" (
	"slug" text NOT NULL,
	"workspace_id" text NOT NULL,
	"until" bigint NOT NULL,
	CONSTRAINT "workspace_former_slugs_pkey" PRIMARY KEY("slug")
);
--> statement-breakpoint
ALTER TABLE "workspace_former_slugs" ADD CONSTRAINT "workspace_former_slugs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_former_slugs_by_workspace" ON "workspace_former_slugs" USING btree ("workspace_id");--> statement-breakpoint
UPDATE "organization" SET "slug" = "id";--> statement-breakpoint
WITH "read" AS (
  SELECT "id", "createdAt",
         rtrim(left(trim(BOTH '-' FROM regexp_replace(
           lower(translate("name",
             'ÀÁÂÃÄÅàáâãäåÇçÈÉÊËèéêëÌÍÎÏìíîïÑñÒÓÔÕÖòóôõöÙÚÛÜùúûüÝýÿ',
             'AAAAAAaaaaaaCcEEEEeeeeIIIIiiiiNnOOOOOoooooUUUUuuuuYyy')),
           '[^a-z0-9]+', '-', 'g')), 35), '-') AS "base"
  FROM "organization"
), "based" AS (
  SELECT "id", "createdAt",
         CASE WHEN length("base") < 3 THEN 'workspace' ELSE "base" END AS "base"
  FROM "read"
), "ranked" AS (
  SELECT "id", "base",
         row_number() OVER (PARTITION BY "base" ORDER BY "createdAt", "id") AS "rank"
  FROM "based"
)
UPDATE "organization" SET "slug" = CASE
    WHEN "ranked"."rank" = 1 AND NOT "ranked"."base" = ANY (ARRAY[
      'about', 'account', 'admin', 'api', 'app', 'assets', 'auth', 'authorize', 'billing', 'blog',
      'cloud', 'config', 'connect', 'console', 'dashboard', 'docs', 'fruitback', 'help', 'invitations',
      'kit', 'login', 'logout', 'mcp', 'new', 'oauth', 'root', 'settings', 'setup', 'sign-in',
      'sign-out', 'sign-up', 'signin', 'signup', 'static', 'status', 'support', 'system',
      'verify-email', 'w', 'well-known', 'workspace', 'workspaces', 'www'
    ]) THEN "ranked"."base"
    ELSE rtrim(left("ranked"."base", 31), '-') || '-' || left(md5("organization"."id"), 8)
  END
FROM "ranked"
WHERE "ranked"."id" = "organization"."id";