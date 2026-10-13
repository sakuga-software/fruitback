import { SEED_STAGES, type Seed, canonicalizePageUrl, parseSeed, type SeedReporter } from '@fruitback/shared';
import { type IdentityResult, readBearerToken, stripClaimedVerification, verifyIdentityToken } from './identity.ts';
import {
  type ClientConfig,
  type ClientDestination,
  type ClientMap,
  type ClientPolicy,
  type ClientResolution,
  normalizeClientId,
  openReadClients,
  originsFromClients,
  resolveClient,
} from './clients.ts';
import { type AccountStore, type Role, can } from './accounts.ts';
import { SESSION_SITES_PATH, handleSessionSites } from './session-sites.ts';
import { type Auth, authFor } from './auth.ts';
import { createWorkspaceWithPlugin, handleOrganizationRoutes, renameWorkspaceWithPlugin } from './auth-organization.ts';
import { MAX_BODY_BYTES, readBoundedBytes, readBoundedText } from './bounded-body.ts';
import { AuthUnavailable, handleAuthRoutes, isAuthRoute, sessionOfCookie, withRenewedCookie } from './auth-routes.ts';
import { SIGN_IN_PROVIDERS, consoleCors, isConsoleRoute } from './console-cors.ts';
import { handleConsoleApi } from './console-api.ts';
import { type TxtResolver, recheckDomains } from './domain-proof.ts';
import { firstReviewerLines } from './first-reviewer.ts';
import { handleLinearOAuth } from './linear-oauth.ts';
import { createConnectorStores, createRoutedStore } from './connectors.ts';
import { DELIVERY_HEADER, LOOP_STATUS, type Send, deliverDue } from './rest-connector.ts';
import { type Mailer, createTemMailer } from './mail.ts';
import { type WorkerConfig, type WorkerEnv, hasAccounts, hasSessions, readAllowedOrigins, readConfig } from './env.ts';
import { type BatchAnswer, type BatchMemory, type CreatedIssue, type SeedStore, StoreError } from './store.ts';
import { createAll } from './batch.ts';
import { watchedStore } from './connector-health.ts';
import { type CorsDecision, diagnosticCorsHeaders, openCors, resolveCors } from './cors.ts';
import { PAIR_PATH, pairPage } from './pair-page.ts';
import { chargeRateLimit, checkRateLimit, maxBatch } from './rate-limit.ts';
import { cached, invalidate } from './cache.ts';
import { type Kv, KvError, processKv } from './kv.ts';
import { type Channel, type NoteEntry, type NoteIndex, authorOf } from './notes-index.ts';
import {
  postgresAccountStore,
  postgresConnectStore,
  postgresKv,
  postgresNoteIndex,
  postgresScreenshotStore,
  postgresSessionStore,
} from './postgres-stores.ts';
import type { ConnectStore } from './connect.ts';
import { handleConsoleConnect, handleExtensionConnect } from './connect-routes.ts';
import {
  MAX_SCREENSHOT_BYTES,
  SCREENSHOT_PATH,
  type ScreenshotStore,
  newScreenshotId,
  pngSize,
  screenshotIdOf,
} from './screenshots.ts';
import { withoutAddress } from './postgres.ts';
import {
  type SessionIdentity,
  type SessionStore,
  createPairing as openPairing,
  redeemPairing,
  refreshSession,
  revokeSession,
} from './session.ts';
import { createSqliteSessionStore } from './session-sqlite.ts';

/**
 * The only server-side piece of Fruitback. Its single reason to exist: the Linear API key cannot
 * live in JavaScript served on a client's public site. Everything else — storage, status, threads —
 * is Linear's job.
 *
 * The handler is written against web `Request`/`Response` and knows nothing about the transport;
 * `server.ts` adapts `node:http` onto it. That keeps every behaviour testable without opening a
 * socket, and keeps the door open if this ever moves to another runtime.
 */

/**
 * Which store this process writes to (FRU-29, FRU-33).
 *
 * It was a `Pick<typeof realLinear, 'createSeedIssue' | 'fetchSeedIssues'>` — an interface
 * discovered by accident — then a branch on a `fakeLinear` boolean with Linear's three credentials
 * read straight off the config. Both are gone: the provider was selected and validated at boot
 * (`stores.ts`), and this is only where it is built. SQLite (FRU-31) and GitHub (FRU-32) each
 * added an entry to the registry and nothing here.
 *
 * A dev-only store cannot win in production: `readStoreConfig` refuses it at boot rather than
 * letting the process start.
 */
export function storeFor(config: WorkerConfig): SeedStore {
  return config.store.create();
}

/**
 * The extension's session store, or `undefined` when this worker runs without one (FRU-42).
 *
 * Deliberately not built from `config.store`: sessions are credentials and seeds are not, so they
 * never share a backend. They are in the database of the accounts when the worker has one (FRU-142),
 * and in their own file otherwise. See `FRUITBACK_SESSION_PATH`.
 */
export function sessionStoreFor(config: WorkerConfig): SessionStore | undefined {
  // `readConfig` refuses the two together, so the order here decides nothing.
  if (config.databaseUrl !== undefined) return postgresSessionStore(config.databaseUrl, config.databaseSchema);

  return config.sessionPath === undefined ? undefined : createSqliteSessionStore(config.sessionPath);
}

/**
 * Writes the pairing code of the first reviewer in the log, on a worker that names one and holds no
 * session yet (FRU-108). `server.ts` calls it when the server listens. It never rejects: a store
 * that does not open must not stop a worker that can still serve, and the next start tries again.
 */
export async function announceFirstReviewer(
  config: WorkerConfig,
  log: (line: string) => void = (line) => console.log(`[fruitback] ${line}`),
): Promise<void> {
  const store = config.firstReviewer === undefined ? undefined : sessionStoreFor(config);
  if (config.firstReviewer === undefined || store === undefined) return;
  try {
    for (const line of await firstReviewerLines(store, config.firstReviewer, config.publicUrl)) log(line);
  } catch (error) {
    console.error(
      `[fruitback] the pairing code of FRUITBACK_FIRST_REVIEWER was not minted: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Where the requests of the extension wait for a person to approve them (FRU-238): the database of
 * the accounts, or nowhere. A worker with no accounts has nobody to approve.
 */
export function connectStoreFor(config: WorkerConfig): ConnectStore | undefined {
  return config.databaseUrl === undefined ? undefined : postgresConnectStore(config.databaseUrl, config.databaseSchema);
}

/** What sends the e-mail of this worker, or `undefined` when it sends none (FRU-98). */
export function mailerFor(config: WorkerConfig): Mailer | undefined {
  return config.mail === undefined ? undefined : createTemMailer(config.mail);
}

/** The accounts of this worker, or `undefined` when its clients come from the env (FRU-96). */
export function accountStoreFor(config: WorkerConfig): AccountStore | undefined {
  return config.databaseUrl === undefined ? undefined : postgresAccountStore(config.databaseUrl, config.databaseSchema);
}

/**
 * The configuration with the sites of every workspace as its clients, and their origins allowed.
 *
 * An empty map stays an empty map: a worker with accounts and no site yet serves no client, and an
 * `undefined` here would turn it into a single-client worker that answers anybody.
 */
async function withSites(config: WorkerConfig, accounts: AccountStore): Promise<Served> {
  const clients = await accounts.clientMap();

  return {
    ...config,
    clients,
    allowedOrigins: [...new Set([...config.allowedOrigins, ...originsFromClients(clients)])],
    roleIn: (workspace, account) => accounts.role(workspace, account),
    accountExists: async (account) => (await accounts.account(account)) !== undefined,
  };
}

/**
 * The configuration as one request reads it: the sites of the accounts are its clients, each with
 * the places it can send to, and the role of a person in a workspace can be asked (FRU-123).
 */
type Served = WorkerConfig & {
  clients?: ClientMap;
  /** Absent on a worker with no accounts: nobody is a member of anything there. */
  roleIn?: (workspace: string, account: string) => Promise<Role | undefined>;
  /** Whether an account is still there (FRU-238). Absent on a worker with no accounts. */
  accountExists?: (account: string) => Promise<boolean>;
};

/** The client as it routes when its notes go to this place, and not to its first one. */
function placedAt(client: ClientConfig, place: ClientDestination): ClientConfig {
  const { teamId: _team, projectId: _project, ...rest } = client;

  return {
    ...rest,
    connector: place.connector,
    ...(place.teamId === undefined ? {} : { teamId: place.teamId }),
    ...(place.projectId === undefined ? {} : { projectId: place.projectId }),
  };
}

/**
 * Whether the caller is a person who may see the tracker of this client (FRU-123).
 *
 * Only a session of the workspace of the client says so, and the role is read at each request: a
 * person who left the workspace holds a token for ten more minutes. The token of a site names a
 * visitor of that site, who is in no workspace, so it never does.
 *
 * WARNING: this decides who reads the names of the places and who chooses one. It does not decide
 * who reads the notes: `authorizeRead` does, before this runs.
 */
async function seesTracker(request: Request, config: Served, policy: ClientPolicy): Promise<boolean> {
  if (config.roleIn === undefined || policy.sessions === undefined) return false;
  const token = readBearerToken(request.headers.get('Authorization'));
  if (token === undefined) return false;

  // The one place that verifies a token, so the workspace is checked here as on every other path.
  const verified = await verifyForClient(token, policy);
  if (verified?.ok !== true || verified.session !== true) return false;
  const account = verified.reporter.id;
  if (account === undefined) return false;
  const role = await config.roleIn(policy.sessions.workspace, account);

  return role !== undefined && can(role, 'see-tracker');
}

/**
 * Whether the worker would sign a note of this caller with an identity it verified (FRU-112).
 *
 * The widget asks for no name then: a typed one would be replaced. It is the answer `attributionFor`
 * gives to the same token, so a site token counts like a session.
 *
 * WARNING: one bit, and never who. In team mode the page reads this answer, and it must learn
 * nothing of the session that the notes do not show already.
 */
async function signsNotes(request: Request, policy: ClientPolicy): Promise<boolean> {
  const token = readBearerToken(request.headers.get('Authorization'));
  if (token === undefined) return false;

  return (await verifyForClient(token, policy))?.ok === true;
}

/**
 * One pass over the notes that wait to be sent to the address a workspace connected (FRU-122).
 *
 * The server calls it on a timer. It is here and not in `server.ts` so a test reaches it with no
 * socket: it reads the same configuration as a request does.
 */
/**
 * Asks the DNS again for the proofs of the domains that were not asked for `RECHECK_MS` (FRU-103).
 * `server.ts` calls it on a timer, like `deliverPending`.
 */
export async function recheckPending(env: WorkerEnv, resolve: TxtResolver, now?: () => number): Promise<void> {
  const config = readConfig(env);
  const accounts = config.ok ? accountStoreFor(config.config) : undefined;
  if (!config.ok || accounts === undefined) return;

  await recheckDomains(accounts, resolve, (now ?? Date.now)());
}

export async function deliverPending(
  env: WorkerEnv,
  send: Send,
  now?: () => number,
  /** The accounts a test opened, as `RequestContext.accounts`. Absent, the ones of the environment. */
  held?: AccountStore,
): Promise<void> {
  const config = readConfig(env);
  if (!config.ok) return;
  const accounts = held ?? accountStoreFor(config.config);
  if (accounts === undefined) return;

  await deliverDue({ accounts, secretsKey: config.config.secretsKey, send, ...(now === undefined ? {} : { now }) });
}

/** What the transport knows and the request itself cannot say. */
export type RequestContext = {
  /** Already resolved against the trusted proxy chain — see `resolveClientIp`. */
  clientIp: string;
  /**
   * The store, built **once by the transport** rather than per request.
   *
   * This began as `storeFor(config)` inside the two handlers, which was invisible for Linear and the
   * in-memory one — both are stateless closures — and would have opened a SQLite connection per
   * request the moment FRU-31 landed. A refactor that exists to let a store hold a resource must
   * not reconstruct it on every call.
   *
   * Optional because `handleRequest` answers `/health` and the misconfigured diagnostic *before*
   * there is a validated config to build a store from, so the transport cannot always have one. When
   * it is absent the fallback builds one, which is also what a test driving this directly wants: a
   * fresh store per case.
   */
  store?: SeedStore;
  /** Same reason as `store`, for the sessions (FRU-42). A suite hands over a fresh file per case. */
  sessionStore?: SessionStore;
  /** Same reason, for the accounts, the workspaces and their sites (FRU-96). */
  accounts?: AccountStore;
  /** Same reason, for the requests of the extension that the console approves (FRU-238). */
  connectStore?: ConnectStore;
  /** What sends the sign-in links (FRU-98). A suite hands over one that keeps what it was given. */
  mailer?: Mailer;
  /** What asks the DNS for the proof of a domain (FRU-103). A suite hands over a double. */
  resolveTxt?: TxtResolver;
  /**
   * better-auth, for a worker that has it on (FRU-147). Absent, the handler takes the one instance of
   * the process (`authFor`), built when the server started. A suite hands over one on PGlite.
   */
  auth?: Auth | Promise<Auth>;
  /** Where the pictures of the notes are kept (FRU-44). A suite hands over one in memory. */
  screenshots?: ScreenshotStore;
  /**
   * Where the rate limiter and the read cache keep their state (FRU-49). When it is absent, the
   * handler uses `kvFor`, which gives the one instance of this process and never a new empty one.
   */
  kv?: Kv;
  /** The index of the notes (FRU-237). A suite hands over one on PGlite. */
  noteIndex?: NoteIndex;
};

/**
 * Where this worker keeps the state of its rate limiter and of its read cache (FRU-67).
 *
 * **A worker with a database keeps it there**, so its replicas share one limit; a worker without one
 * keeps it in the memory of the process, as before. No variable chooses: the database is the one
 * store that replicas share. One instance for the process either way.
 */
export function kvFor(config: Pick<WorkerConfig, 'databaseUrl' | 'databaseSchema'>): Kv {
  return config.databaseUrl === undefined ? processKv() : postgresKv(config.databaseUrl, config.databaseSchema);
}

export async function handleRequest(request: Request, env: WorkerEnv, context: RequestContext): Promise<Response> {
  const seen: { cors?: Record<string, string> } = {};
  let answer: Response;
  try {
    answer = await routed(request, env, context, seen);
  } catch (error) {
    if (!(error instanceof KvError)) throw error;
    // FRU-67. The `Kv` answered the rate limit and then stopped: a route below it counts a message,
    // or keeps a ticket, and nothing there catches this. On memory a `Kv` never throws, so this is
    // the answer of a database that went away between two calls of one request: the same `503` as
    // the limiter's, with the CORS headers of the route, and never a `500` with no header.
    console.error(`[fruitback] the Kv did not answer: ${error.message}`);
    answer = json(503, { error: 'limiter-unavailable' }, seen.cors ?? {});
  }

  // FRU-208: a reading of the cookie of the console that renewed its session renews the cookie too.
  return withRenewedCookie(request, answer);
}

async function routed(
  request: Request,
  env: WorkerEnv,
  context: RequestContext,
  /** The CORS headers of this request, once they are known, for an answer made above. */
  seen: { cors?: Record<string, string> },
): Promise<Response> {
  // FRU-133: a delivery of the REST connector that came back to a worker. Before everything, the
  // readiness probe included: `/health` would answer 200, and the sender would count the note as
  // arrived.
  //
  // WARNING: this answer is not metered, and it must stay above the rate limit. It is the one
  // exception to « metered before the dispatch » that is not a probe or a refusal of the transport.
  // It reads no configuration, no `Kv` and no provider, so there is nothing to protect. Below the
  // limit it would answer `429` to a loop, and a `429` is tried again seven times.
  if (request.headers.has(DELIVERY_HEADER)) return json(LOOP_STATUS, { error: 'delivery-loop' });

  const { pathname } = new URL(request.url);

  // Read straight from the env, before validation: a misconfigured service still has to answer with
  // CORS headers, or the browser turns the diagnostic into an opaque CORS failure and the widget
  // never gets to read which var is missing. It is the same computation the validated config uses —
  // a client declared only in `FRUITBACK_CLIENTS` has to be served here too.
  const origins = readAllowedOrigins(env);
  const config = readConfig(env);

  // Readiness, before anything else: a container that cannot serve must not be routed to.
  if (pathname === '/health') {
    if (!config.ok) return json(503, { ok: false, error: 'misconfigured', missing: config.missing });

    // Announced, not hidden: a `200 ok` that quietly stores feedback in RAM would be the worst kind
    // of green check. The open-read count is here for the same reason (FRU-40) — a deployment
    // whose pins anyone can read should be able to say so without an operator reading the config.
    //
    // A count and not the ids: `/health` needs no authentication either, and listing client ids
    // would hand over the map this worker serves.
    // With accounts the clients are in a file or in a database, and this probe opens neither: it says
    // nothing of them.
    const openRead = hasAccounts(config.config)
      ? 0
      : openReadClients({ read: config.config.read, clients: config.config.clients }).length;

    return json(200, {
      ok: true,
      // The store's name, always, rather than the old `fakeLinear: true` (FRU-33). Which store a
      // process runs on is the thing an operator cannot tell from a green check, and naming one
      // provider in the answer was the last place `/health` assumed there was only ever one.
      store: config.config.store.provider,
      ...(openRead > 0 ? { openRead } : {}),
    });
  }

  if (!config.ok) {
    // Configuration is wrong on the service, not in the request: say so once, clearly.
    const headers = origins.length > 0 ? resolveCors(request, origins).headers : diagnosticCorsHeaders(request);

    return json(500, { error: 'misconfigured', missing: config.missing }, headers);
  }

  // With accounts, the sites the console wrote are this worker's clients (FRU-96), read per request so
  // a site added a second ago is served now. Everything below reads the served map and nothing else.
  const accounts = context.accounts ?? accountStoreFor(config.config);
  let served: Served;
  try {
    served = accounts === undefined ? config.config : await withSites(config.config, accounts);
  } catch (error) {
    if (error instanceof StoreError) {
      // Said in the log, because the answer says nothing: a database on a network fails in more ways
      // than a file, and the message of the store holds no address (FRU-141).
      console.error(`[fruitback] the accounts did not answer: ${error.message}`);

      return json(502, { error: 'store-unavailable' }, diagnosticCorsHeaders(request));
    }
    throw error;
  }

  // The session routes answer the extension, which is not a site on the allowlist and cannot be put
  // on one — see `openCors`. Resolved before the gate, so the preflight succeeds too.
  const session = pathname.startsWith('/session/');
  // The pairing page is opened from a link, by a browser, as a document. No site reads it through
  // CORS, so the list of client sites does not apply and it answers with no CORS header at all.
  const pairing = pathname === PAIR_PATH;
  const site = (): CorsDecision => resolveCors(request, served.allowedOrigins);
  const extension = (): CorsDecision => (session ? openCors(request) : site());
  // The console's routes answer the console and no site, with the cookie of its session (FRU-98).
  const consoleRoute = hasAccounts(served) && isConsoleRoute(pathname);
  const chosen = (): CorsDecision => (consoleRoute ? consoleCors(request, served) : extension());
  const cors: CorsDecision = pairing ? { allowed: true, headers: {} } : chosen();
  if (!cors.allowed) {
    return json(403, { error: 'origin-not-allowed' });
  }
  seen.cors = cors.headers;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors.headers });
  }

  // The console removes a site or a workspace with DELETE, and no other route takes one.
  const deletes = consoleRoute && request.method === 'DELETE';
  if (request.method !== 'GET' && request.method !== 'POST' && !deletes) {
    return json(405, { error: 'method-not-allowed' }, cors.headers);
  }

  // Metered before the dispatch, and that ordering is the point (FRU-42). Both feedback directions
  // burn the same provider quota, and `/session/pair` is a code-guessing oracle without a limit —
  // this check used to sit *below* the `404`, so a new route would have been unmetered by default.
  // An unknown path costs quota too now, which is the right answer for something being probed.
  const kv = context.kv ?? kvFor(served);
  // FRU-237: the notes of the sites of the accounts are indexed, in the database of the accounts.
  const noteIndex = accounts === undefined ? undefined : (context.noteIndex ?? noteIndexFor(served));
  let allowed: boolean;

  try {
    allowed = await checkRateLimit(kv, context.clientIp, { limit: served.rateLimitPerMinute });
  } catch (error) {
    if (!(error instanceof KvError)) throw error;
    // Refused, not let through (FRU-49). A limiter that opens whenever its `Kv` does not answer is a
    // limiter any caller can open. `/health` does not reach this line, so it keeps answering.
    console.error(`[fruitback] rate limit unavailable: ${error.message}`);

    return json(503, { error: 'limiter-unavailable' }, cors.headers);
  }

  if (!allowed) {
    return json(429, { error: 'rate-limited' }, cors.headers);
  }

  if (consoleRoute && accounts !== undefined) {
    const sessions = context.sessionStore ?? sessionStoreFor(served);
    if (sessions === undefined || served.identitySecret === undefined)
      return json(404, { error: 'not-found' }, cors.headers);
    // better-auth, when it is on (FRU-147): the instance of the process, built at boot.
    const auth = context.auth ?? authFor(served);
    const mailer = context.mailer ?? mailerFor(served);

    try {
      // Which ways the routes of better-auth offer (FRU-135, FRU-147): the console asks before it
      // draws a button. `betterAuth` is absent when it is off: then nobody signs in to the console.
      // The two booleans of the path of before are gone with it (FRU-150).
      if (pathname === SIGN_IN_PROVIDERS && request.method === 'GET') {
        return json(
          200,
          auth === undefined
            ? {}
            : {
                betterAuth: {
                  email: mailer !== undefined,
                  github: served.authGithub !== undefined,
                  google: served.google !== undefined,
                },
              },
          cors.headers,
        );
      }

      // The routes of better-auth, and the worker's own beside them (FRU-147). A worker that has it
      // off answers `404` there, as before.
      if (isAuthRoute(pathname)) {
        if (auth === undefined || served.consoleUrl === undefined)
          return json(404, { error: 'not-found' }, cors.headers);
        try {
          const routes = {
            auth,
            accounts,
            mailer,
            kv,
            consoleUrl: served.consoleUrl,
            clientIp: context.clientIp,
            trackIp: served.authTrackIp,
          };
          // The routes of the organization plugin first, each under its rule (FRU-149). A path of the
          // plugin that has none answers `404` there, and never reaches the list below.
          const answer =
            (await handleOrganizationRoutes(request, pathname, { ...routes, sessions }, cors.headers)) ??
            (await handleAuthRoutes(request, pathname, routes, cors.headers));
          if (answer !== undefined) return answer;
        } catch (error) {
          // A `Kv` that stopped is not better-auth: it is answered above, as the limiter's outage.
          if (error instanceof StoreError || error instanceof KvError) throw error;
          // better-auth rejects, and does not answer, on a schema that is not the one it expects, or
          // a database that does not answer (FRU-144). Said in the log, with no address and no token.
          const said = error instanceof Error ? error.message : String(error);
          console.error(
            `[fruitback] better-auth did not answer: ${served.databaseUrl === undefined ? said : withoutAddress(said, served.databaseUrl)}`,
          );

          return json(502, { error: 'auth-unavailable' }, cors.headers);
        }
      }

      // The way to Linear and back, for a workspace that connects it (FRU-134). Navigations too.
      if (
        served.linearOAuth !== undefined &&
        served.publicUrl !== undefined &&
        served.consoleUrl !== undefined &&
        served.secretsKey !== undefined
      ) {
        const viaLinear = await handleLinearOAuth(request, pathname, {
          oauth: served.linearOAuth,
          publicUrl: served.publicUrl,
          consoleUrl: served.consoleUrl,
          accounts,
          kv,
          secretsKey: served.secretsKey,
        });
        if (viaLinear !== undefined) return viaLinear;
      }

      // The extension asks, the console approves (FRU-238): a request, and the browsers of the account.
      const connect = context.connectStore ?? connectStoreFor(served);
      if (auth !== undefined && served.consoleUrl !== undefined && connect !== undefined) {
        const connected = await handleConsoleConnect(
          request,
          pathname,
          {
            connect,
            accounts,
            cookieSession: async (each: Request) => (await sessionOfCookie(auth, each))?.userId,
            consoleUrl: served.consoleUrl,
          },
          cors.headers,
        );
        if (connected !== undefined) return connected;
      }

      const answer = await handleConsoleApi(
        request,
        pathname,
        {
          accounts,
          sessions,
          ...(served.secretsKey === undefined ? {} : { secretsKey: served.secretsKey }),
          kv,
          ...(noteIndex === undefined ? {} : { noteIndex }),
          ...(served.linearOAuth === undefined ? {} : { linearOAuth: served.linearOAuth }),
          ...(served.publicUrl === undefined ? {} : { publicUrl: served.publicUrl }),
          ...(context.resolveTxt === undefined ? {} : { resolveTxt: context.resolveTxt }),
          // Who calls is the person of the cookie of better-auth (FRU-147), and nobody without it.
          ...(auth === undefined || served.consoleUrl === undefined
            ? {}
            : {
                cookieSession: async (each: Request) => (await sessionOfCookie(auth, each))?.userId,
                consoleUrl: served.consoleUrl,
                // A workspace is made by the organization plugin for somebody of the cookie (FRU-149).
                createWorkspace: async (each: Request, name: string) =>
                  createWorkspaceWithPlugin(await auth, each.headers, name),
                // And renamed by it (FRU-236).
                renameWorkspace: async (each: Request, workspace: string, name: string) =>
                  renameWorkspaceWithPlugin(await auth, each.headers, workspace, name),
              }),
        },
        cors.headers,
      );

      return answer ?? json(404, { error: 'not-found' }, cors.headers);
    } catch (error) {
      if (error instanceof StoreError) return json(502, { error: 'store-unavailable' }, cors.headers);
      // The cookie of a call of the console is read by better-auth (FRU-147): the same answer as on
      // its own routes when it does not answer.
      if (error instanceof AuthUnavailable) {
        console.error(
          `[fruitback] better-auth did not answer: ${served.databaseUrl === undefined ? error.message : withoutAddress(error.message, served.databaseUrl)}`,
        );

        return json(502, { error: 'auth-unavailable' }, cors.headers);
      }
      throw error;
    }
  }

  if (pairing) {
    // It exists only where the sessions do, like the three routes below: a worker without the
    // extension does not advertise the page.
    if (context.sessionStore === undefined && !hasSessions(served)) {
      return json(404, { error: 'not-found' });
    }
    if (request.method !== 'GET') return json(405, { error: 'method-not-allowed' });

    return pairPage();
  }

  if (session) {
    try {
      // FRU-101: what the extension may turn on in one click, for a worker that keeps accounts.
      if (pathname === SESSION_SITES_PATH && accounts !== undefined && served.identitySecret !== undefined) {
        return await handleSessionSites(request, accounts, served.identitySecret, cors.headers, undefined, noteIndex);
      }

      // FRU-238: the extension asks to be connected, and comes back for its session. Only where a
      // person can approve: accounts, a console, and the key that signs the tokens.
      const connect = context.connectStore ?? connectStoreFor(served);
      if (
        accounts !== undefined &&
        connect !== undefined &&
        served.identitySecret !== undefined &&
        served.consoleUrl !== undefined
      ) {
        const connected = await handleExtensionConnect(
          request,
          pathname,
          {
            connect,
            accounts,
            kv,
            clientIp: context.clientIp,
            secret: served.identitySecret,
            consoleUrl: served.consoleUrl,
          },
          cors.headers,
        );
        if (connected !== undefined) return connected;
      }

      return await handleSession(request, pathname, served, context, cors.headers);
    } catch (error) {
      // A volume nobody mounted, a read-only disk, a file that is not a database. Answered like the
      // seed path's outage rather than as a bare `500`, so the extension can tell "retry later" from
      // "this request was wrong" — and so the answer carries the CORS headers it needs to read it.
      if (error instanceof StoreError) return json(502, { error: 'store-unavailable' }, cors.headers);
      throw error;
    }
  }

  if (pathname === SCREENSHOT_PATH || pathname.startsWith(`${SCREENSHOT_PATH}/`)) {
    try {
      return await handleScreenshot(request, pathname, served, context, cors.headers);
    } catch (error) {
      if (error instanceof StoreError) return json(502, { error: 'store-unavailable' }, cors.headers);
      throw error;
    }
  }

  if (pathname !== '/feedback') {
    return json(404, { error: 'not-found' }, cors.headers);
  }

  // Resolved once here, not inside each handler: see `RequestContext.store`.
  const own = context.store ?? storeFor(served);
  // FRU-121: a site that chose a destination writes and reads through the connector of its workspace.
  const store =
    accounts === undefined
      ? own
      : createRoutedStore(own, createConnectorStores(accounts, served.secretsKey, Date.now, served.linearOAuth));

  // FRU-102: what the tracker of a connector answers is noted on it, for the console.
  return request.method === 'GET'
    ? getFeedback(request, served, watchedStore(store, accounts), kv, cors.headers, noteIndex)
    : postFeedback(request, served, watchedStore(store, accounts), kv, cors.headers, context.clientIp, noteIndex);
}

/**
 * The extension's session endpoints (FRU-42).
 *
 * Three routes and no more: spend a pairing code, exchange a refresh token for an access token, and
 * end the session. Minting a code is **not** here — it is a command an operator runs on the
 * container, so that vouching for a person never becomes a network surface this worker has to
 * defend. See `main.ts`.
 *
 * All three answer `404` when no session store is configured, which is the same answer an unknown
 * path gets: a worker without the extension does not advertise that these exist.
 */
async function handleSession(
  request: Request,
  pathname: string,
  config: Served,
  context: RequestContext,
  headers: Record<string, string>,
): Promise<Response> {
  const store = context.sessionStore ?? sessionStoreFor(config);
  // `identitySecret` is present whenever the worker keeps sessions — `readConfig` refuses the pair at boot.
  if (store === undefined || config.identitySecret === undefined) return json(404, { error: 'not-found' }, headers);
  if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);

  // `readBoundedText` and not `request.text()`: it refuses a declared length over the cap before a
  // byte is read, and cancels the stream once a chunked upload crosses it. The first version of this
  // handler buffered the whole body and then measured `text.length` — which is UTF-16 units, not
  // bytes, so a multibyte body passed a byte cap it had already exceeded. Raised in review.
  const text = await readBoundedText(request);
  if (text === null) return json(413, { error: 'payload-too-large', maxBytes: MAX_BODY_BYTES }, headers);

  const body = parseJsonObject(text);
  if (body === undefined) return json(400, { error: 'invalid-body' }, headers);

  if (pathname === '/session/pair') {
    const code = typeof body.code === 'string' ? body.code : undefined;
    if (code === undefined) return json(400, { error: 'invalid-body' }, headers);

    const redeemed = await redeemPairing(store, code, config.identitySecret);
    // One answer for a code that never existed and one already spent: telling them apart is how a
    // caller works out which codes exist. `session.ts` returns the same reason for both.
    if (!redeemed.ok) return json(401, { error: redeemed.reason }, headers);
    // A code minted for somebody who left the workspace since: the same answer, and no session stays.
    if (!(await stillOfTheWorkspace(config, redeemed.session.identity))) {
      await revokeSession(store, redeemed.session.refreshToken);

      return json(401, { error: 'code-spent-or-expired' }, headers);
    }

    return json(200, redeemed.session, headers);
  }

  const refreshToken = typeof body.refreshToken === 'string' ? body.refreshToken : undefined;
  if (refreshToken === undefined) return json(400, { error: 'invalid-body' }, headers);

  if (pathname === '/session/refresh') {
    const refreshed = await refreshSession(store, refreshToken, config.identitySecret);
    // The session of somebody who is no longer of the workspace ends here (FRU-149), whatever
    // removed them. The answer is the one of a session that ended: it says nothing of the workspace.
    if (refreshed.ok && !(await stillOfTheWorkspace(config, refreshed.identity))) {
      await revokeSession(store, refreshed.refreshToken);

      return json(401, { error: 'session-revoked-or-expired' }, headers);
    }

    return refreshed.ok
      ? json(
          200,
          {
            accessToken: refreshed.accessToken,
            // Every refresh rotates (FRU-61), and this field is the whole of the client's half.
            // It is named here rather than spread, so leaving it out is what this route would do by
            // default — the rotation would work perfectly and reach nobody. A test asserts the body
            // carries it, because `tsc` cannot: the object is built field by field.
            refreshToken: refreshed.refreshToken,
            expiresIn: refreshed.expiresIn,
            identity: refreshed.identity,
          },
          headers,
        )
      : json(401, { error: refreshed.reason }, headers);
  }

  if (pathname === '/session/revoke') {
    // `204` whether or not this call is what revoked it. A logout that reported "there was nothing
    // to revoke" would tell a caller which refresh tokens are live.
    await revokeSession(store, refreshToken);

    return new Response(null, { status: 204, headers });
  }

  return json(404, { error: 'not-found' }, headers);
}

/** Where this worker keeps the pictures of the notes: its database, or nowhere (FRU-44). */
/** The index of the notes of a worker with a database (FRU-237), or none: `notes-index.ts`. */
export function noteIndexFor(config: WorkerConfig): NoteIndex | undefined {
  return config.databaseUrl === undefined ? undefined : postgresNoteIndex(config.databaseUrl, config.databaseSchema);
}

/**
 * Writes to the index of the notes, and never fails the request for it (FRU-237). The note is in its
 * store by then: a `502` would have the widget send it a second time. A row that is missing is
 * written again by the next read of its page.
 */
async function indexed(index: NoteIndex | undefined, work: (index: NoteIndex) => Promise<void>): Promise<void> {
  if (index === undefined) return;
  try {
    await work(index);
  } catch (error) {
    console.error(
      `[fruitback] the index of the notes was not written: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The row of the index of one note this worker just planted. */
function noteEntry(
  workspace: string,
  site: string,
  seed: Seed,
  channel: Channel,
  target: ClientConfig | undefined,
  issue: CreatedIssue,
): NoteEntry {
  return {
    workspace,
    site,
    seed,
    channel,
    author: authorOf(seed, channel === 'extension'),
    place: placeOf(target),
    issue: { identifier: issue.identifier, ...(issue.url === undefined ? {} : { url: issue.url }) },
    stage: 'seeded',
  };
}

/** Where a note of this target goes, as the index says it. */
function placeOf(target: ClientConfig | undefined): NoteEntry['place'] {
  return target?.connector === undefined ? { kind: 'fruitback' } : { kind: 'connector', connector: target.connector };
}

export function screenshotStoreFor(config: WorkerConfig): ScreenshotStore | undefined {
  return config.databaseUrl === undefined
    ? undefined
    : postgresScreenshotStore(config.databaseUrl, config.databaseSchema);
}

/**
 * The account of a session of the extension, when it is a session of `workspace` and that account is
 * still a member of it (FRU-44). `undefined` for anything else: no token, a token of a site, a
 * session of another workspace, a person who left.
 *
 * Verified by `verifyForClient`, the one place that checks the workspace of a token, with a policy
 * that holds the worker key and nothing of a site: no site key may stand for a member.
 */
async function memberOf(request: Request, config: Served, workspace: string): Promise<string | undefined> {
  const { roleIn } = config;
  if (config.identitySecret === undefined || roleIn === undefined) return undefined;
  const token = readBearerToken(request.headers.get('Authorization'));
  if (token === undefined) return undefined;
  const verified = await verifyForClient(token, {
    showComments: false,
    identitySecret: undefined,
    read: 'authenticated',
    locale: config.teamLocale,
    sessions: {
      secret: config.identitySecret,
      workspace,
      member: async (account) => (await roleIn(workspace, account)) !== undefined,
    },
  });
  if (verified?.ok !== true || verified.session !== true || verified.reporter.id === undefined) return undefined;

  return (await roleIn(workspace, verified.reporter.id)) === undefined ? undefined : verified.reporter.id;
}

/**
 * The pictures that the extension takes with a note (FRU-44): `POST /screenshot` keeps one,
 * `GET /screenshot/<id>` answers it.
 *
 * **Both answer somebody of the workspace, whatever their role, and nobody else.** A picture shows a
 * page of a staging site, so it is never read without a session, as the pins of a public site are
 * (FRU-84 is still open on what a public site may show). A guest sends one and reads one (FRU-213):
 * a guest reads the notes of the workspace, and the address of the picture is in the note. The right
 * asked for is to be of the workspace, and not `see-tracker`, which is about the tracker and what
 * the team answers there. That somebody is the session of the extension: its token, signed with the
 * worker key, names the account and the workspace, and the role is read at each request. A picture is sent for a client (`?client=`, the site of the note) and belongs to
 * the workspace of that site. To anybody who is not one of its members, with a token, a picture
 * answers `404`, as one that does not exist.
 *
 * The rest is the guard of the write path: the rate limit above, the CORS of the sites and of the
 * extension, `413` over `MAX_SCREENSHOT_BYTES`, `400` for bytes that are not a PNG. A worker with no
 * database keeps no picture, and answers `404` on both.
 */
async function handleScreenshot(
  request: Request,
  pathname: string,
  config: Served,
  context: RequestContext,
  headers: Record<string, string>,
): Promise<Response> {
  const store = context.screenshots ?? screenshotStoreFor(config);
  if (store === undefined) return json(404, { error: 'not-found' }, headers);

  if (pathname === SCREENSHOT_PATH) {
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
    // The picture is of the workspace of the site whose note it goes with: the client of the call.
    const route = routeFor(request, config, normalizeClientId(new URL(request.url).searchParams.get('client')));
    if (!route.ok) return routingFailure(route, headers);
    const workspace = route.policy.sessions?.workspace;
    const account = workspace === undefined ? undefined : await memberOf(request, config, workspace);
    if (workspace === undefined || account === undefined) return json(401, { error: 'identity-required' }, headers);

    const body = await readBoundedBytes(request, MAX_SCREENSHOT_BYTES);
    if (body === null) return json(413, { error: 'payload-too-large', maxBytes: MAX_SCREENSHOT_BYTES }, headers);
    const size = pngSize(body);
    if (size === undefined) return json(400, { error: 'not-a-png' }, headers);

    const id = newScreenshotId();
    await store.put({ id, workspace, account, png: body, ...size, createdAt: Date.now() });
    const base = config.publicUrl ?? new URL(request.url).origin;

    // `id` is what a caller builds the address from, at the address it reaches this worker by: `url`
    // is this worker's own idea of itself, which behind a proxy and with no `FRUITBACK_PUBLIC_URL`
    // is an inner address (raised in review).
    return json(201, { id, url: `${base}${SCREENSHOT_PATH}/${id}`, ...size }, headers);
  }

  const id = screenshotIdOf(pathname);
  if (id === undefined) return json(404, { error: 'not-found' }, headers);
  if (request.method !== 'GET') return json(405, { error: 'method-not-allowed' }, headers);
  if (readBearerToken(request.headers.get('Authorization')) === undefined)
    return json(401, { error: 'identity-required' }, headers);
  const found = await store.get(id);
  // A picture of another workspace answers as one that does not exist.
  if (found === undefined || (await memberOf(request, config, found.workspace)) === undefined)
    return json(404, { error: 'not-found' }, headers);

  return new Response(found.png, {
    status: 200,
    headers: {
      ...headers,
      'Content-Type': 'image/png',
      // Read by a member with a token: no shared cache keeps it, and no browser runs it as a page.
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
    },
  });
}

/**
 * Whether the person of a session is still a member of the workspace it names (FRU-149).
 *
 * `verifyForClient` compares the workspace of an access token, and never a role: until a person
 * could be removed, a session of a workspace was a member of it. Now the refresh is where a session
 * that outlived its membership ends, ten minutes at most after the access token it last minted.
 * Removing a member also ends their sessions at once (`endSessionsOf`); this is the second lock, for
 * a removal that did not go through that call, and for a row somebody deleted by hand.
 *
 * `true` on a worker with no accounts, and for a session that names no workspace: nobody is a member
 * of anything there, and the operator named the person with the pairing.
 */
async function stillOfTheWorkspace(config: Served, identity: SessionIdentity): Promise<boolean> {
  // A session of an account (FRU-238) lives as long as its account: it reads what the account is a
  // member of today, and nothing when that is nothing. An account that is gone ends it here.
  if (identity.account === true)
    return config.accountExists !== undefined && (await config.accountExists(identity.subject));
  if (config.roleIn === undefined || identity.workspace === undefined) return true;

  return (await config.roleIn(identity.workspace, identity.subject)) !== undefined;
}

/** Mints a pairing code. Not reachable over HTTP — see `handleSession` and `main.ts`. */
export async function createPairingCommand(
  config: WorkerConfig,
  identity: { subject: string; name?: string; email?: string; workspace?: string },
): Promise<{ code: string; expiresAt: number }> {
  const store = sessionStoreFor(config);
  if (store === undefined) {
    throw new Error(
      'FRUITBACK_SESSION_PATH is not set, and no FRUITBACK_DATABASE_URL, so this worker keeps no sessions',
    );
  }

  return openPairing(store, identity);
}

/** A session body is a JSON object or nothing. An array is not an object here, whatever `typeof` says. */
function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);

    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Which client this request belongs to, and what was decided for it (FRU-15).
 *
 * On a single-client worker this is the worker's own defaults and nothing else happens. With a client
 * map, a request that names nobody — or names a client it cannot be embedded as — is refused rather
 * than served from the default, because on a multi-tenant worker the default *is* the leak.
 *
 * `teamId` and `projectId` used to be resolved here too. They went to the Linear connector with
 * FRU-29: falling back to *the worker's team* is a rule about teams, and this function has no
 * business knowing that a store has any.
 */
function routeFor(request: Request, config: Served, clientId: string | undefined): ClientResolution {
  const { roleIn } = config;

  return resolveClient({
    clients: config.clients,
    clientId,
    origin: request.headers.get('Origin'),
    fallback: {
      // A single-client worker takes its secret from the env; a mapped client brings its own.
      identitySecret: config.identitySecret,
      showComments: config.showComments,
      read: config.read,
      locale: config.teamLocale,
    },
    ...(hasSessions(config) && config.identitySecret !== undefined ? { sessionSecret: config.identitySecret } : {}),
    // A session of an account reaches a client of a workspace it is a member of now (FRU-238).
    ...(roleIn === undefined
      ? {}
      : {
          sessionMember: async (workspace: string, account: string) => (await roleIn(workspace, account)) !== undefined,
        }),
  });
}

/**
 * Verifies a token for one client: as the site's own, or as a session of the client's workspace.
 *
 * The site's key comes first. A session token then verifies only with the worker key **and** a `ws`
 * that names the workspace of this client (FRU-95). The signature alone is not enough: every session
 * of every workspace is signed with that one key.
 */
async function verifyForClient(token: string, policy: ClientPolicy): Promise<Verified | undefined> {
  const asSite =
    policy.identitySecret === undefined ? undefined : await verifyIdentityToken(token, policy.identitySecret);
  if (asSite?.ok === true || policy.sessions === undefined) return asSite;

  const asSession = await verifyIdentityToken(token, policy.sessions.secret);
  if (!asSession.ok) return asSite ?? asSession;

  // A session of an account (FRU-238) names no workspace: it reaches this client while the account is
  // a member of the workspace of the client, read now. A worker that cannot say refuses it.
  if (asSession.account === true) {
    const account = asSession.reporter.id;
    const member = policy.sessions.member;
    if (account === undefined || member === undefined || !(await member(account))) {
      return { ok: false, reason: 'invalid-claims' };
    }

    return { ...asSession, session: true };
  }

  return asSession.workspace === policy.sessions.workspace
    ? { ...asSession, session: true }
    : { ok: false, reason: 'invalid-claims' };
}

/**
 * `session` is there only for a token the worker key verified, with the workspace of the client
 * (FRU-123). A site signs its own tokens and can write any claim in them, a workspace included: what
 * says that a caller is a person of the workspace is the key, never a claim.
 */
type Verified = IdentityResult & { session?: true };

/**
 * Whether this caller may read this client's pins (FRU-40).
 *
 * Until now `GET /feedback` answered anyone who could build the URL, so every note, its author and
 * the team's replies were readable by any visitor of the client's site — and by `curl`, which is why
 * hiding the pins in the browser was never the fix. `read: 'authenticated'` closes that; `public`
 * keeps it, for the anonymous-feedback case where it is the right answer.
 *
 * Same token as the write path, verified the same way. What differs is what is done with it: the
 * write path needs *who* the reporter is, this one only needs that somebody vouched-for asked.
 *
 * A client asking for `authenticated` with no `identitySecret` cannot reach here — `readConfig`
 * refuses that at boot, rather than letting it become a permanent 401 nobody can diagnose.
 */
async function authorizeRead(
  request: Request,
  policy: ClientPolicy,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (policy.read === 'public') return { ok: true };

  const token = readBearerToken(request.headers.get('Authorization'));
  if (token === undefined) return { ok: false, reason: 'identity-required' };

  const verified = await verifyForClient(token, policy);
  if (verified === undefined) return { ok: false, reason: 'identity-not-configured' };

  return verified.ok ? { ok: true } : { ok: false, reason: verified.reason };
}

/**
 * The reporter to store, and whether the worker vouches for it.
 *
 * No token means the claim stands as a claim — anonymous submission is the default and stays
 * possible. A token that fails to verify is refused outright rather than downgraded to a claim: a
 * site that meant to identify someone and got it wrong should hear about it, and silently accepting
 * an expired token as "self-declared" is how a broken integration goes unnoticed for a month.
 */
async function attributionFor(
  request: Request,
  policy: ClientPolicy,
  claimed: SeedReporter | undefined,
): Promise<{ ok: true; reporter: SeedReporter | undefined; channel: Channel } | { ok: false; reason: string }> {
  const token = readBearerToken(request.headers.get('Authorization'));
  if (token === undefined) return { ok: true, reporter: stripClaimedVerification(claimed), channel: 'script' };

  const verified = await verifyForClient(token, policy);
  if (verified === undefined) return { ok: false, reason: 'identity-not-configured' };
  if (!verified.ok) return { ok: false, reason: verified.reason };

  // FRU-237: a session of the workspace is an extension. A token the site signed is its own page.
  return { ok: true, reporter: verified.reporter, channel: verified.session === true ? 'extension' : 'script' };
}

/** Spread, so an absent reporter stays absent — the round-trip forbids a key nobody provided. */
function optionalReporter(reporter: SeedReporter | undefined): { reporter?: SeedReporter } {
  return reporter === undefined ? {} : { reporter };
}

/** 400 when the caller has to say who they are, 403 when they said something they may not claim. */
function routingFailure(
  resolution: Extract<ClientResolution, { ok: false }>,
  headers: Record<string, string>,
): Response {
  const status = resolution.reason === 'origin-not-allowed-for-client' ? 403 : 400;

  return json(status, { error: resolution.reason }, headers);
}

/**
 * The read path: every seed planted on one page, with the Linear state that gives the pin its
 * colour. This is what lets a client come back to the page and see their own notes again.
 */
async function getFeedback(
  request: Request,
  config: Served,
  store: SeedStore,
  kv: Kv,
  corsHeaders: Record<string, string>,
  noteIndex?: NoteIndex,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const requested = params.get('url');
  if (requested === null || requested.trim() === '') {
    return json(400, { error: 'missing-url' }, corsHeaders);
  }

  const url = canonicalizeRequestedPage(requested);
  if (url === null) {
    return json(400, { error: 'invalid-url' }, corsHeaders);
  }

  // Normalised once, here, because this value does three jobs: it picks the route, it builds the
  // Linear label the filter matches on, and it keys the cache. Normalising for only one of them is
  // how a note becomes unreadable by the client that wrote it.
  const clientId = normalizeClientId(params.get('client'));
  const route = routeFor(request, config, clientId);
  if (!route.ok) return routingFailure(route, corsHeaders);

  // **Before the cache, and that ordering is the guarantee.** The cached entry is per
  // (team, client, page) and holds the same answer for every entitled reader, so it is safe to
  // share — but only because an unauthorised caller is turned away here and never reaches the
  // lookup. Moving this below `cached` would serve a warm authenticated answer to an anonymous
  // request, which is the exact leak this ticket exists to close.
  const allowed = await authorizeRead(request, route.policy);
  if (!allowed.ok) {
    return json(401, { error: 'identity-required', reason: allowed.reason }, corsHeaders);
  }

  try {
    // The store says what separates one tenant from another — a team for Linear, nothing extra for
    // the in-memory one. The client id is in the key regardless, so two clients reading the same URL
    // never share an entry even when they share a team.
    //
    // FRU-123: a site that can send to several places is read in each one, because a tracker finds
    // a note by where it is. Each place has its own entry: the scope of the store names it.
    const places = route.client?.destinations ?? [];
    const targets =
      route.client === undefined || places.length < 2
        ? [route.client]
        : places.map((place) => placedAt(route.client as ClientConfig, place));
    const found = await Promise.all(
      targets.map((target) => {
        const key = JSON.stringify([store.name, store.scope(target), clientId ?? null, url]);

        return cached(kv, url, key, async () => {
          const issues = await store.findForPage({ url, clientId }, target, route.policy);
          // FRU-237: what the store says now is the stage the index keeps. Only a read that asked the
          // store writes, so a page that many read costs one write for each answer of the cache.
          const workspace = route.client?.workspace;
          if (workspace !== undefined && clientId !== undefined) {
            await indexed(noteIndex, (index) =>
              index.refresh(workspace, clientId, placeOf(target), issues, Date.now()),
            );
          }

          return issues;
        });
      }),
    );
    // Two places of one team are one read of the tracker, so a note can come back twice. A site
    // that is read in one place gets what its store answers, as it is: nothing there comes back
    // twice, and two notes can hold one seed id.
    const seen = new Set<string>();
    const issues =
      found.length < 2
        ? found.flat()
        : found.flat().filter((issue) => !seen.has(issue.seed.id) && seen.add(issue.seed.id));

    // The stages of the trackers that answered, in the order of `SEED_STAGES` (FRU-188). A site read in
    // several places can show a pin of each of them.
    const reported = await Promise.all(
      targets.map(async (target) => (await store.stagesFor?.(target)) ?? store.stages ?? SEED_STAGES),
    );
    const stages = SEED_STAGES.filter((stage) => reported.some((each) => each.includes(stage)));

    // WARNING: asked at each request, and never in the cached answer. The entry of the cache is
    // shared by everybody who may read the page, and the places are for a member only.
    const offered =
      places.length > 0 && (await seesTracker(request, config, route.policy))
        ? {
            destinations: places.map((place) => ({
              id: place.id,
              ...(place.label === undefined ? {} : { label: place.label }),
            })),
          }
        : {};

    return json(
      200,
      // `stages` does not depend on the page, so it is not in the cached answer.
      {
        url,
        issues,
        stages,
        ...offered,
        // Asked at each request like the places, and absent for a reader the worker cannot name.
        ...((await signsNotes(request, route.policy)) ? { identified: true } : {}),
        ...batchOffer(config),
      },
      // No browser cache, deliberately. The read cache above is what protects the Linear
      // quota; letting the browser hold a copy too only buys one saved request per page load, and
      // costs the widget the pin it planted a second ago — it re-reads and gets served its own
      // stale copy. The E2E suite found exactly that.
      { ...corsHeaders, 'Cache-Control': 'no-store' },
    );
  } catch (error) {
    if (error instanceof StoreError) {
      return json(502, { error: 'store-unavailable', message: error.message }, corsHeaders);
    }
    throw error;
  }
}

/**
 * Canonicalized server-side for the same reason the write path does it: the filter matches this
 * exact string inside the description, so a caller that skipped normalization would find nothing.
 */
function canonicalizeRequestedPage(requested: string): string | null {
  try {
    const url = new URL(requested);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    return canonicalizePageUrl(url);
  } catch {
    return null;
  }
}

async function postFeedback(
  request: Request,
  config: Served,
  store: SeedStore,
  kv: Kv,
  corsHeaders: Record<string, string>,
  clientIp: string,
  noteIndex?: NoteIndex,
): Promise<Response> {
  const body = await readBoundedText(request);
  if (body === null) {
    return json(413, { error: 'payload-too-large', maxBytes: MAX_BODY_BYTES }, corsHeaders);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return json(400, { error: 'invalid-json' }, corsHeaders);
  }

  // FRU-124: an array is a batch, an object is one note, as before.
  if (Array.isArray(payload)) return postBatch(request, config, store, kv, corsHeaders, clientIp, payload, noteIndex);

  const parsed = parseSeed(payload);
  if (!parsed.ok) {
    return json(400, { error: 'invalid-seed', reason: parsed.reason }, corsHeaders);
  }

  const seed = canonicalSeed(parsed.seed);
  const clientId = seed.client?.id;

  const route = routeFor(request, config, clientId);
  if (!route.ok) return routingFailure(route, corsHeaders);

  // Whose word the attribution is (FRU-9). The claimed reporter loses `verified` whatever it said,
  // and only a token this worker checked can put it back.
  const identity = await attributionFor(request, route.policy, seed.reporter);
  if (!identity.ok) {
    return json(401, { error: 'invalid-identity', reason: identity.reason }, corsHeaders);
  }

  const attributed = { ...seed, ...optionalReporter(identity.reporter) };

  const target = await chosenPlace(request, config, route);
  if (target === null) return json(403, { error: 'destination-not-allowed' }, corsHeaders);

  try {
    const issue = await store.create(attributed, target, route.policy);
    await invalidatePages(kv, [attributed.page.url]);
    const workspace = route.client?.workspace;
    if (workspace !== undefined && clientId !== undefined) {
      const entry = noteEntry(workspace, clientId, attributed, identity.channel, target, issue);
      await indexed(noteIndex, (index) => index.record([entry], Date.now()));
    }

    return json(201, { issue }, corsHeaders);
  } catch (error) {
    if (error instanceof StoreError) {
      // Upstream failed, not the caller: 502 tells the widget to keep the note and retry.
      return json(502, { error: 'store-unavailable', message: error.message }, corsHeaders);
    }
    throw error;
  }
}

/**
 * Re-canonicalized server-side. The read path finds seeds by matching this URL inside the
 * description, so a client that skipped normalization would plant a pin nobody can find again.
 *
 * The client id gets the same treatment and for the same reason: it becomes the `fruitback:<id>`
 * label the read filters on, so a padded id here means an issue nobody can query back.
 */
function canonicalSeed(seed: Seed): Seed {
  const clientId = normalizeClientId(seed.client?.id);

  return {
    ...seed,
    page: { ...seed.page, url: canonicalizePageUrl(seed.page.url) },
    ...(seed.client !== undefined && clientId !== undefined ? { client: { ...seed.client, id: clientId } } : {}),
  };
}

/**
 * FRU-123: a member chose where the note goes. The name is in the query, and the body stays the
 * seed: the relay of the extension carries a query and no other header. Absent, the note goes to
 * the first place of the site. `null`: a name the site does not have, or a caller who may not see
 * the tracker. Both get the same answer, and nothing is written. For a batch, the place is the one
 * of all its notes.
 */
async function chosenPlace(
  request: Request,
  config: Served,
  route: Extract<ClientResolution, { ok: true }>,
): Promise<ClientConfig | undefined | null> {
  const wanted = new URL(request.url).searchParams.get('destination');
  if (wanted === null) return route.client;
  const place = route.client?.destinations?.find((each) => each.id === wanted);
  if (route.client === undefined || place === undefined || !(await seesTracker(request, config, route.policy))) {
    return null;
  }

  return placedAt(route.client, place);
}

/** The page just changed, so every cached answer for it is wrong, for every client. */
async function invalidatePages(kv: Kv, urls: readonly string[]): Promise<void> {
  for (const url of new Set(urls)) {
    try {
      await invalidate(kv, url);
    } catch (error) {
      if (!(error instanceof KvError)) throw error;
      // The issue exists now. A 502 here tells the widget to retry, and the retry plants the note a
      // second time. The cost of answering 201 is a pin that shows up one TTL late.
      console.error(`[fruitback] cache not invalidated after a write: ${error.message}`);
    }
  }
}

/**
 * What a worker takes in one request (FRU-124), in the envelope of `GET /feedback` as `stages` is:
 * the most notes, and the most bytes of the body. Absent where the limit of a minute is too low for
 * a batch: the widget then sends its notes one by one, and never sends an array.
 */
function batchOffer(config: WorkerConfig): { batch?: { max: number; maxBytes: number } } {
  const max = maxBatch(config.rateLimitPerMinute);

  return max === 0 ? {} : { batch: { max, maxBytes: MAX_BODY_BYTES } };
}

/** How long a seed that was kept answers its issue again, for a widget that sends it twice. */
const SENT_TTL_MS = 10 * 60_000;

function sentKey(clientId: string | undefined, seedId: string): string {
  return `fruitback:sent:${JSON.stringify([clientId ?? null, seedId])}`;
}

/** How long a seed that a request is planting is held from another request. */
const SENDING_TTL_MS = 60_000;

function sendingKey(clientId: string | undefined, seedId: string): string {
  return `fruitback:sending:${JSON.stringify([clientId ?? null, seedId])}`;
}

/**
 * Takes a seed for this request, or says that another request holds it.
 *
 * `incr` is the one atomic call of a `Kv`: the request that reads 1 holds the seed. Two attempts of
 * one batch at the same moment would both read « not kept yet », and both plant it. A `Kv` that does
 * not answer holds nothing: the seed is sent, as before this guard.
 */
async function hold(kv: Kv, clientId: string | undefined, seedId: string): Promise<boolean> {
  try {
    return (await kv.incr(sendingKey(clientId, seedId), SENDING_TTL_MS)) === 1;
  } catch {
    return true;
  }
}

/** Gives a seed back when it was not kept, so the next attempt can take it at once. */
async function release(kv: Kv, clientId: string | undefined, seedId: string): Promise<void> {
  await kv.set(sendingKey(clientId, seedId), '0', SENDING_TTL_MS).catch(() => undefined);
}

function parentKey(clientId: string | undefined, scope: string, seedId: string): string {
  return `fruitback:batch-parent:${JSON.stringify([clientId ?? null, scope, seedId])}`;
}

/**
 * The parent of a batch, from one attempt to the next (FRU-195), in the `Kv`: one entry for each seed,
 * for as long as a seed is remembered. An attempt that sends again only some of the notes still
 * finds the parent. The place is in the key: a parent of one team is not used for another.
 *
 * WARNING: nothing throws from here. A `Kv` that does not answer costs a second parent, not a note.
 */
function batchMemory(
  kv: Kv,
  store: SeedStore,
  clientId: string | undefined,
  target: ClientConfig | undefined,
  seeds: readonly Seed[],
): BatchMemory {
  const keys = (): string[] => {
    const scope = store.scope(target);

    return seeds.map((seed) => parentKey(clientId, scope, seed.id));
  };
  const write = async (value: string): Promise<void> => {
    try {
      await Promise.all(keys().map((key) => kv.set(key, value, SENT_TTL_MS)));
    } catch {
      // Not remembered: the next attempt writes a parent, as before FRU-195.
    }
  };

  return {
    async parent() {
      try {
        const found = await Promise.all(keys().map((key) => kv.get(key)));

        // An entry that was forgotten is empty: the `Kv` has no delete.
        return found.find((id) => id !== undefined && id !== '');
      } catch {
        return undefined;
      }
    },
    keepParent: (id) => write(id),
    forgetParent: () => write(''),
  };
}

/**
 * Several notes in one request (FRU-124): `POST /feedback` with an array of seeds.
 *
 * - Every seed is read before anything is written: one that is not a seed refuses the batch.
 * - The request passed the limiter for one. The N − 1 others are counted here, before any write:
 *   over the limit, `429`, and nothing is written.
 * - One client for the whole batch, one identity, one place (`?destination=`).
 * - A seed kept in the last minutes answers its issue again and is not planted twice: its id is the
 *   key (`seed.id` « dedupes retries »). That is what a widget sends again after a partial failure.
 *   A seed that another request is planting now is answered as not kept, and is not planted here.
 * - One answer for each seed, in order: `201` when every one was kept, `207` when some were, `502`
 *   when none was. The widget keeps the ones that were not as drafts.
 */
async function postBatch(
  request: Request,
  config: Served,
  store: SeedStore,
  kv: Kv,
  corsHeaders: Record<string, string>,
  clientIp: string,
  payload: unknown[],
  noteIndex?: NoteIndex,
): Promise<Response> {
  const max = maxBatch(config.rateLimitPerMinute);
  if (payload.length === 0 || payload.length > max) {
    return json(400, { error: 'invalid-batch', max }, corsHeaders);
  }

  const seeds: Seed[] = [];
  for (const [index, each] of payload.entries()) {
    const parsed = parseSeed(each);
    if (!parsed.ok) return json(400, { error: 'invalid-seed', index, reason: parsed.reason }, corsHeaders);
    seeds.push(canonicalSeed(parsed.seed));
  }
  if (new Set(seeds.map((seed) => seed.id)).size !== seeds.length) {
    return json(400, { error: 'invalid-batch', reason: 'the same seed twice', max }, corsHeaders);
  }
  const clientId = seeds[0]?.client?.id;
  if (!seeds.every((seed) => seed.client?.id === clientId)) {
    return json(400, { error: 'invalid-batch', reason: 'one client for the whole batch', max }, corsHeaders);
  }

  let allowed: boolean;
  try {
    allowed = await chargeRateLimit(kv, clientIp, seeds.length - 1, { limit: config.rateLimitPerMinute });
  } catch (error) {
    if (!(error instanceof KvError)) throw error;
    console.error(`[fruitback] rate limit unavailable: ${error.message}`);

    return json(503, { error: 'limiter-unavailable' }, corsHeaders);
  }
  if (!allowed) return json(429, { error: 'rate-limited' }, corsHeaders);

  const route = routeFor(request, config, clientId);
  if (!route.ok) return routingFailure(route, corsHeaders);

  // One request is one caller: the identity is checked once, and written on every note it signs.
  const attributed: Seed[] = [];
  let channel: Channel = 'script';
  for (const seed of seeds) {
    const identity = await attributionFor(request, route.policy, seed.reporter);
    if (!identity.ok) return json(401, { error: 'invalid-identity', reason: identity.reason }, corsHeaders);
    attributed.push({ ...seed, ...optionalReporter(identity.reporter) });
    channel = identity.channel;
  }

  const target = await chosenPlace(request, config, route);
  if (target === null) return json(403, { error: 'destination-not-allowed' }, corsHeaders);

  // The notes kept by an earlier attempt are answered from the `Kv`, and only the others are sent.
  const known = await Promise.all(
    attributed.map(async (seed) => {
      try {
        const kept = await kv.get(sentKey(clientId, seed.id));

        return kept === undefined ? undefined : (JSON.parse(kept) as CreatedIssue);
      } catch {
        // A `Kv` that does not answer only loses the protection against a second copy.
        return undefined;
      }
    }),
  );
  // A seed that is not kept yet is taken for this request. One that another request holds is not
  // sent from here: it is answered as not kept, and the next attempt reads what became of it.
  const held = await Promise.all(
    attributed.map((seed, index) => (known[index] === undefined ? hold(kv, clientId, seed.id) : false)),
  );
  const fresh = attributed.filter((_, index) => held[index]);

  let planted: BatchAnswer[] = [];
  try {
    if (fresh.length > 0) {
      planted = await createAll(store, fresh, target, route.policy, batchMemory(kv, store, clientId, target, fresh));
    }
  } catch (error) {
    if (!(error instanceof StoreError)) {
      // An error nobody expected answers `500`. The seeds are given back first: the next attempt
      // must not wait for the hold to end.
      await Promise.all(fresh.map((seed) => release(kv, clientId, seed.id)));
      throw error;
    }
    // Nothing of this attempt was kept. A seed of an earlier one still answers its issue.
    planted = fresh.map(() => ({ error: 'store-unavailable' }) as const);
  }

  let next = 0;
  const results = attributed.map((seed, index) => {
    const issue = known[index];
    if (issue !== undefined) return { id: seed.id, issue };
    const answer: BatchAnswer = held[index] ? (planted[next++] as BatchAnswer) : { error: 'store-unavailable' };

    return { id: seed.id, ...answer };
  });
  await Promise.all(
    results.flatMap((result, index) => (held[index] && 'error' in result ? [release(kv, clientId, result.id)] : [])),
  );

  // WARNING: a `Kv` that does not take this write loses the ten minutes, not the note. The seed is
  // kept and answered; only its trace is missing. Its hold is not given back, so a second attempt in
  // the next minute is answered « not kept » and plants nothing. After that minute, a widget that
  // sends the whole batch again would plant it twice: a widget sends again only the seeds that were
  // answered as not kept. The memory `Kv` of this process does not refuse a write.
  await Promise.all(
    results.flatMap((result) =>
      'issue' in result
        ? [kv.set(sentKey(clientId, result.id), JSON.stringify(result.issue), SENT_TTL_MS).catch(() => undefined)]
        : [],
    ),
  );
  const kept = results.filter((result) => 'issue' in result);
  // FRU-237: the notes this request planted. One kept by an earlier attempt is in the index already.
  const workspace = route.client?.workspace;
  if (workspace !== undefined && clientId !== undefined) {
    const entries = attributed.flatMap((seed, index) => {
      const result = results[index];
      const issue = result !== undefined && 'issue' in result ? result.issue : undefined;

      return held[index] && issue !== undefined ? [noteEntry(workspace, clientId, seed, channel, target, issue)] : [];
    });
    await indexed(noteIndex, (index) => index.record(entries, Date.now()));
  }
  await invalidatePages(
    kv,
    attributed.filter((_, index) => 'issue' in (results[index] as object)).map((seed) => seed.page.url),
  );

  if (kept.length === 0) return json(502, { error: 'store-unavailable', results }, corsHeaders);

  return json(kept.length === results.length ? 201 : 207, { results }, corsHeaders);
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
