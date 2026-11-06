CREATE TABLE "agent_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_id" text NOT NULL,
	"site_id" text,
	"identifiers" text NOT NULL,
	"session_url" text NOT NULL,
	"started_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_sessions_by_connector" ON "agent_sessions" USING btree ("connector_id","started_at");