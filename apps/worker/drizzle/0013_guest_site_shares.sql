CREATE TABLE "invitation_sites" (
	"invitation_id" text NOT NULL,
	"site_id" text NOT NULL,
	CONSTRAINT "invitation_sites_pkey" PRIMARY KEY("invitation_id","site_id")
);
--> statement-breakpoint
CREATE TABLE "site_shares" (
	"workspace_id" text NOT NULL,
	"account_id" text NOT NULL,
	"site_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "site_shares_pkey" PRIMARY KEY("workspace_id","account_id","site_id")
);
--> statement-breakpoint
ALTER TABLE "screenshots" ADD COLUMN "site_id" text;--> statement-breakpoint
ALTER TABLE "invitation_sites" ADD CONSTRAINT "invitation_sites_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_sites" ADD CONSTRAINT "invitation_sites_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_shares" ADD CONSTRAINT "site_shares_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_shares" ADD CONSTRAINT "site_shares_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_shares" ADD CONSTRAINT "site_shares_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invitation_sites_by_site" ON "invitation_sites" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "site_shares_by_site" ON "site_shares" USING btree ("site_id");