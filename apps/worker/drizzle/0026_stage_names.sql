-- FRU-355. The five stages take generic names (docs/decisions/stage-names.md): seeded -> new,
-- green -> todo, ripening -> progress, ripe -> done, composted -> closed. No column changes and no
-- CHECK names a stage, so this file is the UPDATE alone, written by hand into the empty file of
-- `drizzle-kit generate --custom`. A row already on a new name, or on a value that is no stage, is
-- left as it is, so the file can run on any database of before.
--
-- connectors.settings is text. Only a value that is JSON and whose "stages" is an object is read;
-- the CASE are nested, as in 0025, because PostgreSQL does not promise the order of an AND, and the
-- cast must never see what pg_input_is_valid refused. Inside "stages", only a string value that is
-- an old name changes; every other key and value stays.
--
-- The five built-in statuses of the source `own` have the name of their stage as their key
-- (docs/decisions/statuses.md), so statuses.key of `own` and seeds.status_key are renamed too. A key
-- is renamed only when the site has no `own` status that holds the new name already: a team may
-- have added a status keyed `done`, and the primary key (site_id, source, key) must hold. A note
-- keeps an old key when its site kept that status under it.
--
-- Rollback: the reverse UPDATE is REVERSE_SQL in stage-names-migration.test.ts, which runs it.
UPDATE "seeds" SET "stage" = CASE "stage"
    WHEN 'seeded' THEN 'new' WHEN 'green' THEN 'todo' WHEN 'ripening' THEN 'progress'
    WHEN 'ripe' THEN 'done' WHEN 'composted' THEN 'closed' END
 WHERE "stage" IN ('seeded', 'green', 'ripening', 'ripe', 'composted');--> statement-breakpoint
UPDATE "note_index" SET "stage" = CASE "stage"
    WHEN 'seeded' THEN 'new' WHEN 'green' THEN 'todo' WHEN 'ripening' THEN 'progress'
    WHEN 'ripe' THEN 'done' WHEN 'composted' THEN 'closed' END
 WHERE "stage" IN ('seeded', 'green', 'ripening', 'ripe', 'composted');--> statement-breakpoint
UPDATE "statuses" SET "stage" = CASE "stage"
    WHEN 'seeded' THEN 'new' WHEN 'green' THEN 'todo' WHEN 'ripening' THEN 'progress'
    WHEN 'ripe' THEN 'done' WHEN 'composted' THEN 'closed' END
 WHERE "stage" IN ('seeded', 'green', 'ripening', 'ripe', 'composted');--> statement-breakpoint
UPDATE "connectors" SET "settings" = jsonb_set(
    "settings"::jsonb,
    '{stages}',
    (SELECT jsonb_object_agg(e."key", CASE e."value" #>> '{}'
                WHEN 'seeded' THEN to_jsonb('new'::text) WHEN 'green' THEN to_jsonb('todo'::text)
                WHEN 'ripening' THEN to_jsonb('progress'::text) WHEN 'ripe' THEN to_jsonb('done'::text)
                WHEN 'composted' THEN to_jsonb('closed'::text) ELSE e."value" END)
       FROM jsonb_each("settings"::jsonb -> 'stages') AS e("key", "value"))
  )::text
 WHERE CASE WHEN pg_input_is_valid("settings", 'jsonb')
            THEN CASE WHEN jsonb_typeof("settings"::jsonb -> 'stages') = 'object'
                      THEN EXISTS (SELECT 1 FROM jsonb_each("settings"::jsonb -> 'stages') AS e("key", "value")
                                    WHERE jsonb_typeof(e."value") = 'string'
                                      AND e."value" #>> '{}' IN ('seeded', 'green', 'ripening', 'ripe', 'composted'))
                      ELSE false END
            ELSE false END;--> statement-breakpoint
UPDATE "statuses" AS s SET "key" = CASE s."key"
    WHEN 'seeded' THEN 'new' WHEN 'green' THEN 'todo' WHEN 'ripening' THEN 'progress'
    WHEN 'ripe' THEN 'done' WHEN 'composted' THEN 'closed' END
 WHERE s."source" = 'own'
   AND s."key" IN ('seeded', 'green', 'ripening', 'ripe', 'composted')
   AND NOT EXISTS (SELECT 1 FROM "statuses" AS t
                    WHERE t."site_id" = s."site_id" AND t."source" = 'own'
                      AND t."key" = CASE s."key"
    WHEN 'seeded' THEN 'new' WHEN 'green' THEN 'todo' WHEN 'ripening' THEN 'progress'
    WHEN 'ripe' THEN 'done' WHEN 'composted' THEN 'closed' END);--> statement-breakpoint
UPDATE "seeds" SET "status_key" = CASE "status_key"
    WHEN 'seeded' THEN 'new' WHEN 'green' THEN 'todo' WHEN 'ripening' THEN 'progress'
    WHEN 'ripe' THEN 'done' WHEN 'composted' THEN 'closed' END
 WHERE "status_key" IN ('seeded', 'green', 'ripening', 'ripe', 'composted')
   AND NOT EXISTS (SELECT 1 FROM "statuses" AS t
                    WHERE t."site_id" = "seeds"."client_id" AND t."source" = 'own'
                      AND t."key" = "seeds"."status_key");
