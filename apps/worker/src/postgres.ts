import type { Pool, PoolClient, QueryResult } from 'pg';
import { StoreError } from './store.ts';

/**
 * PostgreSQL as the worker speaks to it (FRU-141).
 *
 * `Database` is the seam: `createPgDatabase` is the one implementation that ships, on a `Pool` of
 * `pg`, and the tests have another on PGlite, a PostgreSQL in the process.
 *
 * **This file imports `pg` as types only, and loads it at the first query.** A worker without
 * `FRUITBACK_DATABASE_URL` loads nothing of PostgreSQL and opens nothing.
 *
 * **No message here holds the address of the database.** It carries the password.
 */

export type Row = Record<string, unknown>;

export type Queryable = {
  /**
   * One statement with its values, or several statements with none.
   *
   * A `BIGINT` is answered as a number. Every one in this schema is an instant in milliseconds or a
   * count, and the driver answers a string for it by default.
   */
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Row[]; rowCount: number }>;
};

export type Database = Queryable & {
  /** `run` on one connection, in one transaction. It is rolled back when `run` rejects. */
  transaction<T>(run: (transaction: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

/** The type of a `BIGINT` in the catalogue of PostgreSQL. */
const INT8 = 20;

/** SQLSTATE classes 22 and 23: the statement is wrong for the data. The database answered. */
function isStatementError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;

  return typeof code === 'string' && /^2[23]/.test(code);
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

/**
 * A database on a `Pool` of `pg`.
 *
 * `schema` puts every connection of the pool in one schema. The tests use it to give each case an
 * empty database inside one server.
 */
export function createPgDatabase(url: string, options: { schema?: string; max?: number } = {}): Database {
  let opening: Promise<Pool> | undefined;

  const pool = (): Promise<Pool> => {
    opening ??= import('pg').then(({ default: pg }) => {
      const opened = new pg.Pool({
        connectionString: url,
        max: options.max ?? 10,
        connectionTimeoutMillis: 5_000,
        ...(options.schema === undefined ? {} : { options: `-c search_path=${options.schema}` }),
        types: {
          getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
            oid === INT8 ? Number : pg.types.getTypeParser(oid, format as 'text')) as typeof pg.types.getTypeParser,
        },
      });
      // An idle connection that the server closes emits `error`. With no listener, the process stops.
      opened.on('error', (error) => {
        console.error(`[fruitback] a PostgreSQL connection failed: ${withoutAddress(String(error), url)}`);
      });

      return opened;
    });

    return opening;
  };

  const failure = (error: unknown): Error => {
    const message = withoutAddress(error instanceof Error ? error.message : String(error), url);
    if (isStatementError(error)) {
      return Object.assign(new Error(`PostgreSQL refused a statement: ${message}`), {
        code: (error as { code: string }).code,
      });
    }

    return new StoreError(`PostgreSQL did not answer: ${message}`);
  };

  const answer = (result: QueryResult | QueryResult[]): { rows: Row[]; rowCount: number } => {
    // Several statements answer several results: the last one is the answer.
    const last = Array.isArray(result) ? result.at(-1) : result;

    return { rows: (last?.rows ?? []) as Row[], rowCount: last?.rowCount ?? 0 };
  };

  const on = (client: Pool | PoolClient): Queryable => ({
    async query(text, values) {
      try {
        return answer(await (values === undefined ? client.query(text) : client.query(text, [...values])));
      } catch (error) {
        throw failure(error);
      }
    },
  });

  return {
    async query(text, values) {
      let opened: Pool;
      try {
        opened = await pool();
      } catch (error) {
        throw failure(error);
      }

      return on(opened).query(text, values);
    },

    async transaction(run) {
      let client: PoolClient;
      try {
        client = await (await pool()).connect();
      } catch (error) {
        throw failure(error);
      }

      const transaction = on(client);
      try {
        await transaction.query('BEGIN');
        const result = await run(transaction);
        await transaction.query('COMMIT');
        client.release();

        return result;
      } catch (error) {
        // A connection that cannot roll back is not given to the next caller.
        const broken = await client.query('ROLLBACK').then(
          () => false,
          () => true,
        );
        client.release(broken);
        throw error;
      }
    },

    async close() {
      if (opening === undefined) return;
      const opened = await opening.catch(() => undefined);
      opening = undefined;
      await opened?.end();
    },
  };
}

/**
 * One pool for each address, for the life of the process.
 *
 * The stores are built for each request wherever the transport did not hand one over, as the SQLite
 * ones are: the pool must not be.
 */
const databases = new Map<string, Database>();

export function databaseFor(url: string): Database {
  const known = databases.get(url);
  if (known !== undefined) return known;

  const database = createPgDatabase(url);
  databases.set(url, database);

  return database;
}

export async function closeDatabases(): Promise<void> {
  const open = [...databases.values()];
  databases.clear();
  await Promise.all(open.map((database) => database.close()));
}

/**
 * One step of the schema. `name` says what it adds, and it is kept in the database beside its number:
 * a build whose list was edited, and not appended to, is refused.
 */
export type Migration = { name: string; sql: string };

/** Any number that no other application of the same database uses for an advisory lock. */
const MIGRATION_LOCK = 0x4652_5542;

/**
 * Applies the migrations that the database does not have yet, in order (FRU-141).
 *
 * **Each migration has its own transaction, and takes an advisory lock for it.** Two processes that
 * start together on an empty database both get here. The second one waits for the lock, then reads
 * that the first one applied the migration, and does nothing. Without the lock both read « not
 * applied » and both run `CREATE TABLE`.
 *
 * A database that holds more migrations than this build is left alone: that is the image of before,
 * after a roll back.
 */
export async function migrate(database: Database, migrations: readonly Migration[]): Promise<void> {
  for (const [index, migration] of migrations.entries()) {
    const version = index + 1;

    await database.transaction(async (transaction) => {
      await transaction.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
      await transaction.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at BIGINT NOT NULL)',
      );
      const applied = await transaction.query('SELECT name FROM schema_migrations WHERE version = $1', [version]);
      const known = applied.rows[0]?.name;
      if (known !== undefined) {
        if (known !== migration.name) {
          throw new StoreError(
            `Migration ${version} of the database is « ${String(known)} », and this build calls it « ${migration.name} »: the list is appended to, never edited`,
          );
        }

        return;
      }

      await transaction.query(migration.sql);
      await transaction.query('INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)', [
        version,
        migration.name,
        Date.now(),
      ]);
    });
  }
}
