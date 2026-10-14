import { type FirstReviewer, readFirstReviewer } from './first-reviewer.ts';
import { readFirstAdmin } from './first-admin.ts';
import { z } from 'zod';
import { type TemSettings, parseTemCredentials } from './mail.ts';
import { type OAuthClient, parseOAuthClient } from './oauth-client.ts';
import { type LinearOAuth, parseLinearOAuth } from './linear-oauth.ts';
import { type ClientMap, originsFromClients, readClientMap, unreadableClients, workspacesOf } from './clients.ts';
import {
  DEFAULT_DATABASE_SCHEMA,
  DEV_DATABASE,
  asksForDevDatabase,
  databaseUrlOf,
  readDatabaseSchema,
} from './postgres.ts';
import { DEFAULT_LIMIT } from './rate-limit.ts';
import { DEFAULT_STORE_PROVIDER, type StoreConfig, storeProviderFor } from './store-config.ts';
import { readStoreConfig } from './stores.ts';

/**
 * The worker of before FRU-225, for the tests of its code alone: no database, and the variables of
 * before (`FRUITBACK_CLIENTS`, `FRUITBACK_SESSION_PATH`, `FRUITBACK_STORE=sqlite`).
 *
 * **No environment can set it**: it is a symbol, and `process.env` holds strings. `server.ts`,
 * `main.ts` and `cli.ts` hand `process.env` to `readConfig`, so a deployed worker always has the
 * refusals below. `before-postgres.fixture.ts` sets it, and a test that holds the code of before
 * reads it through that file. It goes with that code (FRU-226).
 */
export const WITHOUT_DATABASE: unique symbol = Symbol('fruitback: the worker of before, for its tests');

/**
 * Configuration comes from the process environment — Dokploy injects it, `docker compose` reads it
 * from `.env`. It is passed explicitly rather than read from `process.env` inside the handler so the
 * tests stay hermetic.
 */
export type WorkerEnv = {
  /**
   * Which store this process runs on: `linear` (the default), `sqlite`, `github` or `memory`. See
   * `stores.ts`.
   *
   * An unknown name is refused at boot rather than defaulted, and the variables each store reads
   * are declared by that store — the three below belong to `linear.ts`, and are listed here only so
   * the type keeps documenting the whole environment.
   */
  FRUITBACK_STORE?: string;
  /** Linear personal API key. A secret — never baked into the image, never sent to the client. */
  LINEAR_API_KEY?: string;
  LINEAR_TEAM_ID?: string;
  LINEAR_PROJECT_ID?: string;
  /** Comma-separated client origins, or `*`. */
  ALLOWED_ORIGINS?: string;
  /** How many reverse proxies sit in front of this process. See `resolveClientIp`. */
  TRUSTED_PROXY_HOPS?: string;
  /** Requests per minute per client IP. Defaults to 20; the E2E suite raises it. */
  RATE_LIMIT_PER_MINUTE?: string;
  PORT?: string;
  HOST?: string;
  /**
   * The older spelling of `FRUITBACK_STORE=memory`, kept working (FRU-33).
   *
   * Dev only: serve the playground off an in-memory Linear instead of the real API, so the whole
   * capture → issue → pins loop runs with no key and writes to nobody's workspace. Ignored when
   * `NODE_ENV=production` — which the Dockerfile sets — so it cannot be talked into a deploy.
   */
  FRUITBACK_FAKE_LINEAR?: string;
  NODE_ENV?: string;
  /** For `dev-worker.fixture.ts` alone: `members` makes the site of the playground one that only a session reads. */
  FRUITBACK_DEV_VISIBILITY?: string;
  /**
   * Multi-tenant routing as JSON, e.g.
   * `{"acme":{"teamId":"team_1","projectId":"proj_1","origins":["https://acme.test"]}}`.
   * Absent means one client, which is how this worker has always behaved. See `clients.ts`.
   */
  FRUITBACK_CLIENTS?: string;
  /** Shared with the client site so it can mint identity tokens (FRU-9). */
  FRUITBACK_IDENTITY_SECRET?: string;
  /** `1` keeps Linear comments out of the read path (FRU-13). */
  FRUITBACK_HIDE_COMMENTS?: string;
  /**
   * Who may read pins: `public` (the default, and what this worker has always done) or
   * `authenticated` (FRU-40). A mapped client's own `read` overrides this.
   */
  FRUITBACK_READ?: string;
  /**
   * SQLite file holding the extension's sessions (FRU-42). Absent turns the `/session` endpoints
   * off, which is every worker that has no extension pointed at it.
   *
   * **Not the seed store, whatever `FRUITBACK_STORE` says.** Seeds go wherever the team already
   * tracks issues, and neither Linear nor GitHub is a place to keep credentials — so a worker on any
   * store still keeps its sessions on a disk it owns. A separate file, with its own schema.
   */
  FRUITBACK_SESSION_PATH?: string;
  /**
   * The first reviewer of a self-hosted worker (FRU-108): `Alice Martin`, or `Alice Martin
   * <alice@acme.dev>`. Set, a worker that holds no session yet writes a pairing code for that person
   * in its log when it starts. **The code is in the log in the clear**: see `first-reviewer.ts`.
   */
  FRUITBACK_FIRST_REVIEWER?: string;
  /**
   * The address of the first administrator (FRU-221). A worker whose instance has no owner yet writes
   * a sign-in link for that address in its log when it starts: see `first-admin.ts`. It needs the
   * sign-in of the console (`FRUITBACK_AUTH_SECRET`, and what that one needs). Nothing is written
   * once a workspace has an owner. **The link is in the log, in the clear.**
   */
  FRUITBACK_FIRST_ADMIN?: string;
  /**
   * The SQLite file of the accounts, until FRU-150. **Refused at boot**: the accounts are in
   * PostgreSQL, and `migrate-to-postgres` copies a file there. It is read only to say so.
   */
  FRUITBACK_ACCOUNTS_PATH?: string;
  /**
   * The address of the PostgreSQL database that holds the accounts, the workspaces and their sites
   * (FRU-141), as `postgres://user:password@host:5432/database`. Set, the worker reads its clients
   * from it, and the console writes them: `FRUITBACK_CLIENTS` is then refused. **It carries a
   * password**, so no diagnostic quotes it.
   */
  FRUITBACK_DATABASE_URL?: string;
  /**
   * `pglite`: the database is a PGlite in the process, which `dev-worker.fixture.ts` makes (FRU-223). For
   * `pnpm dev` and the E2E suite. Refused under `NODE_ENV=production`, and beside
   * `FRUITBACK_DATABASE_URL`. See `DEV_DATABASE` in `postgres.ts`.
   */
  FRUITBACK_DEV_DATABASE?: string;
  /**
   * The schema of that database the worker keeps its tables and its journal of migrations in
   * (FRU-219), for a database that another application uses too. A plain name, `fruitback` for
   * example. Absent: `public`, as before. The worker makes the schema when it is not there, and
   * writes nowhere else.
   */
  FRUITBACK_DATABASE_SCHEMA?: string;
  /**
   * Where the console answers, for example `https://app.fruitback.com` (FRU-98). A sign-in link opens
   * it, and it is the one origin the console routes answer with a cookie. Required with accounts.
   */
  FRUITBACK_CONSOLE_URL?: string;
  /** The address the sign-in links come from, on a domain the mail provider verified (FRU-98). */
  FRUITBACK_MAIL_FROM?: string;
  /**
   * Scaleway Transactional Email: `<project id>:<secret key>` of an API key that may send (FRU-98).
   * Absent, the worker sends no e-mail and offers no sign-in by link.
   */
  FRUITBACK_SCALEWAY_TEM?: string;
  /**
   * The worker's own public address, for example `https://api.fruitback.com` (FRU-97). GitHub sends
   * a person back to it, and behind a proxy the worker cannot tell it from the request.
   */
  FRUITBACK_PUBLIC_URL?: string;
  /**
   * The GitHub App of the sign-in of before, until FRU-150. **Refused at boot**: better-auth signs
   * in with `FRUITBACK_AUTH_GITHUB_OAUTH`. It is read only to say so.
   */
  FRUITBACK_GITHUB_OAUTH?: string;
  /**
   * The OAuth client Google signs people in with, through better-auth (FRU-135, FRU-147):
   * `<client id>:<client secret>`. Its callback is `<FRUITBACK_PUBLIC_URL>/console/auth/callback/google`.
   */
  FRUITBACK_GOOGLE_OAUTH?: string;
  /** The Linear application a workspace connects its Linear with (FRU-134): `<client id>:<client secret>`. */
  FRUITBACK_LINEAR_OAUTH?: string;
  /**
   * What encrypts the keys of the connectors in the database of the accounts (FRU-121). At least 32 characters,
   * and not the identity secret. Absent, a workspace connects no tracker. WARNING: losing it loses
   * every connector, and changing it does the same.
   */
  FRUITBACK_SECRETS_KEY?: string;
  /**
   * What better-auth signs its cookies with (FRU-144). At least 32 characters, and not one of the two
   * secrets above. **It switches better-auth on**, and needs `FRUITBACK_DATABASE_URL` and
   * `FRUITBACK_PUBLIC_URL`. Absent, nothing of better-auth is loaded. WARNING: changing it ends
   * every session of the console.
   */
  FRUITBACK_AUTH_SECRET?: string;
  /**
   * The GitHub OAuth App that better-auth signs people in with (FRU-147): `<client id>:<client secret>`.
   * Its callback is `<FRUITBACK_PUBLIC_URL>/console/auth/callback/github`.
   */
  FRUITBACK_AUTH_GITHUB_OAUTH?: string;
  /**
   * `1`: better-auth keeps the address and the user agent of each session of the console, and counts
   * its own limit by address (FRU-147, decision of 2026-10-11). Absent, it keeps neither, and the
   * limit of the worker is the only one.
   */
  FRUITBACK_AUTH_TRACK_IP?: string;
  /**
   * The language of the prose in an issue description (FRU-39). A BCP-47 tag; English by default.
   *
   * **The team that triages reads it, never the reporter**, so it is configured here and never taken
   * from the browser. A tag this build has no words for falls back to English; a value that is not a
   * locale at all is refused at boot.
   */
  FRUITBACK_TEAM_LOCALE?: string;
  /**
   * The SQLite file of the notes, until FRU-225. **Refused at boot**: the notes are in PostgreSQL,
   * and `migrate-to-postgres --seeds` copies a file there. `sqlite.ts` reads it for the tests of before.
   */
  FRUITBACK_SQLITE_PATH?: string;
  /** See `WITHOUT_DATABASE`. Never in `process.env`. */
  [WITHOUT_DATABASE]?: true;
};

export const DEFAULT_PORT = 8080;
/** Containers must listen on every interface, or nothing outside the container can reach them. */
export const DEFAULT_HOST = '0.0.0.0';
/** One hop: Dokploy's Traefik. Raise it if another proxy (a CDN, a load balancer) is added upstream. */
export const DEFAULT_TRUSTED_PROXY_HOPS = 1;
/** English, which is what every description carried before FRU-39. */
export const DEFAULT_TEAM_LOCALE = 'en';

const configSchema = z.object({
  /**
   * Which store, and how to build one (FRU-33).
   *
   * Opaque on purpose: the provider's own fields were `linearApiKey`, `linearTeamId` and
   * `linearProjectId` right here, where every module reading the config could see one connector's
   * credentials — and where `readConfig` validated them for deployments that will never have them.
   * Validated by the provider, in `stores.ts`.
   */
  store: z.custom<StoreConfig>(),
  /**
   * Shared with the client site so it can mint identity tokens (FRU-9). Absent — the default —
   * means every reporter is self-declared, which is a perfectly good way to run this.
   *
   * **This is the single-client key.** A worker with a client map ignores it: each client declares
   * its own `identitySecret` or has none, because one signing key shared across tenants lets a
   * compromised tenant mint verified identities on anyone else's issues.
   *
   * 32 characters minimum, because a short HMAC secret is a guessable one.
   */
  identitySecret: z.string().min(32).optional(),
  /**
   * Show the team's Linear replies inside the pin (FRU-13). On unless `FRUITBACK_HIDE_COMMENTS` is
   * set. A mapped client's own `showComments` overrides this.
   *
   * Editorial, and independent of `read` — see the field on the client for why the two stay
   * uncoupled (FRU-46).
   */
  showComments: z.boolean(),
  /**
   * Who may read pins when a client does not say for itself (FRU-40).
   *
   * **`public` by default, and that is a compatibility decision rather than a security one.** Every
   * deployment before this change served reads to anyone, so defaulting to `authenticated` would
   * make pins vanish from every upgraded worker with no error anywhere — the operator would learn
   * about it from users. The exposure is instead made *sayable*: the boot log names every client
   * whose pins anyone can read, and `/health` counts them. Loud beats silent, in both directions.
   *
   * An unrecognised value is refused rather than defaulted, like `TRUSTED_PROXY_HOPS`: a typo here
   * would quietly leave the read path open.
   */
  read: z.enum(['public', 'authenticated']),
  allowedOrigins: z.array(z.string().min(1)).min(1),
  trustedProxyHops: z.number().int().min(0),
  rateLimitPerMinute: z.number().int().positive(),
  /**
   * Absent on a single-client worker. Present, a client has to be named on **both** paths: on a read
   * to decide what may be seen, and on a write to decide where the issue is created — the default
   * team would be the leak in either direction.
   */
  clients: z.custom<ClientMap | undefined>().optional(),
  /**
   * Where the extension's sessions live (FRU-42). Absent means the `/session` endpoints answer
   * `404`, exactly as they did before this feature existed.
   */
  sessionPath: z.string().min(1).optional(),
  /** The person a worker with no session mints a pairing code for when it starts (FRU-108). */
  firstReviewer: z.custom<FirstReviewer | undefined>().optional(),
  firstAdmin: z.string().optional(),
  /** The PostgreSQL database that holds the accounts (FRU-141). Absent: the clients come from the env. */
  databaseUrl: z.string().min(1).optional(),
  /** The schema of that database the worker keeps its tables in (FRU-219). `public` when none is named. */
  databaseSchema: z.string().min(1),
  /** The console's address, with no slash at the end (FRU-98). */
  consoleUrl: z.string().min(1).optional(),
  /** How the worker sends e-mail, or absent when it sends none (FRU-98). */
  mail: z.custom<TemSettings | undefined>().optional(),
  /** The worker's public address, with no slash at the end (FRU-97). */
  publicUrl: z.string().min(1).optional(),
  /** The OAuth client Google signs people in with, through better-auth, or absent (FRU-135). */
  google: z.custom<OAuthClient | undefined>().optional(),
  /** The application a workspace connects its Linear with, or absent: a personal key then (FRU-134). */
  linearOAuth: z.custom<LinearOAuth | undefined>().optional(),
  /** What encrypts the connector keys at rest, or absent (FRU-121). */
  secretsKey: z.string().min(32).optional(),
  /** What better-auth signs its cookies with, or absent: better-auth is then off (FRU-144). */
  authSecret: z.string().min(32).optional(),
  /** The second GitHub OAuth App, the one of better-auth, or absent (FRU-147). */
  authGithub: z.custom<OAuthClient | undefined>().optional(),
  /** Whether better-auth keeps the address and the user agent of a session, and limits by address (FRU-147). */
  authTrackIp: z.boolean(),
  /**
   * The language an issue description is written in (FRU-39), for the team that triages.
   *
   * Refused at boot when it is not a locale tag, like `TRUSTED_PROXY_HOPS`: a typo would otherwise
   * print prose in a language nobody chose and say nothing. A valid tag this build has no words for
   * is a different case and degrades to English — a team asking for `de` gets a readable issue
   * rather than a worker that will not start.
   */
  teamLocale: z.string().min(1),
});

export type WorkerConfig = z.infer<typeof configSchema>;

export type ConfigResult = { ok: true; config: WorkerConfig } | { ok: false; missing: string[] };

/**
 * Validate the environment up front, so a missing secret surfaces once — at boot and on `/health` —
 * instead of as an opaque Linear error on every request.
 */
/** Why `FRUITBACK_ACCOUNTS_PATH` stops the worker (FRU-150): what to set, and where to read how. */
export const ACCOUNTS_FILE_REFUSED =
  'FRUITBACK_ACCOUNTS_PATH (the accounts are in PostgreSQL since FRU-150: set FRUITBACK_DATABASE_URL and FRUITBACK_AUTH_SECRET, and copy the file with `migrate-to-postgres`, as « Upgrading » of docs/self-hosting.md says)';

/** Why `FRUITBACK_GITHUB_OAUTH` stops the worker (FRU-150). */
export const GITHUB_APP_REFUSED =
  'FRUITBACK_GITHUB_OAUTH (the sign-in of before is gone since FRU-150: better-auth signs in with FRUITBACK_AUTH_GITHUB_OAUTH; remove this variable, and its GitHub App)';

/**
 * Why a worker with no database stops (FRU-225). PostgreSQL is required, on a database of its own or
 * in a schema of one that exists (decision of 2026-10-13). Nothing falls back to a file.
 */
export const DATABASE_REQUIRED =
  'FRUITBACK_DATABASE_URL (Fruitback keeps its notes, its sites, its accounts and its sessions in PostgreSQL since FRU-225: a postgres:// address, of a database of its own or of one that exists, with FRUITBACK_DATABASE_SCHEMA. An instance of before copies its files there with `migrate-to-postgres`, as « Upgrading » of docs/self-hosting.md says)';

/**
 * What a worker with a database needs for its console (FRU-225): an administrator can always sign
 * in. Each is asked for and none is made by the worker: a secret it made would change at each start,
 * or end in a backup.
 */
export const REQUIRED_WITH_DATABASE: Readonly<
  Record<
    'FRUITBACK_AUTH_SECRET' | 'FRUITBACK_PUBLIC_URL' | 'FRUITBACK_CONSOLE_URL' | 'FRUITBACK_IDENTITY_SECRET',
    string
  >
> = {
  FRUITBACK_AUTH_SECRET:
    'FRUITBACK_AUTH_SECRET (the console signs its administrators in with it: 32 random characters or more, which the worker does not make: openssl rand -base64 32)',
  FRUITBACK_PUBLIC_URL:
    'FRUITBACK_PUBLIC_URL (the address of this worker as a browser reaches it, with no path: the console calls it, and a sign-in comes back to it)',
  FRUITBACK_CONSOLE_URL: 'FRUITBACK_CONSOLE_URL (the address of the console: a sign-in link opens it)',
  FRUITBACK_IDENTITY_SECRET:
    'FRUITBACK_IDENTITY_SECRET (a session of the extension signs its access token with it: 32 random characters or more, which the worker does not make: openssl rand -base64 32)',
};

/**
 * The variables of a worker of before FRU-225, each refused with what to do, and never ignored: a
 * worker that ignored one would start with no site, or with notes that nothing reads, and an operator
 * would read it as data lost.
 */
export const REFUSED_SINCE_POSTGRES = {
  FRUITBACK_CLIENTS:
    'FRUITBACK_CLIENTS (the sites are in the database since FRU-225, and the console makes them: make each site there, then copy its notes with `migrate-to-postgres --seeds <file> --client <id>=<id of the site>`, as « Upgrading » of docs/self-hosting.md says; then remove this variable)',
  FRUITBACK_SESSION_PATH:
    'FRUITBACK_SESSION_PATH (the sessions of the extension are in the database since FRU-225: each reviewer pairs again, once, from the console; remove this variable)',
  FRUITBACK_SQLITE_PATH:
    'FRUITBACK_SQLITE_PATH (the notes are in the database since FRU-225: copy the file with `migrate-to-postgres --seeds <file>`, as « Upgrading » of docs/self-hosting.md says; then remove this variable)',
  sqlite:
    'FRUITBACK_STORE (« sqlite » is gone since FRU-225: the notes are in the database, the store « postgres », which is the default; copy the file with `migrate-to-postgres --seeds <file>`, as « Upgrading » of docs/self-hosting.md says)',
  FRUITBACK_FIRST_REVIEWER:
    'FRUITBACK_FIRST_REVIEWER (it names no workspace, and every worker has workspaces since FRU-225: the first administrator is FRUITBACK_FIRST_ADMIN, and a reviewer pairs from the console; remove this variable)',
  unnamedStore:
    'FRUITBACK_STORE (unset, and the variables of a tracker are set: before FRU-225 a worker with no FRUITBACK_STORE kept its notes in Linear, and the default is « postgres » since. Write FRUITBACK_STORE=linear, or github, to keep the notes there, or postgres to keep them in the database)',
} as const;

/**
 * The variables of the stores `linear` and `github`: every name of their `envNames`. Set beside no
 * `FRUITBACK_STORE`, one of them says the worker ran on a tracker before FRU-225.
 * test:`names every variable of the stores linear and github as the variable of a tracker` holds the list.
 */
export const TRACKER_VARIABLES = [
  'LINEAR_API_KEY',
  'LINEAR_TEAM_ID',
  'LINEAR_PROJECT_ID',
  'FRUITBACK_GITHUB_APP_ID',
  'FRUITBACK_GITHUB_PRIVATE_KEY',
  'FRUITBACK_GITHUB_REPOSITORY',
] as const;

/**
 * What a worker with no `WITHOUT_DATABASE` is refused for (FRU-225), in one start (FRU-217): no
 * database, what the console needs, and each variable of before that is set.
 */
function postgresRefusals(env: WorkerEnv): string[] {
  if (env[WITHOUT_DATABASE] === true) return [];
  // Empty is absent, as everywhere in this file. A value of spaces is set, and refused as one (FRU-217).
  const set = (name: keyof WorkerEnv & string): boolean => (env[name] ?? '') !== '';
  const before = (
    ['FRUITBACK_CLIENTS', 'FRUITBACK_SESSION_PATH', 'FRUITBACK_SQLITE_PATH', 'FRUITBACK_FIRST_REVIEWER'] as const
  )
    .filter(set)
    .map((name) => REFUSED_SINCE_POSTGRES[name]);

  return [
    // A malformed address is said below, with its own reason.
    ...(databaseUrlOf(env) === undefined && !set('FRUITBACK_DATABASE_URL') ? [DATABASE_REQUIRED] : []),
    ...(Object.keys(REQUIRED_WITH_DATABASE) as (keyof typeof REQUIRED_WITH_DATABASE)[])
      .filter((name) => !set(name))
      .map((name) => REQUIRED_WITH_DATABASE[name]),
    ...(storeProviderFor(env) === 'sqlite' ? [REFUSED_SINCE_POSTGRES.sqlite] : []),
    // Raised in review: the default moved from `linear` to `postgres`. A worker of before that named no
    // store and had a key of Linear would start on the database, and its pins would vanish from the
    // widget with no word. It is asked to name its store.
    ...((env.FRUITBACK_STORE ?? '').trim() === '' &&
    storeProviderFor(env) === DEFAULT_STORE_PROVIDER &&
    // The variables of GitHub are its store's own (`envNames`), so `WorkerEnv` does not name them.
    TRACKER_VARIABLES.some((name) => ((env as Record<string, string | undefined>)[name] ?? '') !== '')
      ? [REFUSED_SINCE_POSTGRES.unnamedStore]
      : []),
    ...before,
  ];
}

/** The three secrets of the worker, each a value of the environment that nothing else reads. */
const SECRETS = ['FRUITBACK_IDENTITY_SECRET', 'FRUITBACK_SECRETS_KEY', 'FRUITBACK_AUTH_SECRET'] as const;

/** What the worker says of a secret with white space around it. It never quotes the value. */
const EDGED =
  'no white space at its start or at its end: a value of spaces, or a line of a file that kept one, is not the secret that was meant';

/**
 * Whether a secret has white space around it (FRU-217). The length was the one thing checked, so 32
 * spaces were a secret, and so was a secret copied with the space that followed it.
 */
function edged(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== value.trim();
}

/**
 * Whether two secrets are one secret. White space does not tell two secrets apart: a key and the
 * same key with a space in it are one leak for both of their jobs.
 */
function sameSecret(one: string | undefined, other: string | undefined): boolean {
  return one !== undefined && other !== undefined && one.replaceAll(/\s/g, '') === other.replaceAll(/\s/g, '');
}

/**
 * Why the switch of the database of development is refused, if it is (FRU-223).
 *
 * In production it is refused and never ignored, as `FRUITBACK_STORE=memory` is: a worker that
 * ignored it would start with no database, or on another one than its operator thinks.
 */
function devDatabaseRefusals(env: WorkerEnv): string[] {
  if (!asksForDevDatabase(env)) return [];
  if (env.NODE_ENV === 'production') {
    return ['FRUITBACK_DEV_DATABASE (a database in the process is dev-only and NODE_ENV is production)'];
  }
  if (env.FRUITBACK_DEV_DATABASE?.trim() !== DEV_DATABASE) {
    return [`FRUITBACK_DEV_DATABASE (« ${DEV_DATABASE} » is its one value)`];
  }
  if (env.FRUITBACK_DATABASE_URL) {
    return ['FRUITBACK_DATABASE_URL (FRUITBACK_DEV_DATABASE is set, and the database is in the process)'];
  }

  return [];
}

/** Why a value of `FRUITBACK_DATABASE_SCHEMA` stops the worker (FRU-219). The value is not quoted. */
export const DATABASE_SCHEMA_REFUSED =
  'FRUITBACK_DATABASE_SCHEMA (the name of a schema: a lower-case letter or « _ », then lower-case letters, digits and « _ », 63 characters at most, not a schema of PostgreSQL itself, and not a key word of SQL such as « user »)';

export function readConfig(env: WorkerEnv): ConfigResult {
  const clients = readClientMap(env.FRUITBACK_CLIENTS);
  // The selected provider validates its own environment (FRU-33). The in-memory store needs none,
  // which is what removed the stand-in Linear credentials the dev loop used to be handed.
  const store = readStoreConfig(env);
  const candidate = {
    store: store.ok ? store.config : undefined,
    identitySecret: env.FRUITBACK_IDENTITY_SECRET || undefined,
    secretsKey: env.FRUITBACK_SECRETS_KEY || undefined,
    authSecret: env.FRUITBACK_AUTH_SECRET || undefined,
    authGithub: env.FRUITBACK_AUTH_GITHUB_OAUTH ? parseOAuthClient(env.FRUITBACK_AUTH_GITHUB_OAUTH) : undefined,
    authTrackIp: env.FRUITBACK_AUTH_TRACK_IP === '1',
    showComments: env.FRUITBACK_HIDE_COMMENTS !== '1',
    read: readAccess(env.FRUITBACK_READ),
    // A client's own `origins` are sites that must be able to reach this worker, so they join the
    // allowlist rather than having to be repeated in `ALLOWED_ORIGINS` — two lists to keep in step
    // is one list that drifts.
    allowedOrigins: [
      ...new Set([
        ...splitOrigins(env.ALLOWED_ORIGINS),
        ...originsFromClients(clients.ok ? clients.clients : undefined),
      ]),
    ],
    trustedProxyHops: readTrustedProxyHops(env.TRUSTED_PROXY_HOPS),
    rateLimitPerMinute: readRateLimit(env.RATE_LIMIT_PER_MINUTE),
    // A malformed map is a misconfiguration, not a reason to quietly pool every client into one
    // team — which is precisely the leak the map exists to prevent.
    clients: clients.ok ? clients.clients : Number.NaN,
    sessionPath: env.FRUITBACK_SESSION_PATH || undefined,
    firstReviewer: readFirstReviewer(env.FRUITBACK_FIRST_REVIEWER),
    firstAdmin: readFirstAdmin(env.FRUITBACK_FIRST_ADMIN),
    databaseUrl: databaseUrlOf(env),
    // A name that is refused is reported below, with its reason. `public` only lets the rest be read.
    databaseSchema: readDatabaseSchema(env.FRUITBACK_DATABASE_SCHEMA) ?? DEFAULT_DATABASE_SCHEMA,
    consoleUrl: readConsoleUrl(env.FRUITBACK_CONSOLE_URL),
    mail: readMail(env),
    publicUrl: readConsoleUrl(env.FRUITBACK_PUBLIC_URL),
    google: env.FRUITBACK_GOOGLE_OAUTH ? parseOAuthClient(env.FRUITBACK_GOOGLE_OAUTH) : undefined,
    linearOAuth: env.FRUITBACK_LINEAR_OAUTH ? parseLinearOAuth(env.FRUITBACK_LINEAR_OAUTH) : undefined,
    teamLocale: readTeamLocale(env.FRUITBACK_TEAM_LOCALE),
  };

  const result = configSchema.safeParse(candidate);
  // Each source names its own variables, and they are reported together: an operator fixing a boot
  // failure should see everything that is wrong, not the first thing to be checked.
  // FRU-219. The name goes into statements as an identifier: a plain name, or nothing starts. Said
  // with the rest (raised in review), and once: the store `postgres` reads the same variable, and
  // names it without the rule.
  const schemaRefused = readDatabaseSchema(env.FRUITBACK_DATABASE_SCHEMA) === undefined;
  // FRU-225. The store of before says what it lacks with no word of why it is refused, and the map of
  // before is refused whatever it holds: each says its sentence alone.
  const postgres = postgresRefusals(env);
  const refusedStore = postgres.includes(REFUSED_SINCE_POSTGRES.sqlite);
  const refusedClients = postgres.includes(REFUSED_SINCE_POSTGRES.FRUITBACK_CLIENTS);
  const missing = [
    ...missingFrom(result),
    ...postgres,
    ...(store.ok || refusedStore
      ? []
      : store.missing.filter(
          (name) =>
            !(schemaRefused && name === 'FRUITBACK_DATABASE_SCHEMA') &&
            // The store `postgres` names the address the line above already asks for.
            !(postgres.includes(DATABASE_REQUIRED) && name === 'FRUITBACK_DATABASE_URL'),
        )),
    ...(schemaRefused ? [DATABASE_SCHEMA_REFUSED] : []),
    ...(clients.ok || refusedClients ? [] : [`FRUITBACK_CLIENTS (${clients.reason})`]),
    // Two variables of before (FRU-150): refused, never ignored. A worker that ignored the file would
    // start with no workspace at all, and an operator would read it as the accounts lost. Said with
    // the rest (FRU-217): each one alone cost the operator one more start to read the next.
    ...devDatabaseRefusals(env),
    ...(env.FRUITBACK_ACCOUNTS_PATH ? [ACCOUNTS_FILE_REFUSED] : []),
    ...(env.FRUITBACK_GITHUB_OAUTH ? [GITHUB_APP_REFUSED] : []),
    ...SECRETS.filter((name) => edged(env[name])).map((name) => `${name} (${EDGED})`),
  ];

  // The `!result.success` half is a backstop, not decoration: a field that fails validation and has
  // no entry in `NAMES_BY_FIELD` would otherwise leave `missing` empty and be returned as `ok` with
  // no config at all. Every such field is named today — `answers no empty diagnostic` is what keeps
  // that true — so what this clause really guarantees is that the next one is loud rather than a
  // `config: undefined` handed to the request path.
  if (!result.success || missing.length > 0) {
    return { ok: false, missing: missing.length > 0 ? [...new Set(missing)] : ['(invalid configuration)'] };
  }

  // The reason never quotes the value: it holds the password of the database.
  if (env.FRUITBACK_DATABASE_URL && result.data.databaseUrl === undefined) {
    return { ok: false, missing: ['FRUITBACK_DATABASE_URL (a postgres:// address with a host)'] };
  }
  // A schema with no database names nothing: a line that was left in an `.env`, or a typing error
  // in the name of the other variable.
  if (env.FRUITBACK_DATABASE_SCHEMA?.trim() && result.data.databaseUrl === undefined) {
    return {
      ok: false,
      missing: ['FRUITBACK_DATABASE_URL (FRUITBACK_DATABASE_SCHEMA names a schema of that database)'],
    };
  }
  // The sessions have one source too (FRU-142): with a database they are in it, and a file beside it
  // would be a second place that nothing reads.
  if (result.data.databaseUrl !== undefined && result.data.sessionPath !== undefined) {
    return {
      ok: false,
      missing: ['FRUITBACK_SESSION_PATH (FRUITBACK_DATABASE_URL is set, and the sessions are in that database)'],
    };
  }
  const sessions = hasSessions(result.data);
  const accounts = hasAccounts(result.data);

  // Refused at boot rather than served as a permanent 401 (FRU-40). A client that requires a
  // verified reader and has no key to verify one with answers nobody, for ever, and the symptom — a
  // widget showing no pins — points at the browser rather than at this line of configuration.
  const unreadable = unreadableClients({
    read: result.data.read,
    clients: result.data.clients,
    identitySecret: result.data.identitySecret,
    sessions,
  });

  if (unreadable.length > 0) {
    return {
      ok: false,
      missing: [`FRUITBACK_IDENTITY_SECRET (read is "authenticated" but ${unreadable.join(', ')} has no key)`],
    };
  }

  // One key that signs identities and opens the connector keys is one leak for both.
  if (sameSecret(result.data.secretsKey, result.data.identitySecret)) {
    return { ok: false, missing: ['FRUITBACK_SECRETS_KEY (it must differ from FRUITBACK_IDENTITY_SECRET)'] };
  }
  if (result.data.secretsKey !== undefined && !accounts) {
    return {
      ok: false,
      missing: ['FRUITBACK_DATABASE_URL (FRUITBACK_SECRETS_KEY encrypts the connectors of a workspace)'],
    };
  }

  // Refused at boot for the same reason as the clause above: a session path with nothing to sign
  // with mints no access token, so pairing would succeed and every call it enabled would fail.
  if (sessions && result.data.identitySecret === undefined) {
    const where = result.data.sessionPath === undefined ? 'FRUITBACK_DATABASE_URL' : 'FRUITBACK_SESSION_PATH';

    return {
      ok: false,
      missing: [`FRUITBACK_IDENTITY_SECRET (${where} is set, and a session signs its access token)`],
    };
  }

  // On a mapped worker a session reaches the clients of its workspace and no other (FRU-95). A map in
  // which no client declares a workspace leaves a session nothing to open: pairing would work, the
  // reviewer would look signed in, and every read would answer 401. Refused loudly instead.
  if (
    result.data.sessionPath !== undefined &&
    workspacesOf(result.data.clients).length === 0 &&
    result.data.clients !== undefined
  ) {
    return {
      ok: false,
      missing: ['FRUITBACK_CLIENTS (FRUITBACK_SESSION_PATH is set, and no client declares a workspace for a session)'],
    };
  }

  // FRU-221. As below: a variable that would be set and do nothing is refused. The secret of the
  // sign-in is asked for, and never made by the worker: one that it made would change at each start,
  // and end every session with it.
  if (env.FRUITBACK_FIRST_ADMIN?.trim()) {
    if (result.data.firstAdmin === undefined) {
      return { ok: false, missing: ['FRUITBACK_FIRST_ADMIN (the address of one person)'] };
    }
    if (!hasAuth(result.data)) {
      return {
        ok: false,
        missing: [
          result.data.databaseUrl === undefined
            ? 'FRUITBACK_DATABASE_URL (FRUITBACK_FIRST_ADMIN is set, and an account is in the database)'
            : 'FRUITBACK_AUTH_SECRET (FRUITBACK_FIRST_ADMIN is set, and its link signs a person in to the console: 32 random characters or more, which the worker does not make)',
        ],
      };
    }
  }

  // FRU-108. Each refusal is a variable that would be set and do nothing, with the operator waiting
  // for a line that never comes.
  if (env.FRUITBACK_FIRST_REVIEWER) {
    if (result.data.firstReviewer === undefined) {
      return { ok: false, missing: ['FRUITBACK_FIRST_REVIEWER (a name, or a name and <an address>)'] };
    }
    if (!sessions) {
      return {
        ok: false,
        missing: ['FRUITBACK_SESSION_PATH (FRUITBACK_FIRST_REVIEWER is set, and pairing opens a session)'],
      };
    }
    // A session of a worker with workspaces names one, and this variable names none.
    if (accounts || workspacesOf(result.data.clients).length > 0) {
      return {
        ok: false,
        missing: [
          'FRUITBACK_FIRST_REVIEWER (it names no workspace: on a worker with workspaces, pair with `pair --workspace`, or from the console)',
        ],
      };
    }
  }

  // WARNING: a client key equal to the worker key verifies every session token as the site's own,
  // and the workspace check is skipped. A session of workspace A would then reach this client.
  const sharedKey = Object.entries(result.data.clients ?? {}).filter(
    ([, client]) => client.identitySecret !== undefined && client.identitySecret === result.data.identitySecret,
  );
  if (result.data.sessionPath !== undefined && sharedKey.length > 0) {
    return {
      ok: false,
      missing: [
        `FRUITBACK_CLIENTS (${sharedKey.map(([id]) => id).join(', ')} uses FRUITBACK_IDENTITY_SECRET as its own key)`,
      ],
    };
  }

  // A worker with accounts reads its clients from the database the console writes. Two sources for one
  // map would let a site exist in one and not in the other.
  if (accounts && result.data.clients !== undefined) {
    return { ok: false, missing: [`FRUITBACK_CLIENTS (FRUITBACK_DATABASE_URL is set, and the sites come from it)`] };
  }

  if (env.FRUITBACK_CONSOLE_URL && result.data.consoleUrl === undefined) {
    return { ok: false, missing: ['FRUITBACK_CONSOLE_URL (an https:// address, or http:// on localhost)'] };
  }

  // A sign-in link opens the console, so accounts with no console have nowhere to send a person.
  if (accounts && result.data.consoleUrl === undefined) {
    return {
      ok: false,
      missing: [`FRUITBACK_CONSOLE_URL (FRUITBACK_DATABASE_URL is set, and a sign-in opens the console)`],
    };
  }

  // Both or neither: an address with no way to send from it, or a key with no address to send as,
  // would offer a sign-in by link that never arrives.
  if (
    Boolean(env.FRUITBACK_MAIL_FROM) !== Boolean(env.FRUITBACK_SCALEWAY_TEM) ||
    (env.FRUITBACK_SCALEWAY_TEM && result.data.mail === undefined)
  ) {
    return {
      ok: false,
      missing: [
        'FRUITBACK_MAIL_FROM and FRUITBACK_SCALEWAY_TEM (both, as an address and <project id>:<secret key>, or neither)',
      ],
    };
  }

  if (env.FRUITBACK_PUBLIC_URL && result.data.publicUrl === undefined) {
    return { ok: false, missing: ['FRUITBACK_PUBLIC_URL (an https:// address, or http:// on localhost)'] };
  }

  // FRU-144. One secret for two jobs is one leak for both: the cookie of the console must not be
  // signed with the key that signs an identity, or with the key that opens the connectors.
  const authSecret = result.data.authSecret;
  if (authSecret !== undefined) {
    if (sameSecret(authSecret, result.data.identitySecret) || sameSecret(authSecret, result.data.secretsKey)) {
      return {
        ok: false,
        missing: [
          'FRUITBACK_AUTH_SECRET (it must differ from FRUITBACK_IDENTITY_SECRET and from FRUITBACK_SECRETS_KEY)',
        ],
      };
    }
    // better-auth keeps its tables in the database of the accounts. It has no SQLite here.
    if (result.data.databaseUrl === undefined) {
      return {
        ok: false,
        missing: ['FRUITBACK_DATABASE_URL (FRUITBACK_AUTH_SECRET is set, and better-auth keeps its tables there)'],
      };
    }
    // Absent, better-auth reads its address from each request. With a path, it takes that path as
    // the one its routes are under, in place of `/console/auth` (read in its source, 1.7.7).
    if (result.data.publicUrl === undefined || new URL(result.data.publicUrl).pathname !== '/') {
      return {
        ok: false,
        missing: [
          'FRUITBACK_PUBLIC_URL (FRUITBACK_AUTH_SECRET is set, and better-auth needs the address of this worker, with no path)',
        ],
      };
    }
    // WARNING: better-auth reads these from the environment of the process by itself, over what the
    // worker gives it (measured on 1.7.7): BETTER_AUTH_TRUSTED_ORIGINS adds an origin that may send
    // a request with the cookie, BETTER_AUTH_SECRETS takes the place of the secret, and
    // BETTER_AUTH_TELEMETRY turns the telemetry on. Refused by the prefix, and named, never quoted:
    // two of them hold a secret.
    const ambient = Object.entries(env)
      .filter(([name, value]) => name.startsWith('BETTER_AUTH_') && typeof value === 'string' && value !== '')
      .map(([name]) => name)
      .sort();
    if (ambient.length > 0) {
      return {
        ok: false,
        missing: [
          `${ambient.join(', ')} (better-auth reads it from the environment over the configuration of the worker: remove it)`,
        ],
      };
    }
  }

  // FRU-147. A switch reads `1` or nothing: a `true` or a `yes` that is read as off keeps no address,
  // and the operator believes it does.
  if (env.FRUITBACK_AUTH_TRACK_IP !== undefined && !['', '1'].includes(env.FRUITBACK_AUTH_TRACK_IP)) {
    return { ok: false, missing: ['FRUITBACK_AUTH_TRACK_IP (1, or unset)'] };
  }
  if (env.FRUITBACK_AUTH_TRACK_IP === '1' && authSecret === undefined) {
    return {
      ok: false,
      missing: ['FRUITBACK_AUTH_SECRET (FRUITBACK_AUTH_TRACK_IP is set, and only better-auth keeps an address)'],
    };
  }
  if (env.FRUITBACK_AUTH_GITHUB_OAUTH) {
    if (result.data.authGithub === undefined) {
      return {
        ok: false,
        missing: ['FRUITBACK_AUTH_GITHUB_OAUTH (<client id>:<client secret> of a GitHub OAuth App)'],
      };
    }
    if (authSecret === undefined) {
      return {
        ok: false,
        missing: ['FRUITBACK_AUTH_SECRET (FRUITBACK_AUTH_GITHUB_OAUTH is the GitHub App of better-auth)'],
      };
    }
  }

  // Linear sends the person back to the worker's own address, and the token it gives is kept sealed.
  if (env.FRUITBACK_LINEAR_OAUTH) {
    if (result.data.linearOAuth === undefined) {
      return {
        ok: false,
        missing: ['FRUITBACK_LINEAR_OAUTH (<client id>:<client secret> of a Linear OAuth application)'],
      };
    }
    if (result.data.publicUrl === undefined || !accounts || result.data.secretsKey === undefined) {
      return {
        ok: false,
        missing: [
          'FRUITBACK_PUBLIC_URL, FRUITBACK_DATABASE_URL and FRUITBACK_SECRETS_KEY (FRUITBACK_LINEAR_OAUTH connects the Linear of a workspace, and keeps its token sealed)',
        ],
      };
    }
  }

  // Google sends the person back to the worker's own address, and better-auth signs them in.
  if (env.FRUITBACK_GOOGLE_OAUTH) {
    if (result.data.google === undefined) {
      return { ok: false, missing: ['FRUITBACK_GOOGLE_OAUTH (<client id>:<client secret> of a Google OAuth client)'] };
    }
    if (result.data.authSecret === undefined) {
      return {
        ok: false,
        missing: ['FRUITBACK_AUTH_SECRET (FRUITBACK_GOOGLE_OAUTH signs a person in with better-auth)'],
      };
    }
  }

  return { ok: true, config: result.data };
}

/**
 * Whether this worker keeps accounts: in PostgreSQL, since FRU-150 the one place (FRU-141).
 *
 * The one question for « are there accounts ».
 */
export function hasAccounts(config: Pick<WorkerConfig, 'databaseUrl'>): boolean {
  return config.databaseUrl !== undefined;
}

/**
 * Does this worker keep sessions, in a file or in the database (FRU-142)?
 *
 * Ask this and never `sessionPath`: a route that reads the field is off for a worker on a database.
 */
export function hasSessions(config: Pick<WorkerConfig, 'sessionPath' | 'databaseUrl'>): boolean {
  return config.sessionPath !== undefined || config.databaseUrl !== undefined;
}

/**
 * Whether better-auth is on (FRU-144): its secret, and the database it keeps its tables in.
 *
 * The one question, as `hasAccounts` is. `readConfig` refuses the secret without the database, so
 * the second half only narrows the type.
 */
export function hasAuth(config: Pick<WorkerConfig, 'authSecret' | 'databaseUrl'>): boolean {
  return config.authSecret !== undefined && config.databaseUrl !== undefined;
}

/** The console's address with no slash at the end, or `undefined` when it cannot carry a sign-in. */
function readConsoleUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;

  try {
    const url = new URL(value.trim());
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return undefined;

    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return undefined;
  }
}

function readMail(env: WorkerEnv): TemSettings | undefined {
  const credentials = env.FRUITBACK_SCALEWAY_TEM ? parseTemCredentials(env.FRUITBACK_SCALEWAY_TEM) : undefined;
  const from = env.FRUITBACK_MAIL_FROM?.trim();
  if (credentials === undefined || from === undefined || !from.includes('@')) return undefined;

  return { ...credentials, from };
}

/**
 * Absent means `public`, which is what every worker did before FRU-40. Anything else is passed
 * through verbatim so the enum refuses it — a misspelt `FRUITBACK_READ=authenticaed` must not fall
 * back to the open setting it was written to close.
 */
function readAccess(value: string | undefined): string {
  return value === undefined || value.trim() === '' ? 'public' : value.trim();
}

/**
 * The worker's own variables. A store's are declared by that store — see `createLinearStoreSpec` —
 * which is why `LINEAR_API_KEY` no longer appears here.
 */
const NAMES_BY_FIELD: Record<string, string> = {
  allowedOrigins: 'ALLOWED_ORIGINS',
  trustedProxyHops: 'TRUSTED_PROXY_HOPS',
  rateLimitPerMinute: 'RATE_LIMIT_PER_MINUTE',
  read: 'FRUITBACK_READ',
  teamLocale: 'FRUITBACK_TEAM_LOCALE',
  // Absent until FRU-33, and it showed: a secret under 32 characters failed the schema, matched no
  // name, and answered `503 misconfigured, missing:` with nothing after the colon. Every field that
  // can fail validation needs an entry here — asserted by `answers no empty diagnostic`.
  identitySecret: 'FRUITBACK_IDENTITY_SECRET',
  secretsKey: 'FRUITBACK_SECRETS_KEY',
  authSecret: 'FRUITBACK_AUTH_SECRET',
};

function missingFrom(result: z.ZodSafeParseResult<unknown>): string[] {
  if (result.success) return [];

  const missing = result.error.issues
    .map((issue) => NAMES_BY_FIELD[String(issue.path[0])])
    .filter((name): name is string => name !== undefined);

  return [...new Set(missing)];
}

/**
 * Every origin this worker serves: `ALLOWED_ORIGINS` plus the sites declared per client in
 * `FRUITBACK_CLIENTS`, so a client's origins are written once instead of twice.
 *
 * Exported and used **both** by the validated config and by the misconfigured-response path, which
 * has no validated config to read. Computing it in two places is how a client reachable only through
 * the map lost its CORS headers on the 500 — turning the diagnostic the browser was meant to read
 * into an opaque failure, which is the one thing that branch exists to prevent.
 */
export function readAllowedOrigins(env: WorkerEnv): string[] {
  const clients = readClientMap(env.FRUITBACK_CLIENTS);

  return [
    ...new Set([...splitOrigins(env.ALLOWED_ORIGINS), ...originsFromClients(clients.ok ? clients.clients : undefined)]),
  ];
}

/** Exported so the misconfigured-response path can read the allowlist before validation. */
export function splitOrigins(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/**
 * Requests per minute per client IP. Left alone in production; raised for the E2E suite, where every
 * request comes from the same loopback address and the default ceiling would be reached mid-run.
 */
function readRateLimit(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_LIMIT;

  const parsed = Number(value);

  // Refused rather than defaulted, like the hop count: a typo must not silently widen the ceiling.
  return Number.isInteger(parsed) && parsed > 0 ? parsed : Number.NaN;
}

/**
 * The team's locale, or an empty string when the value is not a locale tag at all (FRU-39).
 *
 * The schema refuses the empty string, so a typo is a boot failure that names
 * `FRUITBACK_TEAM_LOCALE`. `Intl` is what decides, because it is what a formatter would be given.
 * A valid tag with no words in this build is not this function's business: `teamWords` falls back
 * to English for it.
 */
function readTeamLocale(value: string | undefined): string {
  const tag = (value ?? '').trim();
  if (tag === '') return DEFAULT_TEAM_LOCALE;

  try {
    Intl.getCanonicalLocales(tag);
  } catch {
    return '';
  }

  return tag;
}

function readTrustedProxyHops(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_TRUSTED_PROXY_HOPS;

  const parsed = Number(value);

  // A typo here would silently make the rate limit forgeable, so refuse rather than fall back.
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : Number.NaN;
}

export function readPort(env: WorkerEnv): number {
  const parsed = Number(env.PORT ?? '');

  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
}
