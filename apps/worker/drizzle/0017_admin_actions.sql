CREATE TABLE "admin_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"at" bigint NOT NULL,
	"actor_account_id" text,
	"actor_email" text NOT NULL,
	"action" text NOT NULL,
	"target_account_id" text,
	"target_email" text,
	"workspace_id" text,
	"detail" text
);
--> statement-breakpoint
ALTER TABLE "admin_actions" ADD CONSTRAINT "admin_actions_actor_account_id_fkey" FOREIGN KEY ("actor_account_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_actions" ADD CONSTRAINT "admin_actions_target_account_id_fkey" FOREIGN KEY ("target_account_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_actions" ADD CONSTRAINT "admin_actions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_actions_by_date" ON "admin_actions" USING btree ("at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "admin_actions_by_workspace" ON "admin_actions" USING btree ("workspace_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "admin_actions_by_actor" ON "admin_actions" USING btree ("actor_account_id");--> statement-breakpoint
CREATE INDEX "admin_actions_by_target" ON "admin_actions" USING btree ("target_account_id");