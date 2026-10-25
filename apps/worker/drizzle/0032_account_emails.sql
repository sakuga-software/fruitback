CREATE TABLE "account_emails" (
	"email" text NOT NULL,
	"account_id" text NOT NULL,
	"providers" text[] DEFAULT '{}'::text[] NOT NULL,
	"verified_at" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "account_emails_pkey" PRIMARY KEY("email")
);
--> statement-breakpoint
ALTER TABLE "account_emails" ADD CONSTRAINT "account_emails_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_emails_by_account" ON "account_emails" USING btree ("account_id");