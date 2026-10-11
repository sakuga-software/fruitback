import assert from 'node:assert/strict';
import { after } from 'node:test';
import { PGlite, types } from '@electric-sql/pglite';
import { type Cases, type Subject, collect, mutatedModule } from './conformance.fixture.ts';
import { type Database, type Queryable, type Row, createPgDatabase } from './postgres.ts';
import { migrated } from './postgres-migrations.ts';

/**
 * A PostgreSQL for the tests (FRU-141), in two forms.
 *
 * **PGlite** is a PostgreSQL in the process: `node --test` needs no service. It has one connection,
 * so a transaction holds every other call back, and no race can show there.
 *
 * **A real server** is the address in `FRUITBACK_TEST_DATABASE_URL`. There the calls of a case run
 * on several connections of a pool, and the code that ships (`createPgDatabase`) is what answers.
 * The CI job `postgres` sets the address, and fails when it is missing.
 */

export const TEST_DATABASE_URL = process.env.FRUITBACK_TEST_DATABASE_URL || undefined;

/** The reason a subject on a real server is skipped, or `false`. */
export const NO_REAL_POSTGRES: string | false =
  TEST_DATABASE_URL === undefined ? 'FRUITBACK_TEST_DATABASE_URL is not set: the CI job « postgres » sets it' : false;

let counter = 0;

/** A name for a schema that no other case, and no other process on the same server, has. */
export function schemaName(): string {
  counter += 1;

  return `t_${process.pid}_${Date.now().toString(36)}_${counter}`;
}

/** The PGlite of this process. It takes a second to start, so the cases share it. */
let shared: PGlite | undefined;

function pglite(): PGlite {
  shared ??= new PGlite({ parsers: { [types.INT8]: (value: string) => Number(value) } });

  return shared;
}

// An open instance keeps the process of a test file alive for ten seconds after its last test (measured).
after(async () => {
  await shared?.close();
  shared = undefined;
});

type PgliteQueryable = Pick<PGlite, 'query' | 'exec'>;

function on(client: PgliteQueryable): Queryable {
  return {
    async query(text, values) {
      if (values === undefined) {
        // Several statements, as the driver of the worker accepts them: the last one is the answer.
        const results = await client.exec(text);
        const last = results.at(-1);

        return { rows: (last?.rows ?? []) as Row[], rowCount: last?.affectedRows ?? 0 };
      }
      const result = await client.query(text, [...values]);

      return { rows: result.rows as Row[], rowCount: result.affectedRows ?? 0 };
    },
  };
}

/**
 * An empty database on PGlite: a new schema of the shared instance. `close` drops it.
 *
 * One connection, so `SET search_path` holds for every call until the next case sets its own.
 */
export async function createPgliteDatabase(): Promise<Database> {
  const instance = pglite();
  const schema = schemaName();
  await instance.exec(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};`);

  return {
    ...on(instance),
    transaction: (run) => instance.transaction((transaction) => run(on(transaction))) as never,
    async close() {
      await instance.exec(`SET search_path TO public; DROP SCHEMA ${schema} CASCADE;`);
    },
  };
}

/** An empty database on the real server: a new schema, and a pool whose connections are in it. */
export async function createRealDatabase(): Promise<Database> {
  if (TEST_DATABASE_URL === undefined) throw new Error('FRUITBACK_TEST_DATABASE_URL is not set');
  const schema = schemaName();
  const admin = createPgDatabase(TEST_DATABASE_URL, { max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const database = createPgDatabase(TEST_DATABASE_URL, { schema });

  return {
    ...database,
    async close() {
      await database.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.close();
    },
  };
}

/** A store on a new empty database for each case. */
export function onDatabase<Store>(
  label: string,
  factory: string,
  open: () => Promise<Database>,
  create: (database: Database) => Store,
  skip: string | false = false,
): Subject<Store> {
  let database: Database | undefined;

  return {
    factory,
    label,
    ...(skip === false ? {} : { skip }),
    async open() {
      database = await open();

      return create(database);
    },
    async close() {
      await database?.close();
      database = undefined;
    },
  };
}

/** How long the database holds a new row before it writes it, in the tests that plant a race. */
const HOLD_SECONDS = 0.3;

/**
 * What a case answers on a store with one change, on this database: `'passed'`, or its failure.
 *
 * **A race that is left to chance is a control that fails one run in a few.** Two calls overlap only
 * when the scheduler lets them, and a store that loses the race then passes. CI showed it: the same
 * control passed on one head and failed on the next one, which changed one line of a document. So
 * the overlap is made here, as `pg_sleep` makes it for the migrations of two processes:
 *
 * - a trigger holds each new row of `held` for `HOLD_SECONDS` before it is written, inside the
 *   transaction, so the first call has not committed when the second one reads;
 * - the two connections are open before the case starts, so the second call does not wait for one.
 */
export async function outcomeOnChangedStore<Store>(input: {
  /** The file of the store, and the function of it that builds one. */
  file: string;
  factory: string;
  cases: Cases<Store>;
  /** The name of the case to run. */
  name: string;
  change: { from: string; to: string };
  held: { table: string; when?: string };
  open: () => Promise<Database>;
}): Promise<unknown> {
  const mutant = await mutatedModule(input.file, input.change);
  const opened = await input.open();
  const create = mutant.module[input.factory] as (database: Database) => Store;
  try {
    const runCase = collect(input.cases).get(input.name);
    assert.ok(runCase !== undefined, 'the case is gone');

    await migrated(opened);
    await opened.query(`
      CREATE FUNCTION hold_the_row() RETURNS trigger LANGUAGE plpgsql
        AS $$ BEGIN PERFORM pg_sleep(${HOLD_SECONDS}); RETURN NEW; END $$;
      CREATE TRIGGER hold_the_row BEFORE INSERT ON ${input.held.table} FOR EACH ROW
        ${input.held.when === undefined ? '' : `WHEN (${input.held.when})`} EXECUTE FUNCTION hold_the_row();
    `);
    await Promise.all([opened.query('SELECT 1'), opened.query('SELECT 1')]);

    return await runCase(create(opened)).then(
      () => 'passed',
      (error: unknown) => error,
    );
  } finally {
    await opened.close();
    mutant.remove();
  }
}
