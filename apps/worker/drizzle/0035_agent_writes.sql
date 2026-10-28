CREATE TABLE "agent_writes" (
	"id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"key_id" text NOT NULL,
	"key_name" text NOT NULL,
	"site_id" text NOT NULL,
	"note_id" text NOT NULL,
	"action" text NOT NULL,
	"status" text,
	"at" bigint NOT NULL,
	CONSTRAINT "agent_writes_pkey" PRIMARY KEY("id")
);
--> statement-breakpoint
ALTER TABLE "agent_writes" ADD CONSTRAINT "agent_writes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_writes_by_key" ON "agent_writes" USING btree ("workspace_id","key_id","at");