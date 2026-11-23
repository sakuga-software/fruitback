-- FRU-655. The fields of a task in the index, for the filters of the list of the notes.
-- drizzle-kit wrote the columns and the key. The last statement fills them for the tasks kept before:
-- the row of `notes` that the index names `FB-<id>`, of the same site, in Fruitback or sent on to an
-- address.
ALTER TABLE "note_index" ADD COLUMN "task_assignee_id" text;--> statement-breakpoint
ALTER TABLE "note_index" ADD COLUMN "task_priority" text;--> statement-breakpoint
ALTER TABLE "note_index" ADD COLUMN "task_due_on" text;--> statement-breakpoint
ALTER TABLE "note_index" ADD COLUMN "task_label_ids" text[];--> statement-breakpoint
ALTER TABLE "note_index" ADD CONSTRAINT "note_index_task_assignee_id_fkey" FOREIGN KEY ("task_assignee_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;;--> statement-breakpoint
UPDATE "note_index" AS "ni"
SET
  "task_assignee_id" = "n"."assignee_account_id",
  "task_priority" = "n"."priority",
  "task_due_on" = "n"."due_on",
  "task_label_ids" = (SELECT array_agg("l"."label_id" ORDER BY "l"."label_id") FROM "note_labels" AS "l" WHERE "l"."note_id" = "n"."id")
FROM "notes" AS "n"
WHERE "ni"."site_id" = "n"."client_id"
  AND "ni"."reference" = 'FB-' || "n"."id"
  AND ("ni"."place" = 'fruitback' OR "ni"."connector_id" IN (SELECT "id" FROM "connectors" WHERE "kind" = 'rest'));
