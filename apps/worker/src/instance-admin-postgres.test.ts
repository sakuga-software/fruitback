import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createPostgresAccountStore } from './accounts-postgres.ts';
import { DATABASES, databasesOfACase } from './auth.fixture.ts';
import { ADMIN_PAGE } from './instance-admin.ts';
import { ADMIN_ROLE_LOCK, createPostgresInstanceAdmin } from './instance-admin-postgres.ts';
import { type PgDatabase, createPgDatabase } from './postgres.ts';
import { NO_REAL_POSTGRES, createPgliteDatabase, migrationsThrough, ownDatabase, rowsOf } from './postgres.fixture.ts';
import { migrate, migrated } from './postgres-migrate.ts';

/**
 * The administrator of the instance in the database (FRU-261): the trigger of `0016_first_admin`, its
 * migration on a database that had accounts, and the instants of the reads, on PGlite and on a real
 * server when the run has one.
 */

const BEFORE = '0014_invitation_mailed';
const COLUMNS = '0015_instance_admin';

const { opening } = databasesOfACase();

const admins = async (database: PgDatabase): Promise<string[]> =>
  (await rowsOf(database, `SELECT email FROM "user" WHERE role = 'admin' ORDER BY email`)).map((row) =>
    String(row.email),
  );

/** A person as better-auth writes one: no role given. */
const person = (id: string, email: string, createdAt = 'now()') =>
  `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt") VALUES ('${id}', '', '${email}', true, ${createdAt})`;

/** Three accounts of a database of before, made in an order that is not the order of their ids. */
const OF_BEFORE = [
  person('acc_a', 'young@acme.dev', `'2026-10-03T00:00:00Z'`),
  person('acc_b', 'old@acme.dev', `'2026-10-01T00:00:00Z'`),
  person('acc_c', 'middle@acme.dev', `'2026-10-02T00:00:00Z'`),
];

for (const { label, open, skip } of DATABASES) {
  it('takes the lock of the trigger of the first account, so a change of the role waits for it (FRU-280)', () => {
    const trigger = readFileSync(new URL('../drizzle/0016_first_admin.sql', import.meta.url), 'utf8');
    const keys = [...trigger.matchAll(/pg_advisory_xact_lock\((\d+)\)/gu)].map((match) => Number(match[1]));

    assert.ok(keys.length > 0, 'the trigger takes no lock: this test proves nothing');
    assert.deepEqual([...new Set(keys)], [ADMIN_ROLE_LOCK]);
  });

  describe(`the first account is the administrator of the instance, on ${label} (FRU-261)`, { skip }, () => {
    it('makes the first account of an empty database the administrator, and no account after it', async () => {
      const database = await opening(open);
      const accounts = createPostgresAccountStore(database);

      const first = await accounts.signIn({ provider: 'email', subject: 'ana@acme.dev', email: 'ana@acme.dev' });
      const second = await accounts.signIn({ provider: 'github', subject: '42', email: 'bob@acme.dev' });
      await rowsOf(database, person('acc_raw', 'carl@acme.dev'));

      assert.deepEqual(await admins(database), ['ana@acme.dev']);
      assert.equal(await accounts.isInstanceAdmin(first.id), true);
      assert.equal(await accounts.isInstanceAdmin(second.id), false);
    });

    it('gives the role to the oldest account of a database that had accounts and no administrator', async () => {
      const database = await opening(open);
      await migrate(database, migrationsThrough(BEFORE));
      for (const statement of OF_BEFORE) await rowsOf(database, statement);

      await migrate(database);

      assert.deepEqual(await admins(database), ['old@acme.dev']);
      // The trigger is there too: the next account is no administrator.
      await rowsOf(database, person('acc_d', 'new@acme.dev'));
      assert.deepEqual(await admins(database), ['old@acme.dev']);
    });

    // The control of the case above: the migration gives the role only where nobody has it.
    it('gives the role to nobody when an account already has it', async () => {
      const database = await opening(open);
      await migrate(database, migrationsThrough(COLUMNS));
      for (const statement of OF_BEFORE) await rowsOf(database, statement);
      await rowsOf(database, `UPDATE "user" SET role = 'admin' WHERE id = 'acc_c'`);

      await migrate(database);

      assert.deepEqual(await admins(database), ['middle@acme.dev']);
    });

    it('gives the role to nobody on a database with no account, and to the first account made after', async () => {
      const database = await opening(open);
      await migrate(database);
      assert.deepEqual(await admins(database), []);

      await rowsOf(database, person('acc_1', 'first@acme.dev'));
      assert.deepEqual(await admins(database), ['first@acme.dev']);
    });

    it('gives the role to no later account, after the role is taken away or written another way', async () => {
      for (const role of ['NULL', `'Admin'`, `'admin,user'`]) {
        const database = await opening(open);
        await migrate(database);
        await rowsOf(database, person('acc_1', 'first@acme.dev'));
        await rowsOf(database, `UPDATE "user" SET role = ${role} WHERE id = 'acc_1'`);

        await rowsOf(database, person('acc_2', 'second@acme.dev'));

        assert.deepEqual(await admins(database), [], role);
      }
    });

    it('counts every connector that needs attention, beyond the page it lists', async () => {
      const database = await opening(open);
      const accounts = createPostgresAccountStore(database);
      const reads = createPostgresInstanceAdmin(database);
      const bob = await accounts.signIn({ provider: 'email', subject: 'bob@acme.dev', email: 'bob@acme.dev' });
      const workspace = await accounts.createWorkspace('Beta', bob.id);
      for (let index = 0; index <= ADMIN_PAGE; index += 1) {
        const connector = await accounts.addConnector(workspace.id, {
          kind: 'rest',
          label: `Hook ${index}`,
          sealed: 'x',
        });
        await accounts.noteConnector(connector.id, 'key-refused', 1_000 + index);
      }

      const attention = await reads.attention();
      assert.equal(attention.connectors.length, ADMIN_PAGE);
      assert.equal(attention.total, ADMIN_PAGE + 1);
    });

    it('leaves out of the count and of the filter a trouble that this version does not know', async () => {
      const database = await opening(open);
      const accounts = createPostgresAccountStore(database);
      const reads = createPostgresInstanceAdmin(database);
      const bob = await accounts.signIn({ provider: 'email', subject: 'bob@acme.dev', email: 'bob@acme.dev' });
      const workspace = await accounts.createWorkspace('Beta', bob.id);
      const connector = await accounts.addConnector(workspace.id, { kind: 'rest', label: 'Hook', sealed: 'x' });
      await accounts.noteConnector(connector.id, 'key-refused', 1_000);
      // A value that a later version writes, read by this one.
      await rowsOf(database, `UPDATE connectors SET attention = 'quota-reached' WHERE id = '${connector.id}'`);

      assert.deepEqual(await reads.attention(), { total: 0, connectors: [] });
      assert.deepEqual((await reads.workspaces({ show: 'attention' })).workspaces, []);
    });

    it('reads the instants of a connector and of a trace as the numbers that were written', async () => {
      const database = await opening(open);
      const accounts = createPostgresAccountStore(database);
      const reads = createPostgresInstanceAdmin(database);
      const ana = await accounts.signIn({ provider: 'email', subject: 'ana@acme.dev', email: 'ana@acme.dev' });
      const bob = await accounts.signIn({ provider: 'email', subject: 'bob@acme.dev', email: 'bob@acme.dev' });
      const workspace = await accounts.createWorkspace('Beta', bob.id);
      const connector = await accounts.addConnector(workspace.id, { kind: 'rest', label: 'Hook', sealed: 'x' });
      // Past 2^32: a BIGINT read from a raw statement as a string would be 1970.
      const instant = 2 ** 32 + 1;
      await accounts.noteConnector(connector.id, 'key-refused', instant);
      await reads.trace(ana, [workspace.id, workspace.id], 'workspace', instant);

      assert.deepEqual(await reads.attention(), {
        total: 1,
        connectors: [
          {
            id: connector.id,
            kind: 'rest',
            label: 'Hook',
            attention: { reason: 'key-refused', since: new Date(instant).toISOString() },
            workspace: { id: workspace.id, name: 'Beta' },
          },
        ],
      });
      assert.deepEqual(await reads.reads(workspace.id), [
        { admin: { email: 'ana@acme.dev' }, what: 'workspace', at: new Date(instant).toISOString() },
      ]);
      const [listed] = (await reads.workspaces({ show: 'all' })).workspaces;
      assert.equal(listed?.destinations[0]?.id, connector.id);
      assert.ok(Math.abs(Date.parse(listed?.createdAt ?? '') - Date.now()) < 60_000, listed?.createdAt);
      // A member of the workspace leaves no trace there.
      await reads.trace(bob, [workspace.id], 'workspace', instant);
      assert.equal((await reads.reads(workspace.id)).length, 1);
    });

    it('refuses to take the role from the last administrator, whoever asks (FRU-280)', async () => {
      const database = await opening(open);
      const accounts = createPostgresAccountStore(database);
      const reads = createPostgresInstanceAdmin(database);
      const ana = await accounts.signIn({ provider: 'email', subject: 'ana@acme.dev', email: 'ana@acme.dev' });
      const bob = await accounts.signIn({ provider: 'email', subject: 'bob@acme.dev', email: 'bob@acme.dev' });

      // Bob passed the guard a moment before he lost the role: the store asks again.
      assert.deepEqual(await reads.setInstanceAdmin(bob, ana.id, false, 1), { ok: false, refused: 'last-admin' });
      assert.deepEqual(await reads.setInstanceAdmin(bob, bob.id, true, 1), { ok: false, refused: 'not-admin' });
      assert.deepEqual(await admins(database), ['ana@acme.dev']);
      assert.deepEqual(await rowsOf(database, 'SELECT id FROM admin_actions'), []);

      // The control: with two administrators, one removes the other.
      assert.deepEqual(await reads.setInstanceAdmin(ana, bob.id, true, 2), {
        ok: true,
        changed: true,
        instanceAdmin: true,
      });
      assert.deepEqual(await reads.setInstanceAdmin(bob, ana.id, false, 3), {
        ok: true,
        changed: true,
        instanceAdmin: false,
      });
      assert.deepEqual(await admins(database), ['bob@acme.dev']);
      assert.deepEqual(
        (await rowsOf(database, 'SELECT action, at FROM admin_actions ORDER BY at')).map((row) => [
          row.action,
          Number(row.at),
        ]),
        [
          ['admin-named', 2],
          ['admin-removed', 3],
        ],
      );
    });

    it('reads the instant of an action as the number that was written (FRU-280)', async () => {
      const database = await opening(open);
      const accounts = createPostgresAccountStore(database);
      const reads = createPostgresInstanceAdmin(database);
      const ana = await accounts.signIn({ provider: 'email', subject: 'ana@acme.dev', email: 'ana@acme.dev' });
      const bob = await accounts.signIn({ provider: 'email', subject: 'bob@acme.dev', email: 'bob@acme.dev' });
      const instant = 2 ** 32 + 1;

      await reads.setInstanceAdmin(ana, bob.id, true, instant);

      assert.deepEqual(await reads.actions(), [
        {
          action: 'admin-named',
          at: new Date(instant).toISOString(),
          actor: { id: ana.id, email: 'ana@acme.dev' },
          target: { id: bob.id, email: 'bob@acme.dev' },
        },
      ]);
    });
  });
}

describe('the first account in a schema of its own (FRU-219, FRU-261)', () => {
  it('is the administrator, and the function of the trigger is in that schema', async () => {
    const database = await opening(() => createPgliteDatabase('fruitback'));
    const accounts = createPostgresAccountStore(database);

    await accounts.signIn({ provider: 'email', subject: 'ana@acme.dev', email: 'ana@acme.dev' });
    await accounts.signIn({ provider: 'email', subject: 'bob@acme.dev', email: 'bob@acme.dev' });

    assert.deepEqual(await admins(database), ['ana@acme.dev']);
    assert.deepEqual(
      await rowsOf(
        database,
        `SELECT n.nspname AS schema FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.proname = 'fruitback_first_admin'`,
      ),
      [{ schema: 'fruitback' }],
    );
  });
});

describe('two first accounts at the same moment, on a real server (FRU-261)', { skip: NO_REAL_POSTGRES }, () => {
  /** Two pools of one connection each on one new database: two replicas, as far as the server can tell. */
  async function twoReplicas() {
    const own = await ownDatabase();
    const databases = [
      createPgDatabase(own.url, 'public', { max: 1 }),
      createPgDatabase(own.url, 'public', { max: 1 }),
    ] as const;
    await migrated(databases[0]);

    return {
      databases,
      async close() {
        await Promise.all(databases.map((database) => database.close()));
        await own.drop();
      },
    };
  }

  /**
   * The first replica inserts an account and holds its transaction open. The second inserts one, and
   * the first commits after a while. The answer is when the second insert ended: before the commit
   * of the first, or after it.
   */
  async function interleaved(databases: readonly [PgDatabase, PgDatabase]) {
    let commit = (): void => {};
    const held = new Promise<void>((resolve) => (commit = resolve));
    let inserted = (): void => {};
    const firstInserted = new Promise<void>((resolve) => (inserted = resolve));
    const order: string[] = [];

    const first = databases[0].transaction(async (db) => {
      await db.execute(person('acc_1', 'first@acme.dev'));
      inserted();
      await held;
      order.push('first commits');
    });
    await firstInserted;
    const second = databases[1]
      .transaction(async (db) => {
        await db.execute(person('acc_2', 'second@acme.dev'));
      })
      .then(() => order.push('second inserted'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    commit();
    await Promise.all([first, second]);

    return order;
  }

  it('makes one administrator: the second account waits for the first to commit', async () => {
    const { databases, close } = await twoReplicas();
    try {
      const order = await interleaved(databases);

      assert.deepEqual(order, ['first commits', 'second inserted']);
      assert.deepEqual(await admins(databases[0]), ['first@acme.dev']);
    } finally {
      await close();
    }
  });

  // The control: without the lock, the second account sees no administrator and becomes one too.
  it('makes two administrators without the lock of the trigger', async () => {
    const { databases, close } = await twoReplicas();
    try {
      const [{ source }] = (await rowsOf(
        databases[0],
        `SELECT pg_get_functiondef('fruitback_first_admin'::regproc) AS source`,
      )) as [{ source: string }];
      assert.match(source, /pg_advisory_xact_lock/);
      await rowsOf(databases[0], source.replace(/PERFORM pg_advisory_xact_lock\(\d+\);/, ''));

      const order = await interleaved(databases);

      assert.deepEqual(order, ['second inserted', 'first commits']);
      assert.deepEqual(await admins(databases[0]), ['first@acme.dev', 'second@acme.dev']);
    } finally {
      await close();
    }
  });

  it('makes one administrator of twenty sign-ins at once, from two replicas', async () => {
    const { databases, close } = await twoReplicas();
    try {
      const stores = databases.map((database) => createPostgresAccountStore(database));
      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          stores[index % 2]?.signIn({ provider: 'email', subject: `p${index}@acme.dev`, email: `p${index}@acme.dev` }),
        ),
      );

      assert.equal((await admins(databases[0])).length, 1);
      assert.equal(Number((await rowsOf(databases[0], 'SELECT count(*)::int AS n FROM "user"'))[0]?.n), 20);
    } finally {
      await close();
    }
  });
});

describe(
  'two administrators who remove each other at the same moment, on a real server (FRU-280)',
  {
    skip: NO_REAL_POSTGRES,
  },
  () => {
    it('removes one of them: the other gets « last-admin », and one administrator stays', async () => {
      const own = await ownDatabase();
      // Two replicas of one connection each, and a third connection that holds the table of the actions.
      const [first, second, holder] = [0, 1, 2].map(() => createPgDatabase(own.url, 'public', { max: 1 })) as [
        PgDatabase,
        PgDatabase,
        PgDatabase,
      ];
      // A failed assertion must not leave the table held: the cleanup below would then wait for ever.
      let release = (): void => {};
      try {
        await migrated(first);
        const accounts = createPostgresAccountStore(first);
        const ana = await accounts.signIn({ provider: 'email', subject: 'ana@acme.dev', email: 'ana@acme.dev' });
        const bob = await accounts.signIn({ provider: 'email', subject: 'bob@acme.dev', email: 'bob@acme.dev' });
        await rowsOf(first, `UPDATE "user" SET role = 'admin' WHERE id = '${bob.id}'`);
        assert.deepEqual(await admins(first), ['ana@acme.dev', 'bob@acme.dev']);

        // Each removal writes its action last: while the table is held, a removal that counted waits there.
        const released = new Promise<void>((resolve) => (release = resolve));
        let locked = (): void => {};
        const tableLocked = new Promise<void>((resolve) => (locked = resolve));
        const holding = holder.transaction(async (db) => {
          await db.execute('LOCK TABLE admin_actions IN EXCLUSIVE MODE');
          locked();
          await released;
        });
        await tableLocked;

        const settled: string[] = [];
        const removals = [
          createPostgresInstanceAdmin(first).setInstanceAdmin(ana, bob.id, false, 1),
          createPostgresInstanceAdmin(second).setInstanceAdmin(bob, ana.id, false, 1),
        ].map((removal) => removal.finally(() => settled.push('settled')));
        await new Promise((resolve) => setTimeout(resolve, 300));
        // The control of the race: neither removal ended while the table was held.
        assert.deepEqual(settled, []);
        release();
        await holding;
        const outcomes = await Promise.all(removals);

        assert.deepEqual(outcomes.map((outcome) => (outcome.ok ? 'removed' : outcome.refused)).toSorted(), [
          'last-admin',
          'removed',
        ]);
        assert.equal((await admins(first)).length, 1);
        assert.equal(Number((await rowsOf(first, 'SELECT count(*)::int AS n FROM admin_actions'))[0]?.n), 1);
      } finally {
        release();
        await Promise.all([first, second, holder].map((database) => database.close()));
        await own.drop();
      }
    });
  },
);

describe(
  'two administrators who suspend each other at the same moment, on a real server (FRU-281)',
  {
    skip: NO_REAL_POSTGRES,
  },
  () => {
    it('suspends one of them: the other gets « last-admin », and one administrator stays', async () => {
      const own = await ownDatabase();
      // Two replicas of one connection each, and a third connection that holds the table of the actions.
      const [first, second, holder] = [0, 1, 2].map(() => createPgDatabase(own.url, 'public', { max: 1 })) as [
        PgDatabase,
        PgDatabase,
        PgDatabase,
      ];
      // A failed assertion must not leave the table held: the cleanup below would then wait for ever.
      let release = (): void => {};
      try {
        await migrated(first);
        const accounts = createPostgresAccountStore(first);
        const ana = await accounts.signIn({ provider: 'email', subject: 'ana@acme.dev', email: 'ana@acme.dev' });
        const bob = await accounts.signIn({ provider: 'email', subject: 'bob@acme.dev', email: 'bob@acme.dev' });
        await rowsOf(first, `UPDATE "user" SET role = 'admin' WHERE id = '${bob.id}'`);
        assert.deepEqual(await admins(first), ['ana@acme.dev', 'bob@acme.dev']);

        // Each suspension writes its action last: while the table is held, a suspension that counted waits there.
        const released = new Promise<void>((resolve) => (release = resolve));
        let locked = (): void => {};
        const tableLocked = new Promise<void>((resolve) => (locked = resolve));
        const holding = holder.transaction(async (db) => {
          await db.execute('LOCK TABLE admin_actions IN EXCLUSIVE MODE');
          locked();
          await released;
        });
        await tableLocked;

        const settled: string[] = [];
        const suspensions = [
          createPostgresInstanceAdmin(first).setSuspended(ana, bob.id, true, 1),
          createPostgresInstanceAdmin(second).setSuspended(bob, ana.id, true, 1),
        ].map((suspension) => suspension.finally(() => settled.push('settled')));
        await new Promise((resolve) => setTimeout(resolve, 300));
        // The control of the race: neither suspension ended while the table was held.
        assert.deepEqual(settled, []);
        release();
        await holding;
        const outcomes = await Promise.all(suspensions);

        assert.deepEqual(outcomes.map((outcome) => (outcome.ok ? 'suspended' : outcome.refused)).toSorted(), [
          'last-admin',
          'suspended',
        ]);
        // A suspended administrator keeps the role and counts no more.
        const unsuspended = await rowsOf(first, `SELECT email FROM "user" WHERE role = 'admin' AND banned IS NOT TRUE`);
        assert.equal(unsuspended.length, 1);
        assert.equal(Number((await rowsOf(first, 'SELECT count(*)::int AS n FROM admin_actions'))[0]?.n), 1);
      } finally {
        release();
        await Promise.all([first, second, holder].map((database) => database.close()));
        await own.drop();
      }
    });
  },
);
