import { PGlite, types } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate as migrateOnPglite } from 'drizzle-orm/pglite/migrator';
import { type PgDatabase, type PgPool, causeOfQueryError } from './postgres.ts';

/**
 * A `PgDatabase` on a PGlite instance: a PostgreSQL in the process, with one connection (FRU-141).
 *
 * This file imports nothing of `node:test`, so a runner that is not `node --test` can use it: the
 * Playwright spec of the console (FRU-148) serves a worker on it. `postgres.fixture.ts` keeps the
 * instance that the cases of a test file share.
 */

type Row = Record<string, unknown>;

/** A new instance. A `BIGINT` is a number, as the schema of Drizzle reads one. */
export function newPglite(): PGlite {
  return new PGlite({ parsers: { [types.INT8]: (value: string) => Number(value) } });
}

export const EMPTY_PUBLIC = 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;';

/**
 * A pool of `pg`, as Kysely's PostgreSQL dialect uses one, on PGlite: what better-auth takes (FRU-144).
 *
 * PGlite is one connection, so one client is out at a time: a transaction of better-auth is `begin`
 * and `commit` on the client it holds, and no other client may come between the two.
 */
function poolOver(instance: PGlite): PgPool {
  let tail: Promise<void> = Promise.resolve();

  const pool = {
    async connect() {
      let release = (): void => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      const before = tail;
      tail = before.then(() => held);
      await before;

      return {
        async query(text: string, values?: readonly unknown[]) {
          const answer = await instance.query<Row>(text, values === undefined ? [] : [...values]);

          return {
            command: (text.trim().split(/\s+/)[0] ?? '').toUpperCase(),
            rowCount: answer.affectedRows ?? answer.rows.length,
            rows: answer.rows,
          };
        },
        release,
      };
    },
    async end() {},
  };

  return pool as unknown as PgPool;
}

/**
 * The database of `instance`, with nothing in `public`. `close` empties it, and leaves the instance open.
 *
 * `schema` is the one of the worker (FRU-219): the one connection of the instance has it alone in its
 * search path, as each connection of a pool of `postgres.ts` has. A schema that is not `public` is
 * dropped with it, before and after.
 */
export async function databaseOn(instance: PGlite, schema = 'public'): Promise<PgDatabase> {
  const empty = `${EMPTY_PUBLIC}${schema === 'public' ? '' : ` DROP SCHEMA IF EXISTS "${schema}" CASCADE;`}`;
  await instance.exec(`RESET search_path; ${empty} SET search_path TO "${schema}";`);
  const db = drizzle({ client: instance });

  /** The error of PGlite, and not the one of Drizzle around it: a test reads its code. */
  const plain = async <T>(work: Promise<T>): Promise<T> => {
    try {
      return await work;
    } catch (error) {
      throw causeOfQueryError(error) ?? error;
    }
  };

  return {
    schema,
    run: (work) => plain(work(db)),
    transaction: (work) => plain(db.transaction((transaction) => work(transaction))),
    alone: (work) => plain(work(db, (config) => migrateOnPglite(db, config))),
    pool: async () => poolOver(instance),
    async close() {
      await instance.exec(`RESET search_path; ${empty}`);
    },
  };
}
