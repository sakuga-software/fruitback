CREATE TABLE "workspace_suspensions" (
	"workspace_id" text NOT NULL,
	"since" bigint NOT NULL,
	"reason" text,
	CONSTRAINT "workspace_suspensions_pkey" PRIMARY KEY("workspace_id")
);
--> statement-breakpoint
ALTER TABLE "workspace_suspensions" ADD CONSTRAINT "workspace_suspensions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;