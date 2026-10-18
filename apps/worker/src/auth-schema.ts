import { sql } from 'drizzle-orm';
import { boolean, foreignKey, index, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';

/**
 * The tables of better-auth, in the schema of the database of a worker (FRU-144, FRU-180).
 *
 * **These are the tables that better-auth 1.7.7 makes for the configuration of `auth.ts`**
 * (`compileMigrations` of `better-auth/db/migration`, on an empty PostgreSQL), with one constraint
 * added: see `member`. `drizzle-kit` writes their migration with the rest of the schema
 * (`postgres-schema.ts`), and the worker applies it. `auth migrate` and `runMigrations()` never run
 * on a database of the worker: one tool migrates it, and that tool is Drizzle.
 *
 * better-auth keeps its own adapter, Kysely, on the pool of `postgres.ts`. It does not read this
 * file. `auth-schema.test.ts` holds these tables to the library: after the migrations of the worker,
 * better-auth has nothing to create and nothing to add, and the tables are the ones its own migration
 * makes, column for column and constraint for constraint, but the one that is added here.
 *
 * The names are the ones of better-auth: `camelCase`, and `"user"` is a reserved word. An instant is
 * a `timestamptz` here, and a `BIGINT` of milliseconds in the tables of the worker: better-auth writes
 * these rows, with its own types. A default is `CURRENT_TIMESTAMP`, as better-auth writes it, and not
 * `now()`, which the catalogue would show as another text.
 *
 * Every constraint has the name that PostgreSQL gives it, as in `postgres-schema.ts`: the DDL of
 * better-auth names none, and the tool of before made these tables from that DDL.
 *
 * WARNING: `session.token` and `verification.identifier` hold digests, and the token columns of
 * `account` stay empty, only because better-auth writes through the layer of `auth-at-rest.ts`
 * (FRU-181). Code that writes these tables by itself must keep the same rule.
 */

const instant = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () =>
  instant('createdAt')
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull();

export const user = pgTable(
  'user',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    emailVerified: boolean('emailVerified').notNull(),
    image: text('image'),
    createdAt: createdAt(),
    updatedAt: instant('updatedAt')
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    // The language a person chose (FRU-146): an additional field of `user` in `authOptions`.
    locale: text('locale'),
    // The administrator of the instance (FRU-261): `role` is `admin` for one, NULL for the others.
    // The four columns are the ones of the admin plugin of better-auth, which the worker does not
    // mount: additional fields of `user` in `authOptions`. `instance-admin.ts` says who reads them.
    role: text('role'),
    banned: boolean('banned'),
    banReason: text('banReason'),
    banExpires: instant('banExpires'),
  },
  (table) => [unique('user_email_key').on(table.email)],
);

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: instant('expiresAt').notNull(),
    token: text('token').notNull(),
    createdAt: createdAt(),
    updatedAt: instant('updatedAt').notNull(),
    ipAddress: text('ipAddress'),
    userAgent: text('userAgent'),
    // The short label of the browser, « Chrome on macOS » (FRU-249): an additional field of `session`
    // in `authOptions`, from `browserLabel`, never the user agent.
    browser: text('browser'),
    userId: text('userId').notNull(),
    activeOrganizationId: text('activeOrganizationId'),
  },
  (table) => [
    unique('session_token_key').on(table.token),
    foreignKey({ name: 'session_userId_fkey', columns: [table.userId], foreignColumns: [user.id] }).onDelete('cascade'),
    index('session_userId_idx').on(table.userId),
  ],
);

/**
 * A way a person signs in: the `logins` of before (FRU-146). `providerId` is `email`, `github` or
 * `google`, and `accountId` is who the person is there: the address for `email`, the id of the
 * provider for the others.
 *
 * The token columns are where better-auth keeps the tokens of a provider that signs a person in.
 * `SECURITY.md` says that the worker keeps no such token: `accounts-postgres.ts` gives them no value,
 * and the layer of `auth-at-rest.ts` empties them for better-auth.
 *
 * `account_providerId_accountId_key` is not in the DDL of better-auth. One identity at a provider is
 * one person, as the primary key of `logins` said: with two rows, a sign-in finds either.
 */
export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('accountId').notNull(),
    providerId: text('providerId').notNull(),
    userId: text('userId').notNull(),
    accessToken: text('accessToken'),
    refreshToken: text('refreshToken'),
    idToken: text('idToken'),
    accessTokenExpiresAt: instant('accessTokenExpiresAt'),
    refreshTokenExpiresAt: instant('refreshTokenExpiresAt'),
    scope: text('scope'),
    password: text('password'),
    createdAt: createdAt(),
    updatedAt: instant('updatedAt').notNull(),
  },
  (table) => [
    foreignKey({ name: 'account_userId_fkey', columns: [table.userId], foreignColumns: [user.id] }).onDelete('cascade'),
    unique('account_providerId_accountId_key').on(table.providerId, table.accountId),
    index('account_userId_idx').on(table.userId),
  ],
);

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: instant('expiresAt').notNull(),
    createdAt: createdAt(),
    updatedAt: instant('updatedAt')
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
);

export const organization = pgTable(
  'organization',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    logo: text('logo'),
    createdAt: instant('createdAt').notNull(),
    metadata: text('metadata'),
  },
  (table) => [unique('organization_slug_key').on(table.slug)],
);

/**
 * `member_organizationId_userId_key` is not in the DDL of better-auth. A person is a member of a
 * workspace once, as in the `members` table of the worker: with two rows, one person has two roles.
 */
export const member = pgTable(
  'member',
  {
    id: text('id').primaryKey(),
    organizationId: text('organizationId').notNull(),
    userId: text('userId').notNull(),
    role: text('role').notNull(),
    createdAt: instant('createdAt').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'member_organizationId_fkey',
      columns: [table.organizationId],
      foreignColumns: [organization.id],
    }).onDelete('cascade'),
    foreignKey({ name: 'member_userId_fkey', columns: [table.userId], foreignColumns: [user.id] }).onDelete('cascade'),
    unique('member_organizationId_userId_key').on(table.organizationId, table.userId),
    index('member_organizationId_idx').on(table.organizationId),
    index('member_userId_idx').on(table.userId),
  ],
);

export const invitation = pgTable(
  'invitation',
  {
    id: text('id').primaryKey(),
    organizationId: text('organizationId').notNull(),
    email: text('email').notNull(),
    role: text('role'),
    status: text('status').notNull(),
    expiresAt: instant('expiresAt').notNull(),
    createdAt: createdAt(),
    inviterId: text('inviterId').notNull(),
    // Whether a message of this invitation left (FRU-269): an additional field of `invitation` in
    // `authOptions`, written by the route that invites. NULL: an invitation made before it was kept.
    mailed: boolean('mailed'),
  },
  (table) => [
    foreignKey({
      name: 'invitation_organizationId_fkey',
      columns: [table.organizationId],
      foreignColumns: [organization.id],
    }).onDelete('cascade'),
    foreignKey({ name: 'invitation_inviterId_fkey', columns: [table.inviterId], foreignColumns: [user.id] }).onDelete(
      'cascade',
    ),
    index('invitation_organizationId_idx').on(table.organizationId),
    index('invitation_email_idx').on(table.email),
  ],
);
