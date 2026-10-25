CREATE TABLE "workspace_logos" (
	"workspace_id" text NOT NULL,
	"content_type" text NOT NULL,
	"content" "bytea" NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "workspace_logos_pkey" PRIMARY KEY("workspace_id")
);
--> statement-breakpoint
ALTER TABLE "workspace_logos" ADD CONSTRAINT "workspace_logos_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;