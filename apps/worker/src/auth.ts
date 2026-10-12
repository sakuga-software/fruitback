import type { Auth, BetterAuthOptions, BetterAuthPlugin } from 'better-auth';

/** An instance of better-auth, for a file that may not name the library (a lint rule). */
export type { Auth };
import { ACTIONS, ROLES } from './accounts.ts';
import { newId, roleOf } from './account-rows.ts';
import { type AdapterOfAuth, keepAtRest } from './auth-at-rest.ts';
import { ORGANIZATION_PATHS } from './organization-paths.ts';
import { FRUITBACK_RESOURCE, roleStatements } from './auth-roles.ts';
import { type WorkerConfig, hasAuth } from './env.ts';
import type { OAuthClient } from './oauth-client.ts';
import { type PgDatabase, type PgPool, databaseFor, withoutAddress } from './postgres.ts';
import { migrated, sessionStoreOn } from './postgres-stores.ts';
import type { SessionStore } from './session.ts';

/**
 * better-auth (FRU-144), what it keeps in the database (FRU-181), and the console that signs in with
 * it (FRU-147).
 *
 * This file says how better-auth is configured for the console, and builds one instance for the
 * process when `FRUITBACK_AUTH_SECRET` and `FRUITBACK_DATABASE_URL` are both set. `auth-routes.ts`
 * serves it under `/console/auth/`, the paths of `SERVED_PATHS` only. It is the one way to sign in to
 * the console since FRU-150.
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
export const AUTH_PLUGINS = ['organization', 'magic-link', 'fruitback-at-rest'] as const;

/**
 * The routes of better-auth that a request reaches (FRU-147), under `AUTH_BASE_PATH`. Any other path
 * there answers `404` from the worker, before better-auth reads it: a route that a plugin adds is
 * closed until somebody opens it here, with its reason.
 *
 * Not here, and on purpose: `/sign-in/magic-link` and `/magic-link/verify` (the worker's own routes
 * call them in the process: the token of a link travels after a `#`, and never in an address),
 * `/list-sessions` (a route of the worker lists them, with no token), `/get-session` (FRU-206: the
 * console reads who is signed in on `/console/me`, and this route answers the token of the session
 * to a script; the worker reads a session with `auth.api.getSession`, in the process), and the five
 * of `DISABLED_PATHS`. The routes of the organization plugin have their own list, with a rule for each:
 * `ORGANIZATION_PATHS` of `auth-organization.ts` (FRU-149).
 */
export const SERVED_PATHS: Readonly<Record<string, string>> = {
  '/ok': 'it says that better-auth answers, and nothing else',
  '/sign-out': 'it ends the session of this cookie',
  '/revoke-sessions': '« sign out everywhere »: every session of the person',
  '/sign-in/social': 'it starts a sign-in with GitHub or Google',
  '/callback/github': 'GitHub sends the person back here',
  '/callback/google': 'Google sends the person back here',
  '/error': 'better-auth sends a person here when a sign-in fails before it knows the console',
};

/** How long an invitation waits (FRU-104). `auth-organization.ts` says the same number in its message. */
export const INVITATION_SECONDS = 7 * 24 * 60 * 60;

/** How long a link of the e-mail lives: fifteen minutes, as since FRU-98. */
export const MAGIC_LINK_TTL_SECONDS = 15 * 60;

/**
 * How long a session of the console lives, and how often a call that uses it moves its end (FRU-147).
 * These are the defaults of 1.7.7, written: a later default changes nothing here. `SECURITY.md` says
 * both numbers, and `security.test.ts` holds them.
 */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const SESSION_RENEWAL_SECONDS = 24 * 60 * 60;

/**
 * The header that carries the address of the caller to better-auth when the worker keeps addresses
 * (FRU-147). The worker writes it on each request it hands over, from `resolveClientIp`, over
 * anything the caller sent: better-auth reads no other header for an address.
 */
export const CLIENT_IP_HEADER = 'x-fruitback-client-ip';

/**
 * Who sends the link of a sign-in (FRU-147).
 *
 * `/sign-in/magic-link` makes the token and calls `sendMagicLink` in the middle of the call, so the
 * worker cannot pass the mailer as an argument. The route of the worker leaves a delivery here under a
 * ticket, and names the ticket in the `metadata` of the call. No request reaches that path: a call
 * without a ticket sends nothing, and throws.
 *
 * better-auth awaits `sendMagicLink` before it answers (read in `plugins/magic-link/index.mjs` of
 * 1.7.7), so the ticket is there for the whole delivery, and an error of the mailer reaches the
 * route: test:`answers 202 once the link is sent, and 502 when the mail provider refuses it`.
 */
const deliveries = new Map<string, (token: string) => Promise<void>>();

/** Asks better-auth for a link to `email`, and hands its token to `deliver`. */
export async function sendLinkThrough(
  auth: Auth,
  email: string,
  headers: Headers,
  deliver: (token: string) => Promise<void>,
): Promise<void> {
  const ticket = crypto.randomUUID();
  deliveries.set(ticket, deliver);
  try {
    await (auth.api as unknown as { signInMagicLink(input: object): Promise<unknown> }).signInMagicLink({
      body: { email, metadata: { ticket } },
      headers,
    });
  } finally {
    deliveries.delete(ticket);
  }
}

async function deliverLink({ token, metadata }: { token: string; metadata?: Record<string, unknown> }): Promise<void> {
  const deliver = typeof metadata?.ticket === 'string' ? deliveries.get(metadata.ticket) : undefined;
  if (deliver === undefined) throw new Error('A link of better-auth was asked for by no route of the worker');
  await deliver(token);
}

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

/**
 * The code of the refusal of a role that is not one of the four of `ROLES`, or that is several
 * (FRU-149). better-auth takes a list of roles, writes it as `guest,admin`, and reads the union of
 * what each one may do (measured on 1.7.7). In this worker a member has one role.
 */
export const ROLE_REFUSED = 'ROLE_IS_NOT_ONE_OF_THE_FOUR';

/**
 * The code of an invitation that nobody stands behind any more (FRU-209): whoever made it was
 * removed from the workspace, left it, or may no longer invite there.
 */
export const INVITER_GONE = 'INVITER_NO_LONGER_INVITES';

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
  /** `FRUITBACK_AUTH_GITHUB_OAUTH`: the second GitHub App, the one of better-auth (FRU-147). */
  github?: OAuthClient;
  /** `FRUITBACK_GOOGLE_OAUTH`: the Google client, with the callback of better-auth. */
  google?: OAuthClient;
  /** `FRUITBACK_AUTH_TRACK_IP`: keep the address and the user agent of a session, and limit by address. */
  trackIp: boolean;
};

/** The configuration of better-auth for this worker, or `undefined` when it is off. */
export function authConfigOf(config: WorkerConfig): AuthConfig | undefined {
  if (!hasAuth(config)) return undefined;
  const { authSecret, databaseUrl, publicUrl, consoleUrl } = config;
  // `readConfig` refuses the secret without each of these: this only narrows the types.
  if (authSecret === undefined || databaseUrl === undefined || publicUrl === undefined || consoleUrl === undefined) {
    return undefined;
  }

  return {
    secret: authSecret,
    publicUrl,
    consoleUrl,
    databaseUrl,
    ...(config.authGithub === undefined ? {} : { github: config.authGithub }),
    ...(config.google === undefined ? {} : { google: config.google }),
    trackIp: config.authTrackIp,
  };
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
export async function authOptions(
  config: AuthConfig,
  pool: PgPool,
  /** The sessions of the extensions: a member who is removed keeps none for the workspace (FRU-149). */
  sessions: Pick<SessionStore, 'endSessionsOf'>,
): Promise<BetterAuthOptions> {
  const [{ organization }, { magicLink }, { createAccessControl }, { defaultStatements }, { APIError }] =
    await Promise.all([
      import('better-auth/plugins/organization'),
      import('better-auth/plugins/magic-link'),
      import('better-auth/plugins/access'),
      import('better-auth/plugins/organization/access'),
      import('better-auth/api'),
    ]);
  // No picture: the accounts of before kept none, and a picture of GitHub is an address that says
  // when a page of the console was opened.
  const noPicture = () => ({ image: undefined });
  const providers = {
    ...(config.github === undefined ? {} : { github: { ...config.github, mapProfileToUser: noPicture } }),
    ...(config.google === undefined ? {} : { google: { ...config.google, mapProfileToUser: noPicture } }),
  };

  // The four roles, read from `can` of accounts.ts: see auth-roles.ts.
  const access = createAccessControl({ ...defaultStatements, [FRUITBACK_RESOURCE]: ACTIONS });
  const roles = Object.fromEntries(
    Object.entries(roleStatements()).map(([role, statements]) => [role, access.newRole(statements as never)]),
  );

  const refuseOtherRoles = (role: unknown): void => {
    if (roleOf(role) !== undefined) return;
    throw new APIError('BAD_REQUEST', {
      code: ROLE_REFUSED,
      message: `A member has one role, one of ${ROLES.join(', ')}`,
    });
  };
  const organizations = organization({
    ac: access,
    roles,
    creatorRole: 'owner',
    // Written, though both are the defaults of 1.7.7: no team, and no role made at run time. A role
    // is one of the four of `ROLES`, and what it may do is in `RIGHTS` of accounts.ts.
    teams: { enabled: false },
    dynamicAccessControl: { enabled: false },
    // A workspace is deleted by `DELETE /console/workspaces/<id>`, which revokes the tokens of its
    // trackers first and ends the sessions of its extensions. The route of the plugin does neither,
    // and a call to it in the process is refused too.
    disableOrganizationDeletion: true,
    // The invitations (FRU-104). Written, though three are the defaults of 1.7.7: an invitation is
    // read, accepted and declined by a session whose address is verified, a second invitation of one
    // address is refused while the first waits, and a workspace has a hundred waiting at most.
    invitationExpiresIn: INVITATION_SECONDS,
    invitationLimit: 100,
    cancelPendingInvitationsOnReInvite: false,
    requireEmailVerificationOnInvitation: true,
    organizationHooks: {
      // Every way the plugin writes a role: a member it adds (the owner of a new workspace is one),
      // a role it changes, an invitation it keeps.
      beforeAddMember: async ({ member }) => refuseOtherRoles(member.role),
      beforeUpdateMemberRole: async ({ newRole }) => refuseOtherRoles(newRole),
      beforeCreateInvitation: async ({ invitation }) => refuseOtherRoles(invitation.role),
      // Accepting writes the role of the invitation on a member, and runs no `beforeAddMember`
      // (read in `routes/crud-invites.mjs` of 1.7.7): a row that holds another role is refused here.
      beforeAcceptInvitation: async ({ invitation }) => refuseOtherRoles(invitation.role),
      // `/organization/leave` runs no hook (read in `routes/crud-members.mjs` of 1.7.7): the route of
      // the worker ends the sessions of somebody who leaves, in `auth-organization.ts`.
      // The extensions of somebody who is removed stop **before** the member is deleted (FRU-209):
      // when this fails the plugin deletes nothing, and the call is made again. After the write, a
      // failure left a member who was gone with a session that was alive, and the second call
      // answered `MEMBER_NOT_FOUND`. It runs again after, for a session opened between the two.
      beforeRemoveMember: async ({ member }) =>
        sessions.endSessionsOf({ subject: member.userId, workspace: member.organizationId }, Date.now()),
      // The second pass must not fail the call: the member is deleted, the first pass ended their
      // sessions, and a `500` here kept the route from cancelling their invitations.
      afterRemoveMember: async ({ member }) => {
        try {
          await sessions.endSessionsOf({ subject: member.userId, workspace: member.organizationId }, Date.now());
        } catch (error) {
          console.error(`[fruitback] the sessions of a removed member were ended once, not twice: ${String(error)}`);
        }
      },
    },
  });
  // Every route of the plugin that `ORGANIZATION_PATHS` does not name is closed to a request by
  // better-auth itself, under the list of the worker: the list is read from the plugin as it is
  // installed, so a route that a later version adds is closed here before anybody reads its name.
  const closedOrganizationPaths = Object.values(organizations.endpoints as Record<string, { path?: string }>)
    .map((endpoint) => endpoint.path)
    .filter((path): path is string => typeof path === 'string' && !Object.hasOwn(ORGANIZATION_PATHS, path));

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
    // Off, the limit of the worker is the only one. It counts above the dispatch, for every route,
    // with the address `resolveClientIp` read. On (`FRUITBACK_AUTH_TRACK_IP`), better-auth counts too,
    // with the same address: the worker hands it in `CLIENT_IP_HEADER`, and better-auth reads no
    // other header. Left to itself, it reads `X-Forwarded-For`, takes a lone value as the caller wrote
    // it, and refuses a chain (measured).
    rateLimit: { enabled: config.trackIp },
    // The session is read in the database at each call, so a session that is revoked stops at once.
    session: {
      cookieCache: { enabled: false },
      expiresIn: SESSION_TTL_SECONDS,
      updateAge: SESSION_RENEWAL_SECONDS,
    },
    socialProviders: providers,
    // A sign-in that fails goes back to the console, which says why. Without it, to a page of the
    // worker that no person reads.
    onAPIError: { errorURL: `${new URL(config.consoleUrl).origin}/setup` },
    databaseHooks: {
      user: {
        create: {
          // SECURITY.md: an address that a provider did not verify creates no account. better-auth
          // links no such address to an account that exists (measured), and it **creates** one for
          // it (measured on 1.7.7: a session opened, with `emailVerified` false). A link of the
          // e-mail proves its address, so it passes.
          before: async (user: { emailVerified?: unknown }) => (user.emailVerified === true ? undefined : false),
        },
        // An account that is deleted keeps no extension, in any workspace (FRU-149). No route deletes
        // an account today: this holds for the day one does.
        delete: {
          after: async (user: { id: string }) => sessions.endSessionsOf({ subject: user.id }, Date.now()),
        },
      },
      session: {
        create: {
          // Off, no address and no user agent in the row: the decision of 2026-10-11.
          before: async (session: Record<string, unknown>) =>
            config.trackIp ? undefined : { data: { ...session, ipAddress: null, userAgent: null } },
        },
      },
    },
    // A link or a code is kept as its digest. `auth-at-rest.ts` digests each identifier once more,
    // because this option alone also looks the identifier up as it was given (read in the package).
    verification: { storeIdentifier: 'hashed' },
    // The state of a sign-in with a provider holds the state and the PKCE verifier in the clear. In
    // the database, a copy and an intercepted code would finish the sign-in. In an encrypted cookie,
    // it is in the browser that started it, and in no copy.
    account: { storeStateStrategy: 'cookie' },
    // To a request, as `SERVED_PATHS` closes them too. The two of the link stay open to `auth.api`.
    disabledPaths: [
      ...Object.keys(DISABLED_PATHS),
      '/sign-in/magic-link',
      '/magic-link/verify',
      ...closedOrganizationPaths,
    ],
    advanced: {
      cookiePrefix: 'fruitback',
      // `HttpOnly` is the default of better-auth, and `Secure` comes with an `https://` address. The
      // cookie goes to the routes of the console and to no other route of this worker.
      // The state of a sign-in with a provider goes to the routes of better-auth only. It stays `Lax`:
      // the provider sends the person back with a navigation from its own site, and a `Strict` cookie
      // is not sent on it.
      cookies: {
        session_token: { attributes: { sameSite: 'strict', path: '/console' } },
        oauth_state: { attributes: { path: AUTH_BASE_PATH } },
      },
      // Off, no address is read, and none is kept in the `session` table. On, the one that
      // `resolveClientIp` read, in a header that the worker writes over what the caller sent.
      ipAddress: config.trackIp
        ? { ipAddressHeaders: [CLIENT_IP_HEADER], disableIpTracking: false }
        : { disableIpTracking: true },
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
    // The organization plugin: its schema, the four roles, and the routes of `ORGANIZATION_PATHS`.
    // The link of the e-mail (FRU-147): its token is kept as a digest (`storeToken`), digested again
    // by `verification.storeIdentifier`, then by the layer. `sendMagicLink` hands the token to the
    // route of the worker that asked, which writes it after a `#`.
    plugins: [
      organizations,
      magicLink({ storeToken: 'hashed', expiresIn: MAGIC_LINK_TTL_SECONDS, sendMagicLink: deliverLink }),
      atRest(APIError),
    ],
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

  const starting = migrated(database).then(async () =>
    startAuth(await authOptions(auth, await database.pool(), sessionStoreOn(database))),
  );
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
 * Built at boot and not at the first sign-in: a configuration that
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
    log.log('[fruitback] better-auth is ready, under /console/auth');

    return 'ready';
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    log.error(`[fruitback] better-auth did not start: ${withoutAddress(said, config.databaseUrl ?? '')}`);

    return 'failed';
  }
}
