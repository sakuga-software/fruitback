-- Custom SQL migration file, put your code below! --
-- A custom migration (drizzle-kit generate --custom, FRU-261): the first account is the administrator
-- of the instance. On a database that has accounts and no administrator, the oldest account becomes it.
UPDATE "user" SET "role" = 'admin'
 WHERE "id" = (SELECT "id" FROM "user" ORDER BY "createdAt", "id" LIMIT 1)
   AND NOT EXISTS (SELECT 1 FROM "user" WHERE "role" = 'admin');--> statement-breakpoint
-- The first account becomes the administrator in the transaction that creates it. A later account never
-- does, also if no account has the role: else a role written as NULL, 'Admin' or 'admin,user' gives
-- the instance to the next person who signs up.
-- WARNING: the check after the lock sees the commit of the other transaction only in READ COMMITTED,
-- the isolation of every writer of "user". The search path is the one of the migration: the schema of
-- the worker.
CREATE FUNCTION "fruitback_first_admin"() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW."role" = 'admin' OR EXISTS (SELECT 1 FROM "user") THEN
    RETURN NEW;
  END IF;
  -- Two first accounts at the same moment: the second waits here until the first commits.
  PERFORM pg_advisory_xact_lock(1179796036);
  IF NOT EXISTS (SELECT 1 FROM "user") THEN
    NEW."role" := 'admin';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "user_first_admin" BEFORE INSERT ON "user" FOR EACH ROW EXECUTE FUNCTION "fruitback_first_admin"();
