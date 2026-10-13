CREATE TABLE "note_index" (
	"site_id" text NOT NULL,
	"seed_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"page_url" text NOT NULL,
	"excerpt" text NOT NULL,
	"stage" text NOT NULL,
	"channel" text,
	"author_kind" text NOT NULL,
	"author_account_id" text,
	"place" text NOT NULL,
	"connector_id" text,
	"reference" text,
	"reference_url" text,
	"created_at" bigint NOT NULL,
	"checked_at" bigint NOT NULL,
	CONSTRAINT "note_index_pkey" PRIMARY KEY("site_id","seed_id")
);
--> statement-breakpoint
ALTER TABLE "note_index" ADD CONSTRAINT "note_index_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_index" ADD CONSTRAINT "note_index_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_index" ADD CONSTRAINT "note_index_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_index_by_workspace" ON "note_index" USING btree ("workspace_id","site_id","stage");--> statement-breakpoint
CREATE INDEX "note_index_by_author" ON "note_index" USING btree ("author_account_id");