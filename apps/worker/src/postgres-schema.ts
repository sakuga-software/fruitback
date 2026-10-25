import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
} from 'drizzle-orm/pg-core';
import { invitation, member, organization, user } from './auth-schema.ts';

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
 * The tables are the ones of the accounts file of before after its seven migrations, and of the
 * sessions file after its three (`postgres-copy.fixture.ts` holds both), with the same names, **but
 * four** (FRU-146): a person, a way
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
 *
 * `installation` is the fingerprint of the installation of a `github` connector (FRU-360,
 * `installationFingerprint`), and NULL for every other kind. Its unique constraint makes one installation
 * feed one connector of the whole instance.
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
    installation: text('installation'),
    // The name a workspace gave the connector (FRU-404), NULL for none: `label` stays the worker's.
    name: text('name'),
  },
  (table) => [
    unique('connectors_installation_key').on(table.installation),
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
    // FRU-330: `0021` adds the column with `anyone`, the value of every site that exists then, and
    // `0022` makes `members` the default of the next one. `addSite` writes the value in any case.
    writers: text('writers').notNull().default('members'),
    // FRU-368: the states of the site's tracker take the tracker's colours. Off by default (decision 3
    // of docs/decisions/statuses.md): the colours of the stages, which a host can still set.
    tracker_colours: boolean('tracker_colours').notNull().default(false),
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
    // FRU-382: whether the repository of a `github` destination is private, as GitHub last said it:
    // learned when the destination is written, and again when a note goes there. Empty: not known
    // (another kind of connector, or GitHub did not answer).
    private: boolean('private'),
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
 * The statuses of a site (FRU-352, FRU-365): what the team renamed, recoloured, re-staged or added,
 * per site. `docs/decisions/statuses.md` is the model.
 *
 * - `source` is where the state comes from: the id of the connector of a destination of the site, or
 *   `own` for the store of the worker. It is not a foreign key: when a destination changes, the rows
 *   of the old source stay, unused, and going back restores them.
 * - A row exists only for what the team changed or added. A state of the tracker with no row keeps
 *   its name, the stage of its type and the colour of its stage.
 * - `name`, `color` and `text_color` NULL: the name of the tracker, the colour of the stage (FRU-334)
 *   and a text colour computed from the background. A colour is `#rrggbb`; `site-statuses.ts`
 *   refuses anything else, and a text colour under 4.5:1 on its background.
 * - `0025_site_statuses` copies the stages that FRU-102 kept per connector, in
 *   `connectors.settings`, to every site of that connector. The JSON stays one version.
 */
export const statuses = pgTable(
  'statuses',
  {
    site_id: text('site_id').notNull(),
    source: text('source').notNull(),
    key: text('key').notNull(),
    name: text('name'),
    stage: text('stage').notNull(),
    color: text('color'),
    text_color: text('text_color'),
    position: integer('position').notNull().default(0),
    // `tracker`: a state of the provider, or a built-in status; removing its row gives it back what the
    // tracker or the worker says, and deletes no state. `team`: added in the console (FRU-366).
    origin: text('origin').notNull().default('tracker'),
    hidden: boolean('hidden').notNull().default(false),
  },
  (table) => [
    primaryKey({ name: 'statuses_pkey', columns: [table.site_id, table.source, table.key] }),
    foreignKey({
      name: 'statuses_site_id_fkey',
      columns: [table.site_id],
      foreignColumns: [sites.id],
    }).onDelete('cascade'),
  ],
);

/**
 * The sites an invitation of a guest names (FRU-250): the guest of one site reads these and no other.
 * Written by the route that invites, after better-auth kept the invitation. A site that goes, or an
 * invitation that goes, takes its rows with it.
 */
export const invitation_sites = pgTable(
  'invitation_sites',
  {
    invitation_id: text('invitation_id').notNull(),
    site_id: text('site_id').notNull(),
  },
  (table) => [
    primaryKey({ name: 'invitation_sites_pkey', columns: [table.invitation_id, table.site_id] }),
    foreignKey({
      name: 'invitation_sites_invitation_id_fkey',
      columns: [table.invitation_id],
      foreignColumns: [invitation.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'invitation_sites_site_id_fkey',
      columns: [table.site_id],
      foreignColumns: [sites.id],
    }).onDelete('cascade'),
    index('invitation_sites_by_site').on(table.site_id),
  ],
);

/**
 * The sites a guest of a workspace reads (FRU-250), copied from their invitation when they accept it,
 * before the member exists. A role other than `guest` reads every site and never reads this table.
 * A site that goes takes its rows: the guest stays a member, and reads nothing of it.
 *
 * Its key is the workspace and the account, and not a member id: the rows are written before
 * better-auth writes the member. A row without a member gives nothing (`reach` reads the member
 * first), and the next acceptance of the person in the workspace replaces the rows.
 */
export const site_shares = pgTable(
  'site_shares',
  {
    workspace_id: text('workspace_id').notNull(),
    account_id: text('account_id').notNull(),
    site_id: text('site_id').notNull(),
    created_at: instant('created_at').notNull(),
  },
  (table) => [
    primaryKey({ name: 'site_shares_pkey', columns: [table.workspace_id, table.account_id, table.site_id] }),
    foreignKey({
      name: 'site_shares_workspace_id_fkey',
      columns: [table.workspace_id],
      foreignColumns: [organization.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'site_shares_account_id_fkey',
      columns: [table.account_id],
      foreignColumns: [user.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'site_shares_site_id_fkey',
      columns: [table.site_id],
      foreignColumns: [sites.id],
    }).onDelete('cascade'),
    index('site_shares_by_site').on(table.site_id),
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
    // FRU-238. A session that a person approved in the console belongs to their account: `account_id`
    // names it (it is `subject` too), and `workspace` is NULL. NULL on a session of a pairing code.
    account_id: text('account_id'),
    // The short name of the browser the extension gave when it asked (« Chrome on macOS »), for the
    // list of « My account » (Q7). Free text of the caller: shown, never trusted.
    browser: text('browser'),
    // The public name of the session, the same on every token of its chain: « My account » ends one
    // by it, and never by a token or a digest of one.
    connection_id: text('connection_id'),
  },
  (table) => [
    index('sessions_by_expiry').on(table.expires_at),
    index('sessions_by_root').on(table.root_hash),
    index('sessions_by_account').on(table.account_id),
  ],
);

/**
 * What an extension asked, to be connected by a person in the console (FRU-238).
 *
 * `request_hash` is the digest of the public id the console opens, `claim_hash` the digest of the
 * secret the extension alone keeps: neither is stored as it is. `word` is the word both screens show
 * (« PLUM 47 »): a comparison for the eye, and not a secret. A request is answered once
 * (`outcome`), by one account, and claimed once.
 */
export const connect_requests = pgTable(
  'connect_requests',
  {
    request_hash: text('request_hash').notNull(),
    claim_hash: text('claim_hash').notNull(),
    word: text('word').notNull(),
    browser: text('browser').notNull(),
    created_at: instant('created_at').notNull(),
    expires_at: instant('expires_at').notNull(),
    // 'approved' or 'refused', and NULL while nobody answered.
    outcome: text('outcome'),
    account_id: text('account_id'),
    answered_at: instant('answered_at'),
    claimed_at: instant('claimed_at'),
    // Words that did not match, typed against this request: the fifth refuses it.
    misses: integer('misses').notNull().default(0),
  },
  (table) => [
    primaryKey({ name: 'connect_requests_pkey', columns: [table.request_hash] }),
    unique('connect_requests_claim_hash_key').on(table.claim_hash),
    index('connect_requests_by_expiry').on(table.expires_at),
  ],
);

/**
 * The day a member of a workspace was last seen there (FRU-249): their last call to the console in
 * that workspace, or the last refresh of an extension of theirs for it. A day of UTC, `YYYY-MM-DD`,
 * and no hour: « Last seen » says « Today », « Yesterday », « 3 days ago ». Only an owner or an admin
 * reads it. It goes with the membership: a person who leaves and comes back starts with none.
 */
export const last_seen = pgTable(
  'last_seen',
  {
    member_id: text('member_id').notNull(),
    day: text('day').notNull(),
  },
  (table) => [
    primaryKey({ name: 'last_seen_pkey', columns: [table.member_id] }),
    foreignKey({ name: 'last_seen_member_id_fkey', columns: [table.member_id], foreignColumns: [member.id] }).onDelete(
      'cascade',
    ),
  ],
);

/**
 * The addresses of an account beside the one of better-auth (`user.email`, the primary), FRU-450:
 * `account-emails.ts`. A row is an address that something proved for the account:
 *
 * - `providers`: the providers that gave it as verified (`github`, `google`), at a link or at a
 *   sign-in. A provider is in the list of one address of an account at most.
 * - `verified_at`: Fruitback proved it: the person opened the link of verification that it sent
 *   there, or it was the primary address of the account before another one took its place.
 *
 * A row with neither is not kept. The primary address of the account may have a row (when a provider
 * brought it), and is then listed once. **An address is of one account**: the key holds it here, and
 * the trigger of `0033_one_owner_per_address` holds it against `user.email` of another account. An
 * address that waits for its verification is not here: it is in the table `verification`, and holds
 * no address of another person.
 */
export const account_emails = pgTable(
  'account_emails',
  {
    email: text('email').notNull(),
    account_id: text('account_id').notNull(),
    providers: text('providers')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    verified_at: instant('verified_at'),
    created_at: instant('created_at').notNull(),
  },
  (table) => [
    primaryKey({ name: 'account_emails_pkey', columns: [table.email] }),
    foreignKey({
      name: 'account_emails_account_id_fkey',
      columns: [table.account_id],
      foreignColumns: [user.id],
    }).onDelete('cascade'),
    index('account_emails_by_account').on(table.account_id),
  ],
);

/** The bytes of a file. The driver answers a `Buffer`, and PGlite a `Uint8Array`: both are one here. */
const bytes = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => 'bytea',
  toDriver: (value) => value,
  fromDriver: (value) => new Uint8Array(value),
});

/**
 * The files of the notes in transit (FRU-331), on their way to the ticket of the tracker:
 * `attachments.ts`. The table keeps the name of FRU-44, when it held the pictures of the elements.
 *
 * A row goes when its tracker has the file, or at `expires_at`, `ATTACHMENT_TRANSIT_DAYS` after it
 * came. A row read after `expires_at` reads as absent. `expires_at` defaults to 0: a row written
 * with no end is past it at once. `account_id` is who sent it, and holds no foreign key: the file
 * of a person who leaves still goes with its note. `note_id` is the note that took it: the id
 * the widget gave the note.
 */
export const screenshots = pgTable(
  'screenshots',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull(),
    account_id: text('account_id').notNull(),
    // The site of the note the file goes with (FRU-250). NULL for a picture sent before.
    site_id: text('site_id'),
    content: bytes('content').notNull(),
    // The pictures of FRU-44 had a size in pixels. A file has none, and nothing decodes one.
    width: integer('width'),
    height: integer('height'),
    created_at: instant('created_at').notNull(),
    name: text('name').notNull().default('screenshot.png'),
    content_type: text('content_type').notNull().default('image/png'),
    expires_at: instant('expires_at').notNull().default(0),
    note_id: text('note_id'),
    // A picture of FRU-44, marked so by migration 0023: it ends 7 days after it, and counts for
    // nothing in what its account holds in transit (heavy review of #427). A file of FRU-331 is false.
    before_transit: boolean('before_transit').notNull().default(false),
  },
  (table) => [
    foreignKey({
      name: 'screenshots_workspace_id_fkey',
      columns: [table.workspace_id],
      foreignColumns: [organization.id],
    }).onDelete('cascade'),
    index('screenshots_by_workspace').on(table.workspace_id),
    // The sweep, and what one account holds.
    index('screenshots_by_expiry').on(table.expires_at),
    index('screenshots_by_account').on(table.account_id),
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
 * whose store is `postgres`. Until then they were in a SQLite file, and the columns are the same
 * (`postgres-copy.fixture.ts` holds that file).
 *
 * - `id` is the number of the note, `FB-<id>`. An identity that takes a value when one is given: the
 *   copy of a SQLite file (FRU-220) keeps the numbers that people already quoted.
 * - `client_id` is the id of the site. **It holds no foreign key**: the copy of a SQLite file
 *   (FRU-220) writes ids of clients that are not sites. The notes of a site that is removed go with
 *   it by `removeSite` of `accounts-postgres.ts` (FRU-194).
 * - `payload` is the note as JSON, in a `TEXT`: the reader parses a row and never trusts it, as for a
 *   file. `JSONB` refuses the `\u0000` that a note may hold, and `TEXT` holds its six characters.
 * - **It holds what a person wrote, in the clear**: a name, sometimes an address, the note.
 *   `forget` of `notes-postgres.ts` deletes them.
 *
 * **The page is under a hash index, not a B-tree.** An address has no bound but the 64 KiB of a
 * request, and a B-tree refuses a row over 2704 bytes once compressed (« index row size 6432 exceeds
 * btree version 4 maximum 2704 », measured on 17.11 with 6 400 characters that do not compress): the
 * note of such a page would not be kept at all. A hash index takes any length, and the read is an
 * equality. The site is then read in the rows of the page, which are few.
 */
export const notes = pgTable(
  'notes',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity({ name: 'notes_id_seq' }),
    client_id: text('client_id'),
    page_url: text('page_url').notNull(),
    stage: text('stage').notNull(),
    // The key of its status in `statuses`, with the source `own` (FRU-365). NULL: the built-in status
    // of its stage. Written with the stage, never alone (FRU-367).
    status_key: text('status_key'),
    payload: text('payload').notNull(),
    created_at: instant('created_at').notNull(),
    updated_at: instant('updated_at').notNull(),
  },
  (table) => [
    index('notes_by_page').using('hash', table.page_url),
    // Every note of one site: what a removed site deletes (FRU-194), and the read by site.
    index('notes_by_client').on(table.client_id),
  ],
);

/** A reply of the team to a note the worker keeps (FRU-218). It goes with its note. */
export const note_comments = pgTable(
  'note_comments',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity({ name: 'note_comments_id_seq' }),
    note_id: bigint('note_id', { mode: 'number' }).notNull(),
    author: text('author'),
    body: text('body').notNull(),
    created_at: instant('created_at').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'note_comments_note_id_fkey',
      columns: [table.note_id],
      foreignColumns: [notes.id],
    }).onDelete('cascade'),
    index('note_comments_by_note').on(table.note_id, table.created_at),
  ],
);

/**
 * The index of the notes of a workspace (FRU-237): `notes-index.ts` says what it keeps and why, and
 * `docs/privacy.md` names each column. **No column holds more than `EXCERPT_LENGTH` characters of
 * the text of a note**: `excerpt`, and nothing else of the text.
 *
 * A row goes with its site and with its workspace (`cascade`): the index of a site that is removed
 * is removed, with the notes themselves (FRU-194). `connector_id` is `set null` when
 * the connector goes, and `place` then still says that the note went to one.
 */
export const note_index = pgTable(
  'note_index',
  {
    site_id: text('site_id').notNull(),
    note_id: text('note_id').notNull(),
    workspace_id: text('workspace_id').notNull(),
    page_url: text('page_url').notNull(),
    excerpt: text('excerpt').notNull(),
    stage: text('stage').notNull(),
    channel: text('channel'),
    author_kind: text('author_kind').notNull(),
    author_account_id: text('author_account_id'),
    place: text('place').notNull(),
    connector_id: text('connector_id'),
    reference: text('reference'),
    reference_url: text('reference_url'),
    created_at: instant('created_at').notNull(),
    checked_at: instant('checked_at').notNull(),
    // FRU-295: whether the newest verdict in the replies of the note is « looks fixed » (FRU-294), as
    // the last read that saw its replies said it. Empty: no read saw them yet.
    confirmed: boolean('confirmed'),
  },
  (table) => [
    primaryKey({ name: 'note_index_pkey', columns: [table.site_id, table.note_id] }),
    foreignKey({
      name: 'note_index_site_id_fkey',
      columns: [table.site_id],
      foreignColumns: [sites.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'note_index_workspace_id_fkey',
      columns: [table.workspace_id],
      foreignColumns: [organization.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'note_index_connector_id_fkey',
      columns: [table.connector_id],
      foreignColumns: [connectors.id],
    }).onDelete('set null'),
    // The counts of the sites of a workspace: one pass over this index, grouped by site and stage.
    index('note_index_by_workspace').on(table.workspace_id, table.site_id, table.stage),
    // The account of a member goes when the account goes: no row names an account that is not one.
    foreignKey({
      name: 'note_index_author_account_id_fkey',
      columns: [table.author_account_id],
      foreignColumns: [user.id],
    }).onDelete('set null'),
    // What `ON DELETE SET NULL` of an account looks for, and the notes of one member (FRU-244).
    index('note_index_by_author').on(table.author_account_id),
    // The list of the notes of a workspace (FRU-244): the newest first, so a page reads its rows in
    // the order of this index and stops. Two notes of one millisecond are then ordered by their ids,
    // in the bytes of `COLLATE "C"`: the same order on every server, whatever its collation.
    index('note_index_by_date').on(
      table.workspace_id,
      table.created_at.desc(),
      sql`"site_id" COLLATE "C" DESC`,
      sql`"note_id" COLLATE "C" DESC`,
    ),
  ],
);

/**
 * The reads of an administrator of the instance in a workspace they are not a member of (FRU-261):
 * who, which read, and when. The owners of the workspace read them (`instance-admin.ts`).
 *
 * `admin_email` keeps the address of the administrator at the moment of the read, so a row still says
 * who after their account goes (`set null`). A row goes with its workspace.
 */
export const admin_reads = pgTable(
  'admin_reads',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull(),
    admin_account_id: text('admin_account_id'),
    admin_email: text('admin_email').notNull(),
    what: text('what').notNull(),
    at: instant('at').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'admin_reads_workspace_id_fkey',
      columns: [table.workspace_id],
      foreignColumns: [organization.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'admin_reads_admin_account_id_fkey',
      columns: [table.admin_account_id],
      foreignColumns: [user.id],
    }).onDelete('set null'),
    index('admin_reads_by_workspace').on(table.workspace_id, table.at.desc()),
    index('admin_reads_by_admin').on(table.admin_account_id),
  ],
);

/**
 * The actions of an administrator of the instance (FRU-280): who, which action, on whom, and when. The
 * administrators of the instance read them (`instance-admin.ts`).
 *
 * - `actor_email` and `target_email` keep the addresses at the moment of the action, so a row still
 *   says who after an account goes (`set null`).
 * - `workspace_id` is empty for an action on the instance, as naming an administrator. A row stays
 *   after its workspace goes (`set null`).
 * - `detail` is JSON, or empty: what an action needs beyond its kind and its target.
 */
export const admin_actions = pgTable(
  'admin_actions',
  {
    id: text('id').primaryKey(),
    at: instant('at').notNull(),
    actor_account_id: text('actor_account_id'),
    actor_email: text('actor_email').notNull(),
    action: text('action').notNull(),
    target_account_id: text('target_account_id'),
    target_email: text('target_email'),
    workspace_id: text('workspace_id'),
    detail: text('detail'),
  },
  (table) => [
    foreignKey({
      name: 'admin_actions_actor_account_id_fkey',
      columns: [table.actor_account_id],
      foreignColumns: [user.id],
    }).onDelete('set null'),
    foreignKey({
      name: 'admin_actions_target_account_id_fkey',
      columns: [table.target_account_id],
      foreignColumns: [user.id],
    }).onDelete('set null'),
    foreignKey({
      name: 'admin_actions_workspace_id_fkey',
      columns: [table.workspace_id],
      foreignColumns: [organization.id],
    }).onDelete('set null'),
    index('admin_actions_by_date').on(table.at.desc()),
    index('admin_actions_by_workspace').on(table.workspace_id, table.at.desc()),
    index('admin_actions_by_actor').on(table.actor_account_id),
    index('admin_actions_by_target').on(table.target_account_id),
  ],
);

/**
 * The workspaces that an administrator of the instance suspended (FRU-282): one row for each, from
 * the suspension to the restoration. A restoration deletes the row. Who suspended, and who restored,
 * is in `admin_actions`, with the reason in `detail`.
 *
 * `reason` is the text of the administrator, or empty. Every member of the workspace reads it.
 */
export const workspace_suspensions = pgTable(
  'workspace_suspensions',
  {
    workspace_id: text('workspace_id').notNull(),
    since: instant('since').notNull(),
    reason: text('reason'),
  },
  (table) => [
    primaryKey({ name: 'workspace_suspensions_pkey', columns: [table.workspace_id] }),
    foreignKey({
      name: 'workspace_suspensions_workspace_id_fkey',
      columns: [table.workspace_id],
      foreignColumns: [organization.id],
    }).onDelete('cascade'),
  ],
);

/**
 * The logo of a workspace (FRU-428): one row for each workspace that has one. `workspace-logo.ts`
 * checks the bytes before they come here: a PNG, a JPEG or a WebP of `MAX_LOGO_BYTES` at most, whose
 * header says a size of `MAX_LOGO_SIDE` pixels at most on each side. Its owner and its admins send it
 * and remove it; its members read it. The row goes with the workspace.
 *
 * The bytes are in the database, as the files in transit are (`screenshots`), and not in a table of
 * theirs: a file in transit ends and is swept, a logo stays. `updated_at` is the version of the address
 * that the console reads (`?v=`).
 */
export const workspace_logos = pgTable(
  'workspace_logos',
  {
    workspace_id: text('workspace_id').notNull(),
    content_type: text('content_type').notNull(),
    content: bytes('content').notNull(),
    updated_at: instant('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ name: 'workspace_logos_pkey', columns: [table.workspace_id] }),
    foreignKey({
      name: 'workspace_logos_workspace_id_fkey',
      columns: [table.workspace_id],
      foreignColumns: [organization.id],
    }).onDelete('cascade'),
  ],
);
