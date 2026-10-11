import { and, desc, eq, exists, gt, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import {
  accountOf,
  connectorOf,
  destinationOf,
  dueDeliveryOf,
  newId,
  pendingDeliveryOf,
  roleOf,
  siteOf,
  workspaceOf,
} from './account-rows.ts';
import { type AccountStore, type Site, clientOf, normalizeEmail } from './accounts.ts';
import type { ClientMap } from './clients.ts';
import type { Database, Db } from './postgres.ts';
import { migrated } from './postgres-migrate.ts';
import {
  accounts,
  connectors,
  deliveries,
  email_links,
  logins,
  members,
  site_destinations,
  sites,
  workspaces,
} from './postgres-schema.ts';
import { StoreError } from './store.ts';

/**
 * The accounts in PostgreSQL (FRU-141): the same interface as `accounts-sqlite.ts`, the same names of
 * tables and columns, the same ids. `account-conformance.test.ts` holds both to the same cases.
 *
 * The statements are written with Drizzle (FRU-180), on the tables of `postgres-schema.ts`. A row has
 * the keys of its columns, so `account-rows.ts` parses it as it parses a row of SQLite.
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
const SITE_WITH_DESTINATION = {
  id: sites.id,
  workspace_id: sites.workspace_id,
  origin: sites.origin,
  visibility: sites.visibility,
  connector_id: site_destinations.connector_id,
  team_id: site_destinations.team_id,
  project_id: site_destinations.project_id,
  label: site_destinations.label,
};

const ACCOUNT = { id: accounts.id, email: accounts.email, name: accounts.name, locale: accounts.locale };

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

      const now = Date.now();
      const given = name === undefined || name === '' ? null : name;

      return transaction(async (tx) => {
        const known = await tx
          .select({ id: logins.account_id })
          .from(logins)
          .where(and(eq(logins.provider, provider), eq(logins.subject, subject)));
        let id = known[0]?.id;

        if (id === undefined) {
          // The same proven address from another provider is the same person: join, do not duplicate.
          await tx
            .insert(accounts)
            .values({ id: newId('acc'), email: address, name: given, locale: locale ?? null, created_at: now })
            .onConflictDoNothing({ target: accounts.email });
          id = (await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.email, address)))[0]?.id;
        }
        if (id === undefined) throw new StoreError('The account of a sign-in could not be read back');

        // Each one in its statement, with its condition: a value that somebody has is never written over.
        if (given !== null) {
          await tx
            .update(accounts)
            .set({ name: given })
            .where(and(eq(accounts.id, id), or(isNull(accounts.name), eq(accounts.name, ''))));
        }
        // Only when nobody chose: a sign-in from a borrowed browser must not change the language.
        if (locale !== undefined) {
          await tx
            .update(accounts)
            .set({ locale })
            .where(and(eq(accounts.id, id), or(isNull(accounts.locale), eq(accounts.locale, ''))));
        }
        await tx
          .insert(logins)
          .values({ provider, subject, account_id: id, created_at: now })
          .onConflictDoNothing({ target: [logins.provider, logins.subject] });

        const account = accountOf((await tx.select(ACCOUNT).from(accounts).where(eq(accounts.id, id)))[0]);
        if (account === undefined) throw new StoreError('The account of a sign-in could not be read back');

        return account;
      });
    },

    async setLocale(account, locale) {
      await run((db) =>
        db
          .update(accounts)
          .set({ locale: locale ?? null })
          .where(eq(accounts.id, account)),
      );
    },

    async localeOf(email) {
      const address = normalizeEmail(email);
      if (address === undefined) return undefined;
      const rows = await run((db) =>
        db.select({ locale: accounts.locale }).from(accounts).where(eq(accounts.email, address)),
      );
      const locale = rows[0]?.locale;

      return typeof locale === 'string' && locale !== '' ? locale : undefined;
    },

    async account(id) {
      return accountOf((await run((db) => db.select(ACCOUNT).from(accounts).where(eq(accounts.id, id))))[0]);
    },

    async createWorkspace(name, owner) {
      const workspace = { id: newId('ws'), name: name.trim() };
      const now = Date.now();

      await transaction(async (tx) => {
        await tx.insert(workspaces).values({ id: workspace.id, name: workspace.name, created_at: now });
        await tx
          .insert(members)
          .values({ workspace_id: workspace.id, account_id: owner, role: 'owner', created_at: now });
      });

      return workspace;
    },

    async memberships(account) {
      const rows = await run((db) =>
        db
          .select({ id: workspaces.id, name: workspaces.name, role: members.role })
          .from(members)
          .innerJoin(workspaces, eq(workspaces.id, members.workspace_id))
          .where(eq(members.account_id, account))
          .orderBy(members.created_at, workspaces.id),
      );

      return rows.flatMap((row) => {
        const workspace = workspaceOf(row);
        const role = roleOf(row.role);

        return workspace === undefined || role === undefined ? [] : [{ workspace, role }];
      });
    },

    async role(workspace, account) {
      const rows = await run((db) =>
        db
          .select({ role: members.role })
          .from(members)
          .where(and(eq(members.workspace_id, workspace), eq(members.account_id, account))),
      );

      return roleOf(rows[0]?.role);
    },

    async addSite(workspace, { origin, visibility }) {
      // Adding the same address twice is the same site, with the visibility asked for last. It keeps
      // the destinations it had, so the statement that writes it reads them too.
      const rows = await run((db) => {
        const site = db.$with('site').as(
          db
            .insert(sites)
            .values({ id: newId('site'), workspace_id: workspace, origin, visibility, created_at: Date.now() })
            .onConflictDoUpdate({
              target: [sites.workspace_id, sites.origin],
              set: { visibility: sql`excluded.visibility` },
            })
            .returning({
              id: sites.id,
              workspace_id: sites.workspace_id,
              origin: sites.origin,
              visibility: sites.visibility,
            }),
        );

        return db
          .with(site)
          .select({
            id: site.id,
            workspace_id: site.workspace_id,
            origin: site.origin,
            visibility: site.visibility,
            connector_id: site_destinations.connector_id,
            team_id: site_destinations.team_id,
            project_id: site_destinations.project_id,
            label: site_destinations.label,
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
      const removed = await run((db) =>
        db
          .delete(sites)
          .where(and(eq(sites.workspace_id, workspace), eq(sites.id, site)))
          .returning({ id: sites.id }),
      );

      return removed.length === 1;
    },

    async addConnector(workspace, { kind, label, sealed }) {
      const id = newId('con');
      const now = Date.now();
      await run((db) =>
        db.insert(connectors).values({ id, workspace_id: workspace, kind, label, sealed, created_at: now }),
      );

      return { id, workspaceId: workspace, kind, label, createdAt: new Date(now).toISOString() };
    },

    async connectors(workspace) {
      const rows = await run((db) =>
        db
          .select({
            id: connectors.id,
            workspace_id: connectors.workspace_id,
            kind: connectors.kind,
            label: connectors.label,
            created_at: connectors.created_at,
            attention: connectors.attention,
            attention_at: connectors.attention_at,
          })
          .from(connectors)
          .where(eq(connectors.workspace_id, workspace))
          .orderBy(connectors.created_at, connectors.id),
      );

      return rows.flatMap((row) => connectorOf(row) ?? []);
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
            })
            .from(connectors)
            .where(eq(connectors.id, connector)),
        )
      )[0];
      const known = connectorOf(row);
      if (known === undefined || row === undefined) return undefined;

      return { kind: known.kind, sealed: row.sealed, workspaceId: known.workspaceId };
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
          .where(and(isNotNull(deliveries.next_at), lte(deliveries.next_at, now)))
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
      // The foreign keys take its members, its sites and their destinations, its connectors and their
      // deliveries with it.
      await run((db) => db.delete(workspaces).where(eq(workspaces.id, workspace)));
    },

    async createEmailLink({ codeHash, email, expiresAt }) {
      const now = Date.now();
      // Old links go when a new one is made, so the table holds what can still be spent.
      await run((db) =>
        db.delete(email_links).where(or(lte(email_links.expires_at, now), isNotNull(email_links.spent_at))),
      );
      await run((db) =>
        db.insert(email_links).values({ code_hash: codeHash, email, created_at: now, expires_at: expiresAt }),
      );
    },

    async spendEmailLink(codeHash, now) {
      given(codeHash, 'spendEmailLink: codeHash');
      given(now, 'spendEmailLink: now');
      // One statement decides who spent it: two tabs that open the same link get one sign-in. The
      // second update waits for the row, reads `spent_at` again, and changes nothing.
      const rows = await run((db) =>
        db
          .update(email_links)
          .set({ spent_at: now })
          .where(
            and(eq(email_links.code_hash, codeHash), isNull(email_links.spent_at), gt(email_links.expires_at, now)),
          )
          .returning({ email: email_links.email }),
      );

      return rows[0]?.email;
    },

    async clientMap() {
      // Every request reads this. The order of the sites is nothing to a map, and a sort of their ids
      // is what costs: only the places of one site have an order.
      const rows = await run((db) =>
        db
          .select(SITE_WITH_DESTINATION)
          .from(sites)
          .leftJoin(site_destinations, eq(site_destinations.site_id, sites.id))
          .orderBy(site_destinations.position),
      );
      const map: ClientMap = {};
      for (const site of sitesFrom(rows)) map[site.id] = clientOf(site);

      return map;
    },
  };

  return store;
}
