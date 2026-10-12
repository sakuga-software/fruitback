import { sql } from 'drizzle-orm';
import type { Database } from './postgres.ts';
import { rowsOf } from './postgres.fixture.ts';
import { catalogueOf as catalogueOfPublic } from './postgres-migrate.ts';

/**
 * The migrations of the tool of before, as they shipped (FRU-180). **A copy, never edited.**
 *
 * The four entries are `MIGRATIONS` of `postgres-migrations.ts` and `BETTER_AUTH_MIGRATION` of
 * `auth-schema.ts`, copied from `main` at e74be53, the last commit that had them (the SQL of each
 * entry was compared with that commit, word for word, when it was copied). Drizzle replaced that
 * tool, and a worker adopts a database that it made: `adoptWhatTheHomeMadeToolMade` of
 * `postgres-migrate.ts`. This file makes such a database, so the adoption is tested on what shipped.
 */
export const HOME_MADE_MIGRATIONS: readonly { name: string; sql: string }[] = [
  {
    name: 'accounts',
    sql: `
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT,
        locale TEXT,
        created_at BIGINT NOT NULL
      );

      CREATE TABLE logins (
        provider TEXT NOT NULL,
        subject TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (provider, subject)
      );

      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at BIGINT NOT NULL
      );

      CREATE TABLE members (
        workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (workspace_id, account_id)
      );

      CREATE INDEX members_by_account ON members (account_id);

      -- sealed is the key encrypted with FRUITBACK_SECRETS_KEY: a copy of the database is not a set of
      -- working keys. attention NULL: the last answer of the tracker was not a refusal.
      CREATE TABLE connectors (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        sealed TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        attention TEXT,
        attention_at BIGINT
      );

      CREATE INDEX connectors_by_workspace ON connectors (workspace_id);

      CREATE TABLE sites (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        origin TEXT NOT NULL,
        visibility TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        connector_id TEXT REFERENCES connectors (id) ON DELETE SET NULL,
        team_id TEXT,
        project_id TEXT,
        UNIQUE (workspace_id, origin)
      );

      CREATE INDEX sites_by_connector ON sites (connector_id);

      -- body is the request as it is sent. A row goes when its note arrived. next_at NULL: the worker
      -- gave up, and the console offers a new attempt.
      CREATE TABLE deliveries (
        id TEXT PRIMARY KEY,
        connector_id TEXT NOT NULL REFERENCES connectors (id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_at BIGINT,
        last_at BIGINT,
        last_status INTEGER,
        last_error TEXT
      );

      CREATE INDEX deliveries_due ON deliveries (next_at);
      CREATE INDEX deliveries_by_connector ON deliveries (connector_id);

      -- A digest, like a pairing code: a copy of the database is not a way in.
      CREATE TABLE email_links (
        code_hash TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        spent_at BIGINT
      );
    `,
  },
  {
    name: 'site_destinations',
    sql: `
      CREATE TABLE site_destinations (
        site_id TEXT NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        connector_id TEXT NOT NULL REFERENCES connectors (id) ON DELETE CASCADE,
        team_id TEXT,
        project_id TEXT,
        label TEXT,
        PRIMARY KEY (site_id, position)
      );

      CREATE INDEX site_destinations_by_connector ON site_destinations (connector_id);

      INSERT INTO site_destinations (site_id, position, connector_id, team_id, project_id)
        SELECT id, 0, connector_id, team_id, project_id FROM sites WHERE connector_id IS NOT NULL;
    `,
  },
  {
    name: 'sessions',
    sql: `
      CREATE TABLE pairings (
        code_hash TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        name TEXT,
        email TEXT,
        workspace TEXT,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        redeemed_at BIGINT
      );

      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        name TEXT,
        email TEXT,
        workspace TEXT,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        revoked_at BIGINT,
        rotated_at BIGINT,
        predecessor_hash TEXT,
        root_hash TEXT
      );

      -- The purge walks both tables by expiry, before every redemption.
      CREATE INDEX pairings_by_expiry ON pairings (expires_at);
      CREATE INDEX sessions_by_expiry ON sessions (expires_at);
      CREATE INDEX sessions_by_root ON sessions (root_hash);
    `,
  },
  {
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
  },
];

/**
 * A database as the tool of before left it after its first `count` migrations: their tables, and one
 * row of `schema_migrations` for each, as `migrate` of that tool wrote it.
 */
export async function madeByTheHomeMadeTool(
  database: Database,
  count: number = HOME_MADE_MIGRATIONS.length,
): Promise<void> {
  await database.run((db) =>
    db.execute(
      sql.raw(
        'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at BIGINT NOT NULL)',
      ),
    ),
  );
  for (const [index, migration] of HOME_MADE_MIGRATIONS.slice(0, count).entries()) {
    await database.transaction(async (db) => {
      // One statement for each call: Drizzle sends a statement with its values, and a server takes one.
      for (const statement of migration.sql
        .split(/;\s*$/m)
        .filter((text) => text.replace(/--.*$/gm, '').trim() !== '')) {
        await db.execute(sql.raw(statement));
      }
      await db.execute(
        sql`INSERT INTO schema_migrations (version, name, applied_at) VALUES (${index + 1}, ${migration.name}, ${Date.now()})`,
      );
    });
  }
}

/** The tables of the worker and of better-auth: every table but the journals of the two tools. */
export const TABLES = [
  'accounts',
  'logins',
  'workspaces',
  'members',
  'connectors',
  'sites',
  'deliveries',
  'email_links',
  'site_destinations',
  'pairings',
  'sessions',
  'user',
  'session',
  'account',
  'verification',
  'organization',
  'member',
  'invitation',
] as const;

/** The catalogue of `public` without the two journals, as the adoption reads it (`postgres-migrate.ts`). */
export function catalogueOf(database: Database): Promise<string[]> {
  return database.run((db) => catalogueOfPublic(db));
}

/** For each table, its number of rows and a digest of all of them, in a fixed order. */
export async function contentOf(database: Database): Promise<Record<string, string>> {
  const content: Record<string, string> = {};
  for (const table of TABLES) {
    const [row] = await rowsOf(
      database,
      `SELECT count(*)::int AS rows, coalesce(md5(string_agg(t::text, '|' ORDER BY t::text COLLATE "C")), '') AS digest
         FROM "${table}" t`,
    );
    content[table] = `${String(row?.rows)} ${String(row?.digest)}`;
  }

  return content;
}

/** One instant, in milliseconds, for every row that `withRows` writes. */
export const THEN = Date.UTC(2026, 9, 11, 12, 0);

/**
 * One row or more in each table of `TABLES`, as the stores of before wrote them: what a database of a
 * worker held when it ran the tool of before. The digests are fake, and say what they stand for.
 */
export async function withRows(database: Database): Promise<void> {
  const later = THEN + 24 * 60 * 60 * 1000;
  const statements = [
    `INSERT INTO accounts (id, email, name, locale, created_at) VALUES ('acc_alice', 'alice@acme.dev', 'Alice', 'fr', ${THEN})`,
    `INSERT INTO logins (provider, subject, account_id, created_at) VALUES ('github', '42', 'acc_alice', ${THEN})`,
    `INSERT INTO workspaces (id, name, created_at) VALUES ('ws_acme', 'Acme', ${THEN})`,
    `INSERT INTO members (workspace_id, account_id, role, created_at) VALUES ('ws_acme', 'acc_alice', 'owner', ${THEN})`,
    `INSERT INTO connectors (id, workspace_id, kind, label, sealed, created_at) VALUES ('con_linear', 'ws_acme', 'linear', 'Linear', 'sealed-key-of-linear', ${THEN})`,
    `INSERT INTO sites (id, workspace_id, origin, visibility, created_at) VALUES ('site_acme', 'ws_acme', 'https://acme.dev', 'members', ${THEN})`,
    `INSERT INTO site_destinations (site_id, position, connector_id, team_id, project_id, label) VALUES ('site_acme', 0, 'con_linear', 'team-design', NULL, 'Linear · Design')`,
    `INSERT INTO deliveries (id, connector_id, body, created_at, attempts, next_at) VALUES ('dlv_1', 'con_linear', '{"title":"A note"}', ${THEN}, 1, ${THEN})`,
    `INSERT INTO email_links (code_hash, email, created_at, expires_at) VALUES ('digest-of-an-email-code', 'alice@acme.dev', ${THEN}, ${later})`,
    `INSERT INTO pairings (code_hash, subject, name, email, workspace, created_at, expires_at) VALUES ('digest-of-a-pairing-code', 'acc_alice', 'Alice', 'alice@acme.dev', 'ws_acme', ${THEN}, ${later})`,
    `INSERT INTO sessions (token_hash, subject, name, email, workspace, created_at, expires_at) VALUES ('digest-of-a-refresh-token', 'acc_alice', 'Alice', 'alice@acme.dev', 'ws_acme', ${THEN}, ${later})`,
    `INSERT INTO "user" ("id", "name", "email", "emailVerified") VALUES ('acc_alice', 'Alice', 'alice@acme.dev', true)`,
    `INSERT INTO "session" ("id", "expiresAt", "token", "updatedAt", "userId") VALUES ('ses_1', now() + interval '1 day', 'a-token-of-better-auth', now(), 'acc_alice')`,
    `INSERT INTO "account" ("id", "accountId", "providerId", "userId", "updatedAt") VALUES ('lgn_1', '42', 'github', 'acc_alice', now())`,
    `INSERT INTO "verification" ("id", "identifier", "value", "expiresAt") VALUES ('ver_1', 'alice@acme.dev', 'a-value', now() + interval '1 hour')`,
    `INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES ('ws_acme', 'Acme', 'acme', now())`,
    `INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt") VALUES ('mem_1', 'ws_acme', 'acc_alice', 'owner', now())`,
    `INSERT INTO "invitation" ("id", "organizationId", "email", "role", "status", "expiresAt", "inviterId") VALUES ('inv_1', 'ws_acme', 'bob@acme.dev', 'member', 'pending', now() + interval '7 days', 'acc_alice')`,
  ];
  for (const statement of statements) await rowsOf(database, statement);
}
