import type { Auth, BetterAuthOptions, BetterAuthPlugin } from 'better-auth';
import { ACTIONS } from './accounts.ts';
import { newId } from './account-rows.ts';
import { type AdapterOfAuth, keepAtRest } from './auth-at-rest.ts';
import { FRUITBACK_RESOURCE, roleStatements } from './auth-roles.ts';
import { type WorkerConfig, hasAuth } from './env.ts';
import { type PgDatabase, type PgPool, databaseFor, withoutAddress } from './postgres.ts';
import { migrated } from './postgres-stores.ts';

/**
 * better-auth, built and switched off (FRU-144), and what it keeps in the database (FRU-181).
 *
 * **Nothing here serves a route.** This file says how better-auth is configured for the console, and
 * builds one instance for the process when `FRUITBACK_AUTH_SECRET` and `FRUITBACK_DATABASE_URL` are
 * both set. No path under `/console/auth/` answers: `handleRequest` does not know this file.
 *
 * **This file imports better-auth as types only, and loads it when the instance is built**, as
 * `postgres.ts` does for its driver. A worker that has better-auth switched off loads nothing of it:
 * a lint rule holds the import, and a test in a process of its own holds the rest.
 *
 * **It does not take the place of the session of the extension.** `session.ts` stays: a token that
 * rotates, and a replay that ends the chain. A session of better-auth is one token that does not
 * rotate.
 *
 * **A copy of its database opens nothing, even with `FRUITBACK_AUTH_SECRET` beside it** (FRU-181).
 * The plugin `fruitback-at-rest` keeps the token of a session and the identifier of a link as their
 * digests, and never writes a token of a provider: see `auth-at-rest.ts`.
 */

/** Where the routes of better-auth are, the day they are served: under the console's own routes. */
export const AUTH_BASE_PATH = '/console/auth';

/** The plugins of better-auth that the worker configures. A test holds the list. */
export const AUTH_PLUGINS = ['organization', 'fruitback-at-rest'] as const;

/**
 * The routes of better-auth that the digests of `auth-at-rest.ts` break, each with its reason.
 *
 * better-auth answers `404` on each one, and a call to one in the process throws: see `atRest`.
 * « Sign out everywhere » is `/revoke-sessions`, which names the person and not a token: it stays.
 */
export const DISABLED_PATHS: Readonly<Record<string, string>> = {
  '/revoke-session':
    'it names the session to end by its token, and a list of sessions has no token: name a session by its id',
  '/revoke-other-sessions':
    'it reads the token of each session in a list of them, and the database keeps none: it would end nothing',
  '/get-access-token': 'the worker keeps no token of a provider',
  '/refresh-token': 'the worker keeps no token of a provider',
  '/account-info': 'it calls the provider with a token that the worker does not keep',
};

/**
 * The plugin that keeps no usable secret in the database (FRU-181): see `auth-at-rest.ts`.
 *
 * It puts its layer in front of the adapter while better-auth builds its context, before the first
 * query. `startAuth` refuses options that do not have it.
 */
export const AT_REST_PLUGIN = 'fruitback-at-rest';

/** The message of a call, in the process, to a path of `DISABLED_PATHS`. It quotes no value. */
export function closedPath(path: string): string {
  return `better-auth « ${path} » is closed in this worker: ${DISABLED_PATHS[path] ?? 'see DISABLED_PATHS of auth.ts'}`;
}

function atRest(APIError: typeof import('better-auth/api').APIError): BetterAuthPlugin {
  return {
    id: AT_REST_PLUGIN,
    init(context) {
      keepAtRest(context.adapter as unknown as AdapterOfAuth);
    },
    // `disabledPaths` closes a route to a request, and not to `auth.api`. Called in the process,
    // `revokeSession` and `revokeOtherSessions` would end nothing and answer `{ status: true }`:
    // better-auth takes the lookup that the layer refuses for « no such session » (measured). So a
    // call to a closed path throws here, before the endpoint runs.
    hooks: {
      before: [
        {
          matcher: (context: { path?: string }) => Object.hasOwn(DISABLED_PATHS, context.path ?? ''),
          handler: (async (context: { path?: string }) => {
            throw new APIError('NOT_FOUND', { message: closedPath(context.path ?? '') });
          }) as never,
        },
      ],
    },
  };
}

/**
 * The plugins that must never be in the configuration, each with its reason.
 *
 * `startAuth` refuses to build an instance that has one, with the reason in the message.
 */
export const REFUSED_PLUGINS: Readonly<Record<string, string>> = {
  bearer:
    'with it, a session is opened by its token in an `Authorization` header, which a script can send, ' +
    'when the console keeps it in a cookie that no script reads. And without `fruitback-at-rest`, the token ' +
    'read in a copy of the `session` table opens that session alone (measured on 1.7.7)',
  jwt: 'it is a second way to verify a token, beside the one path of identity.ts',
  'device-authorization':
    'it ends in a session token of better-auth, and the extension keeps its own session, which rotates',
};

/** The part of the configuration of the worker that better-auth is built from. */
export type AuthConfig = {
  /** `FRUITBACK_AUTH_SECRET`. It signs the cookie of a session. */
  secret: string;
  /** `FRUITBACK_PUBLIC_URL`, with no path: where this worker answers. */
  publicUrl: string;
  /** `FRUITBACK_CONSOLE_URL`: the one origin that may send a request with the cookie. */
  consoleUrl: string;
  /** `FRUITBACK_DATABASE_URL`. Only to take it out of a message: better-auth gets the pool. */
  databaseUrl: string;
};

/** The configuration of better-auth for this worker, or `undefined` when it is off. */
export function authConfigOf(config: WorkerConfig): AuthConfig | undefined {
  if (!hasAuth(config)) return undefined;
  const { authSecret, databaseUrl, publicUrl, consoleUrl } = config;
  // `readConfig` refuses the secret without each of these: this only narrows the types.
  if (authSecret === undefined || databaseUrl === undefined || publicUrl === undefined || consoleUrl === undefined) {
    return undefined;
  }

  return { secret: authSecret, publicUrl, consoleUrl, databaseUrl };
}

/**
 * The prefix of the id of each table better-auth writes.
 *
 * `acc_` and `ws_` are the ids the worker already gives to an account and a workspace: they are in
 * the access tokens, in `reporter.id` of the notes already written, and in the sessions of the
 * extensions. The others name rows that only better-auth has.
 */
const ID_PREFIXES: Readonly<Record<string, string>> = {
  user: 'acc',
  organization: 'ws',
  session: 'ses',
  account: 'lgn',
  verification: 'ver',
  member: 'mem',
  invitation: 'inv',
};

/**
 * The id of a new row, in the shape of every id of the worker: a prefix and 20 hexadecimal characters.
 *
 * A table with no prefix throws: a plugin that adds a table must say what its ids look like. A test
 * asks this of every table of the configuration.
 */
export function authId(model: string): string {
  const prefix = ID_PREFIXES[model];
  if (prefix === undefined) {
    throw new Error(`better-auth asked for the id of a « ${model} », and ID_PREFIXES of auth.ts has no prefix for it`);
  }

  return newId(prefix);
}

/**
 * The options better-auth is built with. An option that closes something is written even when it is
 * the default of 1.7.7: a default that changes in a later version then changes nothing here.
 *
 * Read in the documentation of 1.7.7 on 2026-10-11, and measured: see « better-auth » in
 * `docs/decisions/worker.md`.
 */
export async function authOptions(config: AuthConfig, pool: PgPool): Promise<BetterAuthOptions> {
  const [{ organization }, { createAccessControl }, { defaultStatements }, { APIError }] = await Promise.all([
    import('better-auth/plugins/organization'),
    import('better-auth/plugins/access'),
    import('better-auth/plugins/organization/access'),
    import('better-auth/api'),
  ]);

  // The four roles, read from `can` of accounts.ts: see auth-roles.ts.
  const access = createAccessControl({ ...defaultStatements, [FRUITBACK_RESOURCE]: ACTIONS });
  const roles = Object.fromEntries(
    Object.entries(roleStatements()).map(([role, statements]) => [role, access.newRole(statements as never)]),
  );

  return {
    appName: 'Fruitback',
    // The origin, written: with no address better-auth reads one from each request, and behind the
    // proxy the worker sees only `http://`.
    baseURL: new URL(config.publicUrl).origin,
    basePath: AUTH_BASE_PATH,
    secret: config.secret,
    database: pool,
    // The console, and no other origin. A request that has the cookie and comes from another one is
    // refused, and so is one with no `Origin`: `demo.fruitback.com` is the same site as the worker,
    // so `SameSite` alone does not keep it out.
    trustedOrigins: [new URL(config.consoleUrl).origin],
    telemetry: { enabled: false },
    // No password: a person signs in with a link or a provider. The accounts hold none.
    emailAndPassword: { enabled: false },
    // The language a person chose (FRU-146), which the worker writes mail in. `input: false`: a
    // sign-up cannot give it, the routes of the worker set it.
    user: { additionalFields: { locale: { type: 'string', required: false, input: false } } },
    // The limit of the worker is the only one. It counts above the dispatch, for every route, with
    // the address `resolveClientIp` read. better-auth reads `X-Forwarded-For` by itself: it takes a
    // lone value as the caller wrote it, and refuses a chain (measured). Two limits with two
    // addresses are two answers to « who is this caller ».
    rateLimit: { enabled: false },
    // The session is read in the database at each call, so a session that is revoked stops at once.
    session: { cookieCache: { enabled: false } },
    // A link or a code is kept as its digest. `auth-at-rest.ts` digests each identifier once more,
    // because this option alone also looks the identifier up as it was given (read in the package).
    verification: { storeIdentifier: 'hashed' },
    // The state of a sign-in with a provider holds the state and the PKCE verifier in the clear. In
    // the database, a copy and an intercepted code would finish the sign-in. In an encrypted cookie,
    // it is in the browser that started it, and in no copy.
    account: { storeStateStrategy: 'cookie' },
    disabledPaths: Object.keys(DISABLED_PATHS),
    advanced: {
      cookiePrefix: 'fruitback',
      // `HttpOnly` is the default of better-auth, and `Secure` comes with an `https://` address. The
      // cookie goes to the routes of the console and to no other route of this worker.
      cookies: { session_token: { attributes: { sameSite: 'strict', path: '/console' } } },
      // Same reason as the limit: no address is read from a header the caller can write, so none is
      // kept in the `session` table.
      ipAddress: { disableIpTracking: true },
      database: { generateId: ({ model }) => authId(model) },
    },
    logger: {
      disableColors: true,
      level: 'warn',
      // One line, in the shape of every line of the worker, and with no address of the database.
      log(level, message, ...rest) {
        const text = withoutAddress([message, ...rest.map(String)].join(' '), config.databaseUrl);
        (level === 'error' ? console.error : console.warn)(`[fruitback] better-auth ${level}: ${text}`);
      },
    },
    // The schema of the organization plugin and the four roles. None of its routes is served.
    plugins: [organization({ ac: access, roles }), atRest(APIError)],
  };
}

/** Each refused plugin of these options, with its reason. Empty for options that may be built. */
export function refusedPlugins(options: Pick<BetterAuthOptions, 'plugins'>): string[] {
  return (options.plugins ?? [])
    .map((plugin) => plugin.id)
    .filter((id) => Object.hasOwn(REFUSED_PLUGINS, id))
    .map((id) => `« ${id} »: ${REFUSED_PLUGINS[id]}`);
}

/**
 * What a schema that is not the one better-auth expects is missing, in one line.
 *
 * The message of better-auth ends with « Run `npx auth migrate` ». That advice is wrong here: one
 * tool migrates the database of a worker, and it is not that one. So the findings are read, and the
 * message is not repeated.
 */
function schemaMismatch(error: unknown): string | undefined {
  const { code, findings } = (error ?? {}) as { code?: unknown; findings?: unknown };
  if (code !== 'SCHEMA_MISMATCH') return undefined;
  const missing = (Array.isArray(findings) ? findings : []).map((finding: Record<string, unknown>) =>
    [finding.kind, [finding.table, finding.column].filter((part) => typeof part === 'string').join('.')].join(' '),
  );

  return (
    `the schema of the database is not the one better-auth expects (${missing.join(', ') || 'no detail given'}). ` +
    'A migration of the worker is missing for this version or these options of better-auth: change auth-schema.ts, ' +
    'run drizzle-kit generate, and never run `auth migrate` on this database'
  );
}

/**
 * An instance of better-auth for these options, ready: it answered a request.
 *
 * **Its context is not enough.** better-auth reads the schema of the database while it starts, and
 * on a schema that is wrong its context is built all the same: it is the first request that is
 * rejected, and every one after it (measured on 1.7.7). So the instance is asked for `/ok` here, in
 * the process and through no socket, before anybody is told that it is ready.
 *
 * WARNING: the migrations of the worker must have run. `authFor` applies them first.
 */
export async function startAuth(options: BetterAuthOptions): Promise<Auth> {
  const refused = refusedPlugins(options);
  if (refused.length > 0) {
    throw new Error(`better-auth is not built with a plugin that the worker refuses. ${refused.join('. ')}`);
  }
  if (!(options.plugins ?? []).some((plugin) => plugin.id === AT_REST_PLUGIN)) {
    throw new Error(
      `better-auth is not built without the plugin « ${AT_REST_PLUGIN} »: without it, the database keeps the token of each session in the clear`,
    );
  }
  // A secondary storage keeps the sessions and the links in a store of keys, by their token in the
  // clear, where the layer of `auth-at-rest.ts` does not reach (read in `db/internal-adapter.mjs`).
  if (options.secondaryStorage !== undefined) {
    throw new Error(
      'better-auth is not built with a secondary storage: it keeps each token in the clear, around the digests',
    );
  }

  const { betterAuth } = await import('better-auth');
  const auth = betterAuth(options);
  await auth.$context;

  const probe = new URL(`${options.basePath ?? ''}/ok`, String(options.baseURL));
  const answer = await auth.handler(new Request(probe)).catch((error: unknown) => {
    throw new Error(schemaMismatch(error) ?? `it did not answer its own probe: ${String(error)}`, { cause: error });
  });
  if (answer.status !== 200) throw new Error(`it answered ${answer.status} to its own probe, ${probe.pathname}`);

  return auth as unknown as Auth;
}

/**
 * One instance for the process, as there is one pool. A failure is not kept: the database may answer
 * the next time.
 */
let started: { key: string; database: PgDatabase; auth: Promise<Auth> } | undefined;

/**
 * better-auth for this worker, or `undefined` when it is off (FRU-144).
 *
 * Off means that this function loads nothing and opens nothing. On, it applies the migrations of the
 * worker, takes the pool of the process, and builds the instance once.
 *
 * `open` is the database of an address. A test gives one on PGlite.
 */
export function authFor(
  config: WorkerConfig,
  open: (url: string) => PgDatabase = databaseFor,
): Promise<Auth> | undefined {
  const auth = authConfigOf(config);
  if (auth === undefined) return undefined;

  const database = open(auth.databaseUrl);
  const key = JSON.stringify(auth);
  // A pool that was closed is another object: the instance that held it is not handed out again.
  if (started !== undefined && started.database === database && started.key === key) return started.auth;

  const starting = migrated(database).then(async () => startAuth(await authOptions(auth, await database.pool())));
  const mine = { key, database, auth: starting };
  started = mine;
  starting.catch(() => {
    if (started === mine) started = undefined;
  });

  return starting;
}

/**
 * Builds better-auth when the server starts, and says in the log what happened.
 *
 * It serves no route, so nothing would build it before the day it does: a configuration that
 * better-auth refuses, a bundle that cannot load it, or a database whose schema is not the one it
 * expects would then show at the first sign-in. Here it shows in the first lines of the log.
 * `/health` does not wait for it, and does not read it.
 */
export async function announceAuth(
  config: WorkerConfig,
  log: Pick<Console, 'log' | 'error'> = console,
  open: (url: string) => PgDatabase = databaseFor,
): Promise<'off' | 'ready' | 'failed'> {
  try {
    // Inside the `try`: the server calls this and waits for nothing, so nothing here may reject.
    const starting = authFor(config, open);
    if (starting === undefined) return 'off';

    await starting;
    log.log('[fruitback] better-auth is ready, and serves no route');

    return 'ready';
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    log.error(`[fruitback] better-auth did not start: ${withoutAddress(said, config.databaseUrl ?? '')}`);

    return 'failed';
  }
}
