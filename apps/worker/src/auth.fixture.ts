import assert from 'node:assert/strict';
import { afterEach } from 'node:test';
import type { Auth, BetterAuthOptions } from 'better-auth';
import { type AuthConfig, authOptions } from './auth.ts';
import { type Database, type Migration, type PgDatabase, type PgPool, migrate } from './postgres.ts';
import { NO_REAL_POSTGRES, createPgliteDatabase, createRealDatabase } from './postgres.fixture.ts';
import { MIGRATIONS } from './postgres-migrations.ts';

/**
 * What the tests of `auth.ts` share (FRU-144): a pool for better-auth on the database of a case, and
 * a way to get a session from an instance that serves no way to sign in.
 */

export const AUTH_SECRET = 'q7Zp!4vLx@9Rk#2Tn$8Wd%5Hs^1Bf&6Yj*3Gc(0M';
export const PUBLIC_URL = 'https://api.fruitback.test';
export const CONSOLE_URL = 'https://app.fruitback.test';
/** Port 1 of this machine: nothing listens there. The tests give better-auth a pool, never this. */
export const DATABASE_PASSWORD = 'hunter2-not-for-a-log';
export const DATABASE_URL = `postgres://fruitback:${DATABASE_PASSWORD}@127.0.0.1:1/fruitback`;

export const AUTH_CONFIG: AuthConfig = {
  secret: AUTH_SECRET,
  publicUrl: PUBLIC_URL,
  consoleUrl: CONSOLE_URL,
  databaseUrl: DATABASE_URL,
};

/**
 * A pool of `pg`, as Kysely's PostgreSQL dialect uses one, on a `Database` of the tests.
 *
 * PGlite is one connection, so one client is out at a time: a transaction of better-auth is `begin`
 * and `commit` on the client it holds, and no other call may come between the two.
 */
function poolOver(database: Database): PgPool {
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
          const answer = await database.query(text, values === undefined || values.length === 0 ? undefined : values);

          return {
            command: (text.trim().split(/\s+/)[0] ?? '').toUpperCase(),
            rowCount: answer.rowCount,
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
 * The database of a case as `authFor` takes one: with a pool.
 *
 * On a real server it is the pool that ships. On PGlite it is `poolOver`.
 */
export function withPool(database: Database): PgDatabase {
  const real = (database as Partial<PgDatabase>).pool;

  return { ...database, pool: real === undefined ? async () => poolOver(database) : real };
}

/** The migrations of the worker, with the one of better-auth changed by `change`. */
export function migrationsWith(change: (sql: string) => string): Migration[] {
  return MIGRATIONS.map((migration) =>
    migration.name === 'better-auth' ? { ...migration, sql: change(migration.sql) } : migration,
  );
}

/** What better-auth wrote in its log while a test ran: a warning there is a finding. */
export type Said = { level: string; message: string }[];

/**
 * The options of the worker for this database, after its migrations, with a log that keeps what
 * better-auth says. `migrations` is the list to apply: a control gives one with something missing.
 */
export async function optionsOn(
  database: Database,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<{ options: BetterAuthOptions; said: Said }> {
  await migrate(database, migrations);
  const options = await authOptions(AUTH_CONFIG, await withPool(database).pool());
  const said: Said = [];

  return {
    options: {
      ...options,
      logger: {
        ...options.logger,
        log: (level, message, ...rest) => void said.push({ level, message: [message, ...rest].join(' ') }),
      },
    },
    said,
  };
}

/** A request to better-auth itself, as the console would send it. `handleRequest` serves none. */
export function ask(auth: Auth, path: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
  return auth.handler(
    new Request(`${PUBLIC_URL}/console/auth${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Origin: CONSOLE_URL, ...init.headers },
    }),
  );
}

/**
 * The options with a password sign-up, **for a test only**.
 *
 * The options of the worker give no way to sign in yet, and a test of the cookie needs a session.
 * A password is the one way that needs no mail and no provider.
 */
export function withTestSignUp(options: BetterAuthOptions): BetterAuthOptions {
  return { ...options, emailAndPassword: { enabled: true } };
}

/** Signs a new person up and answers the cookie as a browser would send it back, and as it was set. */
export async function signUp(
  auth: Auth,
  email: string,
  headers: Record<string, string> = {},
): Promise<{ cookie: string; setCookie: string[] }> {
  const answer = await ask(auth, '/sign-up/email', {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, password: 'correct horse battery staple', name: 'Alice' }),
  });
  if (answer.status !== 200) throw new Error(`the sign-up of a test answered ${answer.status}: ${await answer.text()}`);
  const setCookie = answer.headers.getSetCookie();

  return { cookie: setCookie.map((each) => each.split(';')[0]).join('; '), setCookie };
}

/** The databases a case runs on. PGlite has one connection; the CI job « postgres » has a server. */
export const DATABASES: readonly { label: string; open: () => Promise<Database>; skip: string | false }[] = [
  { label: 'PGlite', open: createPgliteDatabase, skip: false },
  { label: 'a real server', open: createRealDatabase, skip: NO_REAL_POSTGRES },
];

/**
 * The databases of the cases of a test file: `opening` opens one, and it is closed after the case.
 * `closing` closes one before the end of its case, for a case that needs two on one PGlite.
 */
export function databasesOfACase(): {
  opening(open: () => Promise<Database>): Promise<Database>;
  closing(database: Database): Promise<void>;
} {
  const opened: Database[] = [];
  afterEach(async () => {
    for (const database of opened.splice(0)) await database.close();
  });

  return {
    async opening(open) {
      const database = await open();
      opened.push(database);

      return database;
    },
    async closing(database) {
      await database.close();
      opened.splice(opened.indexOf(database), 1);
    },
  };
}

/** `sql` with `text` taken out. It must be there once: a control that changes nothing proves nothing. */
export function without(sql: string, text: string, replacement = ''): string {
  assert.equal(sql.split(text).length - 1, 1, `the migration of better-auth must hold this text once: ${text}`);

  return sql.replace(text, replacement);
}
