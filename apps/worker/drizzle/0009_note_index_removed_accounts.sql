-- Custom SQL migration file, put your code below! --
-- A custom migration (drizzle-kit generate --custom, FRU-237): the ids of accounts that were removed
-- since a row named them. The foreign key of 0010 would refuse them.
UPDATE "note_index" SET "author_account_id" = NULL WHERE "author_account_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "user" WHERE "user"."id" = "note_index"."author_account_id");
