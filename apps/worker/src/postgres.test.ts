import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  type Database,
  type Migration,
  closeDatabases,
  createPgDatabase,
  databaseFor,
  migrate,
  readDatabaseUrl,
  withoutAddress,
} from './postgres.ts';
import {
  NO_REAL_POSTGRES,
  TEST_DATABASE_URL,
  createPgliteDatabase,
  createRealDatabase,
  schemaName,
} from './postgres.fixture.ts';
import { MIGRATIONS } from './postgres-migrations.ts';
import { StoreError } from './store.ts';

const run = promisify(execFile);

const FIRST: Migration = { name: 'first', sql: 'CREATE TABLE first_things (id INTEGER PRIMARY KEY);' };
const SECOND: Migration = {
  name: 'second',
  sql: 'CREATE TABLE second_things (id INTEGER PRIMARY KEY); INSERT INTO second_things VALUES (1);',
};

async function applied(database: Database): Promise<unknown[]> {
  return (await database.query('SELECT version, name FROM schema_migrations ORDER BY version')).rows;
}

async function withPglite(use: (database: Database) => Promise<void>): Promise<void> {
  const database = await createPgliteDatabase();
  try {
    await use(database);
  } finally {
    await database.close();
  }
}

describe('the migrations of the PostgreSQL database (FRU-141)', () => {
  it('applies each migration once, in order, and writes its number and its name', async () => {
    await withPglite(async (database) => {
      await migrate(database, [FIRST]);
      assert.deepEqual(await applied(database), [{ version: 1, name: 'first' }]);

      // A build with one migration more: the first is not run again, or CREATE TABLE would fail.
      await migrate(database, [FIRST, SECOND]);
      await migrate(database, [FIRST, SECOND]);

      assert.deepEqual(await applied(database), [
        { version: 1, name: 'first' },
        { version: 2, name: 'second' },
      ]);
      assert.deepEqual((await database.query('SELECT id FROM second_things')).rows, [{ id: 1 }]);
    });
  });

  it('refuses a list in which an entry that shipped was edited', async () => {
    await withPglite(async (database) => {
      await migrate(database, [FIRST]);

      await assert.rejects(migrate(database, [{ ...SECOND, name: 'renamed' }]), (error: unknown) => {
        assert.ok(error instanceof StoreError);
        assert.match(error.message, /Migration 1 .*« first ».*« renamed »/);

        return true;
      });
    });
  });

  it('leaves nothing of a migration that fails, and keeps the ones before it', async () => {
    await withPglite(async (database) => {
      const broken: Migration = {
        name: 'broken',
        sql: 'CREATE TABLE half_made (id INTEGER PRIMARY KEY); CREATE TABLE first_things (id INTEGER);',
      };

      await assert.rejects(migrate(database, [FIRST, broken]));

      assert.deepEqual(await applied(database), [{ version: 1, name: 'first' }]);
      await assert.rejects(database.query('SELECT 1 FROM half_made'), /half_made/);
    });
  });

  it('leaves a database alone that holds more migrations than the build', async () => {
    await withPglite(async (database) => {
      await migrate(database, [FIRST, SECOND]);

      // The image of before, after a roll back.
      await migrate(database, [FIRST]);

      assert.equal((await applied(database)).length, 2);
    });
  });

  it('gives every migration a name of its own', () => {
    const names = MIGRATIONS.map((migration) => migration.name);

    assert.deepEqual([...new Set(names)], names);
    assert.ok(names.every((name) => name !== ''));
  });

  /**
   * Two workers that start together on an empty database. Each is a process of its own, as two
   * replicas are. `pg_sleep` holds the first migration open long enough for the second process to
   * reach it. Without the advisory lock, both read « not applied » and the second `CREATE TABLE`
   * fails: measured, by removing the lock.
   */
  it('applies each migration once when two processes start together', { skip: NO_REAL_POSTGRES }, async () => {
    const schema = schemaName();
    const admin = createPgDatabase(TEST_DATABASE_URL as string, { max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const script = `
      import { createPgDatabase, migrate } from ${JSON.stringify(new URL('./postgres.ts', import.meta.url).href)};
      const database = createPgDatabase(process.env.FRUITBACK_TEST_DATABASE_URL, { schema: process.env.SCHEMA });
      await migrate(database, [
        { name: 'slow', sql: 'SELECT pg_sleep(0.4); CREATE TABLE made_once (id INTEGER PRIMARY KEY); INSERT INTO made_once VALUES (1);' },
        { name: 'after', sql: 'INSERT INTO made_once VALUES (2);' },
      ]);
      await database.close();
    `;
    const start = () =>
      run(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: fileURLToPath(new URL('.', import.meta.url)),
        env: { ...process.env, SCHEMA: schema },
      });

    try {
      await Promise.all([start(), start()]);

      const inSchema = createPgDatabase(TEST_DATABASE_URL as string, { schema, max: 1 });
      assert.deepEqual((await inSchema.query('SELECT id FROM made_once ORDER BY id')).rows, [{ id: 1 }, { id: 2 }]);
      assert.deepEqual(await applied(inSchema), [
        { version: 1, name: 'slow' },
        { version: 2, name: 'after' },
      ]);
      await inSchema.close();
    } finally {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.close();
    }
  });
});

describe('the pool of a process (FRU-141)', () => {
  it('is one for an address, however many stores a process builds', async () => {
    // A store is built for each request wherever the transport did not hand one over.
    const first = databaseFor('postgres://u:p@127.0.0.1:1/one');

    assert.equal(databaseFor('postgres://u:p@127.0.0.1:1/one'), first);
    assert.notEqual(databaseFor('postgres://u:p@127.0.0.1:1/two'), first);

    await closeDatabases();
    assert.notEqual(databaseFor('postgres://u:p@127.0.0.1:1/one'), first, 'a closed pool was handed out again');
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
    const database = createPgDatabase(UNREACHABLE);
    const failures: unknown[] = [];
    for (const call of [
      () => database.query('SELECT 1'),
      () => database.transaction(async (transaction) => transaction.query('SELECT 1')),
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

  it(
    'answers a statement that the data refuses as an error with its code, not as an outage',
    { skip: NO_REAL_POSTGRES },
    async () => {
      const database = await createRealDatabase();
      try {
        await database.query('CREATE TABLE once (id INTEGER PRIMARY KEY); INSERT INTO once VALUES (1);');

        const failure = await database.query('INSERT INTO once VALUES ($1)', [1]).then(
          () => undefined,
          (error: unknown) => error,
        );

        assert.ok(failure instanceof Error);
        assert.equal(failure instanceof StoreError, false, 'a constraint was reported as a database that is down');
        assert.equal((failure as { code?: string }).code, '23505');
      } finally {
        await database.close();
      }
    },
  );

  it('answers a BIGINT as a number, on the driver that ships', { skip: NO_REAL_POSTGRES }, async () => {
    const database = await createRealDatabase();
    try {
      const { rows } = await database.query('SELECT $1::bigint AS instant, 7::integer AS count', [1_760_000_000_000]);

      assert.deepEqual(rows, [{ instant: 1_760_000_000_000, count: 7 }]);
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
describe('the PostgreSQL of the tests', () => {
  it('has a real server when the run requires one', () => {
    if (process.env.FRUITBACK_TEST_POSTGRES !== 'required') return;

    assert.ok(
      TEST_DATABASE_URL !== undefined,
      'FRUITBACK_TEST_POSTGRES=required, and FRUITBACK_TEST_DATABASE_URL is not set',
    );
  });
});
