import assert from 'node:assert/strict';
import { afterEach } from 'node:test';
import type { Auth, BetterAuthOptions } from 'better-auth';
import { type AuthConfig, authOptions } from './auth.ts';
import type { PgDatabase } from './postgres.ts';
import {
  NO_REAL_POSTGRES,
  createMigratedPgliteDatabase,
  createPgliteDatabase,
  createRealDatabase,
  rowsOf,
} from './postgres.fixture.ts';
import { migrate } from './postgres-migrate.ts';
import { createPostgresKv } from './kv-postgres.ts';

/**
 * What the tests of `auth.ts` share (FRU-144): the database of a case with its pool, and a way to get
 * a session from an instance that serves no way to sign in.
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
  databaseSchema: 'public',
  trackIp: false,
  // The behaviour before FRU-278, which most cases sign two people in with. `sign-up.test.ts` holds `invited`.
  signUp: 'anyone',
};

/** The sessions of the extensions, for a case that removes nobody: it ends none, and says it was not asked. */
export const NO_SESSIONS = {
  async endSessionsOf(): Promise<void> {
    throw new Error('This case gave better-auth no session store, and a member was removed');
  },
};

/**
 * What is in the database of a case when better-auth reads it.
 *
 * `migrations`: the migrations of the worker ran (Drizzle, `postgres-migrate.ts`). `planted`: then
 * these statements ran, one by one. A control plants what a migration would have lost, and the case
 * must find it: the database is what better-auth reads, whatever made it.
 */
export type Made = { migrations: boolean; planted?: readonly string[] };

export const MIGRATED: Made = { migrations: true };
export const EMPTY: Made = { migrations: false };

/** The migrations of the worker, then `planted`. */
export function plantedAfterTheMigrations(...planted: string[]): Made {
  assert.ok(planted.length > 0, 'a control that plants nothing proves nothing');

  return { migrations: true, planted };
}

/** Makes `database` what `made` says. */
export async function make(database: PgDatabase, made: Made = MIGRATED): Promise<void> {
  if (made.migrations) await migrate(database);
  for (const statement of made.planted ?? []) await rowsOf(database, statement);
}

/** What better-auth wrote in its log while a test ran: a warning there is a finding. */
export type Said = { level: string; message: string }[];

/**
 * The options of the worker for this database, after its migrations, with a log that keeps what
 * better-auth says. `made` says what the database holds: a control plants something missing.
 */
export async function optionsOn(
  database: PgDatabase,
  made: Made = MIGRATED,
): Promise<{ options: BetterAuthOptions; said: Said }> {
  await make(database, made);
  const options = await authOptions(AUTH_CONFIG, await database.pool(), NO_SESSIONS, createPostgresKv(database));
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
  // The worker refuses to create a person whose address nobody proved (FRU-147), and a sign-up with
  // a password proves none. A test that needs a session says that the address is proven.
  return {
    ...options,
    emailAndPassword: { enabled: true },
    databaseHooks: {
      ...options.databaseHooks,
      user: {
        ...options.databaseHooks?.user,
        create: { before: async (user) => ({ data: { ...user, emailVerified: true } }) },
      },
    },
  };
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
export const DATABASES: readonly { label: string; open: () => Promise<PgDatabase>; skip: string | false }[] = [
  { label: 'PGlite', open: createPgliteDatabase, skip: false },
  { label: 'a real server', open: createRealDatabase, skip: NO_REAL_POSTGRES },
];

/**
 * `DATABASES`, with the PGlite one migrated before the case (FRU-339): for a case whose subject is
 * not the migrations. The real server is the same: there each case still applies every migration.
 */
export const MIGRATED_DATABASES: typeof DATABASES = [
  { label: 'PGlite', open: createMigratedPgliteDatabase, skip: false },
  ...DATABASES.slice(1),
];

/**
 * The databases of the cases of a test file: `opening` opens one, and it is closed after the case.
 * `closing` closes one before the end of its case, for a case that needs two on one PGlite.
 */
export function databasesOfACase(): {
  opening(open: () => Promise<PgDatabase>): Promise<PgDatabase>;
  closing(database: PgDatabase): Promise<void>;
} {
  const opened: PgDatabase[] = [];
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
