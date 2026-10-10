import { DatabaseSync } from 'node:sqlite';
import {
  accountOf,
  connectorOf,
  dueDeliveryOf,
  newId,
  pendingDeliveryOf,
  roleOf,
  siteOf,
  SITE_COLUMNS,
  workspaceOf,
} from './account-rows.ts';
import { type Account, type AccountStore, type Site, clientOf, normalizeEmail } from './accounts.ts';
import type { ClientMap } from './clients.ts';
import { StoreError } from './store.ts';

/**
 * Where the accounts live (FRU-96): its own file, for the reason `session-sqlite.ts` gives.
 *
 * `sqlite.ts` drives `PRAGMA user_version` with the migrations of the seeds, and `session-sqlite.ts`
 * with those of the sessions. A third schema in one of those files would fight over its counter. An
 * account is also not a credential: the session file can be lost and every reviewer pairs again,
 * but this file holds who owns which workspace.
 */

/** Append; never edit an entry that has shipped. */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE logins (
    provider TEXT NOT NULL,
    subject TEXT NOT NULL,
    account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (provider, subject)
  );

  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE members (
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, account_id)
  );

  CREATE INDEX members_by_account ON members (account_id);

  CREATE TABLE sites (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    origin TEXT NOT NULL,
    visibility TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (workspace_id, origin)
  );
  `,
  // The sign-in links (FRU-98). A digest, like a pairing code: a copy of the file is not a way in.
  `
  CREATE TABLE email_links (
    code_hash TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    spent_at INTEGER
  );
  `,
  // The language a person reads (FRU-119). Absent means nobody chose: the sender's default applies.
  `
  ALTER TABLE accounts ADD COLUMN locale TEXT;
  `,
  // The connectors of a workspace, and where each site sends its notes (FRU-121). `sealed` is the
  // key encrypted with FRUITBACK_SECRETS_KEY: a copy of this file is not a set of working keys.
  `
  CREATE TABLE connectors (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    sealed TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX connectors_by_workspace ON connectors (workspace_id);

  ALTER TABLE sites ADD COLUMN connector_id TEXT REFERENCES connectors (id) ON DELETE SET NULL;
  ALTER TABLE sites ADD COLUMN team_id TEXT;
  ALTER TABLE sites ADD COLUMN project_id TEXT;
  `,
  // The notes to send to an address a workspace connected (FRU-122). `body` is the request as it is
  // sent. A row goes when its note arrived, so the table holds what is late or was given up.
  // `next_at` NULL: the worker gave up, and the console offers a new attempt.
  `
  CREATE TABLE deliveries (
    id TEXT PRIMARY KEY,
    connector_id TEXT NOT NULL REFERENCES connectors (id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER,
    last_at INTEGER,
    last_status INTEGER,
    last_error TEXT
  );

  CREATE INDEX deliveries_due ON deliveries (next_at);
  CREATE INDEX deliveries_by_connector ON deliveries (connector_id);
  `,
  // What the tracker last said of a connector (FRU-102). `attention` NULL: its last answer was not a
  // refusal. `attention_at` is the first refusal of that kind.
  `
  ALTER TABLE connectors ADD COLUMN attention TEXT;
  ALTER TABLE connectors ADD COLUMN attention_at INTEGER;
  `,
];

const connections = new Map<string, DatabaseSync>();

function connect(path: string): DatabaseSync {
  const open = connections.get(path);
  if (open !== undefined) return open;

  let database: DatabaseSync;
  try {
    database = new DatabaseSync(path);
  } catch (error) {
    throw new StoreError(`Account store could not open ${path}: ${String(error)}`);
  }

  try {
    database.exec('PRAGMA journal_mode = WAL');
    // Deleting a workspace removes its members and its sites through the cascade. `node:sqlite`
    // turns this on by default, and it is written anyway: the cascade is the rule, not a default.
    database.exec('PRAGMA foreign_keys = ON');
    migrate(database);
  } catch (error) {
    database.close();
    throw new StoreError(`Account store could not initialise ${path}: ${String(error)}`);
  }

  connections.set(path, database);

  return database;
}

function migrate(database: DatabaseSync): void {
  const row = database.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  const version = row?.user_version ?? 0;

  for (let index = version; index < MIGRATIONS.length; index += 1) {
    database.exec('BEGIN');
    try {
      database.exec(MIGRATIONS[index] as string);
      database.exec(`PRAGMA user_version = ${index + 1}`);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}

export function closeAccountConnections(): void {
  for (const database of connections.values()) database.close();
  connections.clear();
}

export function createSqliteAccountStore(path: string): AccountStore {
  return {
    async signIn({ provider, subject, email, name, locale }) {
      const address = normalizeEmail(email);
      if (address === undefined) throw new StoreError('A sign-in needs a valid address');

      const database = connect(path);
      const now = Date.now();

      database.exec('BEGIN IMMEDIATE');
      try {
        const known = database
          .prepare(
            'SELECT a.id, a.email, a.name, a.locale FROM logins l JOIN accounts a ON a.id = l.account_id WHERE l.provider = ? AND l.subject = ?',
          )
          .get(provider, subject) as Record<string, unknown> | undefined;
        let account = accountOf(known);

        // The same proven address from another provider is the same person: join, do not duplicate.
        account ??= accountOf(
          database.prepare('SELECT id, email, name, locale FROM accounts WHERE email = ?').get(address) as
            | Record<string, unknown>
            | undefined,
        );

        if (account === undefined) {
          account = {
            id: newId('acc'),
            email: address,
            ...(name === undefined || name === '' ? {} : { name }),
            ...(locale === undefined ? {} : { locale }),
          };
          database
            .prepare('INSERT INTO accounts (id, email, name, locale, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(account.id, account.email, account.name ?? null, account.locale ?? null, now);
        } else {
          if (account.name === undefined && name !== undefined && name !== '') {
            database.prepare('UPDATE accounts SET name = ? WHERE id = ?').run(name, account.id);
            account = { ...account, name };
          }
          // Only when nobody chose: a sign-in from a borrowed browser must not change the language.
          if (account.locale === undefined && locale !== undefined) {
            database.prepare('UPDATE accounts SET locale = ? WHERE id = ?').run(locale, account.id);
            account = { ...account, locale };
          }
        }

        database
          .prepare('INSERT OR IGNORE INTO logins (provider, subject, account_id, created_at) VALUES (?, ?, ?, ?)')
          .run(provider, subject, account.id, now);
        database.exec('COMMIT');

        return account;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },

    async setLocale(account, locale) {
      connect(path)
        .prepare('UPDATE accounts SET locale = ? WHERE id = ?')
        .run(locale ?? null, account);
    },

    async localeOf(email) {
      const address = normalizeEmail(email);
      if (address === undefined) return undefined;
      const row = connect(path).prepare('SELECT locale FROM accounts WHERE email = ?').get(address) as
        | { locale: unknown }
        | undefined;

      return typeof row?.locale === 'string' && row.locale !== '' ? row.locale : undefined;
    },

    async account(id) {
      return accountOf(
        connect(path).prepare('SELECT id, email, name, locale FROM accounts WHERE id = ?').get(id) as
          | Record<string, unknown>
          | undefined,
      );
    },

    async createWorkspace(name, owner) {
      const database = connect(path);
      const workspace = { id: newId('ws'), name: name.trim() };
      const now = Date.now();

      database.exec('BEGIN IMMEDIATE');
      try {
        database
          .prepare('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)')
          .run(workspace.id, workspace.name, now);
        database
          .prepare('INSERT INTO members (workspace_id, account_id, role, created_at) VALUES (?, ?, ?, ?)')
          .run(workspace.id, owner, 'owner', now);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }

      return workspace;
    },

    async memberships(account) {
      const rows = connect(path)
        .prepare(
          'SELECT w.id, w.name, m.role FROM members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.account_id = ? ORDER BY m.created_at, w.id',
        )
        .all(account) as Record<string, unknown>[];

      return rows.flatMap((row) => {
        const workspace = workspaceOf(row);
        const role = roleOf(row.role);

        return workspace === undefined || role === undefined ? [] : [{ workspace, role }];
      });
    },

    async role(workspace, account) {
      const row = connect(path)
        .prepare('SELECT role FROM members WHERE workspace_id = ? AND account_id = ?')
        .get(workspace, account) as { role: unknown } | undefined;

      return roleOf(row?.role);
    },

    async addSite(workspace, { origin, visibility }) {
      const database = connect(path);
      const existing = database
        .prepare(`SELECT ${SITE_COLUMNS} FROM sites WHERE workspace_id = ? AND origin = ?`)
        .get(workspace, origin) as Record<string, unknown> | undefined;
      const known = existing === undefined ? undefined : siteOf(existing);

      // Adding the same address twice is the same site, with the visibility asked for last.
      if (known !== undefined) {
        database.prepare('UPDATE sites SET visibility = ? WHERE id = ?').run(visibility, known.id);

        return { ...known, visibility };
      }

      const site: Site = { id: newId('site'), workspaceId: workspace, origin, visibility };
      database
        .prepare('INSERT INTO sites (id, workspace_id, origin, visibility, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(site.id, workspace, origin, visibility, Date.now());

      return site;
    },

    async sites(workspace) {
      const rows = connect(path)
        .prepare(`SELECT ${SITE_COLUMNS} FROM sites WHERE workspace_id = ? ORDER BY created_at, id`)
        .all(workspace) as Record<string, unknown>[];

      return rows.flatMap((row) => siteOf(row) ?? []);
    },

    async removeSite(workspace, site) {
      const result = connect(path).prepare('DELETE FROM sites WHERE workspace_id = ? AND id = ?').run(workspace, site);

      return result.changes === 1;
    },

    async addConnector(workspace, { kind, label, sealed }) {
      const id = newId('con');
      const now = Date.now();
      connect(path)
        .prepare('INSERT INTO connectors (id, workspace_id, kind, label, sealed, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, workspace, kind, label, sealed, now);

      return { id, workspaceId: workspace, kind, label, createdAt: new Date(now).toISOString() };
    },

    async connectors(workspace) {
      const rows = connect(path)
        .prepare(
          `SELECT id, workspace_id, kind, label, created_at, attention, attention_at
           FROM connectors WHERE workspace_id = ? ORDER BY created_at, id`,
        )
        .all(workspace) as Record<string, unknown>[];

      return rows.flatMap((row) => connectorOf(row) ?? []);
    },

    async removeConnector(workspace, connector) {
      const result = connect(path)
        .prepare('DELETE FROM connectors WHERE workspace_id = ? AND id = ?')
        .run(workspace, connector);

      return result.changes === 1;
    },

    async resealConnector(connector, sealed) {
      connect(path).prepare('UPDATE connectors SET sealed = ? WHERE id = ?').run(sealed, connector);
    },

    async noteConnector(connector, trouble, now) {
      // `IS NOT` and not `<>`: NULL compares with nothing. A row that already says this is not
      // written again, so the first moment of a refusal stays, and a call that worked writes nothing.
      connect(path)
        .prepare('UPDATE connectors SET attention = ?, attention_at = ? WHERE id = ? AND attention IS NOT ?')
        .run(trouble ?? null, trouble === undefined ? null : now, connector, trouble ?? null);
    },

    async sealedKey(connector) {
      const row = connect(path)
        .prepare('SELECT id, workspace_id, kind, label, sealed, created_at FROM connectors WHERE id = ?')
        .get(connector) as Record<string, unknown> | undefined;
      const known = connectorOf(row);
      if (known === undefined || typeof row?.sealed !== 'string') return undefined;

      return { kind: known.kind, sealed: row.sealed, workspaceId: known.workspaceId };
    },

    async setDestination(workspace, site, destination) {
      const database = connect(path);
      if (destination === undefined) {
        const cleared = database
          .prepare(
            'UPDATE sites SET connector_id = NULL, team_id = NULL, project_id = NULL WHERE workspace_id = ? AND id = ?',
          )
          .run(workspace, site);

        return cleared.changes === 1;
      }

      // One statement: the connector must be of the same workspace as the site.
      const set = database
        .prepare(
          `UPDATE sites SET connector_id = ?, team_id = ?, project_id = ?
           WHERE workspace_id = ? AND id = ?
             AND EXISTS (SELECT 1 FROM connectors WHERE id = ? AND workspace_id = ?)`,
        )
        .run(
          destination.connector,
          destination.teamId ?? null,
          destination.projectId ?? null,
          workspace,
          site,
          destination.connector,
          workspace,
        );

      return set.changes === 1;
    },

    async enqueueDelivery(connector, body, now) {
      const id = newId('dlv');
      connect(path)
        .prepare('INSERT INTO deliveries (id, connector_id, body, created_at, next_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, connector, body, now, now);

      return id;
    },

    async dueDeliveries(now, limit) {
      const rows = connect(path)
        .prepare(
          `SELECT id, connector_id, body, attempts FROM deliveries
           WHERE next_at IS NOT NULL AND next_at <= ? ORDER BY next_at, created_at LIMIT ?`,
        )
        .all(now, limit) as Record<string, unknown>[];

      return rows.flatMap((row) => dueDeliveryOf(row) ?? []);
    },

    async settleDelivery(id, outcome) {
      const database = connect(path);
      if (outcome.delivered) {
        database.prepare('DELETE FROM deliveries WHERE id = ?').run(id);

        return;
      }
      database
        .prepare(
          `UPDATE deliveries SET attempts = attempts + 1, next_at = ?, last_at = ?, last_status = ?, last_error = ?
           WHERE id = ? AND attempts = ?`,
        )
        .run(outcome.nextAt ?? null, outcome.at, outcome.status ?? null, outcome.error ?? null, id, outcome.attempts);
    },

    async deliveries(workspace, connector) {
      const rows = connect(path)
        .prepare(
          `SELECT d.id, d.created_at, d.attempts, d.next_at, d.last_status, d.last_error
           FROM deliveries d JOIN connectors c ON c.id = d.connector_id
           WHERE c.workspace_id = ? AND c.id = ? ORDER BY d.created_at DESC, d.id LIMIT 100`,
        )
        .all(workspace, connector) as Record<string, unknown>[];

      return rows.flatMap((row) => pendingDeliveryOf(row) ?? []);
    },

    async retryDelivery(workspace, connector, delivery, now) {
      // One statement: the delivery must be of a connector of this workspace.
      const set = connect(path)
        .prepare(
          // The count starts again: somebody asked, so the delivery gets the whole series of
          // attempts, and not one attempt that gives up at its first failure.
          `UPDATE deliveries SET next_at = ?, attempts = 0
           WHERE id = ? AND connector_id = ?
             AND EXISTS (SELECT 1 FROM connectors WHERE id = ? AND workspace_id = ?)`,
        )
        .run(now, delivery, connector, connector, workspace);

      return set.changes === 1;
    },

    async dropAbandonedDeliveries(before) {
      const dropped = connect(path)
        .prepare('DELETE FROM deliveries WHERE next_at IS NULL AND COALESCE(last_at, created_at) < ?')
        .run(before);

      return Number(dropped.changes);
    },

    async deleteWorkspace(workspace) {
      connect(path).prepare('DELETE FROM workspaces WHERE id = ?').run(workspace);
    },

    async createEmailLink({ codeHash, email, expiresAt }) {
      const database = connect(path);
      const now = Date.now();
      // Old links go when a new one is made, so the table holds what can still be spent.
      database.prepare('DELETE FROM email_links WHERE expires_at <= ? OR spent_at IS NOT NULL').run(now);
      database
        .prepare('INSERT INTO email_links (code_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .run(codeHash, email, now, expiresAt);
    },

    async spendEmailLink(codeHash, now) {
      const database = connect(path);
      // One statement decides who spent it: two tabs that open the same link get one sign-in.
      const spent = database
        .prepare('UPDATE email_links SET spent_at = ? WHERE code_hash = ? AND spent_at IS NULL AND expires_at > ?')
        .run(now, codeHash, now);
      if (spent.changes !== 1) return undefined;

      const row = database.prepare('SELECT email FROM email_links WHERE code_hash = ?').get(codeHash) as
        | { email: unknown }
        | undefined;

      return typeof row?.email === 'string' ? row.email : undefined;
    },

    async clientMap() {
      const rows = connect(path).prepare(`SELECT ${SITE_COLUMNS} FROM sites`).all() as Record<string, unknown>[];
      const map: ClientMap = {};
      for (const row of rows) {
        const site = siteOf(row);
        if (site !== undefined) map[site.id] = clientOf(site);
      }

      return map;
    },
  };
}
