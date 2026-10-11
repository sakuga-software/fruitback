CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"locale" text,
	"created_at" bigint NOT NULL,
	CONSTRAINT "accounts_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "connectors" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"sealed" text NOT NULL,
	"created_at" bigint NOT NULL,
	"attention" text,
	"attention_at" bigint
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" bigint NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_at" bigint,
	"last_at" bigint,
	"last_status" integer,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "email_links" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"spent_at" bigint
);
--> statement-breakpoint
CREATE TABLE "logins" (
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"account_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "logins_provider_subject_pk" PRIMARY KEY("provider","subject")
);
--> statement-breakpoint
CREATE TABLE "members" (
	"workspace_id" text NOT NULL,
	"account_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "members_workspace_id_account_id_pk" PRIMARY KEY("workspace_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "pairings" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"name" text,
	"email" text,
	"workspace" text,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"redeemed_at" bigint
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"name" text,
	"email" text,
	"workspace" text,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"revoked_at" bigint,
	"rotated_at" bigint,
	"predecessor_hash" text,
	"root_hash" text
);
--> statement-breakpoint
CREATE TABLE "site_destinations" (
	"site_id" text NOT NULL,
	"position" integer NOT NULL,
	"connector_id" text NOT NULL,
	"team_id" text,
	"project_id" text,
	"label" text,
	CONSTRAINT "site_destinations_site_id_position_pk" PRIMARY KEY("site_id","position")
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"origin" text NOT NULL,
	"visibility" text NOT NULL,
	"created_at" bigint NOT NULL,
	"connector_id" text,
	"team_id" text,
	"project_id" text,
	CONSTRAINT "sites_workspace_id_origin_unique" UNIQUE("workspace_id","origin")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logins" ADD CONSTRAINT "logins_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_destinations" ADD CONSTRAINT "site_destinations_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_destinations" ADD CONSTRAINT "site_destinations_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connectors_by_workspace" ON "connectors" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "deliveries_due" ON "deliveries" USING btree ("next_at");--> statement-breakpoint
CREATE INDEX "deliveries_by_connector" ON "deliveries" USING btree ("connector_id");--> statement-breakpoint
CREATE INDEX "members_by_account" ON "members" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "pairings_by_expiry" ON "pairings" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sessions_by_expiry" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sessions_by_root" ON "sessions" USING btree ("root_hash");--> statement-breakpoint
CREATE INDEX "site_destinations_by_connector" ON "site_destinations" USING btree ("connector_id");--> statement-breakpoint
CREATE INDEX "sites_by_connector" ON "sites" USING btree ("connector_id");