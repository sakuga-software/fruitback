import { type Database, type Migration, migrate } from './postgres.ts';

/**
 * The schema of the whole PostgreSQL database of a worker, one step for each entry (FRU-141).
 *
 * **Append; never edit an entry that has shipped.** One list for the database, and not one for each
 * store as the SQLite files have: the stores share one database here, and two lists would be two
 * counters on it.
 *
 * Every instant is a `BIGINT` of milliseconds, as in the SQLite files: `now` comes from the worker,
 * and the same number goes in both.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    // The accounts as `accounts-sqlite.ts` holds them after its six migrations, with the same names.
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
];

/**
 * The database with its schema, once for each `Database`.
 *
 * A failure is not kept: the database may answer the next request, and that request tries again.
 */
const applied = new WeakMap<Database, Promise<void>>();

export function migrated(database: Database): Promise<void> {
  const known = applied.get(database);
  if (known !== undefined) return known;

  const running = migrate(database, MIGRATIONS);
  applied.set(database, running);
  running.catch(() => applied.delete(database));

  return running;
}
