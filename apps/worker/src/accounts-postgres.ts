import {
  SITE_COLUMNS,
  accountOf,
  connectorOf,
  dueDeliveryOf,
  newId,
  pendingDeliveryOf,
  roleOf,
  siteOf,
  workspaceOf,
} from './account-rows.ts';
import { type AccountStore, clientOf, normalizeEmail } from './accounts.ts';
import type { ClientMap } from './clients.ts';
import type { Database } from './postgres.ts';
import { migrated } from './postgres-migrations.ts';
import { StoreError } from './store.ts';

/**
 * The accounts in PostgreSQL (FRU-141): the same interface as `accounts-sqlite.ts`, the same names of
 * tables and columns, the same ids. `account-conformance.test.ts` holds both to the same cases.
 *
 * **What SQLite did without saying it, written on purpose here.** A SQLite store is one connection
 * that does one thing at a time, so a read followed by a write was safe there. Here two requests
 * run on two connections:
 *
 * - `INSERT OR IGNORE` is `ON CONFLICT … DO NOTHING`, and it names the constraint it means.
 * - A new account is an `INSERT … ON CONFLICT (email) DO NOTHING` followed by a read. Two sign-ins of
 *   one new address at the same moment both find no account: the second insert waits for the first
 *   transaction, does nothing, and the read then answers the row of the first.
 * - `addSite` is one `INSERT … ON CONFLICT … DO UPDATE`, where SQLite read the site and then wrote it.
 * - `IS NOT ?` with a null is `IS DISTINCT FROM`: `<>` with a null is never true.
 * - A link is spent by one `UPDATE … RETURNING`: the row lock decides which of two calls changed it.
 * - An instant is a `BIGINT` of milliseconds that the worker gives. The database never reads its clock.
 */
export function createPostgresAccountStore(database: Database): AccountStore {
  /** The database, with its schema. The first call of a process applies the migrations. */
  const ready = async (): Promise<Database> => {
    await migrated(database);

    return database;
  };

  return {
    async signIn({ provider, subject, email, name, locale }) {
      const address = normalizeEmail(email);
      if (address === undefined) throw new StoreError('A sign-in needs a valid address');

      const now = Date.now();
      const given = name === undefined || name === '' ? null : name;

      return (await ready()).transaction(async (transaction) => {
        const known = await transaction.query(
          'SELECT account_id AS id FROM logins WHERE provider = $1 AND subject = $2',
          [provider, subject],
        );
        let id = known.rows[0]?.id;

        if (typeof id !== 'string') {
          // The same proven address from another provider is the same person: join, do not duplicate.
          await transaction.query(
            `INSERT INTO accounts (id, email, name, locale, created_at) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (email) DO NOTHING`,
            [newId('acc'), address, given, locale ?? null, now],
          );
          id = (await transaction.query('SELECT id FROM accounts WHERE email = $1', [address])).rows[0]?.id;
        }
        if (typeof id !== 'string') throw new StoreError('The account of a sign-in could not be read back');

        // Each one in its statement, with its condition: a value that somebody has is never written over.
        if (given !== null) {
          await transaction.query("UPDATE accounts SET name = $1 WHERE id = $2 AND (name IS NULL OR name = '')", [
            given,
            id,
          ]);
        }
        // Only when nobody chose: a sign-in from a borrowed browser must not change the language.
        if (locale !== undefined) {
          await transaction.query("UPDATE accounts SET locale = $1 WHERE id = $2 AND (locale IS NULL OR locale = '')", [
            locale,
            id,
          ]);
        }
        await transaction.query(
          `INSERT INTO logins (provider, subject, account_id, created_at) VALUES ($1, $2, $3, $4)
           ON CONFLICT (provider, subject) DO NOTHING`,
          [provider, subject, id, now],
        );

        const account = accountOf(
          (await transaction.query('SELECT id, email, name, locale FROM accounts WHERE id = $1', [id])).rows[0],
        );
        if (account === undefined) throw new StoreError('The account of a sign-in could not be read back');

        return account;
      });
    },

    async setLocale(account, locale) {
      await (await ready()).query('UPDATE accounts SET locale = $1 WHERE id = $2', [locale ?? null, account]);
    },

    async localeOf(email) {
      const address = normalizeEmail(email);
      if (address === undefined) return undefined;
      const row = (await (await ready()).query('SELECT locale FROM accounts WHERE email = $1', [address])).rows[0];

      return typeof row?.locale === 'string' && row.locale !== '' ? row.locale : undefined;
    },

    async account(id) {
      return accountOf(
        (await (await ready()).query('SELECT id, email, name, locale FROM accounts WHERE id = $1', [id])).rows[0],
      );
    },

    async createWorkspace(name, owner) {
      const workspace = { id: newId('ws'), name: name.trim() };
      const now = Date.now();

      await (
        await ready()
      ).transaction(async (transaction) => {
        await transaction.query('INSERT INTO workspaces (id, name, created_at) VALUES ($1, $2, $3)', [
          workspace.id,
          workspace.name,
          now,
        ]);
        await transaction.query(
          'INSERT INTO members (workspace_id, account_id, role, created_at) VALUES ($1, $2, $3, $4)',
          [workspace.id, owner, 'owner', now],
        );
      });

      return workspace;
    },

    async memberships(account) {
      const { rows } = await (
        await ready()
      ).query(
        `SELECT w.id, w.name, m.role FROM members m JOIN workspaces w ON w.id = m.workspace_id
         WHERE m.account_id = $1 ORDER BY m.created_at, w.id`,
        [account],
      );

      return rows.flatMap((row) => {
        const workspace = workspaceOf(row);
        const role = roleOf(row.role);

        return workspace === undefined || role === undefined ? [] : [{ workspace, role }];
      });
    },

    async role(workspace, account) {
      const { rows } = await (
        await ready()
      ).query('SELECT role FROM members WHERE workspace_id = $1 AND account_id = $2', [workspace, account]);

      return roleOf(rows[0]?.role);
    },

    async addSite(workspace, { origin, visibility }) {
      // Adding the same address twice is the same site, with the visibility asked for last.
      const { rows } = await (
        await ready()
      ).query(
        `INSERT INTO sites (id, workspace_id, origin, visibility, created_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (workspace_id, origin) DO UPDATE SET visibility = EXCLUDED.visibility
         RETURNING ${SITE_COLUMNS}`,
        [newId('site'), workspace, origin, visibility, Date.now()],
      );
      const site = rows[0] === undefined ? undefined : siteOf(rows[0]);
      if (site === undefined) throw new StoreError('The site could not be read back');

      return site;
    },

    async sites(workspace) {
      const { rows } = await (
        await ready()
      ).query(`SELECT ${SITE_COLUMNS} FROM sites WHERE workspace_id = $1 ORDER BY created_at, id`, [workspace]);

      return rows.flatMap((row) => siteOf(row) ?? []);
    },

    async removeSite(workspace, site) {
      const removed = await (
        await ready()
      ).query('DELETE FROM sites WHERE workspace_id = $1 AND id = $2', [workspace, site]);

      return removed.rowCount === 1;
    },

    async addConnector(workspace, { kind, label, sealed }) {
      const id = newId('con');
      const now = Date.now();
      await (
        await ready()
      ).query(
        'INSERT INTO connectors (id, workspace_id, kind, label, sealed, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, workspace, kind, label, sealed, now],
      );

      return { id, workspaceId: workspace, kind, label, createdAt: new Date(now).toISOString() };
    },

    async connectors(workspace) {
      const { rows } = await (
        await ready()
      ).query(
        `SELECT id, workspace_id, kind, label, created_at, attention, attention_at
         FROM connectors WHERE workspace_id = $1 ORDER BY created_at, id`,
        [workspace],
      );

      return rows.flatMap((row) => connectorOf(row) ?? []);
    },

    async removeConnector(workspace, connector) {
      const removed = await (
        await ready()
      ).query('DELETE FROM connectors WHERE workspace_id = $1 AND id = $2', [workspace, connector]);

      return removed.rowCount === 1;
    },

    async resealConnector(connector, sealed) {
      await (await ready()).query('UPDATE connectors SET sealed = $1 WHERE id = $2', [sealed, connector]);
    },

    async noteConnector(connector, trouble, now) {
      // `IS DISTINCT FROM` and not `<>`: NULL compares with nothing. A row that already says this is
      // not written again, so the first moment of a refusal stays, and a call that worked writes nothing.
      await (
        await ready()
      ).query(
        'UPDATE connectors SET attention = $1, attention_at = $2 WHERE id = $3 AND attention IS DISTINCT FROM $1',
        [trouble ?? null, trouble === undefined ? null : now, connector],
      );
    },

    async sealedKey(connector) {
      const row = (
        await (
          await ready()
        ).query('SELECT id, workspace_id, kind, label, sealed, created_at FROM connectors WHERE id = $1', [connector])
      ).rows[0];
      const known = connectorOf(row);
      if (known === undefined || typeof row?.sealed !== 'string') return undefined;

      return { kind: known.kind, sealed: row.sealed, workspaceId: known.workspaceId };
    },

    async setDestination(workspace, site, destination) {
      const db = await ready();
      if (destination === undefined) {
        const cleared = await db.query(
          'UPDATE sites SET connector_id = NULL, team_id = NULL, project_id = NULL WHERE workspace_id = $1 AND id = $2',
          [workspace, site],
        );

        return cleared.rowCount === 1;
      }

      // One statement: the connector must be of the same workspace as the site.
      const set = await db.query(
        `UPDATE sites SET connector_id = $1, team_id = $2, project_id = $3
         WHERE workspace_id = $4 AND id = $5
           AND EXISTS (SELECT 1 FROM connectors WHERE id = $1 AND workspace_id = $4)`,
        [destination.connector, destination.teamId ?? null, destination.projectId ?? null, workspace, site],
      );

      return set.rowCount === 1;
    },

    async enqueueDelivery(connector, body, now) {
      const id = newId('dlv');
      await (
        await ready()
      ).query('INSERT INTO deliveries (id, connector_id, body, created_at, next_at) VALUES ($1, $2, $3, $4, $4)', [
        id,
        connector,
        body,
        now,
      ]);

      return id;
    },

    async dueDeliveries(now, limit) {
      const { rows } = await (
        await ready()
      ).query(
        `SELECT id, connector_id, body, attempts FROM deliveries
         WHERE next_at IS NOT NULL AND next_at <= $1 ORDER BY next_at, created_at LIMIT $2`,
        [now, limit],
      );

      return rows.flatMap((row) => dueDeliveryOf(row) ?? []);
    },

    async settleDelivery(id, outcome) {
      const db = await ready();
      if (outcome.delivered) {
        await db.query('DELETE FROM deliveries WHERE id = $1', [id]);

        return;
      }
      // The count in the condition: of two attempts that started from the same count, one writes.
      await db.query(
        `UPDATE deliveries SET attempts = attempts + 1, next_at = $1, last_at = $2, last_status = $3, last_error = $4
         WHERE id = $5 AND attempts = $6`,
        [outcome.nextAt ?? null, outcome.at, outcome.status ?? null, outcome.error ?? null, id, outcome.attempts],
      );
    },

    async deliveries(workspace, connector) {
      const { rows } = await (
        await ready()
      ).query(
        `SELECT d.id, d.created_at, d.attempts, d.next_at, d.last_status, d.last_error
         FROM deliveries d JOIN connectors c ON c.id = d.connector_id
         WHERE c.workspace_id = $1 AND c.id = $2 ORDER BY d.created_at DESC, d.id LIMIT 100`,
        [workspace, connector],
      );

      return rows.flatMap((row) => pendingDeliveryOf(row) ?? []);
    },

    async retryDelivery(workspace, connector, delivery, now) {
      // One statement: the delivery must be of a connector of this workspace. The count starts again:
      // somebody asked, so the delivery gets the whole series of attempts.
      const set = await (
        await ready()
      ).query(
        `UPDATE deliveries SET next_at = $1, attempts = 0
         WHERE id = $2 AND connector_id = $3
           AND EXISTS (SELECT 1 FROM connectors WHERE id = $3 AND workspace_id = $4)`,
        [now, delivery, connector, workspace],
      );

      return set.rowCount === 1;
    },

    async dropAbandonedDeliveries(before) {
      const dropped = await (
        await ready()
      ).query('DELETE FROM deliveries WHERE next_at IS NULL AND COALESCE(last_at, created_at) < $1', [before]);

      return dropped.rowCount;
    },

    async deleteWorkspace(workspace) {
      // The foreign keys take its members, its sites, its connectors and their deliveries with it.
      await (await ready()).query('DELETE FROM workspaces WHERE id = $1', [workspace]);
    },

    async createEmailLink({ codeHash, email, expiresAt }) {
      const db = await ready();
      const now = Date.now();
      // Old links go when a new one is made, so the table holds what can still be spent.
      await db.query('DELETE FROM email_links WHERE expires_at <= $1 OR spent_at IS NOT NULL', [now]);
      await db.query('INSERT INTO email_links (code_hash, email, created_at, expires_at) VALUES ($1, $2, $3, $4)', [
        codeHash,
        email,
        now,
        expiresAt,
      ]);
    },

    async spendEmailLink(codeHash, now) {
      // One statement decides who spent it: two tabs that open the same link get one sign-in. The
      // second `UPDATE` waits for the row, reads `spent_at` again, and changes nothing.
      const { rows } = await (
        await ready()
      ).query(
        `UPDATE email_links SET spent_at = $1
         WHERE code_hash = $2 AND spent_at IS NULL AND expires_at > $1 RETURNING email`,
        [now, codeHash],
      );
      const email = rows[0]?.email;

      return typeof email === 'string' ? email : undefined;
    },

    async clientMap() {
      const { rows } = await (await ready()).query(`SELECT ${SITE_COLUMNS} FROM sites`);
      const map: ClientMap = {};
      for (const row of rows) {
        const site = siteOf(row);
        if (site !== undefined) map[site.id] = clientOf(site);
      }

      return map;
    },
  };
}
