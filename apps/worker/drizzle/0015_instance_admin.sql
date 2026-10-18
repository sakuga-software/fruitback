CREATE TABLE "admin_reads" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"admin_account_id" text,
	"admin_email" text NOT NULL,
	"what" text NOT NULL,
	"at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "role" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "banned" boolean;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "banReason" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "banExpires" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_reads" ADD CONSTRAINT "admin_reads_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_reads" ADD CONSTRAINT "admin_reads_admin_account_id_fkey" FOREIGN KEY ("admin_account_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_reads_by_workspace" ON "admin_reads" USING btree ("workspace_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "admin_reads_by_admin" ON "admin_reads" USING btree ("admin_account_id");