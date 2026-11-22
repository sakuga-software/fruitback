-- FRU-652. The fields of a task the worker keeps: who, how urgent, by when, and the labels of a workspace.
-- drizzle-kit wrote every statement. A row of before reads as a task with no field set.
CREATE TABLE "labels" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "labels_workspace_id_name_key" UNIQUE("workspace_id","name")
);
--> statement-breakpoint
CREATE TABLE "note_labels" (
	"note_id" bigint NOT NULL,
	"label_id" text NOT NULL,
	CONSTRAINT "note_labels_pkey" PRIMARY KEY("note_id","label_id")
);
--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "assignee_account_id" text;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "priority" text;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "due_on" text;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_labels" ADD CONSTRAINT "note_labels_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_labels" ADD CONSTRAINT "note_labels_label_id_fkey" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_labels_by_label" ON "note_labels" USING btree ("label_id");--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_assignee_account_id_fkey" FOREIGN KEY ("assignee_account_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notes_by_assignee" ON "notes" USING btree ("assignee_account_id");