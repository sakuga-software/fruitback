import type { Migration } from './postgres.ts';

/**
 * The tables of better-auth, as one step of the schema of the database (FRU-144).
 *
 * **This is the DDL that better-auth 1.7.7 compiles for the configuration of `auth.ts`**
 * (`compileMigrations` of `better-auth/db/migration`, on an empty PostgreSQL), with one constraint
 * added: see `member`. `auth migrate` and `runMigrations()` never run on a database of the worker:
 * one tool migrates it, and that tool is `migrate` of `postgres.ts`.
 *
 * `auth.test.ts` holds this text to the library: after the migrations of the worker, better-auth has
 * nothing to create and nothing to add, and the tables are the ones its own migration makes, column
 * for column and constraint for constraint, but the one that is added here.
 *
 * The names are the ones of better-auth: `camelCase`, between quotes, and `"user"` is a reserved
 * word. An instant is a `timestamptz` here, and a `BIGINT` of milliseconds in the tables of the
 * worker: better-auth writes these rows, with its own types.
 *
 * WARNING: `session.token` is the token of a session, in the clear. What keeps a copy of this table
 * from being a set of working logins is the signature of the cookie, with `FRUITBACK_AUTH_SECRET`,
 * and the absence of the `bearer` plugin. See `REFUSED_PLUGINS` in `auth.ts`.
 */
export const BETTER_AUTH_MIGRATION: Migration = {
  name: 'better-auth',
  sql: `
    CREATE TABLE "user" (
      "id" text NOT NULL PRIMARY KEY,
      "name" text NOT NULL,
      "email" text NOT NULL UNIQUE,
      "emailVerified" boolean NOT NULL,
      "image" text,
      "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
      "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
    );

    CREATE TABLE "session" (
      "id" text NOT NULL PRIMARY KEY,
      "expiresAt" timestamptz NOT NULL,
      "token" text NOT NULL UNIQUE,
      "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
      "updatedAt" timestamptz NOT NULL,
      "ipAddress" text,
      "userAgent" text,
      "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
      "activeOrganizationId" text
    );

    -- The token columns are where better-auth keeps the tokens of a provider that signs a person in.
    -- Nothing writes this table yet. SECURITY.md says that the worker keeps no such token: the code
    -- that writes a row here must leave them empty.
    CREATE TABLE "account" (
      "id" text NOT NULL PRIMARY KEY,
      "accountId" text NOT NULL,
      "providerId" text NOT NULL,
      "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
      "accessToken" text,
      "refreshToken" text,
      "idToken" text,
      "accessTokenExpiresAt" timestamptz,
      "refreshTokenExpiresAt" timestamptz,
      "scope" text,
      "password" text,
      "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
      "updatedAt" timestamptz NOT NULL
    );

    CREATE TABLE "verification" (
      "id" text NOT NULL PRIMARY KEY,
      "identifier" text NOT NULL,
      "value" text NOT NULL,
      "expiresAt" timestamptz NOT NULL,
      "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
      "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
    );

    CREATE TABLE "organization" (
      "id" text NOT NULL PRIMARY KEY,
      "name" text NOT NULL,
      "slug" text NOT NULL UNIQUE,
      "logo" text,
      "createdAt" timestamptz NOT NULL,
      "metadata" text
    );

    -- The constraint is not in the DDL of better-auth. A person is a member of a workspace once, as
    -- in the members table of the worker: with two rows, one person has two roles.
    CREATE TABLE "member" (
      "id" text NOT NULL PRIMARY KEY,
      "organizationId" text NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
      "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
      "role" text NOT NULL,
      "createdAt" timestamptz NOT NULL,
      CONSTRAINT "member_organizationId_userId_key" UNIQUE ("organizationId", "userId")
    );

    CREATE TABLE "invitation" (
      "id" text NOT NULL PRIMARY KEY,
      "organizationId" text NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
      "email" text NOT NULL,
      "role" text,
      "status" text NOT NULL,
      "expiresAt" timestamptz NOT NULL,
      "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
      "inviterId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
    );

    CREATE INDEX "session_userId_idx" ON "session" ("userId");
    CREATE INDEX "account_userId_idx" ON "account" ("userId");
    CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");
    CREATE INDEX "member_organizationId_idx" ON "member" ("organizationId");
    CREATE INDEX "member_userId_idx" ON "member" ("userId");
    CREATE INDEX "invitation_organizationId_idx" ON "invitation" ("organizationId");
    CREATE INDEX "invitation_email_idx" ON "invitation" ("email");
  `,
};
