import { after } from 'node:test';
import { PGlite, types } from '@electric-sql/pglite';
import type { Subject } from './conformance.fixture.ts';
import { type Database, type Queryable, type Row, createPgDatabase } from './postgres.ts';

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
