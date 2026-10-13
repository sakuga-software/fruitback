import type { MigrationConfig } from 'drizzle-orm/migrator';
import type { PgDatabase as Drizzle, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { Pool, PoolClient } from 'pg';
import { StoreError } from './store.ts';

/**
 * PostgreSQL as the worker speaks to it (FRU-141), through Drizzle (FRU-180).
 *
 * `Database` is the seam: `createPgDatabase` is the one implementation that ships, on a `Pool` of
 * `pg`, and the tests have another on PGlite, a PostgreSQL in the process. A store writes its
 * statements with the `Db` that the seam hands it, and never opens a connection.
 *
 * **This file imports `pg` and Drizzle as types only, and loads them at the first call.** A worker
 * without `FRUITBACK_DATABASE_URL` loads nothing of PostgreSQL and opens nothing.
 *
 * **No message here holds the address of the database.** It carries the password.
 *
 * **No message here holds what Drizzle says of a statement that failed.** Its error quotes the
 * statement and its values: an address, a digest. `causeOfQueryError` takes the error of the driver
 * out of it, and only that one is read.
 */

/** Drizzle, on a pool or on one connection. A store writes its statements with it. */
export type Db = Drizzle<PgQueryResultHKT>;

/** `migrate` of Drizzle for one driver, on one connection. */
export type Migrator = (config: MigrationConfig) => Promise<void>;

export type Database = {
  /** `work` on the database. Two statements of one `work` may run on two connections. */
  run<T>(work: (db: Db) => Promise<T>): Promise<T>;
  /** `work` on one connection, in one transaction. It is rolled back when `work` rejects. */
  transaction<T>(work: (db: Db) => Promise<T>): Promise<T>;
  /**
   * `work` on one connection, in no transaction: what a lock of the session needs. `migrate` applies
   * a folder of migrations on that connection.
   */
  alone<T>(work: (db: Db, migrate: Migrator) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

/** The pool of `pg`, for the one file that may name the driver. */
export type PgPool = Pool;

/**
 * A database that is on a pool of `pg`, and can hand that pool over (FRU-144).
 *
 * better-auth takes a pool and writes its own queries. It gets the pool of the process: one pool for
 * a database, whoever reads it. Nothing else may take it: a store goes through `run` and
 * `transaction`, which take the address out of every message.
 */
export type PgDatabase = Database & { pool(): Promise<PgPool> };

/** SQLSTATE classes 22 and 23: the statement is wrong for the data. The database answered. */
function isStatementError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;

  return typeof code === 'string' && /^2[23]/.test(code);
}

/**
 * The error of the driver inside the error of Drizzle, or `undefined` for any other error.
 *
 * Drizzle throws `DrizzleQueryError` for a statement that failed. Its message is the statement and
 * its values, so it must reach no log. It is read by its shape: this file loads nothing of Drizzle.
 */
export function causeOfQueryError(error: unknown): unknown {
  const wrapped = error as { query?: unknown; params?: unknown; cause?: unknown } | null;

  return typeof wrapped?.query === 'string' && Array.isArray(wrapped.params) ? wrapped.cause : undefined;
}

/**
 * The words of an error, with the address and its password taken out.
 *
 * The driver does not write them in its messages today. A message that did would reach a log.
 */
export function withoutAddress(message: string, url: string): string {
  let password = '';
  try {
    password = decodeURIComponent(new URL(url).password);
  } catch {
    password = '';
  }
  const secrets = [url, password].filter((secret) => secret.length > 0);

  return secrets.reduce((text, secret) => text.replaceAll(secret, '***'), message);
}

/**
 * The address as the worker accepts it, or `undefined`.
 *
 * `undefined` and never the reason: a reason that quotes the value would put the password in the
 * boot log and on `/health`.
 */
export function readDatabaseUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return undefined;
    if (url.hostname === '' && !url.searchParams.has('host')) return undefined;

    return value.trim();
  } catch {
    return undefined;
  }
}

type Opened = {
  pool: Pool;
  /** Drizzle on the pool: each statement takes a connection, and gives it back. */
  db: Db;
  /** Drizzle on one connection, and `migrate` of Drizzle on it. */
  on(client: PoolClient): { db: Db; migrate: Migrator };
};

/**
 * A database on a `Pool` of `pg`.
 *
 * The tables are in the schema `public`: the migrations that `drizzle-kit` writes name it in every
 * foreign key. A test that needs an empty database makes a database, not a schema.
 */
export function createPgDatabase(url: string, options: { max?: number } = {}): PgDatabase {
  let opening: Promise<Opened> | undefined;

  const open = (): Promise<Opened> => {
    opening ??= Promise.all([
      import('pg'),
      import('drizzle-orm/node-postgres'),
      import('drizzle-orm/node-postgres/migrator'),
    ]).then(([{ default: pg }, { drizzle }, { migrate }]) => {
      const pool = new pg.Pool({
        connectionString: url,
        max: options.max ?? 10,
        connectionTimeoutMillis: 5_000,
      });
      // A connection that the server closes emits `error`. With no listener, the process stops (FRU-187).
      // The pool listens to a connection only while it is idle. A connection that a transaction, a
      // migration or better-auth holds has no listener of the pool, so each connection gets this one
      // for its life. The call that used it rejects with its own error.
      pool.on('connect', (client) => {
        client.on('error', (error) => {
          console.error(`[fruitback] a PostgreSQL connection failed: ${withoutAddress(String(error), url)}`);
        });
      });
      // The pool sends the error of an idle connection here too. The listener above wrote it already.
      pool.on('error', () => {});

      return {
        pool,
        db: drizzle({ client: pool }),
        on(client) {
          const db = drizzle({ client });

          return { db, migrate: (config) => migrate(db, config) };
        },
      };
    });

    return opening;
  };

  /** What the driver said, as the worker reports it: a statement the data refuses, or an outage. */
  const failure = (error: unknown): Error => {
    const message = withoutAddress(error instanceof Error ? error.message : String(error), url);
    if (isStatementError(error)) {
      return Object.assign(new Error(`PostgreSQL refused a statement: ${message}`), {
        code: (error as { code: string }).code,
      });
    }

    return new StoreError(`PostgreSQL did not answer: ${message}`);
  };

  /** An error of `work`: the one of the driver is reported, and any other one is left as it is. */
  const reported = (error: unknown): unknown => {
    const cause = causeOfQueryError(error);

    return cause === undefined ? error : failure(cause);
  };

  /** The pool, and one connection of it. */
  const connect = async (): Promise<{ opened: Opened; client: PoolClient }> => {
    try {
      const opened = await open();

      return { opened, client: await opened.pool.connect() };
    } catch (error) {
      throw failure(error);
    }
  };

  /** One statement of this file, on one connection. */
  const ask = async (client: PoolClient, text: string): Promise<void> => {
    try {
      await client.query(text);
    } catch (error) {
      throw failure(error);
    }
  };

  return {
    async pool() {
      try {
        return (await open()).pool;
      } catch (error) {
        throw failure(error);
      }
    },

    async run(work) {
      let opened: Opened;
      try {
        opened = await open();
      } catch (error) {
        throw failure(error);
      }

      try {
        return await work(opened.db);
      } catch (error) {
        throw reported(error);
      }
    },

    async transaction(work) {
      const { opened, client } = await connect();

      try {
        await ask(client, 'BEGIN');
        const result = await work(opened.on(client).db);
        await ask(client, 'COMMIT');
        client.release();

        return result;
      } catch (error) {
        // A connection that cannot roll back is not given to the next caller.
        const broken = await client.query('ROLLBACK').then(
          () => false,
          () => true,
        );
        client.release(broken);
        throw reported(error);
      }
    },

    async alone(work) {
      const { opened, client } = await connect();
      const { db, migrate } = opened.on(client);

      try {
        const result = await work(db, migrate);
        client.release();

        return result;
      } catch (error) {
        // The connection is closed, and not given back: whatever the session held ends with it.
        client.release(true);
        throw reported(error);
      }
    },

    async close() {
      if (opening === undefined) return;
      const opened = await opening.catch(() => undefined);
      opening = undefined;
      await opened?.pool.end();
    },
  };
}

/**
 * One pool for each address, for the life of the process.
 *
 * The stores are built for each request wherever the transport did not hand one over, as the SQLite
 * ones are: the pool must not be.
 */
const databases = new Map<string, PgDatabase>();

export function databaseFor(url: string): PgDatabase {
  const known = databases.get(url);
  if (known !== undefined) return known;
  // The address of the switch names no server: `dev-worker.fixture.ts` gives its database before the first call.
  if (url === DEV_DATABASE_URL) {
    throw new StoreError(
      'FRUITBACK_DEV_DATABASE is set, and this process has no database of its own: start the worker with `pnpm dev` (src/dev-worker.fixture.ts)',
    );
  }

  const database = createPgDatabase(url);
  databases.set(url, database);

  return database;
}

/**
 * The database of development, in the process (FRU-223).
 *
 * `FRUITBACK_DEV_DATABASE=pglite` is the switch: the worker then has the database that `dev-worker.fixture.ts`
 * made, a PGlite, in place of the one of `FRUITBACK_DATABASE_URL`. `pnpm dev` and the E2E suite
 * start that way, with no server to install. **Refused under `NODE_ENV=production`** (`readConfig`),
 * as the store `memory` is: the image sets it, and holds neither `dev-worker.fixture.ts` nor PGlite.
 *
 * `DEV_DATABASE_URL` is what the configuration holds in place of an address. Its host is a name
 * that no DNS answers (RFC 6761), so a process that has the switch and no database gets an error,
 * and never a connection to somebody's server.
 */
export const DEV_DATABASE = 'pglite';
export const DEV_DATABASE_URL = 'postgres://fruitback@pglite.invalid/dev';

/** Whether the environment asks for the database of development. */
export function asksForDevDatabase(env: { FRUITBACK_DEV_DATABASE?: string }): boolean {
  return (env.FRUITBACK_DEV_DATABASE ?? '').trim() !== '';
}

/**
 * The address of the database of a worker, as its environment gives it: the one of the switch, or
 * `FRUITBACK_DATABASE_URL`. `readConfig` refuses the switch in production before anything reads this.
 */
export function databaseUrlOf(env: {
  FRUITBACK_DEV_DATABASE?: string;
  FRUITBACK_DATABASE_URL?: string;
  NODE_ENV?: string;
}): string | undefined {
  if (asksForDevDatabase(env) && env.NODE_ENV !== 'production') return DEV_DATABASE_URL;

  return readDatabaseUrl(env.FRUITBACK_DATABASE_URL);
}

/** Gives the process the database that `databaseFor(DEV_DATABASE_URL)` answers. For `dev-worker.fixture.ts` alone. */
export function provideDevDatabase(database: PgDatabase): void {
  databases.set(DEV_DATABASE_URL, database);
}

export async function closeDatabases(): Promise<void> {
  const open = [...databases.values()];
  databases.clear();
  await Promise.all(open.map((database) => database.close()));
}
