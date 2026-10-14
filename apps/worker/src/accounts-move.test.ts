import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, afterEach, describe, it } from 'node:test';
import { getMigrations } from 'better-auth/db/migration';
import { createPostgresAccountStore } from './accounts-postgres.ts';
import { handleRequest } from './app.ts';
import { DATABASES, optionsOn } from './auth.fixture.ts';
import type { WorkerEnv } from './env.ts';
import { createMemoryKv } from './kv.ts';
import type { PgDatabase } from './postgres.ts';
import { appliedDates, journalDates, journalTags, migrationsThrough, rowsOf } from './postgres.fixture.ts';
import { migrate } from './postgres-migrate.ts';
import { createPostgresSessionStore } from './session-postgres.ts';
import { closeSessionConnections, createSqliteSessionStore } from './session-sqlite.ts';
import { createPairing, redeemPairing, refreshSession } from './session.ts';

/**
 * The accounts and the workspaces move into the tables of better-auth (FRU-146).
 *
 * `0002_accounts_in_better_auth` copies `accounts`, `logins`, `workspaces` and `members` into `user`,
 * `account`, `organization` and `member`, then drops them. Each case starts from a database of the
 * image of before, `BEFORE`, with rows as its stores wrote them, applies the migrations of this
 * build as a worker does when it starts, and reads the result through the store and through a route.
 *
 * **Nothing changes for a caller**: the same person under the same id, the same role, the same sites.
 * `account-conformance.test.ts` holds the store on the new tables to the cases of every store.
 */

const BEFORE = '0001_connector_settings';
const MOVE = '0002_accounts_in_better_auth';
const SECRET = 'a-worker-secret-of-exactly-enough';
const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

/** 2026-10-01 at noon, to the millisecond: a row of before holds an instant as this number. */
const THEN = Date.UTC(2026, 9, 1, 12, 0, 0, 123);

const folders: string[] = [];
after(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const opened: PgDatabase[] = [];
afterEach(async () => {
  closeSessionConnections();
  for (const database of opened.splice(0)) await database.close();
});

/**
 * A session of the extension that was opened before the move: its tokens, and the rows that hold
 * their digests. `session.ts` makes them on a SQLite file, and the rows are put in the database as
 * they are: the tables of the sessions are the same in both, and the move does not touch them.
 */
async function sessionOfBefore(subject: string, workspace: string) {
  const folder = mkdtempSync(join(tmpdir(), 'fruitback-move-'));
  folders.push(folder);
  const path = join(folder, 'sessions.db');
  const sessions = createSqliteSessionStore(path);
  const redeemed = await redeemPairing(sessions, (await createPairing(sessions, { subject, workspace })).code, SECRET);
  assert.ok(redeemed.ok);
  closeSessionConnections();

  const file = new DatabaseSync(path);
  const rows = (table: string) => file.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
  const statements = ['pairings', 'sessions'].flatMap((table) =>
    rows(table).map((row) => {
      const columns = Object.keys(row);
      const values = columns.map((column) => {
        const value = row[column];
        if (value === null) return 'NULL';

        return typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
      });

      return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${values.join(', ')})`;
    }),
  );
  file.close();
  assert.equal(statements.length, 2, 'one pairing that was spent, and one session');

  return { ...redeemed.session, statements };
}

/**
 * A database of the image of before, with what its stores wrote: every shape of a row that the
 * tables of better-auth do not take as it is.
 *
 * - Alice has a name, a language and two ways to sign in. Bob has no name and no language (`NULL`).
 *   Carol has the empty name and the empty language, which the store of before read as none.
 * - Acme has one member of each role. `ws_odd` has two members whose role is no role of the worker.
 * - Each instant is another millisecond, so an order that the move lost would show.
 */
async function databaseOfBefore(open: () => Promise<PgDatabase>) {
  const database = await open();
  opened.push(database);
  await migrate(database, migrationsThrough(BEFORE));
  const session = await sessionOfBefore('acc_alice', 'ws_acme');

  const statements = [
    `INSERT INTO accounts (id, email, name, locale, created_at) VALUES
       ('acc_alice', 'alice@acme.dev', 'Alice', 'fr', ${THEN}),
       ('acc_bob', 'bob@acme.dev', NULL, NULL, ${THEN + 1}),
       ('acc_carol', 'carol@acme.dev', '', '', ${THEN + 2}),
       ('acc_dave', 'dave@acme.dev', 'Dave', NULL, ${THEN + 3})`,
    `INSERT INTO logins (provider, subject, account_id, created_at) VALUES
       ('github', '42', 'acc_alice', ${THEN}),
       ('email', 'alice@acme.dev', 'acc_alice', ${THEN + 10}),
       ('email', 'bob@acme.dev', 'acc_bob', ${THEN + 1}),
       ('google', '1081', 'acc_carol', ${THEN + 2}),
       ('email', 'dave@acme.dev', 'acc_dave', ${THEN + 3})`,
    `INSERT INTO workspaces (id, name, created_at) VALUES
       ('ws_acme', 'Acme', ${THEN + 20}), ('ws_solo', 'Bob and co', ${THEN + 21}), ('ws_odd', 'Odd', ${THEN + 22})`,
    `INSERT INTO members (workspace_id, account_id, role, created_at) VALUES
       ('ws_acme', 'acc_alice', 'owner', ${THEN + 20}),
       ('ws_acme', 'acc_bob', 'guest', ${THEN + 30}),
       ('ws_acme', 'acc_carol', 'admin', ${THEN + 31}),
       ('ws_acme', 'acc_dave', 'member', ${THEN + 32}),
       ('ws_solo', 'acc_bob', 'owner', ${THEN + 21}),
       ('ws_odd', 'acc_alice', 'owner', ${THEN + 22}),
       ('ws_odd', 'acc_bob', 'guest,admin', ${THEN + 40}),
       ('ws_odd', 'acc_carol', 'superuser', ${THEN + 41})`,
    `INSERT INTO connectors (id, workspace_id, kind, label, sealed, created_at) VALUES
       ('con_acme', 'ws_acme', 'rest', 'Hook', 'sealed-key-of-acme', ${THEN}),
       ('con_solo', 'ws_solo', 'rest', 'Hook', 'sealed-key-of-solo', ${THEN})`,
    `INSERT INTO sites (id, workspace_id, origin, visibility, created_at) VALUES
       ('site_acme', 'ws_acme', 'https://staging.acme.dev', 'members', ${THEN}),
       ('site_solo', 'ws_solo', 'https://solo.dev', 'everyone', ${THEN})`,
    `INSERT INTO site_destinations (site_id, position, connector_id, label) VALUES
       ('site_acme', 0, 'con_acme', 'Hook'), ('site_solo', 0, 'con_solo', 'Hook')`,
    `INSERT INTO deliveries (id, connector_id, body, created_at, next_at) VALUES
       ('dlv_acme', 'con_acme', '{"n":1}', ${THEN}, ${THEN}), ('dlv_solo', 'con_solo', '{"n":2}', ${THEN}, ${THEN})`,
    ...session.statements,
  ];
  for (const statement of statements) await rowsOf(database, statement);

  return { database, session };
}

async function has(database: PgDatabase, table: string): Promise<boolean> {
  return (await rowsOf(database, `SELECT to_regclass('public.${table}') AS found`))[0]?.found !== null;
}

async function count(database: PgDatabase, table: string, where = 'true'): Promise<number> {
  return Number((await rowsOf(database, `SELECT count(*)::int AS n FROM "${table}" WHERE ${where}`))[0]?.n);
}

function env(): WorkerEnv {
  return {
    FRUITBACK_STORE: 'memory',
    ALLOWED_ORIGINS: 'https://app.fruitback.test',
    FRUITBACK_IDENTITY_SECRET: SECRET,
    // Port 1 of this machine: nothing listens there. The store of the case is given to the request.
    FRUITBACK_DATABASE_URL: 'postgres://fruitback:not-a-password@127.0.0.1:1/fruitback',
    FRUITBACK_CONSOLE_URL: 'https://app.fruitback.test',
    FRUITBACK_PUBLIC_URL: 'https://api.fruitback.test',
    FRUITBACK_AUTH_SECRET: 'a-secret-of-better-auth-that-signs-nothing-here',
  };
}

/** `GET /session/sites`, as the extension asks it. */
function sitesOf(database: PgDatabase, token: string): Promise<Response> {
  return handleRequest(
    new Request('https://api.fruitback.test/session/sites', {
      headers: { Origin: EXTENSION, Authorization: `Bearer ${token}` },
    }),
    env(),
    { clientIp: '198.51.100.9', kv: createMemoryKv(), accounts: createPostgresAccountStore(database) },
  );
}

it('names the migration that moves the accounts, and the one before it', () => {
  const tags = journalTags();

  assert.deepEqual(tags.slice(tags.indexOf(BEFORE), tags.indexOf(BEFORE) + 2), [BEFORE, MOVE]);
});

for (const { label, open, skip } of DATABASES) {
  describe(`a database of before the accounts moved, on ${label} (FRU-146)`, { skip }, () => {
    it('finds each person again, under the same id, by each way they signed in with', async () => {
      const { database } = await databaseOfBefore(open);
      const accounts = createPostgresAccountStore(database);

      // The first call of a store applies the migrations, as on a worker that starts.
      assert.deepEqual(await accounts.account('acc_alice'), {
        id: 'acc_alice',
        email: 'alice@acme.dev',
        name: 'Alice',
        locale: 'fr',
      });
      assert.deepEqual(await appliedDates(database), journalDates());
      // No name and no language, whether the row of before held NULL or the empty text.
      assert.deepEqual(await accounts.account('acc_bob'), { id: 'acc_bob', email: 'bob@acme.dev' });
      assert.deepEqual(await accounts.account('acc_carol'), { id: 'acc_carol', email: 'carol@acme.dev' });
      assert.deepEqual(await accounts.account('acc_dave'), { id: 'acc_dave', email: 'dave@acme.dev', name: 'Dave' });
      assert.equal(await accounts.localeOf('alice@acme.dev'), 'fr');
      assert.equal(await accounts.localeOf('carol@acme.dev'), undefined);

      for (const [provider, subject, email, id] of [
        ['github', '42', 'alice@acme.dev', 'acc_alice'],
        ['email', 'alice@acme.dev', 'alice@acme.dev', 'acc_alice'],
        ['email', 'bob@acme.dev', 'bob@acme.dev', 'acc_bob'],
        ['google', '1081', 'carol@acme.dev', 'acc_carol'],
        ['email', 'dave@acme.dev', 'dave@acme.dev', 'acc_dave'],
      ] as const) {
        assert.equal((await accounts.signIn({ provider, subject, email })).id, id, `${provider} ${subject}`);
      }
      // A sign-in that the person already had made no person and no row.
      assert.equal(await count(database, 'user'), 4);
      assert.equal(await count(database, 'account'), 5);
      // A way to sign in that is new joins the person of its address, as before.
      const joined = await accounts.signIn({ provider: 'google', subject: '7', email: 'bob@acme.dev', name: 'Bob' });
      assert.deepEqual(joined, { id: 'acc_bob', email: 'bob@acme.dev', name: 'Bob' });
    });

    it('finds each membership and each role again, in the order they were made', async () => {
      const { database } = await databaseOfBefore(open);
      const accounts = createPostgresAccountStore(database);

      assert.deepEqual(await accounts.memberships('acc_alice'), [
        { workspace: { id: 'ws_acme', name: 'Acme' }, role: 'owner' },
        { workspace: { id: 'ws_odd', name: 'Odd' }, role: 'owner' },
      ]);
      // Bob made `ws_solo` before he joined Acme: the order is the one of the instants, not of the ids.
      assert.deepEqual(await accounts.memberships('acc_bob'), [
        { workspace: { id: 'ws_solo', name: 'Bob and co' }, role: 'owner' },
        { workspace: { id: 'ws_acme', name: 'Acme' }, role: 'guest' },
      ]);
      assert.deepEqual(
        await Promise.all(['acc_alice', 'acc_bob', 'acc_carol', 'acc_dave'].map((id) => accounts.role('ws_acme', id))),
        ['owner', 'guest', 'admin', 'member'],
      );
      assert.equal(await accounts.role('ws_solo', 'acc_alice'), undefined);
    });

    it('reads a role that is not one of the four as no role, « guest,admin » too', async () => {
      const { database } = await databaseOfBefore(open);
      const accounts = createPostgresAccountStore(database);

      assert.equal(await accounts.role('ws_odd', 'acc_bob'), undefined);
      assert.equal(await accounts.role('ws_odd', 'acc_carol'), undefined);
      assert.deepEqual(await accounts.memberships('acc_carol'), [
        { workspace: { id: 'ws_acme', name: 'Acme' }, role: 'admin' },
      ]);
      // The control: the two rows are there, with the text they had. better-auth reads the first as two roles.
      assert.deepEqual(
        await rowsOf(database, `SELECT "userId", role FROM "member" WHERE "organizationId" = 'ws_odd' ORDER BY 1`),
        [
          { userId: 'acc_alice', role: 'owner' },
          { userId: 'acc_bob', role: 'guest,admin' },
          { userId: 'acc_carol', role: 'superuser' },
        ],
      );
    });

    it('writes each row as better-auth expects it, and no token of a provider', async () => {
      const { database } = await databaseOfBefore(open);
      await migrate(database);

      for (const table of ['accounts', 'logins', 'workspaces', 'members']) {
        assert.equal(await has(database, table), false, `${table} is still there`);
      }
      assert.deepEqual(
        await rowsOf(
          database,
          `SELECT id, name, email, "emailVerified", image, locale,
                  (extract(epoch FROM "createdAt") * 1000)::bigint::text AS created,
                  (extract(epoch FROM "updatedAt") * 1000)::bigint::text AS updated
             FROM "user" ORDER BY id`,
        ),
        [
          ['acc_alice', 'Alice', 'alice@acme.dev', 'fr', THEN],
          ['acc_bob', '', 'bob@acme.dev', null, THEN + 1],
          ['acc_carol', '', 'carol@acme.dev', '', THEN + 2],
          ['acc_dave', 'Dave', 'dave@acme.dev', null, THEN + 3],
        ].map(([id, name, email, locale, at]) => ({
          id,
          name,
          email,
          emailVerified: true,
          image: null,
          locale,
          created: String(at),
          updated: String(at),
        })),
      );
      assert.deepEqual(
        await rowsOf(
          database,
          `SELECT id, name, slug, logo, metadata, (extract(epoch FROM "createdAt") * 1000)::bigint::text AS created
             FROM "organization" ORDER BY id`,
        ),
        [
          { id: 'ws_acme', name: 'Acme', slug: 'ws_acme', logo: null, metadata: null, created: String(THEN + 20) },
          { id: 'ws_odd', name: 'Odd', slug: 'ws_odd', logo: null, metadata: null, created: String(THEN + 22) },
          {
            id: 'ws_solo',
            name: 'Bob and co',
            slug: 'ws_solo',
            logo: null,
            metadata: null,
            created: String(THEN + 21),
          },
        ],
      );

      const ways = await rowsOf(
        database,
        `SELECT id, "providerId", "accountId", "userId",
                (extract(epoch FROM "createdAt") * 1000)::bigint::text AS created,
                (extract(epoch FROM "updatedAt") * 1000)::bigint::text AS updated
           FROM "account" ORDER BY "providerId", "accountId"`,
      );
      assert.deepEqual(
        ways.map(({ id: _id, ...way }) => way),
        [
          ['email', 'alice@acme.dev', 'acc_alice', THEN + 10],
          ['email', 'bob@acme.dev', 'acc_bob', THEN + 1],
          ['email', 'dave@acme.dev', 'acc_dave', THEN + 3],
          ['github', '42', 'acc_alice', THEN],
          ['google', '1081', 'acc_carol', THEN + 2],
        ].map(([providerId, accountId, userId, at]) => ({
          providerId,
          accountId,
          userId,
          created: String(at),
          updated: String(at),
        })),
      );
      const members = await rowsOf(database, 'SELECT id FROM "member"');
      assert.equal(members.length, 8);
      // An id as the worker and better-auth give one, and one for each row.
      for (const { id } of ways) assert.match(String(id), /^lgn_[0-9a-f]{20}$/);
      for (const { id } of members) assert.match(String(id), /^mem_[0-9a-f]{20}$/);
      assert.equal(new Set([...ways, ...members].map(({ id }) => id)).size, 13);

      // SECURITY.md: no token of a provider that signs a person in, no scope and no password.
      assert.equal(
        await count(
          database,
          'account',
          `"accessToken" IS NOT NULL OR "refreshToken" IS NOT NULL OR "idToken" IS NOT NULL OR scope IS NOT NULL
             OR password IS NOT NULL OR "accessTokenExpiresAt" IS NOT NULL OR "refreshTokenExpiresAt" IS NOT NULL`,
        ),
        0,
      );
      // Nothing of better-auth opened a session or made a link: those tables are as empty as before.
      for (const table of ['session', 'verification', 'invitation']) assert.equal(await count(database, table), 0);
    });

    it('writes a new sign-in and a new workspace as it writes a moved one', async () => {
      const { database } = await databaseOfBefore(open);
      const accounts = createPostgresAccountStore(database);

      const erin = await accounts.signIn({ provider: 'github', subject: '77', email: 'Erin@Acme.dev' });
      const workspace = await accounts.createWorkspace(' Erin and co ', erin.id);

      assert.match(erin.id, /^acc_[0-9a-f]{20}$/);
      assert.match(workspace.id, /^ws_[0-9a-f]{20}$/);
      assert.deepEqual(
        await rowsOf(database, `SELECT name, email, "emailVerified", locale FROM "user" WHERE id = '${erin.id}'`),
        [{ name: '', email: 'erin@acme.dev', emailVerified: true, locale: null }],
      );
      const [way] = await rowsOf(database, `SELECT * FROM "account" WHERE "userId" = '${erin.id}'`);
      assert.match(String(way?.id), /^lgn_[0-9a-f]{20}$/);
      assert.deepEqual(
        Object.entries(way ?? {})
          .filter(([, value]) => value !== null)
          .map(([column]) => column)
          .toSorted(),
        ['accountId', 'createdAt', 'id', 'providerId', 'updatedAt', 'userId'],
      );
      assert.deepEqual(await rowsOf(database, `SELECT name, slug FROM "organization" WHERE id = '${workspace.id}'`), [
        { name: 'Erin and co', slug: workspace.id },
      ]);
      const [member] = await rowsOf(database, `SELECT id, role FROM "member" WHERE "userId" = '${erin.id}'`);
      assert.match(String(member?.id), /^mem_[0-9a-f]{20}$/);
      assert.equal(member?.role, 'owner');
    });

    it('lets a session of the extension that was opened before read its sites, and refresh', async () => {
      const { database, session } = await databaseOfBefore(open);

      const answer = await sitesOf(database, session.accessToken);

      assert.equal(answer.status, 200, await answer.clone().text());
      assert.deepEqual(await answer.json(), {
        workspace: { id: 'ws_acme', name: 'Acme' },
        locale: 'fr',
        sites: [{ id: 'site_acme', origin: 'https://staging.acme.dev', visibility: 'members' }],
      });

      const refreshed = await refreshSession(createPostgresSessionStore(database), session.refreshToken, SECRET);
      assert.ok(refreshed.ok, 'the refresh token of before is refused');
      assert.deepEqual(
        { subject: refreshed.identity.subject, workspace: refreshed.identity.workspace },
        { subject: 'acc_alice', workspace: 'ws_acme' },
      );
      assert.equal((await sitesOf(database, refreshed.accessToken)).status, 200);
    });

    // The control of the case above: the answer comes from the membership, not from the token alone.
    it('refuses that session the moment its person is no member any more', async () => {
      const { database, session } = await databaseOfBefore(open);
      assert.equal((await sitesOf(database, session.accessToken)).status, 200);

      await rowsOf(database, `DELETE FROM "member" WHERE "organizationId" = 'ws_acme' AND "userId" = 'acc_alice'`);
      const answer = await sitesOf(database, session.accessToken);

      assert.equal(answer.status, 401);
      assert.deepEqual(await answer.json(), { error: 'identity-required', reason: 'not-a-member' });
    });

    it('removes the sites, the connectors and the deliveries of a workspace with it, and of no other', async () => {
      const { database } = await databaseOfBefore(open);
      const accounts = createPostgresAccountStore(database);
      const held = async () =>
        Object.fromEntries(
          await Promise.all(
            ['organization', 'member', 'sites', 'site_destinations', 'connectors', 'deliveries'].map(
              async (table) => [table, await count(database, table)] as const,
            ),
          ),
        );
      await accounts.account('acc_alice');
      assert.deepEqual(await held(), {
        organization: 3,
        member: 8,
        sites: 2,
        site_destinations: 2,
        connectors: 2,
        deliveries: 2,
      });

      await accounts.deleteWorkspace('ws_acme');

      assert.deepEqual(await held(), {
        organization: 2,
        member: 4,
        sites: 1,
        site_destinations: 1,
        connectors: 1,
        deliveries: 1,
      });
      assert.deepEqual(
        (await accounts.sites('ws_solo')).map((site) => site.id),
        ['site_solo'],
      );
      assert.equal((await accounts.sealedKey('con_solo'))?.sealed, 'sealed-key-of-solo');
      // The people stay: a person is of no workspace.
      assert.equal(await count(database, 'user'), 4);
    });

    it('holds a site and a connector to a workspace that is there', async () => {
      const { database } = await databaseOfBefore(open);
      await migrate(database);

      for (const statement of [
        `INSERT INTO sites (id, workspace_id, origin, visibility, created_at) VALUES ('site_x', 'ws_gone', 'https://x.dev', 'members', 1)`,
        `INSERT INTO connectors (id, workspace_id, kind, label, sealed, created_at) VALUES ('con_x', 'ws_gone', 'rest', 'X', 's', 1)`,
      ]) {
        const refused = await rowsOf(database, statement).then(
          () => undefined,
          (error: unknown) => error,
        );
        assert.equal((refused as { code?: string } | undefined)?.code, '23503', statement);
      }
    });

    it('leaves better-auth nothing to create and nothing to add on the database it moved', async () => {
      const { database } = await databaseOfBefore(open);

      const { options } = await optionsOn(database);
      const found = await getMigrations(options, { throwOnUnsafe: false });

      assert.equal(await count(database, 'user'), 4);
      assert.deepEqual(
        [found.toBeCreated, found.toBeAdded, found.toBeAddedIndexes, found.unsafeChanges, found.schemaProblems],
        [[], [], [], [], []],
      );
    });

    it('moves nothing and drops nothing when a person is already in the table of better-auth', async () => {
      const { database } = await databaseOfBefore(open);
      // Nothing wrote that table before this migration. A row there is one that nobody can explain:
      // the migration must not join it to an account, nor write over it.
      await rowsOf(
        database,
        `INSERT INTO "user" (id, name, email, "emailVerified") VALUES ('acc_other', 'Mallory', 'alice@acme.dev', false)`,
      );
      const before = await appliedDates(database);

      const failure = await migrate(database).then(
        () => undefined,
        (error: unknown) => error,
      );

      assert.ok(failure !== undefined, 'the migration joined a row of before to a person it did not make');
      assert.deepEqual(await appliedDates(database), before);
      assert.equal(await count(database, 'accounts'), 4);
      assert.equal(await count(database, 'members'), 8);
      assert.deepEqual(await rowsOf(database, 'SELECT id, name FROM "user"'), [{ id: 'acc_other', name: 'Mallory' }]);
      assert.equal(await count(database, 'organization'), 0);
    });
  });
}
