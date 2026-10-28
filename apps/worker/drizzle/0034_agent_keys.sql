CREATE TABLE "agent_key_sites" (
	"key_id" text NOT NULL,
	"site_id" text NOT NULL,
	CONSTRAINT "agent_key_sites_pkey" PRIMARY KEY("key_id","site_id")
);
--> statement-breakpoint
CREATE TABLE "agent_keys" (
	"id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"can_write" boolean NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	CONSTRAINT "agent_keys_pkey" PRIMARY KEY("id"),
	CONSTRAINT "agent_keys_key_hash_key" UNIQUE("key_hash")
);
--> statement-breakpoint
ALTER TABLE "agent_key_sites" ADD CONSTRAINT "agent_key_sites_key_id_fkey" FOREIGN KEY ("key_id") REFERENCES "public"."agent_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_key_sites" ADD CONSTRAINT "agent_key_sites_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_keys" ADD CONSTRAINT "agent_keys_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_keys" ADD CONSTRAINT "agent_keys_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_key_sites_by_site" ON "agent_key_sites" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "agent_keys_by_workspace" ON "agent_keys" USING btree ("workspace_id");