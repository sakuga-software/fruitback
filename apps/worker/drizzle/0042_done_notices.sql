CREATE TABLE "done_notices" (
	"site_id" text NOT NULL,
	"note_id" text NOT NULL,
	"account_id" text,
	"email" text,
	"locale" text,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	CONSTRAINT "done_notices_pkey" PRIMARY KEY("site_id","note_id")
);
--> statement-breakpoint
ALTER TABLE "done_notices" ADD CONSTRAINT "done_notices_site_id_note_id_fkey" FOREIGN KEY ("site_id","note_id") REFERENCES "public"."note_index"("site_id","note_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "done_notices" ADD CONSTRAINT "done_notices_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "done_notices_by_account" ON "done_notices" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "done_notices_by_expiry" ON "done_notices" USING btree ("expires_at");