CREATE TABLE "saved_views" (
	"id" text NOT NULL,
	"member_id" text NOT NULL,
	"name" text NOT NULL,
	"filters" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "saved_views_pkey" PRIMARY KEY("id")
);
--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saved_views_by_member" ON "saved_views" USING btree ("member_id","created_at");