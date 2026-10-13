import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DrizzleQueryError, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { mutatedModule } from './conformance.fixture.ts';
import {
  type Database,
  causeOfQueryError,
  closeDatabases,
  createPgDatabase,
  databaseFor,
  readDatabaseUrl,
  withoutAddress,
} from './postgres.ts';
import {
  NO_REAL_POSTGRES,
  TEST_DATABASE_URL,
  createPgliteDatabase,
  createRealDatabase,
  ownDatabase,
  rowsOf,
} from './postgres.fixture.ts';
import { APPLIED, migrate, migrated, migrationsFolder } from './postgres-migrate.ts';
import { pairings } from './postgres-schema.ts';
import { StoreError } from './store.ts';

const run = promisify(execFile);

type Entry = { tag: string; when: number; sql: string };

const FIRST: Entry = { tag: '0000_first', when: 1_000, sql: 'CREATE TABLE first_things (id INTEGER PRIMARY KEY);' };
const SECOND: Entry = {
  tag: '0001_second',
  when: 2_000,
  sql: 'CREATE TABLE second_things (id INTEGER PRIMARY KEY);\n--> statement-breakpoint\nINSERT INTO second_things VALUES (1);',
};

const folders: string[] = [];

after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

/** A folder as `drizzle-kit` writes one, with these migrations in this order. */
function folderOf(entries: readonly Entry[]): string {
  const folder = mkdtempSync(join(tmpdir(), 'fruitback-migrations-'));
  folders.push(folder);
  mkdirSync(join(folder, 'meta'));
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: entries.map((entry, idx) => ({
        idx,
        version: '7',
        when: entry.when,
        tag: entry.tag,
        breakpoints: true,
      })),
    }),
  );
  for (const entry of entries) writeFileSync(join(folder, `${entry.tag}.sql`), entry.sql);

  return folder;
}

/** The dates of the migrations that the database says it applied, in order. */
async function applied(database: Database): Promise<number[]> {
  const rows = await rowsOf(database, 'SELECT created_at FROM __drizzle_migrations ORDER BY created_at');

  return rows.map((row) => Number(row.created_at));
}

async function has(database: Database, table: string): Promise<boolean> {
  return (await rowsOf(database, sql`SELECT to_regclass(${table}) AS found`))[0]?.found !== null;
}

async function withPglite(use: (database: Database) => Promise<void>): Promise<void> {
  const database = await createPgliteDatabase();
  try {
    await use(database);
  } finally {
    await database.close();
  }
}

describe('the migrations of the PostgreSQL database (FRU-180)', () => {
  it('applies each migration once, in order, and writes its date and its digest', async () => {
    await withPglite(async (database) => {
      await migrate(database, folderOf([FIRST]));
      assert.deepEqual(await applied(database), [1_000]);

      // A build with one migration more: the first is not run again, or CREATE TABLE would fail.
      await migrate(database, folderOf([FIRST, SECOND]));
      await migrate(database, folderOf([FIRST, SECOND]));

      assert.deepEqual(await applied(database), [1_000, 2_000]);
      assert.deepEqual(await rowsOf(database, 'SELECT id FROM second_things'), [{ id: 1 }]);
      assert.deepEqual(await rowsOf(database, 'SELECT hash FROM __drizzle_migrations ORDER BY created_at'), [
        { hash: createHash('sha256').update(FIRST.sql).digest('hex') },
        { hash: createHash('sha256').update(SECOND.sql).digest('hex') },
      ]);
    });
  });

  it('writes what it applied in the schema of the tables, and makes no schema of its own', async () => {
    await withPglite(async (database) => {
      await migrate(database, folderOf([FIRST]));

      assert.equal(await has(database, `${APPLIED.migrationsSchema}.${APPLIED.migrationsTable}`), true);
      assert.equal(await has(database, 'public.first_things'), true);
      // The place where Drizzle writes when nobody tells it.
      assert.equal(await has(database, 'drizzle.__drizzle_migrations'), false);
    });
  });

  it('refuses a folder in which a migration that shipped was edited', async () => {
    await withPglite(async (database) => {
      await migrate(database, folderOf([FIRST]));
      const edited = { ...FIRST, sql: 'CREATE TABLE first_things (id INTEGER PRIMARY KEY, more TEXT);' };

      await assert.rejects(migrate(database, folderOf([edited, SECOND])), (error: unknown) => {
        assert.ok(error instanceof StoreError);
        assert.match(error.message, /« 0000_first » is not the one that the database applied/);

        return true;
      });
      // Nothing of the folder was applied: the refusal comes before Drizzle.
      assert.deepEqual(await applied(database), [1_000]);
    });
  });

  /**
   * The defect of the migrator of drizzle-orm 0.45, and what `migrate` does about it. A pull request
   * that was rebased after another one merged its migration holds a date before the last one applied.
   */
  describe('a migration dated before the last one that the database applied', () => {
    const LATE: Entry = { tag: '0001_late', when: 1_500, sql: 'CREATE TABLE late_things (id INTEGER PRIMARY KEY);' };
    const AFTER: Entry = { ...SECOND, tag: '0002_second' };

    it('is refused, and named', async () => {
      await withPglite(async (database) => {
        await migrate(database, folderOf([FIRST, SECOND]));

        await assert.rejects(migrate(database, folderOf([FIRST, LATE, AFTER])), (error: unknown) => {
          assert.ok(error instanceof StoreError);
          assert.match(error.message, /« 0001_late » is dated before the last one that the database applied/);

          return true;
        });
      });
    });

    // The control of the test above: this is what the check is for.
    it('is skipped in silence by Drizzle alone: no error, and no table', async () => {
      await withPglite(async (database) => {
        await migrate(database, folderOf([FIRST, SECOND]));

        await database.alone((_, apply) => apply({ migrationsFolder: folderOf([FIRST, LATE, AFTER]), ...APPLIED }));

        assert.equal(await has(database, 'public.late_things'), false);
        assert.deepEqual(await applied(database), [1_000, 2_000]);
      });
    });

    it('is applied on a database that is empty, where every continuous integration starts', async () => {
      await withPglite(async (database) => {
        await migrate(database, folderOf([FIRST, LATE, AFTER]));

        assert.equal(await has(database, 'public.late_things'), true);
      });
    });
  });

  it('leaves nothing of a run that fails, and keeps what the run before applied', async () => {
    await withPglite(async (database) => {
      const half: Entry = { tag: '0001_half', when: 2_000, sql: 'CREATE TABLE half_made (id INTEGER PRIMARY KEY);' };
      const broken: Entry = { tag: '0002_broken', when: 3_000, sql: 'CREATE TABLE first_things (id INTEGER);' };
      await migrate(database, folderOf([FIRST]));

      await assert.rejects(migrate(database, folderOf([FIRST, half, broken])));

      // Drizzle applies a run in one transaction: the migration that passed goes with the one that failed.
      assert.deepEqual(await applied(database), [1_000]);
      assert.equal(await has(database, 'public.half_made'), false);
    });
  });

  it('leaves a database alone that holds more migrations than the build', async () => {
    await withPglite(async (database) => {
      await migrate(database, folderOf([FIRST, SECOND]));

      // The image of before, after a roll back.
      await migrate(database, folderOf([FIRST]));

      assert.deepEqual(await applied(database), [1_000, 2_000]);
    });
  });

  it('finds the migrations of the worker beside its sources, and applies them once for a database', async () => {
    const folder = migrationsFolder();
    assert.ok(existsSync(join(folder, 'meta', '_journal.json')));
    assert.match(folder, /apps\/worker\/drizzle\/$/);

    await withPglite(async (database) => {
      await Promise.all([migrated(database), migrated(database)]);

      assert.equal(await has(database, 'public.sites'), true);
      assert.equal((await applied(database)).length > 0, true);
    });
  });

  it('refuses a folder in which two migrations have one date, before it applies anything', async () => {
    await withPglite(async (database) => {
      const twin: Entry = { ...SECOND, when: FIRST.when };

      await assert.rejects(migrate(database, folderOf([FIRST, twin])), (error: unknown) => {
        assert.ok(error instanceof StoreError);
        assert.match(error.message, /« 0000_first » and « 0001_second » have one date/);

        return true;
      });
      assert.equal(await has(database, 'public.first_things'), false);
    });
  });

  /**
   * `migrate` of Drizzle sends `CREATE SCHEMA IF NOT EXISTS "public"` first, and PostgreSQL asks for
   * the privilege on the database before it looks for the schema. The worker sends no such
   * statement for a schema that is there (FRU-219): a role that can create in the schema is enough,
   * as it was for the tool of before.
   */
  describe('a role that cannot create in its database', { skip: NO_REAL_POSTGRES }, () => {
    /** A database of its own, and a role that can make tables in `public` and nothing in the database. */
    async function withALesserRole(use: (database: Database) => Promise<void>): Promise<void> {
      const own = await ownDatabase();
      const admin = createPgDatabase(own.url, 'public', { max: 1 });
      const role = `r_${new URL(own.url).pathname.slice(1)}`;
      const lesser = new URL(own.url);
      lesser.username = role;
      lesser.password = 'not-a-secret-of-a-test';
      const database = createPgDatabase(lesser.href, 'public', { max: 2 });
      try {
        await rowsOf(admin, `CREATE ROLE ${role} LOGIN PASSWORD 'not-a-secret-of-a-test'`);
        await rowsOf(admin, `GRANT USAGE, CREATE ON SCHEMA public TO ${role}`);
        await use(database);
      } finally {
        await database.close();
        await admin.close();
        await own.drop();
        const server = createPgDatabase(TEST_DATABASE_URL ?? '', 'public', { max: 1 });
        await rowsOf(server, `DROP ROLE IF EXISTS ${role}`);
        await server.close();
      }
    }

    it('is enough when it can create in the schema: the migrations go (FRU-219)', async () => {
      await withALesserRole(async (database) => {
        await migrate(database, folderOf([FIRST]));

        assert.equal(await has(database, 'public.first_things'), true);
        assert.equal(await has(database, `public.${APPLIED.migrationsTable}`), true);
      });
    });

    it('is refused a schema that is not there, with what to grant, and with no name of the role (FRU-219)', async () => {
      await withALesserRole(async (inPublic) => {
        const address = String(
          (await rowsOf(inPublic, 'SELECT current_database() AS name, current_user AS role'))[0]?.name,
        );
        const lesser = new URL(`/${address}`, TEST_DATABASE_URL ?? '');
        lesser.username = `r_${address}`;
        lesser.password = 'not-a-secret-of-a-test';
        const database = createPgDatabase(lesser.href, 'fruitback', { max: 2 });
        try {
          await assert.rejects(migrate(database, folderOf([FIRST])), (error: unknown) => {
            assert.ok(error instanceof StoreError);
            assert.match(error.message, /The schema « fruitback » is not in the database/);
            assert.match(error.message, /cannot create in its database to make it/);
            assert.match(error.message, /grant that role CREATE and USAGE on it/);
            assert.doesNotMatch(error.message, /r_t_/);

            return true;
          });
          assert.deepEqual(await rowsOf(inPublic, `SELECT 1 FROM pg_namespace WHERE nspname = 'fruitback'`), []);
        } finally {
          await database.close();
        }
      });
    });

    it('is refused too when it can create in its database and not in public', async () => {
      await withALesserRole(async (database) => {
        const admin = createPgDatabase(TEST_DATABASE_URL ?? '', 'public', { max: 1 });
        const name = String(
          (await rowsOf(database, 'SELECT current_database() AS name, current_user AS role'))[0]?.name,
        );
        const role = String((await rowsOf(database, 'SELECT current_user AS role'))[0]?.role);
        try {
          await rowsOf(admin, `GRANT CREATE ON DATABASE ${name} TO ${role}`);
        } finally {
          await admin.close();
        }
        const owner = createPgDatabase(new URL(`/${name}`, TEST_DATABASE_URL ?? '').href, 'public', { max: 1 });
        try {
          await rowsOf(owner, `REVOKE CREATE ON SCHEMA public FROM ${role}, PUBLIC`);
        } finally {
          await owner.close();
        }

        await assert.rejects(migrate(database, folderOf([FIRST])), (error: unknown) => {
          assert.ok(error instanceof StoreError);
          assert.match(error.message, /cannot create in the schema « public »/);
          assert.doesNotMatch(error.message, /did not answer/);

          return true;
        });
      });
    });

    // The control: the role can make a table in `public`, and Drizzle alone is what PostgreSQL refuses.
    it('can make a table in public, and is refused by PostgreSQL when Drizzle alone migrates', async () => {
      await withALesserRole(async (database) => {
        await rowsOf(database, 'CREATE TABLE made_by_the_role (id INTEGER PRIMARY KEY)');

        await assert.rejects(
          database.alone((_, apply) => apply({ migrationsFolder: folderOf([FIRST]), ...APPLIED })),
          /permission denied for database/,
        );
      });
    });
  });

  /**
   * The search path of an address, of a role or of a database once decided where the tables went,
   * and the worker refused one that put another schema first. The worker now sets the search path of
   * each connection itself (FRU-219): the one of somebody else has no effect.
   */
  describe('an address whose search path puts another schema first', { skip: NO_REAL_POSTGRES }, () => {
    /** A database of its own, with a schema `other`, and an address whose search path starts with it. */
    async function withAnotherSchemaFirst(use: (database: Database, address: string) => Promise<void>): Promise<void> {
      const own = await ownDatabase();
      const admin = createPgDatabase(own.url, 'public', { max: 1 });
      const elsewhere = new URL(own.url);
      elsewhere.searchParams.set('options', '-c search_path=other,public');
      const database = createPgDatabase(elsewhere.href, 'public', { max: 2 });
      try {
        await rowsOf(admin, 'CREATE SCHEMA other');
        await use(database, elsewhere.href);
      } finally {
        await database.close();
        await admin.close();
        await own.drop();
      }
    }

    // The control: the address does set the search path, for a client that the worker does not open.
    it('does put that schema first for a connection the worker did not open', async () => {
      await withAnotherSchemaFirst(async (_database, address) => {
        const { default: pg } = await import('pg');
        const client = new pg.Client({ connectionString: address });
        await client.connect();
        try {
          assert.deepEqual((await client.query('SELECT current_schema() AS first')).rows, [{ first: 'other' }]);
        } finally {
          await client.end();
        }
      });
    });

    it('has no effect: every connection of the worker is in its schema, and the tables go there', async () => {
      await withAnotherSchemaFirst(async (database) => {
        assert.deepEqual(await rowsOf(database, 'SELECT current_schema() AS first'), [{ first: 'public' }]);

        await migrate(database);

        assert.equal(await has(database, 'public.sites'), true);
        assert.equal(await has(database, `public.${APPLIED.migrationsTable}`), true);
        assert.deepEqual(await rowsOf(database, `SELECT tablename FROM pg_tables WHERE schemaname = 'other'`), []);
      });
    });
  });

  /**
   * Two workers that start together on an empty database. Each is a process of its own, as two
   * replicas are. `pg_sleep` holds the first migration open long enough for the second process to
   * reach it: 1.5 s, because the two processes do not start at the same instant on a busy machine.
   */
  describe('two processes that start together', { skip: NO_REAL_POSTGRES }, () => {
    const SLOW: Entry = {
      tag: '0000_slow',
      when: 1_000,
      sql: 'SELECT pg_sleep(1.5);\n--> statement-breakpoint\nCREATE TABLE made_once (id INTEGER PRIMARY KEY);\n--> statement-breakpoint\nINSERT INTO made_once VALUES (1);',
    };
    const THEN: Entry = { tag: '0001_then', when: 2_000, sql: 'INSERT INTO made_once VALUES (2);' };

    /** Two processes that migrate one database with `migrate` of this module, at the same moment. */
    async function twoProcesses(module: string, url: string): Promise<PromiseSettledResult<unknown>[]> {
      const script = `
        import { createPgDatabase } from ${JSON.stringify(new URL('./postgres.ts', import.meta.url).href)};
        const { migrate } = await import(process.env.MIGRATE);
        const database = createPgDatabase(process.env.DATABASE, 'public');
        try {
          await migrate(database, process.env.FOLDER);
        } finally {
          await database.close();
        }
      `;
      const start = () =>
        run(process.execPath, ['--input-type=module', '--eval', script], {
          cwd: fileURLToPath(new URL('.', import.meta.url)),
          env: { ...process.env, MIGRATE: module, DATABASE: url, FOLDER: folderOf([SLOW, THEN]) },
        });

      return Promise.allSettled([start(), start()]);
    }

    it('applies each migration once', async () => {
      const own = await ownDatabase();
      try {
        const ended = await twoProcesses(new URL('./postgres-migrate.ts', import.meta.url).href, own.url);
        assert.deepEqual(
          ended.map((end) => end.status),
          ['fulfilled', 'fulfilled'],
          JSON.stringify(ended),
        );

        const database = createPgDatabase(own.url, 'public', { max: 1 });
        assert.deepEqual(await rowsOf(database, 'SELECT id FROM made_once ORDER BY id'), [{ id: 1 }, { id: 2 }]);
        assert.deepEqual(await applied(database), [1_000, 2_000]);
        await database.close();
      } finally {
        await own.drop();
      }
    });

    // The control of the test above: Drizzle takes no lock, so without ours one process fails.
    it('fails for one of the two when nothing holds the lock', async () => {
      const own = await ownDatabase();
      const unlocked = await mutatedModule('postgres-migrate.ts', {
        from: 'await db.execute(sql`SELECT pg_advisory_lock(${MIGRATION_LOCK})`);',
        to: '',
      });
      try {
        const ended = await twoProcesses(unlocked.url, own.url);

        assert.equal(ended.filter((end) => end.status === 'rejected').length, 1, JSON.stringify(ended));
      } finally {
        unlocked.remove();
        await own.drop();
      }
    });
  });
});

describe('the pool of a process (FRU-141)', () => {
  it('is one for an address, however many stores a process builds', async () => {
    // A store is built for each request wherever the transport did not hand one over.
    const first = databaseFor('postgres://u:p@127.0.0.1:1/one', 'public');

    assert.equal(databaseFor('postgres://u:p@127.0.0.1:1/one', 'public'), first);
    assert.notEqual(databaseFor('postgres://u:p@127.0.0.1:1/two', 'public'), first);

    await closeDatabases();
    assert.notEqual(
      databaseFor('postgres://u:p@127.0.0.1:1/one', 'public'),
      first,
      'a closed pool was handed out again',
    );
    await closeDatabases();
  });
});

describe('the address of the database, which holds a password (FRU-141)', () => {
  const SECRET = 'hunter2-not-for-a-log';
  // Port 1 of this machine: nothing listens, so the driver is refused at once.
  const UNREACHABLE = `postgres://fruitback:${SECRET}@127.0.0.1:1/fruitback`;

  it('accepts a postgres address with a host, and nothing else', () => {
    assert.equal(readDatabaseUrl('  postgres://u:p@db:5432/fruitback '), 'postgres://u:p@db:5432/fruitback');
    assert.equal(readDatabaseUrl('postgresql://u:p@db/fruitback'), 'postgresql://u:p@db/fruitback');
    assert.equal(
      readDatabaseUrl('postgres:///fruitback?host=/var/run/postgresql'),
      'postgres:///fruitback?host=/var/run/postgresql',
    );
    for (const refused of [
      undefined,
      '',
      '  ',
      'mysql://u:p@db/fruitback',
      '/data/accounts.db',
      'postgres://',
      'db:5432',
    ]) {
      assert.equal(readDatabaseUrl(refused), undefined, String(refused));
    }
  });

  it('takes the address and its password out of a message', () => {
    const encoded = 'postgres://u:p%40ss%2Fword@db/fruitback';

    assert.equal(withoutAddress(`could not reach ${UNREACHABLE}`, UNREACHABLE), 'could not reach ***');
    assert.equal(withoutAddress(`password "${SECRET}" refused`, UNREACHABLE), 'password "***" refused');
    assert.equal(withoutAddress('password "p@ss/word" refused', encoded), 'password "***" refused');
    assert.equal(withoutAddress('nothing secret here', 'not an address'), 'nothing secret here');
  });

  it('rejects with StoreError, and no word of the address, when the database does not answer', async () => {
    const database = createPgDatabase(UNREACHABLE, 'public');
    const failures: unknown[] = [];
    for (const call of [
      () => database.run((db) => db.execute(sql`SELECT 1`)),
      () => database.transaction((transaction) => transaction.execute(sql`SELECT 1`)),
      () => database.alone((db) => db.execute(sql`SELECT 1`)),
    ]) {
      failures.push(
        await call().then(
          () => undefined,
          (error: unknown) => error,
        ),
      );
    }
    await database.close();

    for (const failure of failures) {
      assert.ok(failure instanceof StoreError, `not a StoreError: ${String(failure)}`);
      assert.equal(failure.message.includes(SECRET), false);
      assert.equal(failure.message.includes('fruitback:'), false);
    }
  });
});

/**
 * Drizzle says of a statement that failed what the statement was, and with which values. A value is
 * an address or a digest, so that sentence must reach no log: the worker reports the error of the
 * driver, which is inside it.
 */
describe('a statement that fails, which Drizzle quotes with its values (FRU-180)', () => {
  const VALUE = 'a-digest-that-is-not-for-a-log';

  it('takes the error of the driver out of the error of Drizzle, and leaves any other error alone', () => {
    const driver = Object.assign(new Error('duplicate key'), { code: '23505' });
    const wrapped = new DrizzleQueryError('INSERT INTO once VALUES ($1)', [VALUE], driver);

    // The control: the sentence of Drizzle holds the value.
    assert.match(wrapped.message, new RegExp(VALUE));
    assert.equal(causeOfQueryError(wrapped), driver);
    assert.equal(causeOfQueryError(driver), undefined);
    assert.equal(causeOfQueryError(new StoreError('The site could not be read back')), undefined);
    assert.equal(causeOfQueryError(undefined), undefined);
  });

  it(
    'answers a statement that the data refuses as an error with its code, not as an outage, and without its values',
    { skip: NO_REAL_POSTGRES },
    async () => {
      const database = await createRealDatabase();
      try {
        await rowsOf(database, 'CREATE TABLE once (id TEXT PRIMARY KEY)');
        await rowsOf(database, sql`INSERT INTO once VALUES (${VALUE})`);

        for (const call of [
          () => database.run((db) => db.execute(sql`INSERT INTO once VALUES (${VALUE})`)),
          () => database.transaction((transaction) => transaction.execute(sql`INSERT INTO once VALUES (${VALUE})`)),
        ]) {
          const failure = await call().then(
            () => undefined,
            (error: unknown) => error,
          );

          assert.ok(failure instanceof Error);
          assert.equal(failure instanceof StoreError, false, 'a constraint was reported as a database that is down');
          assert.equal((failure as { code?: string }).code, '23505');
          assert.equal(failure.message.includes(VALUE), false, failure.message);
          assert.equal(failure.message.includes('INSERT INTO'), false, failure.message);
        }
        // The transaction that failed was rolled back, and its connection serves the next call.
        assert.deepEqual(await rowsOf(database, 'SELECT count(*)::integer AS rows FROM once'), [{ rows: 1 }]);
      } finally {
        await database.close();
      }
    },
  );

  it('leaves an error that a store throws in a transaction as it is, and rolls back', async () => {
    await withPglite(async (database) => {
      await rowsOf(database, 'CREATE TABLE once (id TEXT PRIMARY KEY)');
      const mine = new StoreError('The site could not be read back');

      await assert.rejects(
        database.transaction(async (transaction) => {
          await transaction.execute(sql`INSERT INTO once VALUES (${VALUE})`);
          throw mine;
        }),
        (error: unknown) => error === mine,
      );
      assert.deepEqual(await rowsOf(database, 'SELECT id FROM once'), []);
    });
  });

  it('answers a BIGINT of the schema as a number, on the driver that ships', { skip: NO_REAL_POSTGRES }, async () => {
    const database = await createRealDatabase();
    try {
      await migrated(database);
      const instant = 1_760_000_000_000;
      await database.run((db) =>
        db.insert(pairings).values({ code_hash: 'digest', subject: 'acc_1', created_at: instant, expires_at: instant }),
      );

      const rows = await database.run((db) =>
        db.select({ created_at: pairings.created_at }).from(pairings).where(eq(pairings.code_hash, 'digest')),
      );

      assert.deepEqual(rows, [{ created_at: instant }]);
    } finally {
      await database.close();
    }
  });
});

/**
 * A test that is skipped proves nothing, so the CI job that has a server says so: with
 * `FRUITBACK_TEST_POSTGRES=required` a missing address fails here, and the skips above cannot pass
 * for a run on a real PostgreSQL.
 */
/**
 * The database of a case is dropped when its connections have ended, not while they end (FRU-196).
 *
 * A pool of `pg` with no listener, as `postgres-numbers.test.ts` makes one: an error on one of its
 * connections is an unhandled error of the process, and `node:test` gives it to the test that runs.
 * Here the pool has a listener that counts. Eight connections, so that one at least is still on the
 * server when `end()` answers.
 */
describe('the database of a case, when it is dropped (FRU-196)', { skip: NO_REAL_POSTGRES }, () => {
  /** How many connections of a pool that has ended read an error, when its database is dropped. */
  async function errorsOfAnEndedPool(how: 'drop' | 'dropAtOnce'): Promise<number> {
    const own = await ownDatabase();
    const pool = new pg.Pool({ connectionString: own.url, max: 8 });
    let errors = 0;
    pool.on('error', () => (errors += 1));
    await Promise.all(Array.from({ length: 8 }, () => pool.query('SELECT pg_sleep(0.01)')));

    await pool.end();
    await own[how]();
    // The error of a connection that the server ended comes on its socket, after the answer of the DROP.
    await new Promise((resolve) => setTimeout(resolve, 50));

    return errors;
  }

  it('ends no connection of a pool that has just ended', async () => {
    for (let round = 0; round < 10; round += 1) {
      assert.equal(await errorsOfAnEndedPool('drop'), 0, `round ${round}`);
    }
  });

  // The control: with no wait, the DROP meets a connection that is still there. Measured on 17.11:
  // at the first round, every time. Ten rounds at most, so that one slow server does not fail it.
  it('ended one when it did not wait, which is what failed a test in CI', async () => {
    let errors = 0;
    for (let round = 0; round < 10 && errors === 0; round += 1) errors += await errorsOfAnEndedPool('dropAtOnce');

    assert.ok(errors > 0, 'ten databases were dropped at once, and no connection of an ended pool read an error');
  });
});

describe('the PostgreSQL of the tests', () => {
  it('has a real server when the run requires one', () => {
    if (process.env.FRUITBACK_TEST_POSTGRES !== 'required') return;

    assert.ok(
      TEST_DATABASE_URL !== undefined,
      'FRUITBACK_TEST_POSTGRES=required, and FRUITBACK_TEST_DATABASE_URL is not set',
    );
  });
});
