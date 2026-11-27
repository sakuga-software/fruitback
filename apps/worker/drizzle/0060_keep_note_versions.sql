CREATE TABLE "note_versions" (
	"id" text NOT NULL,
	"site_id" text NOT NULL,
	"note_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"author_kind" text NOT NULL,
	"author_account_id" text,
	"at" bigint NOT NULL,
	CONSTRAINT "note_versions_pkey" PRIMARY KEY("id")
);
--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "keep_note_versions" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "note_versions" ADD CONSTRAINT "note_versions_note_fkey" FOREIGN KEY ("site_id","note_id") REFERENCES "public"."note_index"("site_id","note_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_versions" ADD CONSTRAINT "note_versions_author_account_id_fkey" FOREIGN KEY ("author_account_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_versions_by_note" ON "note_versions" USING btree ("site_id","note_id","at");--> statement-breakpoint
CREATE INDEX "note_versions_by_author" ON "note_versions" USING btree ("author_account_id");