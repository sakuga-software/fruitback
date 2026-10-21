-- FRU-365. The statuses of a site (docs/decisions/statuses.md), and the key of a status on a note
-- that the worker keeps. Nothing is dropped or rewritten: connectors.settings keeps its "stages" one
-- version, so a worker of before reads what it wrote.
--
-- drizzle-kit wrote every statement of this file but the INSERT, from postgres-schema.ts. It writes
-- no copy of rows. The INSERT copies the stages that FRU-102 kept per Linear connector, by id of a
-- state, to every site that sends to that connector (site_destinations): each site keeps what its
-- connector showed. It keeps only what readConnectorSettings of accounts.ts keeps: an id of 1 to 64
-- of [A-Za-z0-9_-], and one of the five stages. Settings that are not JSON, or whose "stages" is not
-- an object, copy nothing; the CASE are nested because PostgreSQL does not promise the order of an
-- AND, and the cast must never see what pg_input_is_valid refused.
CREATE TABLE "statuses" (
	"site_id" text NOT NULL,
	"source" text NOT NULL,
	"key" text NOT NULL,
	"name" text,
	"stage" text NOT NULL,
	"color" text,
	"text_color" text,
	"position" integer DEFAULT 0 NOT NULL,
	"origin" text DEFAULT 'tracker' NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	CONSTRAINT "statuses_pkey" PRIMARY KEY("site_id","source","key")
);
--> statement-breakpoint
ALTER TABLE "seeds" ADD COLUMN "status_key" text;--> statement-breakpoint
ALTER TABLE "statuses" ADD CONSTRAINT "statuses_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "statuses" ("site_id", "source", "key", "stage")
SELECT DISTINCT d."site_id", c."id", e."key", e."value"
  FROM "connectors" c
  JOIN "site_destinations" d ON d."connector_id" = c."id"
  CROSS JOIN LATERAL jsonb_each_text(
    CASE WHEN pg_input_is_valid(c."settings", 'jsonb')
         THEN CASE WHEN jsonb_typeof(c."settings"::jsonb -> 'stages') = 'object'
                   THEN c."settings"::jsonb -> 'stages'
                   ELSE '{}'::jsonb END
         ELSE '{}'::jsonb END
  ) AS e("key", "value")
 WHERE c."kind" = 'linear'
   AND e."key" ~ '^[A-Za-z0-9_-]{1,64}$'
   AND e."value" IN ('seeded', 'green', 'ripening', 'ripe', 'composted')
ON CONFLICT DO NOTHING;
