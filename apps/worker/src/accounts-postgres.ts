import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import {
  accountOf,
  connectorOf,
  destinationOf,
  domainOf,
  dueDeliveryOf,
  newId,
  pendingDeliveryOf,
  roleOf,
  siteOf,
  workspaceOf,
} from './account-rows.ts';
import {
  type AccountStore,
  type Connector,
  DEFAULT_CONNECTOR_SETTINGS,
  DEFAULT_WRITERS,
  type SharedSite,
  type Site,
  type WorkspaceSuspension,
  clientOf,
  normalizeEmail,
} from './accounts.ts';
import type { ClientMap } from './clients.ts';
import type { Database, Db } from './postgres.ts';
import { migrated } from './postgres-migrate.ts';
import { account, invitation, member, organization, user } from './auth-schema.ts';
import {
  connectors,
  deliveries,
  domains,
  invitation_sites,
  last_seen,
  note_index,
  seeds,
  site_destinations,
  site_shares,
  sites,
  statuses,
  workspace_suspensions,
} from './postgres-schema.ts';
import { MAX_STATUSES, type SeedStage } from '@fruitback/shared';
import { OWN_SOURCE, type SiteStatus, isBuiltIn } from './site-statuses.ts';
import { identifierFor, isSameSeed, keptRowOf } from './seed-rows.ts';
import { StoreError } from './store.ts';

/**
 * The accounts in PostgreSQL (FRU-141), the one place they live since FRU-150. The store on a file
 * that it took the place of went with FRU-226. `account-conformance.test.ts` holds this store to its
 * cases.
 *
 * The statements are written with Drizzle (FRU-180). A site, a connector and what goes with them are
 * in the tables of `postgres-schema.ts`, with the names of the SQLite file: a row has the keys of its
 * columns, so `account-rows.ts` parses it as it parses a row of SQLite.
 *
 * **A person, a way to sign in, a workspace and a membership are rows of better-auth** (FRU-146):
 * `user`, `account`, `organization` and `member` of `auth-schema.ts`. This store reads and writes
 * them itself, with the sign-in code of before: better-auth does not run for it, and its layer
 * (`auth-at-rest.ts`) is not between this file and the table. So the rule of that layer is kept here
 * by hand: **no statement of this file gives a value to a token column of `account`, or to its
 * password.** What each column holds is in « The accounts in the tables of better-auth » of
 * `docs/decisions/worker.md`.
 *
 * **What SQLite did without saying it, written on purpose here.** A SQLite store is one connection
 * that does one thing at a time, so a read followed by a write was safe there. Here two requests
 * run on two connections:
 *
 * - `INSERT OR IGNORE` is `onConflictDoNothing`, and it names the constraint it means.
 * - A new account is an insert that does nothing on a conflict of `email`, followed by a read. Two
 *   sign-ins of one new address at the same moment both find no account: the second insert waits
 *   for the first transaction, does nothing, and the read then answers the row of the first.
 * - `addSite` is one insert with `onConflictDoUpdate`, where SQLite read the site and then wrote it.
 * - `IS NOT ?` with a null is `IS DISTINCT FROM`: `<>` with a null is never true.
 * - A link is spent by one update that returns its row: the row lock decides which of two calls
 *   changed it.
 * - An instant is a `BIGINT` of milliseconds that the worker gives. The database never reads its clock.
 * - `setDestinations` checks and writes in one transaction that holds the row of the site. SQLite
 *   checked, then wrote, with nothing between. Two lists for one site at the same moment would
 *   otherwise both remove the old rows and both write position 0.
 * - A site and its destinations are one statement, where SQLite reads the sites and then every
 *   destination: one exchange with the server for a request, and one moment of the database.
 *
 * **A write that must say whether it changed a row returns that row.** The two drivers of Drizzle do
 * not count the rows of a statement in the same way, and `returning` is the same on both.
 */

/** A site beside one of its destinations. With a `LEFT JOIN`, a site that has none is one row. */
/** A row of `workspace_suspensions`, or of a join that found none. */
function suspensionOf(row: { since: number | null; reason: string | null }): WorkspaceSuspension | undefined {
  if (row.since === null) return undefined;

  return { since: row.since, ...(row.reason === null || row.reason === '' ? {} : { reason: row.reason }) };
}

const SITE_WITH_DESTINATION = {
  id: sites.id,
  workspace_id: sites.workspace_id,
  origin: sites.origin,
  visibility: sites.visibility,
  writers: sites.writers,
  connector_id: site_destinations.connector_id,
  team_id: site_destinations.team_id,
  project_id: site_destinations.project_id,
  label: site_destinations.label,
  private: site_destinations.private,
};

/** A domain as `domainOf` reads one. */
const DOMAIN = {
  id: domains.id,
  workspace_id: domains.workspace_id,
  domain: domains.domain,
  created_at: domains.created_at,
  verified_at: domains.verified_at,
  lost_at: domains.lost_at,
  checked_at: domains.checked_at,
  previews_site_id: domains.previews_site_id,
};

/** A person as `accountOf` reads one: a row of `user`. */
const ACCOUNT = { id: user.id, email: user.email, name: user.name, locale: user.locale, banned: user.banned };

/** The account of the row is not suspended (FRU-281): `banned` of `user` is not true. */
const NOT_SUSPENDED = or(isNull(user.banned), eq(user.banned, false));

/** The sites of these rows in the order of the rows, each with its destinations in that order. */
function sitesFrom(rows: readonly Record<string, unknown>[]): Site[] {
  const found = new Map<string, Site>();
  for (const row of rows) {
    const site = found.get(String(row.id)) ?? siteOf(row, []);
    if (site === undefined) continue;
    found.set(site.id, site);

    const destination = destinationOf(row);
    if (destination !== undefined) site.destinations.push(destination);
  }

  return [...found.values()];
}

/**
 * `value`, or a `TypeError` that names it (FRU-187).
 *
 * Drizzle writes no `NULL` for `undefined`. In `.set()` it leaves the column out, and the row keeps
 * its old value. In a raw fragment it leaves the value out of the text, and the statement is
 * wrong. The types say every one of these values is given: this holds it for a caller that the types
 * do not see.
 */
function given<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new TypeError(`${what} is required`);

  return value;
}

/** `limit`, when it is a whole number of rows of at least one. Drizzle leaves out a `LIMIT` that is not. */
function rowLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError(`dueDeliveries: limit must be a positive integer`);

  return limit;
}

/**
 * The notes that the worker keeps for these sites, their replies, and the deliveries that wait to
 * send them (FRU-194). A site that goes takes them with it: nothing reads them after, and a site
 * that is added again gets a new id. `note_index` goes by its own foreign key; `seeds` has none,
 * because a copy from SQLite writes the ids of clients that are not sites. A delivery names its site
 * in its body only, as `pendingOf` of `notes-index-postgres.ts` reads it.
 */
async function dropKeptNotes(db: Db, workspace: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(seeds).where(inArray(seeds.client_id, [...ids]));
  const site = sql`(CASE WHEN pg_input_is_valid(${deliveries.body}, 'jsonb') THEN ${deliveries.body}::jsonb -> 'site' ->> 'id' END)`;
  await db
    .delete(deliveries)
    .where(
      and(
        inArray(site, [...ids]),
        inArray(
          deliveries.connector_id,
          db.select({ id: connectors.id }).from(connectors).where(eq(connectors.workspace_id, workspace)),
        ),
      ),
    );
}

/**
 * Holds the rows of the members of a workspace, in the transaction of `db` (FRU-324). A writer that
 * holds the workspace and then writes its members calls this **before** it holds the workspace.
 *
 * WARNING: the trigger of `0020_workspace_keeps_owner` holds the workspace after the row of the member
 * that a route of better-auth writes. A writer that held the workspace first, and then waited for that
 * member, waited for a route that waited for it: PostgreSQL ended one of them on a deadlock. Members,
 * then the workspace, is the one order.
 */
export async function holdMembers(db: Db, workspace: string): Promise<void> {
  // `of: member`, written: the planted case of `accounts-postgres.test.ts` takes out the lock of the
  // site by its text, which must be in this file once.
  await db
    .select({ id: member.id })
    .from(member)
    .where(eq(member.organizationId, workspace))
    .orderBy(asc(member.id))
    .for('update', { of: member });
}

/**
 * Deletes a workspace, in the transaction of `db`: the one path of a deletion, for its owner and for
 * an administrator of the instance (FRU-284). The foreign keys take its members, its invitations, its
 * sites and their destinations, its connectors and their deliveries with it. The notes that the
 * worker keeps go first, while the sites still name them.
 */
export async function dropWorkspace(db: Db, workspace: string): Promise<void> {
  // WARNING: the workspace is held first, before `dropKeptNotes` holds rows of `seeds`. Both paths of
  // a deletion then take their locks in one order: an owner and an administrator who delete one
  // workspace at the same moment wait for each other, where the other order ended one of them on a
  // deadlock (seen by the heavy review of #364).
  // `NO KEY UPDATE`, which waits for the `FOR UPDATE` of the deletion by an administrator as well.
  // Its members first, which the foreign keys delete with it: see `holdMembers`.
  await holdMembers(db, workspace);
  await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.id, workspace))
    .for('no key update');
  const ids = await db.select({ id: sites.id }).from(sites).where(eq(sites.workspace_id, workspace));
  await dropKeptNotes(
    db,
    workspace,
    ids.map((row) => row.id),
  );
  await db.delete(organization).where(eq(organization.id, workspace));
}

/** Whether `site` is a site of `workspace`, read in the transaction of `db`, and held until it ends. */
async function siteHeld(db: Db, workspace: string, site: string): Promise<boolean> {
  const rows = await db
    .select({ id: sites.id })
    .from(sites)
    .where(and(eq(sites.workspace_id, workspace), eq(sites.id, site)))
    // `of`: the same lock as a bare FOR UPDATE on one table, and a text the mutation of FRU-141 does not take.
    .for('update', { of: sites });

  return rows.length === 1;
}

/** A row of `statuses` as the store hands it over. */
function siteStatusOf(row: typeof statuses.$inferSelect): SiteStatus {
  return {
    source: row.source,
    key: row.key,
    name: row.name,
    stage: row.stage as SiteStatus['stage'],
    color: row.color,
    textColor: row.text_color,
    position: row.position,
    origin: row.origin as SiteStatus['origin'],
    hidden: row.hidden,
  };
}

/**
 * The stage of notes the worker keeps, in the index of the notes too, in the transaction of `db`
 * (FRU-366, found in the heavy review of #487). The index learns a stage from a read of a page
 * (FRU-237): a note that a status moved, on a page nobody opens again, would keep its old stage in
 * the list and the counts of the console for good. A note of the worker is `FB-<id>` there, with no
 * connector; `checked_at` is now, since the worker is the store that just set the stage.
 */
async function restageIndex(db: Db, site: string, ids: readonly number[], stage: string, now: number): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(note_index)
    .set({ stage, checked_at: now })
    .where(
      and(
        eq(note_index.site_id, site),
        isNull(note_index.connector_id),
        inArray(
          note_index.reference,
          ids.map((id) => identifierFor(id)),
        ),
      ),
    );
}

/** Thrown inside a transaction to roll it back, and caught by the method that threw it. */
class RolledBack extends Error {}

export function createPostgresAccountStore(database: Database): AccountStore {
  /** `work` on the database, with its schema. The first call of a process applies the migrations. */
  const run = async <T>(work: (db: Db) => Promise<T>): Promise<T> => {
    await migrated(database);

    return database.run(work);
  };

  /** `work` in one transaction, on the database with its schema. */
  const transaction = async <T>(work: (db: Db) => Promise<T>): Promise<T> => {
    await migrated(database);

    return database.transaction(work);
  };

  const store: AccountStore = {
    async signIn({ provider, subject, email, name, locale }) {
      const address = normalizeEmail(email);
      if (address === undefined) throw new StoreError('A sign-in needs a valid address');

      const now = new Date();
      // `user.name` takes no null: a person with no name has the empty one, which `accountOf` reads as none.
      const given = name ?? '';

      return transaction(async (tx) => {
        const known = await tx
          .select({ id: account.userId })
          .from(account)
          .where(and(eq(account.providerId, provider), eq(account.accountId, subject)));
        let id = known[0]?.id;

        if (id === undefined) {
          // The same proven address from another provider is the same person: join, do not duplicate.
          // Every way to sign in that reaches this store proves the address, so it is verified.
          await tx
            .insert(user)
            .values({
              id: newId('acc'),
              email: address,
              name: given,
              emailVerified: true,
              locale: locale ?? null,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoNothing({ target: user.email });
          id = (await tx.select({ id: user.id }).from(user).where(eq(user.email, address)))[0]?.id;
        }
        if (id === undefined) throw new StoreError('The account of a sign-in could not be read back');

        // Each one in its statement, with its condition: a value that somebody has is never written over.
        if (given !== '') {
          await tx
            .update(user)
            .set({ name: given, updatedAt: now })
            .where(and(eq(user.id, id), eq(user.name, '')));
        }
        // Only when nobody chose: a sign-in from a borrowed browser must not change the language.
        if (locale !== undefined) {
          await tx
            .update(user)
            .set({ locale, updatedAt: now })
            .where(and(eq(user.id, id), or(isNull(user.locale), eq(user.locale, ''))));
        }
        // No token of the provider, no scope and no password: the columns stay empty (SECURITY.md).
        await tx
          .insert(account)
          .values({
            id: newId('lgn'),
            providerId: provider,
            accountId: subject,
            userId: id,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing({ target: [account.providerId, account.accountId] });

        const found = accountOf((await tx.select(ACCOUNT).from(user).where(eq(user.id, id)))[0]);
        if (found === undefined) throw new StoreError('The account of a sign-in could not be read back');

        return found;
      });
    },

    async setLocale(person, locale) {
      await run((db) =>
        db
          .update(user)
          .set({ locale: locale ?? null, updatedAt: new Date() })
          .where(eq(user.id, person)),
      );
    },

    async setName(person, name) {
      await run((db) => db.update(user).set({ name, updatedAt: new Date() }).where(eq(user.id, person)));
    },

    async localeOf(email) {
      const address = normalizeEmail(email);
      if (address === undefined) return undefined;
      const rows = await run((db) => db.select({ locale: user.locale }).from(user).where(eq(user.email, address)));
      const locale = rows[0]?.locale;

      return typeof locale === 'string' && locale !== '' ? locale : undefined;
    },

    async account(id) {
      return accountOf((await run((db) => db.select(ACCOUNT).from(user).where(eq(user.id, id))))[0]);
    },

    async isInstanceAdmin(id) {
      const rows = await run((db) =>
        db
          .select({ id: user.id })
          .from(user)
          // Strict, as `roleOf`: « admin,user », which the admin plugin reads as two roles, is no administrator.
          .where(and(eq(user.id, given(id, 'isInstanceAdmin: account')), eq(user.role, 'admin'), NOT_SUSPENDED)),
      );

      return rows.length === 1;
    },

    async createWorkspace(name, owner) {
      const workspace = { id: newId('ws'), name: name.trim() };
      const now = new Date();

      await transaction(async (tx) => {
        // `organization.slug` is required and unique, and a workspace has no slug: it is its id.
        await tx
          .insert(organization)
          .values({ id: workspace.id, name: workspace.name, slug: workspace.id, createdAt: now });
        await tx
          .insert(member)
          .values({ id: newId('mem'), organizationId: workspace.id, userId: owner, role: 'owner', createdAt: now });
      });

      return workspace;
    },

    async memberships(person) {
      const rows = await run((db) =>
        db
          .select({
            id: organization.id,
            name: organization.name,
            role: member.role,
            since: workspace_suspensions.since,
            reason: workspace_suspensions.reason,
          })
          .from(member)
          .innerJoin(organization, eq(organization.id, member.organizationId))
          .leftJoin(workspace_suspensions, eq(workspace_suspensions.workspace_id, organization.id))
          .where(eq(member.userId, person))
          .orderBy(member.createdAt, organization.id),
      );

      return rows.flatMap((row) => {
        const workspace = workspaceOf(row);
        const role = roleOf(row.role);
        const suspension = suspensionOf(row);
        if (workspace === undefined || role === undefined) return [];

        return [{ workspace, role, ...(suspension === undefined ? {} : { suspension }) }];
      });
    },

    async suspension(workspace) {
      const [row] = await run((db) =>
        db
          .select({ since: workspace_suspensions.since, reason: workspace_suspensions.reason })
          .from(workspace_suspensions)
          .where(eq(workspace_suspensions.workspace_id, workspace)),
      );

      return row === undefined ? undefined : suspensionOf(row);
    },

    async owners() {
      const rows = await run((db) =>
        db
          .selectDistinct({ email: user.email })
          .from(member)
          .innerJoin(user, eq(user.id, member.userId))
          // Strict, as `roleOf`: « owner,admin », which better-auth reads as two roles, is no owner.
          .where(eq(member.role, 'owner'))
          .orderBy(user.email),
      );

      return rows.map((row) => row.email.toLowerCase());
    },

    async markSeen(workspace, person, day) {
      await run(async (db) => {
        const [membership] = await db
          .select({ id: member.id })
          .from(member)
          .where(and(eq(member.organizationId, workspace), eq(member.userId, person)));
        if (membership === undefined) return;
        await db
          .insert(last_seen)
          .values({ member_id: membership.id, day })
          .onConflictDoUpdate({
            target: last_seen.member_id,
            set: { day },
            // A day never goes back: two calls that cross keep the later one.
            setWhere: lt(last_seen.day, day),
          });
      });
    },

    async lastSeen(workspace) {
      const rows = await run((db) =>
        db
          .select({ account: member.userId, day: last_seen.day })
          .from(last_seen)
          .innerJoin(member, eq(member.id, last_seen.member_id))
          .where(eq(member.organizationId, workspace)),
      );

      return Object.fromEntries(rows.map((row) => [row.account, row.day]));
    },

    async role(workspace, person) {
      const rows = await run((db) =>
        db
          .select({ role: member.role })
          .from(member)
          .innerJoin(user, eq(user.id, member.userId))
          .where(and(eq(member.organizationId, workspace), eq(member.userId, person), NOT_SUSPENDED)),
      );

      // Strict: « guest,admin », which better-auth reads as two roles, is no role of the worker.
      return roleOf(rows[0]?.role);
    },

    async reach(workspace, person) {
      // One statement: the member, and the sites shared with them. A share with no member is not read.
      const rows = await run((db) =>
        db
          .select({ role: member.role, site: site_shares.site_id })
          .from(member)
          .innerJoin(user, eq(user.id, member.userId))
          .leftJoin(
            site_shares,
            and(eq(site_shares.workspace_id, member.organizationId), eq(site_shares.account_id, member.userId)),
          )
          .where(and(eq(member.organizationId, workspace), eq(member.userId, person), NOT_SUSPENDED)),
      );
      const role = roleOf(rows[0]?.role);
      if (role === undefined) return undefined;
      if (role !== 'guest') return { role, sites: 'every' };

      return { role, sites: rows.flatMap((row) => (row.site === null ? [] : [row.site])) };
    },

    async shareByInvitation(workspace, invited, named) {
      const wanted = [...new Set(named)];
      if (wanted.length === 0) return true;

      return transaction(async (tx) => {
        // The sites are read in the workspace of the invitation: a site of another workspace is none.
        const found = await tx
          .select({ id: sites.id })
          .from(sites)
          .where(and(eq(sites.workspace_id, workspace), inArray(sites.id, wanted)));
        if (found.length !== wanted.length) return false;
        await tx
          .insert(invitation_sites)
          .values(wanted.map((site) => ({ invitation_id: invited, site_id: site })))
          .onConflictDoNothing({ target: [invitation_sites.invitation_id, invitation_sites.site_id] });

        return true;
      });
    },

    async sitesOfInvitations(invitations) {
      const found = new Map<string, SharedSite[]>();
      if (invitations.length === 0) return found;
      const rows = await run((db) =>
        db
          .select({ invitation: invitation_sites.invitation_id, id: sites.id, origin: sites.origin })
          .from(invitation_sites)
          .innerJoin(sites, eq(sites.id, invitation_sites.site_id))
          .where(inArray(invitation_sites.invitation_id, [...invitations]))
          .orderBy(sites.created_at, sites.id),
      );
      for (const row of rows)
        found.set(row.invitation, [...(found.get(row.invitation) ?? []), { id: row.id, origin: row.origin }]);

      return found;
    },

    async shareOnAcceptance(person, invited) {
      const now = Date.now();
      await transaction(async (tx) => {
        const rows = await tx
          .select({ workspace: invitation.organizationId })
          .from(invitation)
          .where(eq(invitation.id, invited));
        const workspace = rows[0]?.workspace;
        if (workspace === undefined) return;
        await tx
          .delete(site_shares)
          .where(and(eq(site_shares.workspace_id, workspace), eq(site_shares.account_id, person)));
        // The sites of the invitation that are still sites of its workspace.
        const named = await tx
          .select({ id: sites.id })
          .from(invitation_sites)
          .innerJoin(sites, eq(sites.id, invitation_sites.site_id))
          .where(and(eq(invitation_sites.invitation_id, invited), eq(sites.workspace_id, workspace)));
        if (named.length === 0) return;
        await tx
          .insert(site_shares)
          .values(
            named.map(({ id }) => ({ workspace_id: workspace, account_id: person, site_id: id, created_at: now })),
          );
      });
    },

    async sharedIn(workspace) {
      const rows = await run((db) =>
        db
          .select({ account: site_shares.account_id, id: sites.id, origin: sites.origin })
          .from(site_shares)
          .innerJoin(sites, eq(sites.id, site_shares.site_id))
          .where(eq(site_shares.workspace_id, workspace))
          .orderBy(sites.created_at, sites.id),
      );
      const found = new Map<string, SharedSite[]>();
      for (const row of rows)
        found.set(row.account, [...(found.get(row.account) ?? []), { id: row.id, origin: row.origin }]);

      return found;
    },

    async unshare(workspace, person) {
      await run((db) =>
        db.delete(site_shares).where(and(eq(site_shares.workspace_id, workspace), eq(site_shares.account_id, person))),
      );
    },

    async addSite(workspace, { origin, visibility, writers }) {
      // Adding the same address twice is the same site, with the visibility asked for last. It keeps
      // the destinations it had, so the statement that writes it reads them too. It keeps who writes
      // there too, unless the caller says (FRU-330): a console of before closes nothing.
      const rows = await run((db) => {
        const site = db.$with('site').as(
          db
            .insert(sites)
            .values({
              id: newId('site'),
              workspace_id: workspace,
              origin,
              visibility,
              writers: writers ?? DEFAULT_WRITERS,
              created_at: Date.now(),
            })
            .onConflictDoUpdate({
              target: [sites.workspace_id, sites.origin],
              set: {
                visibility: sql`excluded.visibility`,
                ...(writers === undefined ? {} : { writers }),
              },
            })
            .returning({
              id: sites.id,
              workspace_id: sites.workspace_id,
              origin: sites.origin,
              visibility: sites.visibility,
              writers: sites.writers,
            }),
        );

        return db
          .with(site)
          .select({
            id: site.id,
            workspace_id: site.workspace_id,
            origin: site.origin,
            visibility: site.visibility,
            writers: site.writers,
            connector_id: site_destinations.connector_id,
            team_id: site_destinations.team_id,
            project_id: site_destinations.project_id,
            label: site_destinations.label,
            private: site_destinations.private,
          })
          .from(site)
          .leftJoin(site_destinations, eq(site_destinations.site_id, site.id))
          .orderBy(site_destinations.position);
      });
      const site = sitesFrom(rows)[0];
      if (site === undefined) throw new StoreError('The site could not be read back');

      return site;
    },

    async sites(workspace) {
      const rows = await run((db) =>
        db
          .select(SITE_WITH_DESTINATION)
          .from(sites)
          .leftJoin(site_destinations, eq(site_destinations.site_id, sites.id))
          .where(eq(sites.workspace_id, workspace))
          .orderBy(sites.created_at, sites.id, site_destinations.position),
      );

      return sitesFrom(rows);
    },

    async removeSite(workspace, site) {
      const removed = await transaction(async (db) => {
        const rows = await db
          .delete(sites)
          .where(and(eq(sites.workspace_id, workspace), eq(sites.id, site)))
          .returning({ id: sites.id });
        await dropKeptNotes(
          db,
          workspace,
          rows.map((row) => row.id),
        );

        return rows;
      });

      return removed.length === 1;
    },

    async siteTrackerColours(workspace, site) {
      return run(async (db) => {
        const rows = await db
          .select({ on: sites.tracker_colours })
          .from(sites)
          .where(and(eq(sites.workspace_id, workspace), eq(sites.id, site)));

        return rows[0]?.on;
      });
    },

    async setSiteTrackerColours(workspace, site, on) {
      return run(async (db) => {
        const set = await db
          .update(sites)
          .set({ tracker_colours: on })
          .where(and(eq(sites.workspace_id, workspace), eq(sites.id, site)))
          .returning({ id: sites.id });

        return set.length === 1;
      });
    },

    async siteStatuses(workspace, site) {
      return run(async (db) => {
        const owned = await db
          .select({ id: sites.id })
          .from(sites)
          .where(and(eq(sites.workspace_id, workspace), eq(sites.id, site)));
        if (owned.length === 0) return undefined;
        const rows = await db
          .select()
          .from(statuses)
          .where(eq(statuses.site_id, site))
          .orderBy(asc(statuses.position), asc(statuses.source), asc(statuses.key));

        return rows.map(siteStatusOf);
      });
    },

    async putSiteStatus(workspace, site, status) {
      return transaction(async (db) => {
        if (!(await siteHeld(db, workspace, site))) return { saved: false as const, reason: 'not-found' as const };
        const there = await db
          .select({ key: statuses.key, source: statuses.source })
          .from(statuses)
          .where(eq(statuses.site_id, site));
        const known = there.some((row) => row.source === status.source && row.key === status.key);
        if (!known && there.length >= MAX_STATUSES) return { saved: false as const, reason: 'too-many' as const };

        const values = {
          name: status.name,
          stage: status.stage,
          color: status.color,
          text_color: status.textColor,
          position: status.position,
          hidden: status.hidden,
        };
        await db
          .insert(statuses)
          .values({ site_id: site, source: status.source, key: status.key, origin: status.origin, ...values })
          .onConflictDoUpdate({ target: [statuses.site_id, statuses.source, statuses.key], set: values });
        // The notes of a status the team added follow its stage: `statusOf` draws a note by its status
        // only when the two agree, and a note's stage is what every reader without the list draws.
        let pages: string[] = [];
        if (status.source === OWN_SOURCE && !isBuiltIn(status.source, status.key)) {
          const now = Date.now();
          const moved = await db
            .update(seeds)
            .set({ stage: status.stage, updated_at: now })
            .where(and(eq(seeds.client_id, site), eq(seeds.status_key, status.key), ne(seeds.stage, status.stage)))
            .returning({ id: seeds.id, page: seeds.page_url });
          pages = moved.map((row) => row.page);
          await restageIndex(
            db,
            site,
            moved.map((row) => row.id),
            status.stage,
            now,
          );
        }

        return { saved: true as const, pages };
      });
    },

    async orderSiteStatuses(workspace, site, order) {
      try {
        return await transaction(async (db) => {
          if (!(await siteHeld(db, workspace, site))) return 'not-found' as const;
          for (const [position, { source, key }] of order.entries()) {
            const moved = await db
              .update(statuses)
              .set({ position })
              .where(and(eq(statuses.site_id, site), eq(statuses.source, source), eq(statuses.key, key)))
              .returning({ key: statuses.key });
            if (moved.length !== 1) throw new RolledBack();
          }

          return 'saved' as const;
        });
      } catch (error) {
        if (error instanceof RolledBack) return 'unknown-status';
        throw error;
      }
    },

    async removeSiteStatus(workspace, site, { source, key }, moveTo) {
      return transaction(async (db) => {
        const missing = { removed: false as const, reason: 'not-found' as const };
        if (!(await siteHeld(db, workspace, site))) return missing;
        const which = and(eq(statuses.site_id, site), eq(statuses.source, source), eq(statuses.key, key));
        const row = (await db.select({ key: statuses.key }).from(statuses).where(which))[0];
        if (row === undefined) return missing;

        let moved = 0;
        let pages: string[] = [];
        // Only a status the team added to the worker's store holds notes of its own.
        if (source === OWN_SOURCE && !isBuiltIn(source, key)) {
          let target: { key: string | null; stage: string } | undefined;
          if (moveTo !== undefined && moveTo !== key) {
            if (isBuiltIn(OWN_SOURCE, moveTo)) {
              // NULL is the built-in status of the note's stage.
              target = { key: null, stage: moveTo };
            } else {
              const other = (
                await db
                  .select({ stage: statuses.stage })
                  .from(statuses)
                  .where(and(eq(statuses.site_id, site), eq(statuses.source, OWN_SOURCE), eq(statuses.key, moveTo)))
              )[0];
              if (other !== undefined) target = { key: moveTo, stage: other.stage };
            }
          }
          if (moveTo !== undefined && target === undefined) {
            return { removed: false as const, reason: 'invalid-target' as const };
          }
          const held = and(eq(seeds.client_id, site), eq(seeds.status_key, key));
          if (target === undefined) {
            const [counted] = await db.select({ notes: count() }).from(seeds).where(held);
            const notes = Number(counted?.notes ?? 0);
            if (notes > 0) return { removed: false as const, reason: 'in-use' as const, notes };
          } else {
            const now = Date.now();
            const changed = await db
              .update(seeds)
              .set({ status_key: target.key, stage: target.stage, updated_at: now })
              .where(held)
              .returning({ id: seeds.id, page: seeds.page_url });
            moved = changed.length;
            pages = changed.map((row) => row.page);
            await restageIndex(
              db,
              site,
              changed.map((row) => row.id),
              target.stage,
              now,
            );
          }
        } else if (moveTo !== undefined) {
          return { removed: false as const, reason: 'invalid-target' as const };
        }
        await db.delete(statuses).where(which);

        return { removed: true as const, moved, pages };
      });
    },

    async setNoteStatus(workspace, site, seed, key, who) {
      return transaction(async (db) => {
        const refused = <R extends string>(reason: R) => ({ set: false as const, reason });
        // The site, for update: the same lock as a status added, moved or removed (FRU-366), so the
        // status read below is the one written.
        if (!(await siteHeld(db, workspace, site))) return refused('not-found');
        const [note] = await db
          .select({
            place: note_index.place,
            connectorKind: connectors.kind,
            reference: note_index.reference,
            author: note_index.author_account_id,
          })
          .from(note_index)
          .leftJoin(connectors, eq(connectors.id, note_index.connector_id))
          .where(
            and(eq(note_index.workspace_id, workspace), eq(note_index.site_id, site), eq(note_index.seed_id, seed)),
          );
        if (note === undefined) return refused('not-found');
        // The author as the index keeps it, the one the route of the extension reads too (FRU-367).
        if (!who.manages && (note.author === null || note.author !== who.account)) return refused('not-allowed');
        // In Fruitback, or sent on to an address: the worker keeps it, as `FB-<id>` (FRU-237).
        const id = keptRowOf(note.place, note.connectorKind, note.reference);
        if (id === undefined) return refused('not-kept');
        // That row, of this site, and this very note: a tracker can name an issue `FB-12` too.
        const [kept] = await db
          .select({ seed: seeds.seed })
          .from(seeds)
          .where(and(eq(seeds.id, id), eq(seeds.client_id, site)));
        if (kept === undefined || !isSameSeed(kept.seed, seed)) return refused('not-kept');

        const [row] = await db
          .select({ stage: statuses.stage, hidden: statuses.hidden })
          .from(statuses)
          .where(and(eq(statuses.site_id, site), eq(statuses.source, OWN_SOURCE), eq(statuses.key, key)));
        if (row?.hidden === true) return refused('status-hidden');
        // A built-in status writes no key: a note with none is in the built-in status of its stage.
        let chosen: { key: string | null; stage: SeedStage };
        if (isBuiltIn(OWN_SOURCE, key)) chosen = { key: null, stage: key as SeedStage };
        else if (row !== undefined) chosen = { key, stage: row.stage as SeedStage };
        else return refused('unknown-status');

        const now = Date.now();
        const [written] = await db
          .update(seeds)
          .set({ status_key: chosen.key, stage: chosen.stage, updated_at: now })
          .where(and(eq(seeds.id, id), eq(seeds.client_id, site)))
          .returning({ page: seeds.page_url });
        if (written === undefined) return refused('not-kept');
        await restageIndex(db, site, [id], chosen.stage, now);

        return { set: true as const, stage: chosen.stage, page: written.page };
      });
    },

    async noteRepositoryPrivacy(connector, repository, isPrivate) {
      await run((db) =>
        db
          .update(site_destinations)
          .set({ private: isPrivate })
          .where(
            and(
              eq(site_destinations.connector_id, connector),
              eq(site_destinations.team_id, repository),
              or(isNull(site_destinations.private), ne(site_destinations.private, isPrivate)),
            ),
          ),
      );
    },

    async addConnector(workspace, { kind, label, sealed }) {
      const id = newId('con');
      const now = Date.now();
      await run((db) =>
        db.insert(connectors).values({ id, workspace_id: workspace, kind, label, sealed, created_at: now }),
      );

      return {
        id,
        workspaceId: workspace,
        kind,
        label,
        createdAt: new Date(now).toISOString(),
        settings: DEFAULT_CONNECTOR_SETTINGS,
      };
    },

    async connectors(workspace) {
      const rows = await run((db) =>
        db
          .select({
            id: connectors.id,
            workspace_id: connectors.workspace_id,
            kind: connectors.kind,
            label: connectors.label,
            name: connectors.name,
            created_at: connectors.created_at,
            attention: connectors.attention,
            attention_at: connectors.attention_at,
            settings: connectors.settings,
          })
          .from(connectors)
          .where(eq(connectors.workspace_id, workspace))
          .orderBy(connectors.created_at, connectors.id),
      );

      return rows.flatMap((row) => connectorOf(row) ?? []);
    },

    async attachInstallation(workspace, { label, sealed, installation }) {
      given(installation, 'attachInstallation: installation');
      const id = newId('con');
      const now = Date.now();

      return transaction(async (db) => {
        // WARNING: the unique constraint decides, not a read before the write. Two callbacks at the same
        // moment for two workspaces make one connector.
        const insert = () =>
          db
            .insert(connectors)
            .values({ id, workspace_id: workspace, kind: 'github', label, sealed, created_at: now, installation })
            .onConflictDoNothing({ target: connectors.installation })
            .returning({ id: connectors.id });
        let made = await insert();
        if (made.length === 0) {
          // The connector that held the installation can be removed between the insert and this read.
          // Then the installation is free, and it is not « elsewhere »: insert again, once.
          const holders = await db
            .select({ id: connectors.id })
            .from(connectors)
            .where(eq(connectors.installation, installation));
          if (holders.length === 0) made = await insert();
        }
        if (made.length === 1) {
          const connector: Connector = {
            id,
            workspaceId: workspace,
            kind: 'github',
            label,
            createdAt: new Date(now).toISOString(),
            settings: DEFAULT_CONNECTOR_SETTINGS,
          };

          return { connector, created: true };
        }
        const [held] = await db
          .update(connectors)
          .set({ label, sealed })
          .where(
            and(
              eq(connectors.installation, installation),
              eq(connectors.workspace_id, workspace),
              eq(connectors.kind, 'github'),
            ),
          )
          .returning({
            id: connectors.id,
            workspace_id: connectors.workspace_id,
            kind: connectors.kind,
            label: connectors.label,
            name: connectors.name,
            created_at: connectors.created_at,
            attention: connectors.attention,
            attention_at: connectors.attention_at,
            settings: connectors.settings,
          });
        const connector = connectorOf(held);

        return connector === undefined ? undefined : { connector, created: false };
      });
    },

    async removeConnector(workspace, connector) {
      const removed = await run((db) =>
        db
          .delete(connectors)
          .where(and(eq(connectors.workspace_id, workspace), eq(connectors.id, connector)))
          .returning({ id: connectors.id }),
      );

      return removed.length === 1;
    },

    async resealConnector(connector, sealed) {
      given(connector, 'resealConnector: connector');
      given(sealed, 'resealConnector: sealed');
      await run((db) => db.update(connectors).set({ sealed }).where(eq(connectors.id, connector)));
    },

    async noteConnector(connector, trouble, now) {
      given(connector, 'noteConnector: connector');
      given(now, 'noteConnector: now');
      // `IS DISTINCT FROM` and not `<>`: NULL compares with nothing. A row that already says this is
      // not written again, so the first moment of a refusal stays, and a call that worked writes nothing.
      await run((db) =>
        db
          .update(connectors)
          .set({ attention: trouble ?? null, attention_at: trouble === undefined ? null : now })
          .where(and(eq(connectors.id, connector), sql`${connectors.attention} IS DISTINCT FROM ${trouble ?? null}`)),
      );
    },

    async setConnectorSettings(workspace, connector, settings) {
      const changed = await run((db) =>
        db
          .update(connectors)
          .set({ settings: JSON.stringify(settings) })
          .where(and(eq(connectors.workspace_id, workspace), eq(connectors.id, connector)))
          .returning({ id: connectors.id }),
      );

      return changed.length === 1;
    },

    async renameConnector(workspace, connector, name) {
      const changed = await run((db) =>
        db
          .update(connectors)
          .set({ name: name ?? null })
          .where(and(eq(connectors.workspace_id, workspace), eq(connectors.id, connector)))
          .returning({ id: connectors.id }),
      );

      return changed.length === 1;
    },

    async sealedKey(connector) {
      const row = (
        await run((db) =>
          db
            .select({
              id: connectors.id,
              workspace_id: connectors.workspace_id,
              kind: connectors.kind,
              label: connectors.label,
              sealed: connectors.sealed,
              created_at: connectors.created_at,
              settings: connectors.settings,
            })
            .from(connectors)
            .where(eq(connectors.id, connector)),
        )
      )[0];
      const known = connectorOf(row);
      if (known === undefined || row === undefined) return undefined;

      return { kind: known.kind, sealed: row.sealed, workspaceId: known.workspaceId, settings: known.settings };
    },

    async setDestination(workspace, site, destination) {
      return store.setDestinations(workspace, site, destination === undefined ? [] : [destination]);
    },

    async setDestinations(workspace, site, destinations) {
      return transaction(async (tx) => {
        // The lock puts two lists for one site one after the other. Without it the second removal
        // does not see the rows the first transaction wrote, and both write position 0.
        const owned = await tx
          .select({ id: sites.id })
          .from(sites)
          .where(and(eq(sites.id, site), eq(sites.workspace_id, workspace)))
          .for('update');
        if (owned.length !== 1) return false;

        // A site must not write through the key of another team: each connector is of this workspace.
        // `key share` keeps the connector until the end: a removal waits, then takes these rows.
        for (const connector of new Set(destinations.map((destination) => destination.connector))) {
          const ours = await tx
            .select({ id: connectors.id })
            .from(connectors)
            .where(and(eq(connectors.id, connector), eq(connectors.workspace_id, workspace)))
            .for('key share');
          if (ours.length !== 1) return false;
        }

        // One transaction: a reader never sees half of a list.
        await tx.delete(site_destinations).where(eq(site_destinations.site_id, site));
        for (const [position, destination] of destinations.entries()) {
          await tx.insert(site_destinations).values({
            site_id: site,
            position,
            connector_id: destination.connector,
            team_id: destination.teamId ?? null,
            project_id: destination.projectId ?? null,
            label: destination.label ?? null,
            private: destination.private ?? null,
          });
        }

        return true;
      });
    },

    async enqueueDelivery(connector, body, now) {
      const id = newId('dlv');
      await run((db) =>
        db.insert(deliveries).values({ id, connector_id: connector, body, created_at: now, next_at: now }),
      );

      return id;
    },

    async dueDeliveries(now, limit) {
      given(now, 'dueDeliveries: now');
      rowLimit(limit);
      const rows = await run((db) =>
        db
          .select({
            id: deliveries.id,
            connector_id: deliveries.connector_id,
            body: deliveries.body,
            attempts: deliveries.attempts,
          })
          .from(deliveries)
          .where(
            and(
              isNotNull(deliveries.next_at),
              lte(deliveries.next_at, now),
              // A delivery of a suspended workspace waits, and its count stays (FRU-282).
              notExists(
                db
                  .select({ id: connectors.id })
                  .from(connectors)
                  .innerJoin(workspace_suspensions, eq(workspace_suspensions.workspace_id, connectors.workspace_id))
                  .where(eq(connectors.id, deliveries.connector_id)),
              ),
            ),
          )
          .orderBy(deliveries.next_at, deliveries.created_at)
          .limit(limit),
      );

      return rows.flatMap((row) => dueDeliveryOf(row) ?? []);
    },

    async settleDelivery(id, outcome) {
      given(id, 'settleDelivery: id');
      if (outcome.delivered) {
        await run((db) => db.delete(deliveries).where(eq(deliveries.id, id)));

        return;
      }
      given(outcome.attempts, 'settleDelivery: outcome.attempts');
      given(outcome.at, 'settleDelivery: outcome.at');
      // The count in the condition: of two attempts that started from the same count, one writes.
      await run((db) =>
        db
          .update(deliveries)
          .set({
            attempts: sql`${deliveries.attempts} + 1`,
            next_at: outcome.nextAt ?? null,
            last_at: outcome.at,
            last_status: outcome.status ?? null,
            last_error: outcome.error ?? null,
          })
          .where(and(eq(deliveries.id, id), eq(deliveries.attempts, outcome.attempts))),
      );
    },

    async deliveries(workspace, connector) {
      const rows = await run((db) =>
        db
          .select({
            id: deliveries.id,
            created_at: deliveries.created_at,
            attempts: deliveries.attempts,
            next_at: deliveries.next_at,
            last_status: deliveries.last_status,
            last_error: deliveries.last_error,
          })
          .from(deliveries)
          .innerJoin(connectors, eq(connectors.id, deliveries.connector_id))
          .where(and(eq(connectors.workspace_id, workspace), eq(connectors.id, connector)))
          .orderBy(desc(deliveries.created_at), deliveries.id)
          .limit(100),
      );

      return rows.flatMap((row) => pendingDeliveryOf(row) ?? []);
    },

    async retryDelivery(workspace, connector, delivery, now) {
      given(workspace, 'retryDelivery: workspace');
      given(connector, 'retryDelivery: connector');
      given(delivery, 'retryDelivery: delivery');
      given(now, 'retryDelivery: now');
      // One statement: the delivery must be of a connector of this workspace. The count starts again:
      // somebody asked, so the delivery gets the whole series of attempts.
      const set = await run((db) =>
        db
          .update(deliveries)
          .set({ next_at: now, attempts: 0 })
          .where(
            and(
              eq(deliveries.id, delivery),
              eq(deliveries.connector_id, connector),
              exists(
                db
                  .select({ id: connectors.id })
                  .from(connectors)
                  .where(and(eq(connectors.id, connector), eq(connectors.workspace_id, workspace))),
              ),
            ),
          )
          .returning({ id: deliveries.id }),
      );

      return set.length === 1;
    },

    async dropAbandonedDeliveries(before) {
      given(before, 'dropAbandonedDeliveries: before');
      const dropped = await run((db) =>
        db
          .delete(deliveries)
          .where(
            and(isNull(deliveries.next_at), sql`COALESCE(${deliveries.last_at}, ${deliveries.created_at}) < ${before}`),
          )
          .returning({ id: deliveries.id }),
      );

      return dropped.length;
    },

    async deleteWorkspace(workspace) {
      await transaction((db) => dropWorkspace(db, workspace));
    },

    async addDomain(workspace, domain, now) {
      given(now, 'addDomain: now');
      const rows = await run(async (db) => {
        await db
          .insert(domains)
          .values({ id: newId('dom'), workspace_id: workspace, domain, created_at: now })
          .onConflictDoNothing({ target: [domains.workspace_id, domains.domain] });

        return db
          .select(DOMAIN)
          .from(domains)
          .where(and(eq(domains.workspace_id, workspace), eq(domains.domain, domain)));
      });
      const added = domainOf(rows[0]);
      if (added === undefined) throw new StoreError('The domain could not be read back');

      return added;
    },

    async domains(workspace) {
      const rows = await run((db) =>
        db
          .select(DOMAIN)
          .from(domains)
          .where(eq(domains.workspace_id, workspace))
          .orderBy(domains.created_at, domains.id),
      );

      return rows.flatMap((row) => domainOf(row) ?? []);
    },

    async removeDomain(workspace, domain) {
      const removed = await run((db) =>
        db
          .delete(domains)
          .where(and(eq(domains.workspace_id, workspace), eq(domains.id, domain)))
          .returning({ id: domains.id }),
      );

      return removed.length === 1;
    },

    async noteDomainCheck(domain, answer, now) {
      given(domain, 'noteDomainCheck: domain');
      given(now, 'noteDomainCheck: now');
      const changes = {
        found: { verified_at: now, lost_at: null, checked_at: now },
        missing: {
          // The first moment of a loss stays. A domain never proven has nothing to lose.
          lost_at: sql`CASE WHEN ${domains.verified_at} IS NOT NULL AND ${domains.lost_at} IS NULL THEN ${now}::bigint ELSE ${domains.lost_at} END`,
          checked_at: now,
        },
        unknown: { checked_at: now },
      };
      await run((db) => db.update(domains).set(changes[answer]).where(eq(domains.id, domain)));
    },

    async domainsToCheck(before, limit) {
      given(before, 'domainsToCheck: before');
      rowLimit(limit);
      const rows = await run((db) =>
        db
          .select(DOMAIN)
          .from(domains)
          .where(and(isNotNull(domains.verified_at), or(isNull(domains.checked_at), lt(domains.checked_at, before))))
          // A proven domain was asked, so `checked_at` holds a number: no NULL to place.
          .orderBy(domains.checked_at, domains.id)
          .limit(limit),
      );

      return rows.flatMap((row) => domainOf(row) ?? []);
    },

    async setPreviews(workspace, domain, site) {
      // One statement: the site is checked in the statement that writes it, so no site of another
      // workspace is ever named, even by two calls at the same moment.
      const changed = await run((db) =>
        db
          .update(domains)
          .set({ previews_site_id: site ?? null })
          .where(
            and(
              eq(domains.workspace_id, workspace),
              eq(domains.id, domain),
              site === undefined
                ? undefined
                : exists(
                    db
                      .select({ id: sites.id })
                      .from(sites)
                      .where(and(eq(sites.workspace_id, workspace), eq(sites.id, site))),
                  ),
            ),
          )
          .returning({ id: domains.id }),
      );

      return changed.length === 1;
    },

    async clientMap() {
      // Every request reads this. The order of the sites is nothing to a map, and a sort of their ids
      // is what costs: only the places of one site have an order.
      const rows = await run((db) =>
        db
          .select(SITE_WITH_DESTINATION)
          .from(sites)
          .leftJoin(site_destinations, eq(site_destinations.site_id, sites.id))
          // A site of a suspended workspace is no client (FRU-282): it answers as a site that does not exist.
          .where(
            notExists(
              db
                .select({ id: workspace_suspensions.workspace_id })
                .from(workspace_suspensions)
                .where(eq(workspace_suspensions.workspace_id, sites.workspace_id)),
            ),
          )
          .orderBy(site_destinations.position),
      );
      const map: ClientMap = {};
      for (const site of sitesFrom(rows)) map[site.id] = clientOf(site);

      return map;
    },
  };

  return store;
}
