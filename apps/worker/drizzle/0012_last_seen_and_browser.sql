CREATE TABLE "last_seen" (
	"member_id" text NOT NULL,
	"day" text NOT NULL,
	CONSTRAINT "last_seen_pkey" PRIMARY KEY("member_id")
);
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "browser" text;--> statement-breakpoint
ALTER TABLE "last_seen" ADD CONSTRAINT "last_seen_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;