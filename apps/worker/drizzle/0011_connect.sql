CREATE TABLE "connect_requests" (
	"request_hash" text NOT NULL,
	"claim_hash" text NOT NULL,
	"word" text NOT NULL,
	"browser" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"outcome" text,
	"account_id" text,
	"answered_at" bigint,
	"claimed_at" bigint,
	"misses" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "connect_requests_pkey" PRIMARY KEY("request_hash"),
	CONSTRAINT "connect_requests_claim_hash_key" UNIQUE("claim_hash")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "account_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "browser" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "connection_id" text;--> statement-breakpoint
CREATE INDEX "connect_requests_by_expiry" ON "connect_requests" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sessions_by_account" ON "sessions" USING btree ("account_id");