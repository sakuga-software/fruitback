import { bigint, foreignKey, index, integer, pgTable, primaryKey, text, unique } from 'drizzle-orm/pg-core';

/**
 * The schema of the whole PostgreSQL database of a worker (FRU-180): one description, in Drizzle.
 *
 * **This file is the source, and `drizzle/` is generated from it.** Change a table here, then run
 * `pnpm --filter @fruitback/worker db:generate`, and commit the migration it writes. Never edit a
 * migration that has shipped, and never write one by hand: `postgres-drift.test.ts` fails when this
 * file and the last snapshot differ, and `postgres-journal.test.ts` holds the journal.
 *
 * **A property has the name of its column.** `account-rows.ts` and `session-rows.ts` parse a row of
 * either database, so a row of PostgreSQL must have the keys that a row of SQLite has.
 *
 * Every instant is a `BIGINT` of milliseconds, as in the SQLite files: `now` comes from the worker,
 * and the same number goes in both. `mode: 'number'` answers it as a number.
 *
 * The tables are the ones of `accounts-sqlite.ts` after its seven migrations, and of
 * `session-sqlite.ts` after its three, with the same names. The tables of better-auth are in
 * `auth-schema.ts`, and `drizzle.config.ts` reads both files.
 *
 * **Every constraint has the name that PostgreSQL gives it** (`<table>_pkey`, `<table>_<column>_key`,
 * `<table>_<column>_fkey`), and not the one that Drizzle would choose. The tool of before made these
 * tables with those names, and a database it made is adopted as it is (`postgres-migrate.ts`): a
 * later migration that drops a constraint by its name must find it on both. A constraint of one
 * column is therefore written in the third argument, where it takes a name, and not on its column.
 */

const instant = (name: string) => bigint(name, { mode: 'number' });

export const accounts = pgTable('accounts', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique('accounts_email_key'),
  name: text('name'),
  locale: text('locale'),
  created_at: instant('created_at').notNull(),
});

export const logins = pgTable(
  'logins',
  {
    provider: text('provider').notNull(),
    subject: text('subject').notNull(),
    account_id: text('account_id').notNull(),
    created_at: instant('created_at').notNull(),
  },
  (table) => [
    primaryKey({ name: 'logins_pkey', columns: [table.provider, table.subject] }),
    foreignKey({ name: 'logins_account_id_fkey', columns: [table.account_id], foreignColumns: [accounts.id] }).onDelete(
      'cascade',
    ),
  ],
);

export const workspaces = pgTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  created_at: instant('created_at').notNull(),
});

export const members = pgTable(
  'members',
  {
    workspace_id: text('workspace_id').notNull(),
    account_id: text('account_id').notNull(),
    role: text('role').notNull(),
    created_at: instant('created_at').notNull(),
  },
  (table) => [
    primaryKey({ name: 'members_pkey', columns: [table.workspace_id, table.account_id] }),
    foreignKey({
      name: 'members_workspace_id_fkey',
      columns: [table.workspace_id],
      foreignColumns: [workspaces.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'members_account_id_fkey',
      columns: [table.account_id],
      foreignColumns: [accounts.id],
    }).onDelete('cascade'),
    index('members_by_account').on(table.account_id),
  ],
);

/**
 * `sealed` is the key encrypted with `FRUITBACK_SECRETS_KEY`: a copy of the database is not a set of
 * working keys. `attention` NULL: the last answer of the tracker was not a refusal.
 */
export const connectors = pgTable(
  'connectors',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull(),
    kind: text('kind').notNull(),
    label: text('label').notNull(),
    sealed: text('sealed').notNull(),
    created_at: instant('created_at').notNull(),
    attention: text('attention'),
    attention_at: instant('attention_at'),
    // What a workspace sets on the connector (FRU-102), as JSON: `connectorSettingsOf` reads it.
    settings: text('settings').notNull().default('{}'),
  },
  (table) => [
    foreignKey({
      name: 'connectors_workspace_id_fkey',
      columns: [table.workspace_id],
      foreignColumns: [workspaces.id],
    }).onDelete('cascade'),
    index('connectors_by_workspace').on(table.workspace_id),
  ],
);

/**
 * `connector_id`, `team_id` and `project_id` held the one destination of a site until
 * `site_destinations` (FRU-123). Nothing reads or writes them. They stay because the SQLite file has
 * them: the two schemas have the same columns.
 */
export const sites = pgTable(
  'sites',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull(),
    origin: text('origin').notNull(),
    visibility: text('visibility').notNull(),
    created_at: instant('created_at').notNull(),
    connector_id: text('connector_id'),
    team_id: text('team_id'),
    project_id: text('project_id'),
  },
  (table) => [
    foreignKey({
      name: 'sites_workspace_id_fkey',
      columns: [table.workspace_id],
      foreignColumns: [workspaces.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'sites_connector_id_fkey',
      columns: [table.connector_id],
      foreignColumns: [connectors.id],
    }).onDelete('set null'),
    unique('sites_workspace_id_origin_key').on(table.workspace_id, table.origin),
    index('sites_by_connector').on(table.connector_id),
  ],
);

/**
 * `body` is the request as it is sent. A row goes when its note arrived. `next_at` NULL: the worker
 * gave up, and the console offers a new attempt.
 */
export const deliveries = pgTable(
  'deliveries',
  {
    id: text('id').primaryKey(),
    connector_id: text('connector_id').notNull(),
    body: text('body').notNull(),
    created_at: instant('created_at').notNull(),
    attempts: integer('attempts').notNull().default(0),
    next_at: instant('next_at'),
    last_at: instant('last_at'),
    last_status: integer('last_status'),
    last_error: text('last_error'),
  },
  (table) => [
    foreignKey({
      name: 'deliveries_connector_id_fkey',
      columns: [table.connector_id],
      foreignColumns: [connectors.id],
    }).onDelete('cascade'),
    index('deliveries_due').on(table.next_at),
    index('deliveries_by_connector').on(table.connector_id),
  ],
);

/** `code_hash` is a digest, like a pairing code: a copy of the database is not a way in. */
export const email_links = pgTable('email_links', {
  code_hash: text('code_hash').primaryKey(),
  email: text('email').notNull(),
  created_at: instant('created_at').notNull(),
  expires_at: instant('expires_at').notNull(),
  spent_at: instant('spent_at'),
});

/**
 * Every place a site can send to, in order (FRU-123). The first row of a site is where a note goes
 * when nobody chose. A connector that goes takes its rows with it, and the next row of the site
 * becomes the first.
 */
export const site_destinations = pgTable(
  'site_destinations',
  {
    site_id: text('site_id').notNull(),
    position: integer('position').notNull(),
    connector_id: text('connector_id').notNull(),
    team_id: text('team_id'),
    project_id: text('project_id'),
    label: text('label'),
  },
  (table) => [
    primaryKey({ name: 'site_destinations_pkey', columns: [table.site_id, table.position] }),
    foreignKey({
      name: 'site_destinations_site_id_fkey',
      columns: [table.site_id],
      foreignColumns: [sites.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'site_destinations_connector_id_fkey',
      columns: [table.connector_id],
      foreignColumns: [connectors.id],
    }).onDelete('cascade'),
    index('site_destinations_by_connector').on(table.connector_id),
  ],
);

/**
 * The pairing codes and the sessions (FRU-142). Every code and every token is a SHA-256 digest: a
 * copy of the database is not a way in.
 */
export const pairings = pgTable(
  'pairings',
  {
    code_hash: text('code_hash').primaryKey(),
    subject: text('subject').notNull(),
    name: text('name'),
    email: text('email'),
    workspace: text('workspace'),
    created_at: instant('created_at').notNull(),
    expires_at: instant('expires_at').notNull(),
    redeemed_at: instant('redeemed_at'),
  },
  // The purge walks both tables by expiry, before every redemption.
  (table) => [index('pairings_by_expiry').on(table.expires_at)],
);

/**
 * `root_hash` names the chain of a token, so a log out and a replay end it in one statement. It is
 * NULL on the head of a chain: read it as the row's own `token_hash` there.
 */
export const sessions = pgTable(
  'sessions',
  {
    token_hash: text('token_hash').primaryKey(),
    subject: text('subject').notNull(),
    name: text('name'),
    email: text('email'),
    workspace: text('workspace'),
    created_at: instant('created_at').notNull(),
    expires_at: instant('expires_at').notNull(),
    revoked_at: instant('revoked_at'),
    rotated_at: instant('rotated_at'),
    predecessor_hash: text('predecessor_hash'),
    root_hash: text('root_hash'),
  },
  (table) => [index('sessions_by_expiry').on(table.expires_at), index('sessions_by_root').on(table.root_hash)],
);
