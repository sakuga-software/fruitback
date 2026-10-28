CREATE TABLE "site_agent_triggers" (
	"site_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"connector_id" text NOT NULL,
	"moment" text NOT NULL,
	"enabled" boolean NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "site_agent_triggers_pkey" PRIMARY KEY("site_id")
);
--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "event" text DEFAULT 'note.created' NOT NULL;--> statement-breakpoint
ALTER TABLE "site_agent_triggers" ADD CONSTRAINT "site_agent_triggers_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_agent_triggers" ADD CONSTRAINT "site_agent_triggers_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_agent_triggers" ADD CONSTRAINT "site_agent_triggers_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "site_agent_triggers_by_connector" ON "site_agent_triggers" USING btree ("connector_id");