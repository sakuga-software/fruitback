import { type SQL, getTableName, sql } from 'drizzle-orm';
import { type Kv, KvError } from './kv.ts';
import type { Database } from './postgres.ts';
import { migrated } from './postgres-migrate.ts';
import { kv as table } from './postgres-schema.ts';

/**
 * The `Kv` in the database of the worker (FRU-67): one table, and one statement for each call.
 *
 * A worker with a database has several replicas sooner or later, and the memory of one process is
 * then one rate limit for each replica. PostgreSQL is the one store they share, so the state goes
 * there, and no other system is run for it. The libraries that do this were compared first: none
 * holds both a string and an atomic count, and the best of them sends the statement written here.
 * The comparison is in FRU-67.
 *
 * - **`incr` is one `INSERT … ON CONFLICT DO UPDATE … RETURNING`.** PostgreSQL locks the row of the
 *   key, so two replicas that count at the same moment get two different counts. No transaction, no
 *   advisory lock, one round trip. `kv-postgres.test.ts` counts from two connections of a real server.
 * - **The clock is the one of the database**, one for every replica: an entry whose instant is past
 *   reads as absent in the statement itself, and a count on it starts again.
 * - **Nothing here needs to survive a crash of the server**, and that is what `quietly` is for.
 * - **Expired rows are removed as calls come**, a bounded number at a time: no task, no timer.
 *
 * The statements name the table through the schema of Drizzle, never as a string: the schema of the
 * tables is to become a setting (FRU-219), and a name written here would not follow it.
 */

/** How often one process looks for expired rows, and how many it removes at a time. */
export const SWEEP_INTERVAL_MS = 10_000;
export const SWEEP_BATCH = 500;

/** A count is a canonical integer that JavaScript holds exactly: the rules of the memory store. */
const CANONICAL = '^(0|-?[1-9][0-9]{0,15})$';
const LAST_EXACT = 9_007_199_254_740_991;

/** The instant of the database, in milliseconds. `clock_timestamp`: the instant of the statement, in a transaction too. */
const NOW = sql`(extract(epoch FROM clock_timestamp()) * 1000)::bigint`;

/**
 * A row source that makes the transaction of its statement commit without waiting for the disk.
 *
 * WARNING: read this before a statement of another store takes it.
 *
 * A commit waits for the write-ahead log to reach the disk, and the rate limiter writes once for
 * each request of the widget: measured on a local PostgreSQL 17, that wait is the whole cost of a
 * count (700 to 2000 counts a second with it, 8600 to 16000 without). `synchronous_commit = off`
 * answers before the flush. **What is lost is at most the last few hundred milliseconds of writes,
 * when the server crashes** (three times `wal_writer_delay`), and never the consistency of the
 * table. For a count, a cached answer and a ticket of one minute, that is what a restart of a
 * worker on memory loses already. For an account, a site or a session it would be a defect.
 *
 * `set_config(…, true)` is `SET LOCAL`: it holds for the transaction of the statement and no
 * longer. Each statement of this file is its own transaction, on a connection that the pool takes
 * back, so the setting never reaches another statement. `kv-postgres.test.ts` reads it back on the
 * same connection, and writes an account on it. **Never call this store inside `transaction`**: the
 * whole transaction would commit without waiting.
 *
 * It is a common table expression that the statement reads in its `FROM`: PostgreSQL does not run a
 * `SELECT` of a `WITH` that nothing reads.
 */
const quietly = sql`quiet AS (SELECT set_config('synchronous_commit', 'off', true) AS commits)`;

type Rows = { rows?: Record<string, unknown>[] };

export type PostgresKvOptions = {
  /** The clock of this process, for the pace of the sweep only. */
  now?: () => number;
  sweepEveryMs?: number;
  sweepBatch?: number;
};

export function createPostgresKv(database: Database, options: PostgresKvOptions = {}): Kv {
  const { now = Date.now, sweepEveryMs = SWEEP_INTERVAL_MS, sweepBatch = SWEEP_BATCH } = options;
  const key = sql.identifier(table.key.name);
  const value = sql.identifier(table.value.name);
  const expiresAt = sql.identifier(table.expires_at.name);
  let nextSweep = 0;

  /** One statement. Whatever fails is a `KvError`: the caller decides what an outage means. */
  async function ask(statement: SQL): Promise<Record<string, unknown>[]> {
    try {
      await migrated(database);

      return ((await database.run((db) => db.execute(statement))) as Rows).rows ?? [];
    } catch (error) {
      // The message of the seam holds no address and no value of the statement: see `postgres.ts`.
      throw new KvError(`the Kv of the database did not answer: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  /**
   * Removes expired rows, `sweepBatch` at most, and at most once in `sweepEveryMs` for this process.
   * A full batch means there are more: the next call sweeps again. A row that another statement
   * holds is skipped, and a sweep that fails costs nothing but the rows it would have removed.
   */
  async function sweep(): Promise<void> {
    const at = now();
    if (at < nextSweep) return;
    nextSweep = at + sweepEveryMs;
    try {
      const removed = await ask(sql`
        WITH ${quietly}, gone AS (
          SELECT ${key} FROM ${table}
          WHERE ${expiresAt} <= ${NOW} AND (SELECT commits FROM quiet) IS NOT NULL
          ORDER BY ${expiresAt} LIMIT ${sweepBatch} FOR UPDATE SKIP LOCKED
        )
        DELETE FROM ${table} WHERE ${key} IN (SELECT ${key} FROM gone) RETURNING 1 AS removed`);
      if (removed.length >= sweepBatch) nextSweep = 0;
    } catch {
      // Tried again at the next interval.
    }
  }

  return {
    async get(k) {
      const [row] = await ask(sql`SELECT ${value} FROM ${table} WHERE ${key} = ${k} AND ${expiresAt} > ${NOW}`);
      await sweep();

      return row === undefined ? undefined : String(row[table.value.name]);
    },
    async set(k, v, ttlMs) {
      await ask(sql`
        WITH ${quietly}
        INSERT INTO ${table} (${key}, ${value}, ${expiresAt})
        SELECT ${k}, ${v}, ${NOW} + ${Math.ceil(ttlMs)}::bigint FROM quiet
        ON CONFLICT (${key}) DO UPDATE SET ${value} = EXCLUDED.${value}, ${expiresAt} = EXCLUDED.${expiresAt}
        RETURNING current_setting('synchronous_commit') AS commits`);
      await sweep();
    },
    async incr(k, ttlMs, by = 1) {
      if (!Number.isSafeInteger(by) || by < 1) throw new KvError('an increment is a positive integer');
      const ttl = Math.ceil(ttlMs);
      // `EXCLUDED.expires_at - ttl` is the instant of this statement: the row that would be inserted
      // carries it. A row whose instant is past starts again, and gets the expiry of this call. A
      // live row keeps its expiry, whatever it holds: a count that started from a stored `0` ends
      // with it. A live row that holds no count is left as it is, and nothing is returned.
      // `CASE`, and not `AND`: PostgreSQL may evaluate the two sides of an `AND` in any order, and the
      // cast of a value that is no number is an error.
      const past = sql`held.${expiresAt} <= EXCLUDED.${expiresAt} - ${ttl}::bigint`;
      const rows = await ask(sql`
        WITH ${quietly}
        INSERT INTO ${table} AS held (${key}, ${value}, ${expiresAt})
        SELECT ${k}, ${String(by)}, ${NOW} + ${ttl}::bigint FROM quiet
        ON CONFLICT (${key}) DO UPDATE SET
          ${value} = CASE WHEN ${past} THEN EXCLUDED.${value} ELSE (held.${value}::numeric + ${by}::numeric)::text END,
          ${expiresAt} = CASE WHEN ${past} THEN EXCLUDED.${expiresAt} ELSE held.${expiresAt} END
        WHERE ${past} OR CASE
          WHEN held.${value} ~ ${CANONICAL}
          THEN abs(held.${value}::numeric) <= ${LAST_EXACT}::numeric AND abs(held.${value}::numeric + ${by}::numeric) <= ${LAST_EXACT}::numeric
          ELSE false END
        RETURNING held.${value} AS count, current_setting('synchronous_commit') AS commits`);
      await sweep();
      const [row] = rows;
      if (row === undefined) throw new KvError('value is not an integer this store can count');

      return Number(row.count);
    },
    // The database belongs to the process, and the stores of the accounts read it too.
    async close() {},
  };
}

/** The name of the table, for a test that reads it beside the store. */
export const KV_TABLE = getTableName(table);
