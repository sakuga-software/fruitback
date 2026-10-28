CREATE TABLE "oauth_clients" (
	"id" text NOT NULL,
	"name" text NOT NULL,
	"redirect_uris" text NOT NULL,
	"secret_hash" text,
	"created_at" bigint NOT NULL,
	CONSTRAINT "oauth_clients_pkey" PRIMARY KEY("id")
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"token_hash" text NOT NULL,
	"kind" text NOT NULL,
	"key_id" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"used_at" bigint,
	CONSTRAINT "oauth_tokens_pkey" PRIMARY KEY("token_hash")
);
--> statement-breakpoint
ALTER TABLE "agent_keys" ALTER COLUMN "key_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_keys" ADD COLUMN "client_id" text;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_key_id_fkey" FOREIGN KEY ("key_id") REFERENCES "public"."agent_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_clients_by_creation" ON "oauth_clients" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "oauth_tokens_by_key" ON "oauth_tokens" USING btree ("key_id");--> statement-breakpoint
ALTER TABLE "agent_keys" ADD CONSTRAINT "agent_keys_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_keys_by_client" ON "agent_keys" USING btree ("client_id");