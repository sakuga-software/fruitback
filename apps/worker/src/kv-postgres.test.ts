import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { handleRequest, kvFor } from './app.ts';
import { KvError, processKv } from './kv.ts';
import { KV_TABLE, createPostgresKv } from './kv-postgres.ts';
import { type Database, createPgDatabase } from './postgres.ts';
import { NO_REAL_POSTGRES, createPgliteDatabase, ownDatabase, rowsOf } from './postgres.fixture.ts';
import { migrated } from './postgres-migrate.ts';
import { StoreError } from './store.ts';
import { beforePostgres } from './before-postgres.fixture.ts';

/**
 * What the `Kv` of the database does that the contract of `kv.test.ts` cannot see (FRU-67): two
 * connections that count at once, a commit that does not wait and stays in its statement, the sweep,
 * and an outage.
 *
 * **The two first run on a real server only**, the job « postgres » of CI: PGlite is one process and
 * one connection, so it can show neither a race nor what a pool does with a setting.
 */

const key = () => `fruitback:test:${randomUUID()}`;

/** `database`, and every row its statements answered, in order. */
function watched(database: Database): { database: Database; answers: Record<string, unknown>[][] } {
  const answers: Record<string, unknown>[][] = [];

  return {
    answers,
    database: {
      ...database,
      async run(work) {
        const answer = await database.run(work);
        answers.push((answer as { rows?: Record<string, unknown>[] }).rows ?? []);

        return answer;
      },
    },
  };
}

describe('two replicas that count at once, on a real server (FRU-67)', { skip: NO_REAL_POSTGRES }, () => {
  /** Two pools of one connection each, on one database: two replicas, as far as the server can tell. */
  async function twoReplicas() {
    const own = await ownDatabase();
    const databases = [
      createPgDatabase(own.url, 'public', { max: 1 }),
      createPgDatabase(own.url, 'public', { max: 1 }),
    ] as const;
    await migrated(databases[0]);

    return {
      databases,
      stores: databases.map((database) => createPostgresKv(database)),
      async close() {
        await Promise.all(databases.map((database) => database.close()));
        await own.drop();
      },
    };
  }

  it('gives each of 400 counts of one key to one caller, from two connections', async () => {
    const { stores, close } = await twoReplicas();
    const k = key();

    try {
      const counts = (
        await Promise.all(
          stores.map(async (kv) => {
            const mine: number[] = [];
            for (let i = 0; i < 200; i += 1) mine.push(await kv.incr(k, 60_000));

            return mine;
          }),
        )
      ).flat();

      // Every count from 1 to 400, once: none lost, and none given twice.
      assert.deepEqual(
        counts.toSorted((a, b) => a - b),
        Array.from({ length: 400 }, (_, index) => index + 1),
      );
      assert.equal(await stores[0]?.get(k), '400');
    } finally {
      await close();
    }
  });

  it('answers 1 to one of two callers that hold the same seed at the same moment, each time', async () => {
    // `incr` === 1 is how a batch holds a seed: two attempts of one batch must not both hold it.
    const { stores, close } = await twoReplicas();

    try {
      for (let round = 0; round < 100; round += 1) {
        const k = key();
        const answers = await Promise.all(stores.map((kv) => kv.incr(k, 60_000)));
        assert.deepEqual(answers.toSorted(), [1, 2], `round ${round}`);
      }
    } finally {
      await close();
    }
  });

  it('starts an expired count again once, when two callers count it at the same moment', async () => {
    const { stores, databases, close } = await twoReplicas();

    try {
      for (let round = 0; round < 50; round += 1) {
        const k = key();
        await rowsOf(databases[0], `INSERT INTO ${KV_TABLE} (key, value, expires_at) VALUES ('${k}', '41', 1)`);
        const answers = await Promise.all(stores.map((kv) => kv.incr(k, 60_000)));
        assert.deepEqual(answers.toSorted(), [1, 2], `round ${round}`);
      }
    } finally {
      await close();
    }
  });
});

describe(
  'a write of the Kv that does not wait for the disk, on a real server (FRU-67)',
  { skip: NO_REAL_POSTGRES },
  () => {
    // `public`, and a schema of its own (FRU-219): the Kv writes in the schema of its worker, and its
    // `SET LOCAL` leaves the search path that the pool set as it was.
    const writesWithoutWaiting = async (schema: string): Promise<void> => {
      const own = await ownDatabase();
      // One connection: every statement below runs on it, and the pids say so.
      const pool = createPgDatabase(own.url, schema, { max: 1 });
      const { database, answers } = watched(pool);
      const setting = async () => (await rowsOf(pool, 'SHOW synchronous_commit'))[0]?.synchronous_commit;
      const pid = async () => (await rowsOf(pool, 'SELECT pg_backend_pid() AS pid'))[0]?.pid;

      try {
        await migrated(pool);
        const ofTheServer = await setting();
        const connection = await pid();
        assert.notEqual(ofTheServer, 'off', 'the control needs a server that waits for the disk by default');
        const kv = createPostgresKv(database);
        const k = key();

        for (const write of [() => kv.incr(k, 60_000), () => kv.set(key(), 'x', 60_000), () => kv.incr(k, 60_000, 3)]) {
          answers.length = 0;
          await write();
          // The control: the statement of the store did commit without waiting. It says so itself.
          assert.equal(answers[0]?.[0]?.commits, 'off', 'the write of the Kv waited for the disk');
          // And the connection it ran on is as the server set it.
          assert.equal(await setting(), ofTheServer);
        }

        // A write of another store on that connection waits, as before: what its own transaction reads.
        const [written] = await rowsOf(
          pool,
          `INSERT INTO "user" (id, name, email, "emailVerified")
         VALUES ('u_1', 'Alice', 'alice@acme.dev', true)
         RETURNING current_setting('synchronous_commit') AS commits, pg_backend_pid() AS pid`,
        );
        assert.equal(written?.commits, ofTheServer);
        assert.equal(written?.pid, connection, 'the account was not written on the connection of the Kv');
        assert.equal(await pid(), connection);
        // Where the rows are: the table of the schema, and no other.
        assert.deepEqual(await rowsOf(pool, "SELECT array_to_string(current_schemas(false), ',') AS path"), [
          { path: schema },
        ]);
        assert.deepEqual(
          (await rowsOf(pool, `SELECT schemaname FROM pg_tables WHERE tablename = 'kv'`)).map((row) => row.schemaname),
          [schema],
        );
        assert.deepEqual(await rowsOf(pool, `SELECT count(*)::int AS n FROM "${schema}".kv`), [{ n: 2 }]);
      } finally {
        await pool.close();
        await own.drop();
      }
    };

    it('commits without waiting in its own statement, and leaves the connection as the server set it', () =>
      writesWithoutWaiting('public'));

    it('does the same in a schema of its own, and writes in its table (FRU-219)', () =>
      writesWithoutWaiting('fruitback'));
  },
);

describe('the Kv of the database (FRU-67)', () => {
  /** A row planted beside the store, with an instant of the clock of the database. */
  const plant = (database: Database, k: string, agoMs: number) =>
    rowsOf(
      database,
      `INSERT INTO ${KV_TABLE} (key, value, expires_at)
       VALUES ('${k}', 'x', (extract(epoch FROM clock_timestamp()) * 1000)::bigint - ${agoMs})`,
    );
  const kept = async (database: Database) =>
    (await rowsOf(database, `SELECT key FROM ${KV_TABLE} ORDER BY expires_at`)).map((row) => String(row.key));

  it('removes expired rows as calls come, a batch at a time, and leaves the live ones', async () => {
    const database = await createPgliteDatabase();

    try {
      await migrated(database);
      for (let i = 0; i < 7; i += 1) await plant(database, `gone:${i}`, 1_000 * (10 - i));
      await plant(database, 'live', -60_000);
      let at = 1_000_000;
      const kv = createPostgresKv(database, { now: () => at, sweepEveryMs: 10_000, sweepBatch: 3 });

      // A read sweeps too: a page served from the cache only reads.
      assert.equal(await kv.get('live'), 'x');
      assert.deepEqual(
        await kept(database),
        ['gone:3', 'gone:4', 'gone:5', 'gone:6', 'live'],
        'the oldest three go first',
      );
      // A full batch says there are more: the next call sweeps again, before the interval.
      await kv.get('live');
      assert.deepEqual(await kept(database), ['gone:6', 'live']);
      await kv.get('live');
      assert.deepEqual(await kept(database), ['live']);

      // A batch that was not full ends the hurry: nothing is looked for until the interval has passed.
      await plant(database, 'gone:late', 1_000);
      at += 9_999;
      await kv.get('live');
      assert.deepEqual(await kept(database), ['gone:late', 'live']);
      at += 1;
      await kv.get('live');
      assert.deepEqual(await kept(database), ['live']);
    } finally {
      await database.close();
    }
  });

  it('reads an expired row as absent before any sweep removed it', async () => {
    const database = await createPgliteDatabase();

    try {
      await migrated(database);
      await plant(database, 'gone', 1);
      // A sweep that never comes: the statement itself must not answer the row.
      const kv = createPostgresKv(database, { now: () => 0, sweepEveryMs: Number.MAX_SAFE_INTEGER });
      await kv.get('warm');

      assert.equal(await kv.get('gone'), undefined);
      assert.equal(await kv.incr('gone', 60_000), 1, 'a count on an expired row starts again');
      assert.deepEqual(await kept(database), ['gone'], 'the row was never removed, only written again');
    } finally {
      await database.close();
    }
  });

  it('rejects with KvError when the database does not answer, and quotes no address', async () => {
    const down: Database = {
      schema: 'public',
      run: async () => {
        throw new StoreError('PostgreSQL did not answer: connect ECONNREFUSED');
      },
      transaction: async () => {
        throw new Error('the Kv opens no transaction');
      },
      alone: async () => {
        throw new StoreError('PostgreSQL did not answer: connect ECONNREFUSED');
      },
      close: async () => {},
    };
    const kv = createPostgresKv(down);

    for (const call of [() => kv.get('k'), () => kv.set('k', 'v', 1_000), () => kv.incr('k', 1_000)]) {
      await assert.rejects(
        call(),
        (error: unknown) => error instanceof KvError && !/postgres:\/\//.test(error.message),
      );
    }
  });

  it('names its table through the schema, and opens no transaction', () => {
    // The schema of the tables is to become a setting (FRU-219): a name written in a statement would
    // not follow it. And a statement of this store inside a transaction would make the whole
    // transaction commit without waiting.
    const source = readFileSync(new URL('./kv-postgres.ts', import.meta.url), 'utf8');
    const statements = source
      .split('sql`')
      .slice(1)
      .map((rest) => rest.slice(0, rest.indexOf('`')));

    assert.ok(statements.length >= 6);
    for (const statement of statements) {
      assert.doesNotMatch(
        statement,
        /\bpublic\b|"kv"|\bkv\b(?!\.)/i,
        `a statement names a table or a schema: ${statement}`,
      );
    }
    assert.doesNotMatch(source, /\.transaction\(|\.alone\(/);
  });
});

describe('which Kv a worker runs on (FRU-67)', () => {
  const base = beforePostgres({ FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: 'https://app.fruitback.test' });

  it('changes nothing for a worker with no database: the store of the process, the very instance', () => {
    assert.equal(kvFor({ databaseSchema: 'public' }), processKv());
    assert.equal(kvFor({ databaseUrl: undefined, databaseSchema: 'public' }), processKv());
  });

  it('keeps the state in the database of a worker that has one, with one instance for the process', () => {
    const url = 'postgres://fruitback:not-a-password@127.0.0.1:1/fruitback';

    const of = (databaseSchema: string) => kvFor({ databaseUrl: url, databaseSchema });

    assert.notEqual(of('public'), processKv());
    assert.equal(of('public'), of('public'));
    // Two schemas of one database are two workers (FRU-219): each has its Kv, in its schema.
    assert.notEqual(of('fruitback'), of('public'));
    assert.equal(of('fruitback'), of('fruitback'));
  });

  it('answers a worker with no database from memory, with no variable to set', async () => {
    const answer = await handleRequest(
      new Request('https://worker.fruitback.dev/feedback?url=https%3A%2F%2Fapp.fruitback.test%2F', {
        headers: { Origin: 'https://app.fruitback.test' },
      }),
      base,
      { clientIp: '203.0.113.9' },
    );

    assert.equal(answer.status, 200);
  });
});
