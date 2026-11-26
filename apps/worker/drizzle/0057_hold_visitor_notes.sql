CREATE TABLE "held_notes" (
	"site_id" text NOT NULL,
	"note_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"payload" text NOT NULL,
	"author_visitor" text,
	"held_at" bigint NOT NULL,
	"claimed_until" bigint,
	CONSTRAINT "held_notes_pkey" PRIMARY KEY("site_id","note_id")
);
--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "hold_visitor_notes" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "held_notes" ADD CONSTRAINT "held_notes_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "held_notes_by_workspace" ON "held_notes" USING btree ("workspace_id","held_at");--> statement-breakpoint
CREATE INDEX "held_notes_by_time" ON "held_notes" USING btree ("held_at");