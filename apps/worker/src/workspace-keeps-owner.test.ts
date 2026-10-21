import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { createPostgresAccountStore } from './accounts-postgres.ts';
import { DATABASES, databasesOfACase } from './auth.fixture.ts';
import { workerOf } from './auth-worker.fixture.ts';
import { createPostgresInstanceAdmin } from './instance-admin-postgres.ts';
import { type PgDatabase, createPgDatabase } from './postgres.ts';
import { NO_REAL_POSTGRES, ownDatabase, rowsOf } from './postgres.fixture.ts';
import { migrated } from './postgres-migrate.ts';

/**
 * A workspace keeps an owner, whoever writes its members (FRU-324): the trigger of
 * `0020_workspace_keeps_owner`, and the routes of the organization plugin of better-auth against the
 * deletion of an account by the administrator of the instance (FRU-285), on a real server.
 */

const { opening } = databasesOfACase();

const owners = async (database: PgDatabase, workspace: string): Promise<string[]> =>
  (
    await rowsOf(
      database,
      `SELECT u.email FROM member m JOIN "user" u ON u.id = m."userId"
        WHERE m."organizationId" = '${workspace}' AND m.role = 'owner' ORDER BY u.email`,
    )
  ).map((row) => String(row.email));

/** A member as better-auth writes one. */
const memberOf = (id: string, workspace: string, account: string, role: string) =>
  `INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ('${id}', '${workspace}', '${account}', '${role}', now())`;

for (const { label, open, skip } of DATABASES) {
  describe(`a workspace keeps an owner, on ${label} (FRU-324)`, { skip: skip !== false }, () => {
    async function acme(database: PgDatabase) {
      const accounts = createPostgresAccountStore(database);
      const ana = await accounts.signIn({ provider: 'email', subject: 'ana@acme.dev', email: 'ana@acme.dev' });
      const bob = await accounts.signIn({ provider: 'email', subject: 'bob@acme.dev', email: 'bob@acme.dev' });
      const workspace = await accounts.createWorkspace('Acme', ana.id);

      return { accounts, ana, bob, workspace: workspace.id };
    }

    it('refuses to demote or remove the last owner, written straight in the database', async () => {
      const database = await opening(open);
      const { ana, workspace } = await acme(database);

      await assert.rejects(
        rowsOf(database, `UPDATE member SET role = 'admin' WHERE "userId" = '${ana.id}'`),
        /keeps an owner/,
      );
      await assert.rejects(rowsOf(database, `DELETE FROM member WHERE "userId" = '${ana.id}'`), /keeps an owner/);
      assert.deepEqual(await owners(database, workspace), ['ana@acme.dev']);
    });

    it('lets an owner go when another one stays, and lets a member that is no owner go', async () => {
      const database = await opening(open);
      const { ana, bob, workspace } = await acme(database);
      await rowsOf(database, memberOf('mem_bob', workspace, bob.id, 'owner'));

      await rowsOf(database, `UPDATE member SET role = 'admin' WHERE "userId" = '${ana.id}'`);
      await rowsOf(database, `DELETE FROM member WHERE "userId" = '${ana.id}'`);

      assert.deepEqual(await owners(database, workspace), ['bob@acme.dev']);
    });

    it('deletes a workspace with its owner, and an account that owns a workspace with another owner', async () => {
      const database = await opening(open);
      const { accounts, ana, bob, workspace } = await acme(database);
      const other = await accounts.createWorkspace('Other', ana.id);
      await rowsOf(database, memberOf('mem_bob', other.id, bob.id, 'owner'));

      await accounts.deleteWorkspace(workspace);
      const root = { id: 'acc_root', email: 'root@acme.dev' };
      await rowsOf(
        database,
        `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", role) VALUES ('${root.id}', '', '${root.email}', true, now(), 'admin')`,
      );
      const deletion = await createPostgresInstanceAdmin(database).deleteAccount(root, ana.id, ana.email, 1);

      assert.equal(deletion.ok, true, JSON.stringify(deletion));
      assert.equal((await rowsOf(database, `SELECT 1 FROM organization WHERE id = '${workspace}'`)).length, 0);
      assert.deepEqual(await owners(database, other.id), ['bob@acme.dev']);
    });
  });
}

/**
 * The route of better-auth and the deletion of an account, on a real server. The deletion counts the
 * other owner, then waits on `admin_actions`, which a third connection holds. The route runs in that
 * moment. Without the trigger it takes the other owner away before the deletion commits.
 */
describe(
  'a route of the organization plugin while the administrator deletes an owner, on a real server (FRU-324)',
  { skip: NO_REAL_POSTGRES !== false },
  () => {
    /** What the route does: take Bob away, or (`remove-the-deleted`) Bob removes Ana. */
    type Ask = 'remove-member' | 'update-member-role' | 'leave' | 'remove-the-deleted';

    /**
     * What runs beside the route, and the table where it waits: the deletion of Ana by the
     * administrator, or of Acme by its owner (FRU-209) or by the administrator (FRU-284).
     */
    type Deletion = 'account' | 'workspace-by-owner' | 'workspace-by-admin';

    async function race(ask: Ask, control: { withoutTrigger?: boolean; deletion?: Deletion } = {}) {
      const deleting_ = control.deletion ?? 'account';
      const own = await ownDatabase();
      const database = createPgDatabase(own.url, 'public');
      const [deleting, holder] = [0, 1].map(() => createPgDatabase(own.url, 'public', { max: 1 })) as [
        PgDatabase,
        PgDatabase,
      ];
      // A failed assertion must not leave the table held: the cleanup below would then wait for ever.
      let release = (): void => {};
      try {
        await migrated(database);
        const worker = await workerOf(database);
        const person = async (email: string) => {
          const cookie = await worker.signIn(email);
          const [row] = await rowsOf(database, `SELECT id FROM "user" WHERE email = '${email}'`);

          return { email, cookie, id: String(row?.id) };
        };
        // The first account is the administrator of the instance.
        const root = await person('root@acme.dev');
        const ana = await person('ana@acme.dev');
        const bob = await person('bob@acme.dev');
        const made = await worker.call('/console/workspaces', {
          body: { name: 'Acme' },
          headers: { Cookie: ana.cookie },
        });
        assert.equal(made.status, 201, await made.clone().text());
        const workspace = ((await made.json()) as { id: string }).id;
        await rowsOf(database, memberOf('mem_bob', workspace, bob.id, 'owner'));
        if (control.withoutTrigger === true) await rowsOf(database, 'DROP TRIGGER member_keeps_owner ON member');
        // A site, so that the deletion of Acme by its owner deletes its notes, and waits there.
        await rowsOf(
          database,
          `INSERT INTO sites (id, workspace_id, origin, visibility, created_at) VALUES ('site_acme', '${workspace}', 'https://acme.dev', 'private', 1)`,
        );

        const released = new Promise<void>((resolve) => (release = resolve));
        let locked = (): void => {};
        const tableLocked = new Promise<void>((resolve) => (locked = resolve));
        const holding = holder.transaction(async (db) => {
          await db.execute(
            `LOCK TABLE ${deleting_ === 'workspace-by-owner' ? 'seeds' : 'admin_actions'} IN EXCLUSIVE MODE`,
          );
          locked();
          await released;
        });
        await tableLocked;

        // Ana is deleted: Bob owns Acme too, so the count passes, and the deletion waits on the table.
        // Or Acme is: the deletion holds it, and waits on the table.
        const deletions: Record<Deletion, () => Promise<{ ok: boolean }>> = {
          account: () => createPostgresInstanceAdmin(deleting).deleteAccount(root, ana.id, ana.email, 1),
          'workspace-by-admin': () => createPostgresInstanceAdmin(deleting).deleteWorkspace(root, workspace, 'Acme', 1),
          'workspace-by-owner': async () => {
            await createPostgresAccountStore(deleting).deleteWorkspace(workspace);

            return { ok: true };
          },
        };
        const deletion = deletions[deleting_]();
        await waiters(database, 1);

        // Ana takes Bob away, or Bob leaves, while the deletion waits.
        const [anas] = await rowsOf(database, `SELECT id FROM member WHERE "userId" = '${ana.id}'`);
        const calls: Record<Ask, [string, typeof ana, Record<string, string>]> = {
          'remove-the-deleted': [
            'remove-member',
            bob,
            { organizationId: workspace, memberIdOrEmail: String(anas?.id) },
          ],
          'remove-member': ['remove-member', ana, { organizationId: workspace, memberIdOrEmail: 'mem_bob' }],
          'update-member-role': [
            'update-member-role',
            ana,
            { organizationId: workspace, memberId: 'mem_bob', role: 'admin' },
          ],
          leave: ['leave', bob, { organizationId: workspace }],
        };
        const [path, by, body] = calls[ask];
        const settled: string[] = [];
        const route = worker
          .call(`/console/auth/organization/${path}`, { body, headers: { Cookie: by.cookie } })
          .finally(() => settled.push('route'));
        const waited = await waiters(database, 2, 1_000);
        const beforeRelease = [...settled];
        release();
        await holding;
        const [deleted, answer] = await Promise.all([deletion, route]);
        // The same call, asked again once both are done.
        const again = await worker.call(`/console/auth/organization/${path}`, { body, headers: { Cookie: by.cookie } });

        return {
          waited,
          beforeRelease,
          deleted,
          status: answer.status,
          again: { status: again.status, body: await again.text() },
          owners: await owners(database, workspace),
        };
      } finally {
        release();
        await Promise.all([database, deleting, holder].map((each) => each.close()));
        await own.drop();
      }
    }

    for (const ask of ['remove-member', 'update-member-role', 'leave'] as const) {
      it(`refuses « ${ask} » of the other owner: it waits for the deletion, and Bob stays the owner`, async () => {
        const outcome = await race(ask);

        // The route waited for the deletion: it was in the trigger while the deletion held Acme.
        assert.equal(outcome.waited, true);
        assert.deepEqual(outcome.beforeRelease, []);
        assert.equal(outcome.deleted.ok, true, JSON.stringify(outcome.deleted));
        // The trigger refused the write: better-auth answers a failure, and the worker passes it on.
        assert.ok(outcome.status >= 500, `the route answered ${outcome.status}`);
        assert.deepEqual(outcome.owners, ['bob@acme.dev']);
        // Asked again, better-auth reads the owners first and refuses: Bob leaves no workspace without
        // an owner. Ana, who asked the two others, is gone.
        if (ask === 'leave') {
          assert.equal(outcome.again.status, 400, outcome.again.body);
          assert.match(outcome.again.body, /YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER/);
        } else assert.equal(outcome.again.status, 401, outcome.again.body);
      });
    }

    // The route holds the row of Ana, and the trigger then waits for Acme; the deletion held Acme and
    // then waited for that row. The deletion now holds the rows of Ana first, so the route waits for
    // the row, before the trigger. With Acme first, PostgreSQL ended one of the two on a deadlock.
    it('deletes Ana while Bob removes her: the route waits for the row, and neither ends on a deadlock', async () => {
      const outcome = await race('remove-the-deleted');

      assert.equal(outcome.waited, true);
      assert.deepEqual(outcome.beforeRelease, []);
      assert.equal(outcome.deleted.ok, true, JSON.stringify(outcome.deleted));
      assert.ok(outcome.status < 500, `the route answered ${outcome.status}`);
      assert.deepEqual(outcome.owners, ['bob@acme.dev']);
    });

    // The deletion of a workspace holds its members, then the workspace: a route that takes an owner
    // away waits for the row, and then finds no member. With the workspace first, the route held the
    // row of Bob and waited for Acme in the trigger, while the deletion waited for that row.
    for (const deletion of ['workspace-by-owner', 'workspace-by-admin'] as const) {
      it(`deletes Acme (${deletion}) while Ana demotes Bob: neither ends on a deadlock`, async () => {
        const outcome = await race('update-member-role', { deletion });

        assert.equal(outcome.waited, true);
        assert.deepEqual(outcome.beforeRelease, []);
        assert.equal(outcome.deleted.ok, true, JSON.stringify(outcome.deleted));
        assert.ok(outcome.status < 500, `the route answered ${outcome.status}`);
        assert.deepEqual(outcome.owners, []);
      });
    }

    // The control: without the trigger, the route does not wait, and Acme keeps no owner.
    it('leaves the workspace with no owner without the trigger', async () => {
      const outcome = await race('update-member-role', { withoutTrigger: true });

      assert.deepEqual(outcome.beforeRelease, ['route']);
      assert.equal(outcome.status, 200);
      assert.equal(outcome.deleted.ok, true, JSON.stringify(outcome.deleted));
      assert.deepEqual(outcome.owners, []);
    });
  },
);

/**
 * Whether `count` connections of the database wait for a lock, within `ms`. A connection that waits
 * on a lock of a row or of a table shows as `Lock` in `pg_stat_activity`.
 */
async function waiters(database: PgDatabase, count: number, ms = 5_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const [row] = await rowsOf(
      database,
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if (Number(row?.n) >= count) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return false;
}
