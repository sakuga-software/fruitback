CREATE TABLE "domains" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"domain" text NOT NULL,
	"created_at" bigint NOT NULL,
	"verified_at" bigint,
	"lost_at" bigint,
	"checked_at" bigint,
	"previews_site_id" text,
	CONSTRAINT "domains_workspace_id_domain_key" UNIQUE("workspace_id","domain")
);
--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_previews_site_id_fkey" FOREIGN KEY ("previews_site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "domains_by_check" ON "domains" USING btree ("checked_at");--> statement-breakpoint
CREATE INDEX "domains_by_site" ON "domains" USING btree ("previews_site_id");