import { bigint, customType, foreignKey, index, integer, pgTable, primaryKey, text, unique } from 'drizzle-orm/pg-core';
import { organization } from './auth-schema.ts';

/**
 * The schema of the whole PostgreSQL database of a worker (FRU-180): one description, in Drizzle.
 *
 * **This file is the source, and `drizzle/` is generated from it.** Change a table here, then run
 * `pnpm --filter @fruitback/worker db:generate`, and commit the migration it writes. Never edit a
 * migration that has shipped, and never write one by hand: `postgres-drift.test.ts` fails when this
 * file and the last snapshot differ, and `postgres-journal.test.ts` holds the journal. Rows that must
 * move before a table goes are the one thing added to a generated file, before its first merge:
 * `0002_accounts_in_better_auth` (FRU-146).
 *
 * **A property has the name of its column.** `account-rows.ts` and `session-rows.ts` parse a row of
 * either database, so a row of PostgreSQL must have the keys that a row of SQLite has.
 *
 * Every instant is a `BIGINT` of milliseconds, as in the SQLite files: `now` comes from the worker,
 * and the same number goes in both. `mode: 'number'` answers it as a number.
 *
 * The tables are the ones of `accounts-sqlite.fixture.ts` after its seven migrations, and of
 * `session-sqlite.ts` after its three, with the same names, **but four** (FRU-146): a person, a way
 * to sign in, a workspace and a membership are rows of `user`, `account`, `organization` and
 * `member`, the tables of better-auth in `auth-schema.ts`. `drizzle.config.ts` reads both files. A
 * site and a connector are of an `organization`, and go with it.
 *
 * **Every constraint has the name that PostgreSQL gives it** (`<table>_pkey`, `<table>_<column>_key`,
 * `<table>_<column>_fkey`), and not the one that Drizzle would choose. The tool of before made these
 * tables with those names, and a database it made is adopted as it is (`postgres-migrate.ts`): a
 * later migration that drops a constraint by its name must find it on both. A constraint of one
 * column is therefore written in the third argument, where it takes a name, and not on its column.
 */

const instant = (name: string) => bigint(name, { mode: 'number' });

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
      foreignColumns: [organization.id],
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
      foreignColumns: [organization.id],
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

/**
 * The domains a workspace says it owns, and what the DNS said of each (FRU-103): `domain-proof.ts`.
 * `verified_at` NULL: never proven. `lost_at` is the first answer of the DNS without the record.
 * `previews_site_id` names the one site whose previews the domain covers.
 */
export const domains = pgTable(
  'domains',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull(),
    domain: text('domain').notNull(),
    created_at: instant('created_at').notNull(),
    verified_at: instant('verified_at'),
    lost_at: instant('lost_at'),
    checked_at: instant('checked_at'),
    previews_site_id: text('previews_site_id'),
  },
  (table) => [
    foreignKey({
      name: 'domains_workspace_id_fkey',
      columns: [table.workspace_id],
      foreignColumns: [organization.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'domains_previews_site_id_fkey',
      columns: [table.previews_site_id],
      foreignColumns: [sites.id],
    }).onDelete('set null'),
    unique('domains_workspace_id_domain_key').on(table.workspace_id, table.domain),
    index('domains_by_check').on(table.checked_at),
    index('domains_by_site').on(table.previews_site_id),
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

/** The bytes of a file. The driver answers a `Buffer`, and PGlite a `Uint8Array`: both are one here. */
const bytes = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => 'bytea',
  toDriver: (value) => value,
  fromDriver: (value) => new Uint8Array(value),
});

/**
 * The picture of an element, taken by the extension with a note (FRU-44). `content` is a PNG of
 * `MAX_SCREENSHOT_BYTES` at most. It is of a workspace and goes with it: only a member reads it.
 * `account_id` is who sent it, and holds no foreign key: the picture stays when the person leaves.
 */
export const screenshots = pgTable(
  'screenshots',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull(),
    account_id: text('account_id').notNull(),
    content: bytes('content').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    created_at: instant('created_at').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'screenshots_workspace_id_fkey',
      columns: [table.workspace_id],
      foreignColumns: [organization.id],
    }).onDelete('cascade'),
    index('screenshots_by_workspace').on(table.workspace_id),
  ],
);

/**
 * The state that the replicas of a worker share (FRU-67): the counts of the rate limiter and of the
 * messages, the cached answers, the tickets of a minute. See `kv-postgres.ts`.
 *
 * `expires_at` is an instant of the clock of the database. A row whose instant is past reads as
 * absent, and `kv_by_expiry` is what the sweep reads to remove it. Nothing here must survive a
 * crash, and nothing of it is of a workspace: no foreign key.
 */
export const kv = pgTable(
  'kv',
  {
    key: text('key').primaryKey(),
    value: text('value').notNull(),
    expires_at: instant('expires_at').notNull(),
  },
  (table) => [index('kv_by_expiry').on(table.expires_at)],
);

/**
 * A note that the worker keeps itself (FRU-218): the notes of a site with no destination, on a worker
 * whose store is `postgres`. Until then they were in a SQLite file, `sqlite.ts`, and the columns are
 * the same.
 *
 * - `id` is the number of the note, `FB-<id>`. An identity that takes a value when one is given: the
 *   copy of a SQLite file (FRU-220) keeps the numbers that people already quoted.
 * - `client_id` is the id of the site. **It holds no foreign key**: what becomes of the notes of a
 *   site that is removed is not decided (FRU-194), and a key would decide it.
 * - `seed` is the note as JSON, in a `TEXT`: the reader parses a row and never trusts it, as for a
 *   file. `JSONB` refuses the `\u0000` that a note may hold, and `TEXT` holds its six characters.
 * - **It holds what a person wrote, in the clear**: a name, sometimes an address, the note.
 *   `forget` of `seeds-postgres.ts` deletes them.
 *
 * **The page is under a hash index, not a B-tree.** An address has no bound but the 64 KiB of a
 * request, and a B-tree refuses a row over 2704 bytes once compressed (« index row size 6432 exceeds
 * btree version 4 maximum 2704 », measured on 17.11 with 6 400 characters that do not compress): the
 * note of such a page would not be kept at all. A hash index takes any length, and the read is an
 * equality. The site is then read in the rows of the page, which are few.
 */
export const seeds = pgTable(
  'seeds',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity({ name: 'seeds_id_seq' }),
    client_id: text('client_id'),
    page_url: text('page_url').notNull(),
    stage: text('stage').notNull(),
    seed: text('seed').notNull(),
    created_at: instant('created_at').notNull(),
    updated_at: instant('updated_at').notNull(),
  },
  (table) => [
    index('seeds_by_page').using('hash', table.page_url),
    // Every note of one site: what FRU-194 will delete or keep, and the read by site.
    index('seeds_by_client').on(table.client_id),
  ],
);

/** A reply of the team to a note the worker keeps (FRU-218). It goes with its note. */
export const seed_comments = pgTable(
  'seed_comments',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity({ name: 'seed_comments_id_seq' }),
    seed_id: bigint('seed_id', { mode: 'number' }).notNull(),
    author: text('author'),
    body: text('body').notNull(),
    created_at: instant('created_at').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'seed_comments_seed_id_fkey',
      columns: [table.seed_id],
      foreignColumns: [seeds.id],
    }).onDelete('cascade'),
    index('seed_comments_by_seed').on(table.seed_id, table.created_at),
  ],
);
