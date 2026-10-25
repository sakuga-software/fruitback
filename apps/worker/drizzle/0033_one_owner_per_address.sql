-- Custom SQL migration file, put your code below! --
-- A custom migration (drizzle-kit generate --custom, FRU-450): an address is of one account, as its
-- primary address ("user"."email") or as one of its other addresses ("account_emails"). Each table
-- has its own unique key; this holds the pair. A write that gives an address of another account fails
-- with the code of a unique key (23505), as a write that breaks a key of its own table.
-- WARNING: the check after the lock sees the commit of the other transaction only in READ COMMITTED,
-- the isolation of every writer of both tables. The search path is the one of the migration: the
-- schema of the worker.
CREATE FUNCTION "fruitback_user_address_free"() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  -- Two writes of one address at the same moment: the second waits here until the first commits.
  PERFORM pg_advisory_xact_lock(1179796037, hashtext(lower(NEW."email")));
  IF EXISTS (SELECT 1 FROM "account_emails" WHERE "email" = lower(NEW."email") AND "account_id" <> NEW."id") THEN
    RAISE EXCEPTION 'the address is of another account' USING ERRCODE = 'unique_violation', CONSTRAINT = 'user_email_key';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "user_address_free" BEFORE INSERT OR UPDATE OF "email" ON "user" FOR EACH ROW EXECUTE FUNCTION "fruitback_user_address_free"();--> statement-breakpoint
CREATE FUNCTION "fruitback_account_email_free"() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(1179796037, hashtext(lower(NEW."email")));
  IF EXISTS (SELECT 1 FROM "user" WHERE "email" = lower(NEW."email") AND "id" <> NEW."account_id") THEN
    RAISE EXCEPTION 'the address is of another account' USING ERRCODE = 'unique_violation', CONSTRAINT = 'account_emails_pkey';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "account_email_free" BEFORE INSERT OR UPDATE OF "email", "account_id" ON "account_emails" FOR EACH ROW EXECUTE FUNCTION "fruitback_account_email_free"();
