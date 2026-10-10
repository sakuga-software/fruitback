import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { accountCases } from './account-conformance.fixture.ts';
import type { AccountStore } from './accounts.ts';
import { closeAccountConnections, createSqliteAccountStore } from './accounts-sqlite.ts';
import type { ClientMap } from './clients.ts';
import {
  type FileStoreModule,
  type Subject,
  type Violation,
  describeConformance,
  describeControls,
  factoriesOf,
  mutatedModule,
  onFile,
  turn,
} from './conformance.fixture.ts';

/**
 * Each `AccountStore` against the conformance suite (FRU-140). A new implementation adds a subject
 * here: the last test of this file fails until it does.
 */

const SQLITE = onFile<AccountStore>('the SQLite account store', 'createSqliteAccountStore', () => ({
  create: createSqliteAccountStore,
  close: closeAccountConnections,
}));

const SUBJECTS: Subject<AccountStore>[] = [SQLITE];

for (const subject of SUBJECTS) describeConformance('AccountStore', accountCases, subject);

/** One change to `accounts-sqlite.ts`, or one store around it, for each case: the case must fail. */
const VIOLATIONS: Violation<AccountStore>[] = [
  {
    breaks: 'makes one account of two providers that prove the same address',
    by: 'does not look for the address of a new sign-in',
    replace: {
      from: "'SELECT id, email, name, locale FROM accounts WHERE email = ?').get(address)",
      to: "'SELECT id, email, name, locale FROM accounts WHERE email = ?').get('')",
    },
  },
  {
    breaks: 'makes one account of two providers that prove the same address',
    by: 'does not keep a name that the first sign-in did not have',
    replace: { from: "account.name === undefined && name !== undefined && name !== ''", to: 'false' },
  },
  {
    breaks: 'keeps two addresses apart',
    by: 'gives every sign-in the same address',
    wrap: (real) => ({ ...real, signIn: (login) => real.signIn({ ...login, email: 'one@acme.dev' }) }),
  },
  {
    breaks: 'makes one account of two sign-ins of one address at the same moment',
    by: 'looks for the address, waits, then makes an account that another call made in that time',
    wrap: (real) => {
      const inFlight = new Set<string>();

      return {
        ...real,
        async signIn(login) {
          // What a read followed by a write does on a store that waits: the second call read
          // before the first one wrote, so it makes its own account.
          const raced = inFlight.has(login.email);
          inFlight.add(login.email);
          try {
            await turn();

            return await real.signIn(raced ? { ...login, email: `raced.${login.email}` } : login);
          } finally {
            inFlight.delete(login.email);
          }
        },
      };
    },
  },
  {
    breaks: 'refuses a sign-in whose address is not an address',
    by: 'takes any text as an address',
    replace: {
      from: "if (address === undefined) throw new StoreError('A sign-in needs a valid address');",
      to: '',
    },
  },
  {
    breaks: 'answers the account of an id, and nothing for an id nobody has',
    by: 'answers the first account for every id',
    replace: {
      from: "'SELECT id, email, name, locale FROM accounts WHERE id = ?').get(id)",
      to: "'SELECT id, email, name, locale FROM accounts WHERE id IS NOT ?').get(id)",
    },
  },
  {
    breaks: 'keeps the language of the first sign-in until the person chooses another',
    by: 'takes the language of every sign-in',
    replace: { from: 'if (account.locale === undefined && locale !== undefined) {', to: 'if (locale !== undefined) {' },
  },
  {
    breaks: 'gives each thing an id whose prefix says what it names',
    by: 'names a site with another prefix',
    replace: { from: "newId('site')", to: "newId('s')" },
  },
  {
    breaks: 'makes the creator the owner, and gives nobody else a role',
    by: 'makes the creator an admin',
    replace: { from: ".run(workspace.id, owner, 'owner', now)", to: ".run(workspace.id, owner, 'admin', now)" },
  },
  {
    breaks: 'lists the workspaces of an account oldest first',
    by: 'lists them newest first',
    replace: { from: 'ORDER BY m.created_at, w.id', to: 'ORDER BY m.created_at DESC, w.id' },
  },
  {
    breaks:
      'removes the members, the sites, the connectors and the deliveries of a workspace it deletes, and only those',
    by: 'removes the row of the workspace alone',
    replace: { from: "database.exec('PRAGMA foreign_keys = ON');", to: "database.exec('PRAGMA foreign_keys = OFF');" },
  },
  {
    breaks: 'adds a site once, whatever was pasted twice, and serves it as a client of its workspace',
    by: 'keeps the visibility of the first time',
    replace: {
      from: "database.prepare('UPDATE sites SET visibility = ? WHERE id = ?').run(visibility, known.id);",
      to: '',
    },
  },
  {
    breaks: 'keeps one address apart in two workspaces',
    by: 'finds the site of another workspace by its address',
    replace: {
      from: 'FROM sites WHERE workspace_id = ? AND origin = ?',
      to: 'FROM sites WHERE ? IS NOT NULL AND origin = ?',
    },
  },
  {
    breaks: 'lists the sites and the connectors of a workspace oldest first',
    by: 'lists the sites newest first',
    replace: {
      from: 'FROM sites WHERE workspace_id = ? ORDER BY created_at, id',
      to: 'FROM sites WHERE workspace_id = ? ORDER BY created_at DESC, id',
    },
  },
  {
    breaks: 'removes a site only from its own workspace',
    by: 'removes a site for any workspace',
    replace: {
      from: 'DELETE FROM sites WHERE workspace_id = ? AND id = ?',
      to: 'DELETE FROM sites WHERE ? IS NOT NULL AND id = ?',
    },
  },
  {
    breaks: 'answers an empty client map before a site exists, never no map',
    by: 'answers no map when it has no site',
    wrap: (real) => ({
      ...real,
      async clientMap() {
        const map = await real.clientMap();

        return Object.keys(map).length === 0 ? (undefined as unknown as ClientMap) : map;
      },
    }),
  },
  {
    breaks: 'keeps what a connector seals for the worker, and never lists it',
    by: 'keeps the first key when a new one is sealed',
    replace: {
      from: "'UPDATE connectors SET sealed = ? WHERE id = ?').run(sealed, connector)",
      to: "'UPDATE connectors SET sealed = ? WHERE id = ?').run(sealed, '')",
    },
  },
  {
    breaks: 'keeps what a connector seals for the worker, and never lists it',
    by: 'lists what a connector seals',
    wrap: (real) => ({
      ...real,
      async connectors(workspace) {
        const listed = await real.connectors(workspace);

        return Promise.all(
          listed.map(async (connector) => ({ ...connector, sealed: (await real.sealedKey(connector.id))?.sealed })),
        );
      },
    }),
  },
  {
    breaks: 'removes a connector only from its own workspace, and its sites keep their notes in the worker again',
    by: 'removes a connector for any workspace',
    replace: {
      from: 'DELETE FROM connectors WHERE workspace_id = ? AND id = ?',
      to: 'DELETE FROM connectors WHERE ? IS NOT NULL AND id = ?',
    },
  },
  {
    breaks: 'never lets a site write through the connector of another workspace',
    by: 'takes a connector of any workspace',
    replace: {
      after: 'async setDestination(',
      from: 'AND EXISTS (SELECT 1 FROM connectors WHERE id = ? AND workspace_id = ?)',
      to: 'AND EXISTS (SELECT 1 FROM connectors WHERE id = ? AND ? IS NOT NULL)',
    },
  },
  {
    breaks: 'never lets a site write through the connector of another workspace',
    by: 'clears the destination of a site for any workspace',
    replace: {
      from: 'project_id = NULL WHERE workspace_id = ? AND id = ?',
      to: 'project_id = NULL WHERE ? IS NOT NULL AND id = ?',
    },
  },
  {
    breaks: 'keeps a destination with no team, for an address that only receives',
    by: 'gives a team to a destination that has none',
    replace: { from: 'destination.teamId ?? null,', to: "destination.teamId ?? 'team_default'," },
  },
  {
    breaks: 'keeps the first moment of a refusal, and forgets it at the first call that works',
    by: 'writes the moment of every refusal',
    replace: { from: 'WHERE id = ? AND attention IS NOT ?', to: 'WHERE id = ? AND (attention IS NOT ? OR 1)' },
  },
  {
    breaks: 'gives the deliveries that are due, oldest first, up to the limit',
    by: 'gives the newest first',
    replace: { from: 'ORDER BY next_at, created_at LIMIT ?', to: 'ORDER BY next_at DESC, created_at LIMIT ?' },
  },
  {
    breaks: 'gives the deliveries that are due, oldest first, up to the limit',
    by: 'gives a delivery before it is due',
    replace: { from: 'WHERE next_at IS NOT NULL AND next_at <= ?', to: 'WHERE next_at IS NOT NULL AND ? IS NOT NULL' },
  },
  {
    breaks: 'removes a delivery that arrived, and no other',
    by: 'keeps a delivery that arrived',
    replace: {
      from: "'DELETE FROM deliveries WHERE id = ?').run(id)",
      to: "'DELETE FROM deliveries WHERE id = ?').run('')",
    },
  },
  {
    breaks: 'writes what a failed attempt answered, and gives up when no other attempt is set',
    by: 'never gives up',
    replace: { from: '.run(outcome.nextAt ?? null, outcome.at,', to: '.run(outcome.nextAt ?? outcome.at, outcome.at,' },
  },
  {
    breaks: 'never writes a failure over a new attempt that somebody asked for',
    by: 'writes a failure whatever the count is',
    replace: { from: 'WHERE id = ? AND attempts = ?', to: 'WHERE id = ? AND ? IS NOT NULL' },
  },
  {
    breaks: 'counts one failure when two attempts of one delivery answer at the same moment',
    by: 'writes a failure whatever the count is',
    replace: { from: 'WHERE id = ? AND attempts = ?', to: 'WHERE id = ? AND ? IS NOT NULL' },
  },
  {
    breaks: 'starts the attempts again only for a delivery of this workspace and of this connector',
    by: 'starts them again for any workspace',
    replace: {
      after: 'async retryDelivery(',
      from: 'AND EXISTS (SELECT 1 FROM connectors WHERE id = ? AND workspace_id = ?)',
      to: 'AND EXISTS (SELECT 1 FROM connectors WHERE id = ? AND ? IS NOT NULL)',
    },
  },
  {
    breaks: 'starts the attempts again only for a delivery of this workspace and of this connector',
    by: 'keeps the count of the attempts before',
    replace: {
      from: 'UPDATE deliveries SET next_at = ?, attempts = 0',
      to: 'UPDATE deliveries SET next_at = ?, attempts = attempts',
    },
  },
  {
    breaks: 'lists the deliveries of a connector newest first, without their body, to its workspace only',
    by: 'lists them oldest first',
    replace: { from: 'ORDER BY d.created_at DESC, d.id LIMIT 100', to: 'ORDER BY d.created_at, d.id LIMIT 100' },
  },
  {
    breaks: 'lists the deliveries of a connector newest first, without their body, to its workspace only',
    by: 'lists them to any workspace',
    replace: { from: 'WHERE c.workspace_id = ? AND c.id = ?', to: 'WHERE ? IS NOT NULL AND c.id = ?' },
  },
  {
    breaks: 'drops the deliveries that were given up before a moment, and keeps the ones still to send',
    by: 'drops the deliveries still to send too',
    replace: {
      from: 'WHERE next_at IS NULL AND COALESCE(last_at, created_at) < ?',
      to: 'WHERE COALESCE(last_at, created_at) < ?',
    },
  },
  {
    breaks: 'spends a sign-in link once, and answers its address',
    by: 'spends a link each time it is asked',
    replace: { from: 'AND spent_at IS NULL AND expires_at > ?', to: 'AND expires_at > ?' },
  },
  {
    breaks: 'refuses a sign-in link at its expiry, and after',
    by: 'never reads the expiry',
    replace: { from: 'AND spent_at IS NULL AND expires_at > ?', to: 'AND spent_at IS NULL AND ? IS NOT NULL' },
  },
  {
    breaks: 'refuses a sign-in link at its expiry, and after',
    by: 'still takes a link at the instant of its expiry',
    replace: { from: 'AND spent_at IS NULL AND expires_at > ?', to: 'AND spent_at IS NULL AND expires_at >= ?' },
  },
  {
    breaks: 'gives one sign-in to two calls that spend one link at the same moment',
    by: 'reads the link, waits, then marks it spent',
    wrap: (real) => {
      const links = new Map<string, { email: string; expiresAt: number }>();
      const spent = new Set<string>();

      return {
        ...real,
        async createEmailLink(link) {
          links.set(link.codeHash, link);
        },
        async spendEmailLink(codeHash, now) {
          const link = links.get(codeHash);
          if (link === undefined || spent.has(codeHash) || link.expiresAt <= now) return undefined;
          await turn();
          spent.add(codeHash);

          return link.email;
        },
      };
    },
  },
  {
    breaks: 'keeps a link that can still be spent when another one is made',
    by: 'removes every link when it makes one',
    replace: {
      from: 'DELETE FROM email_links WHERE expires_at <= ? OR spent_at IS NOT NULL',
      to: 'DELETE FROM email_links WHERE ? IS NOT NULL',
    },
  },
];

describeControls('AccountStore', accountCases, VIOLATIONS, SQLITE, async (change) => {
  const mutant = await mutatedModule('accounts-sqlite.ts', change);
  const subject = onFile<AccountStore>('a changed SQLite account store', 'createSqliteAccountStore', () => ({
    create: mutant.module.createSqliteAccountStore as FileStoreModule<AccountStore>['create'],
    close: mutant.module.closeAccountConnections as FileStoreModule<AccountStore>['close'],
  }));

  return {
    ...subject,
    close() {
      subject.close();
      mutant.remove();
    },
  };
});

describe('the AccountStore conformance suite', () => {
  it('runs for every implementation the worker exports', () => {
    assert.deepEqual(SUBJECTS.map((subject) => subject.factory).sort(), factoriesOf('AccountStore'));
  });
});
