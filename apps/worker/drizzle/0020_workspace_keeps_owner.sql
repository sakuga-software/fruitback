-- Custom SQL migration file, put your code below! --
-- A custom migration (drizzle-kit generate --custom, FRU-324): a workspace keeps an owner, whoever
-- writes its members. The routes of the organization plugin of better-auth count the owners, then
-- write, in no transaction: the deletion of an account by the administrator of the instance (FRU-285)
-- counted the other owner, and a route took that owner away before the deletion committed. The
-- workspace then had no owner.
-- The row of the workspace is held before the count, `FOR NO KEY UPDATE`: a write that takes an owner
-- away waits for a deletion of an account, which holds the workspace `FOR UPDATE`, and counts after
-- its commit. Two such writes of two replicas wait for each other the same way.
-- A workspace that is deleted takes its members with it: its row is gone, and nothing is counted.
-- WARNING: the count after the lock sees the commit of the other transaction only in READ COMMITTED,
-- the isolation of every writer of "member". The trigger runs after the row of the member is held: a
-- writer that holds the workspace and then writes members holds those members first (see
-- `holdMembers` of `accounts-postgres.ts`), or two writers can wait for each other. The search path is
-- the one of the migration: the schema of the worker.
CREATE FUNCTION "fruitback_workspace_keeps_owner"() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF OLD."role" <> 'owner' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."role" = 'owner' AND NEW."organizationId" = OLD."organizationId" THEN
    RETURN NULL;
  END IF;
  PERFORM 1 FROM "organization" WHERE "id" = OLD."organizationId" FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "member" WHERE "organizationId" = OLD."organizationId" AND "role" = 'owner') THEN
    RAISE EXCEPTION 'fruitback: the workspace % keeps an owner', OLD."organizationId" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER "member_keeps_owner" AFTER UPDATE OF "role", "organizationId" OR DELETE ON "member" FOR EACH ROW EXECUTE FUNCTION "fruitback_workspace_keeps_owner"();
