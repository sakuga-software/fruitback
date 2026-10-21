import {
  MAX_ATTACHMENTS_PER_NOTE,
  SEED_STAGES,
  type Seed,
  type SeedIssue,
  parseSeed,
  type SeedReporter,
} from '@fruitback/shared';
import { type IdentityResult, readBearerToken, stripClaimedVerification, verifyIdentityToken } from './identity.ts';
import {
  type ClientConfig,
  type ClientPolicy,
  type ClientResolution,
  normalizeClientId,
  openReadClients,
  resolveClient,
} from './clients.ts';
import { type AccountStore, can, readsSite } from './accounts.ts';
import { MAX_BODY_BYTES, readBoundedText } from './bounded-body.ts';
import { withRenewedCookie } from './auth-routes.ts';
import { consoleCors, isConsoleRoute } from './console-cors.ts';
import { createConnectorStores, createRoutedStore } from './connectors.ts';
import { DELIVERY_HEADER, LOOP_STATUS } from './rest-connector.ts';
import { type WorkerEnv, hasAccounts, hasSessions, readAllowedOrigins, readConfig } from './env.ts';
import {
  type BatchAnswer,
  type CreatedIssue,
  type ReplyAuthor,
  type SeedStore,
  StoreError,
  takesAttachments,
  takesChecks,
  takesReplies,
} from './store.ts';
import { checkedOf } from './reply-text.ts';
import { SENT_TTL_MS, batchMemory, createAll, hold, release, sentKey } from './batch.ts';
import { watchedStore } from './connector-health.ts';
import { type CorsDecision, diagnosticCorsHeaders, openCors, resolveCors } from './cors.ts';
import { PAIR_PATH } from './pair-page.ts';
import { chargeRateLimit, checkRateLimit, maxBatch } from './rate-limit.ts';
import { cached } from './cache.ts';
import { type Kv, KvError } from './kv.ts';
import { type Channel, type NoteIndex } from './notes-index.ts';
import { sessionStillValid } from './session-check.ts';
import { ATTACHMENTS_PATH, attachmentIdsOf } from './attachments.ts';
import { handleAttachment, legacyAttachment, settleFiles, takeFiles } from './attachment-routes.ts';
import { handleConsole } from './console-routes.ts';
import { handlePairing, handleSessionRoutes } from './session-routes.ts';
import { CHECK_PATH, REPLY_PATH, postCheck, postReply } from './reply-routes.ts';
import type { SessionIdentity } from './session.ts';
import { type RequestContext, type Served, type Verified, withSites } from './request-context.ts';
import {
  batchOffer,
  canonicalSeed,
  canonicalizeRequestedPage,
  indexed,
  invalidatePages,
  noteEntry,
  optionalReporter,
  placeOf,
  placedAt,
  routingFailure,
  withoutTracker,
} from './note-helpers.ts';

import {
  accountStoreFor,
  attachmentStoreFor,
  kvFor,
  noteIndexFor,
  sessionStoreFor,
  storeFor,
} from './worker-stores.ts';

export type { RequestContext, Verified } from './request-context.ts';
export { createPairingCommand } from './session-routes.ts';
export { CHECK_LOCK_MS } from './reply-routes.ts';
export {
  accountStoreFor,
  adminLinksFor,
  announceFirstAdmin,
  attachmentStoreFor,
  connectStoreFor,
  deliverPending,
  instanceAdminFor,
  kvFor,
  mailerFor,
  noteIndexFor,
  recheckPending,
  sessionStoreFor,
  storeFor,
} from './worker-stores.ts';

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
 * Whether the caller is a person of the workspace of this client who does not see the tracker: a
 * guest (FRU-250). Such a caller gets no reference of a tracker on any route: `withoutTracker`.
 *
 * A visitor and a token of a site are not asked: what a public site shows is FRU-84, and this does
 * not change it.
 */
async function hidesTracker(request: Request, config: Served, policy: ClientPolicy): Promise<boolean> {
  if (config.roleIn === undefined || policy.sessions === undefined) return false;
  const token = readBearerToken(request.headers.get('Authorization'));
  if (token === undefined) return false;
  const verified = await verifyForClient(token, policy);
  if (verified?.ok !== true || verified.session !== true || verified.reporter.id === undefined) return false;
  const role = await config.roleIn(policy.sessions.workspace, verified.reporter.id);

  return role !== undefined && !can(role, 'see-tracker');
}

/**
 * The ids the widget gave to the notes of `issues` that the reader of this request left (FRU-294): a
 * session of the workspace of the site, whose account the index keeps as their author. Empty for
 * anybody else, and for a worker with no index. An index that does not answer costs `mine`, never
 * the read.
 */
async function notesOfReader(
  request: Request,
  config: Served,
  policy: ClientPolicy,
  workspace: string | undefined,
  site: string | undefined,
  issues: readonly SeedIssue[],
  noteIndex: NoteIndex | undefined,
): Promise<Set<string>> {
  if (noteIndex === undefined || workspace === undefined || site === undefined || issues.length === 0) {
    return new Set();
  }
  if (policy.sessions === undefined) return new Set();
  const token = readBearerToken(request.headers.get('Authorization'));
  if (token === undefined) return new Set();
  const verified = await verifyForClient(token, policy);
  const account = verified?.ok === true && verified.session === true ? verified.reporter.id : undefined;
  if (account === undefined) return new Set();
  try {
    const authors = await noteIndex.authors(
      workspace,
      site,
      issues.map((issue) => issue.seed.id),
    );

    return new Set([...authors].flatMap(([seed, author]) => (author === account ? [seed] : [])));
  } catch (error) {
    console.error(
      `[fruitback] the index of the notes did not answer: ${error instanceof Error ? error.message : String(error)}`,
    );

    return new Set();
  }
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
 * Whether the worker would take a note of this caller on this client (FRU-330), as `attributionFor`
 * decides it: always on a client that anybody writes on, and with a session only on a site whose
 * notes are « Members only ». The read says it with `canWrite: false`, so the widget offers no note
 * that the worker would refuse.
 *
 * WARNING: one bit, as `signsNotes`.
 */
async function writesHere(request: Request, policy: ClientPolicy): Promise<boolean> {
  if (policy.write === 'public') return true;
  const token = readBearerToken(request.headers.get('Authorization'));
  if (token === undefined) return false;

  return writesWith(policy, await verifyForClient(token, policy));
}

/**
 * Whether a caller with this verified token may write on this client (FRU-330). On a site whose
 * notes are « Members only », a session of the worker only: a token that a site signs verifies, and
 * names nobody of the workspace. The note, the batch, the reply and the read answer this one rule.
 */
export function writesWith(policy: Pick<ClientPolicy, 'write'>, verified: Verified | undefined): boolean {
  if (policy.write === 'public') return true;

  return verified?.ok === true && verified.session === true;
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
    return handleConsole(request, pathname, { served, context, accounts, kv, noteIndex, cors });
  }

  if (pairing) return handlePairing(request, served, context);

  if (session) {
    return handleSessionRoutes(request, pathname, { served, context, accounts, kv, noteIndex, cors, sessionWrites });
  }

  // Resolved once here, not inside each handler: see `RequestContext.store`.
  const storeOfRequest = (): SeedStore => {
    const own = context.store ?? storeFor(served);

    // FRU-121: a site that chose a destination writes and reads through the connector of its workspace.
    return accounts === undefined
      ? own
      : createRoutedStore(
          own,
          createConnectorStores(accounts, served.secretsKey, Date.now, served.linearOAuth, {
            // FRU-331: a delivery carries the address of a file on this worker, which needs both.
            filesReachable: served.publicUrl !== undefined && served.secretsKey !== undefined,
          }),
        );
  };

  if (pathname === ATTACHMENTS_PATH || pathname.startsWith(`${ATTACHMENTS_PATH}/`)) {
    try {
      return await handleAttachment(request, pathname, {
        files: context.attachments ?? attachmentStoreFor(served),
        store: storeOfRequest(),
        headers: cors.headers,
        secretsKey: served.secretsKey,
        kv: () => context.kv ?? kvFor(served),
        route: (site) => {
          const route = routeFor(request, served, site);
          if (!route.ok) return { ok: false, response: routingFailure(route, cors.headers) };

          return {
            ok: true,
            workspace: route.policy.sessions?.workspace,
            place: () => chosenPlace(request, served, route),
          };
        },
        writer: (workspace, site) => writerIn(request, served, context, workspace, site),
      });
    } catch (error) {
      if (error instanceof StoreError) return json(502, { error: 'store-unavailable' }, cors.headers);
      throw error;
    }
  }

  const replyTo = REPLY_PATH.exec(pathname)?.[1];
  const checkOf = CHECK_PATH.exec(pathname)?.[1];
  if (pathname !== '/feedback' && replyTo === undefined && checkOf === undefined) {
    return json(404, { error: 'not-found' }, cors.headers);
  }

  const store = storeOfRequest();
  // The checks of the caller that the routes under a note call, which stay in this file.
  const checks = { routeFor, replyAuthorFor, endedSession, sessionWrites, writerIn, hidesTracker, REPLY_LENGTH };

  if (replyTo !== undefined) {
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, cors.headers);

    return postReply(
      request,
      replyTo,
      served,
      watchedStore(store, accounts),
      kv,
      cors.headers,
      {
        clientIp: context.clientIp,
        accounts,
        stillWrites: () => sessionWrites(request, served, context).then((session) => session !== undefined),
      },
      checks,
    );
  }

  if (checkOf !== undefined) {
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, cors.headers);

    return postCheck(
      request,
      checkOf,
      served,
      watchedStore(store, accounts),
      kv,
      cors.headers,
      {
        clientIp: context.clientIp,
        accounts,
        noteIndex,
        context,
      },
      checks,
    );
  }

  // FRU-102: what the tracker of a connector answers is noted on it, for the console.
  return request.method === 'GET'
    ? getFeedback(request, served, watchedStore(store, accounts), kv, cors.headers, noteIndex, context)
    : postFeedback(
        request,
        served,
        watchedStore(store, accounts),
        kv,
        cors.headers,
        context.clientIp,
        noteIndex,
        () => sessionWrites(request, served, context).then((session) => session !== undefined),
        context,
      );
}

/** The longest reply, in characters. A longer one is refused, never cut. */
export const REPLY_LENGTH = 2000;

/**
 * Who writes a reply, or why nobody may (FRU-257, the rule of Mathieu of 2026-10-13).
 *
 * - A session of the workspace of the site, by the relay of the extension: a member, named by their
 *   account, on any site. A name in the body is not read.
 * - No token: a visitor, on a site that everybody reads (`read: 'public'`) only. The name they typed
 *   is their word, and the text says « not verified ».
 * - A token that does not verify is refused, as on a note.
 */
async function replyAuthorFor(
  request: Request,
  policy: ClientPolicy,
  workspace: string | undefined,
  typed: string | undefined,
  accounts: AccountStore | undefined,
): Promise<{ ok: true; author: ReplyAuthor; account: boolean } | { ok: false; status: number; reason: string }> {
  const token = readBearerToken(request.headers.get('Authorization'));
  if (token === undefined) {
    if (policy.read !== 'public') return { ok: false, status: 401, reason: 'identity-required' };

    return { ok: true, author: { kind: 'visitor', ...(typed === undefined ? {} : { name: typed }) }, account: false };
  }

  const verified = await verifyForClient(token, policy);
  if (verified === undefined) return { ok: false, status: 401, reason: 'identity-not-configured' };
  if (!verified.ok) return { ok: false, status: 401, reason: verified.reason };
  // FRU-330: a site whose notes are « Members only » takes a reply of a session only, as a note.
  if (!writesWith(policy, verified)) return { ok: false, status: 401, reason: 'session-required' };
  // A token that the site signed names a person of the site, not of the workspace: the worker
  // vouches for no membership, so the text says « not verified » with the name the site gave.
  if (verified.session !== true || accounts === undefined || workspace === undefined) {
    const name = verified.reporter.name;

    return { ok: true, author: { kind: 'visitor', ...(name === undefined ? {} : { name }) }, account: false };
  }

  const id = verified.reporter.id;
  const [account, memberships] =
    id === undefined ? [undefined, []] : await Promise.all([accounts.account(id), accounts.memberships(id)]);
  const membership = memberships.find((each) => each.workspace.id === workspace);
  if (account === undefined || membership === undefined) return { ok: false, status: 401, reason: 'invalid-claims' };

  return {
    ok: true,
    author: { kind: 'member', name: account.name ?? account.email, workspace: membership.workspace.name },
    account: verified.account === true,
  };
}

/**
 * The account of a session of the extension, when it is a session of `workspace` and that account
 * reads `site` there now (FRU-44, FRU-250): a member, and a guest only on a site shared with them.
 * `site` undefined: a thing of the workspace that names no site, which a guest does not read.
 * `undefined` for anything else: no token, a token of a site, a session of another workspace, a
 * person who left, a guest on another site.
 *
 * Verified by `verifyForClient`, the one place that checks the workspace of a token, with a policy
 * that holds the worker key and nothing of a site: no site key may stand for a member.
 */
async function memberOf(
  request: Request,
  config: Served,
  workspace: string,
  site: string | undefined,
): Promise<string | undefined> {
  const { reachIn } = config;
  if (config.identitySecret === undefined || reachIn === undefined) return undefined;
  const token = readBearerToken(request.headers.get('Authorization'));
  if (token === undefined) return undefined;
  // The extension knows no suspended workspace (FRU-282): its pictures answer as pictures that do not exist.
  if (config.suspendedIn !== undefined && (await config.suspendedIn(workspace))) return undefined;
  const reaches = async (account: string) => readsSite(await reachIn(workspace, account), site);
  const verified = await verifyForClient(token, {
    showComments: false,
    identitySecret: undefined,
    read: 'authenticated',
    write: 'public',
    locale: config.teamLocale,
    sessions: { secret: config.identitySecret, workspace, reaches },
  });
  if (verified?.ok !== true || verified.session !== true || verified.reporter.id === undefined) return undefined;

  return (await reaches(verified.reporter.id)) ? verified.reporter.id : undefined;
}

/**
 * The person of the session of the token of this request, while that session is still valid in the
 * store (FRU-238), or `undefined`: the check of every route that writes for an extension, which then
 * answers `401`. See `session-check.ts`. A route that needs who writes (FRU-255) reads it here.
 */
export async function sessionWrites(
  request: Request,
  config: Served,
  context: RequestContext,
): Promise<SessionIdentity | undefined> {
  const token = readBearerToken(request.headers.get('Authorization'));
  const sessions = context.sessionStore ?? sessionStoreFor(config);
  if (token === undefined || sessions === undefined || config.identitySecret === undefined) return undefined;

  return sessionStillValid(token, {
    sessions,
    secret: config.identitySecret,
    ...(config.roleIn === undefined ? {} : { roleIn: config.roleIn }),
    ...(config.accountActive === undefined ? {} : { accountActive: config.accountActive }),
  });
}

/**
 * The account that writes in `workspace` with the token of this request, or `undefined` (FRU-238): a
 * member of the workspace now, with a session still valid in the store, and the same person for both.
 * One function, so that a route that writes cannot ask one and forget the other.
 */
async function writerIn(
  request: Request,
  config: Served,
  context: RequestContext,
  workspace: string,
  site: string | undefined,
): Promise<string | undefined> {
  const account = await memberOf(request, config, workspace, site);
  if (account === undefined) return undefined;
  const session = await sessionWrites(request, config, context);

  return session?.subject === account ? account : undefined;
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
  const { reachIn } = config;

  return resolveClient({
    clients: config.clients,
    clientId,
    origin: request.headers.get('Origin'),
    fallback: {
      // A single-client worker takes its secret from the env; a mapped client brings its own.
      identitySecret: config.identitySecret,
      showComments: config.showComments,
      read: config.read,
      // A worker of one client has no site of a workspace: anybody writes there (FRU-330).
      write: 'public',
      locale: config.teamLocale,
    },
    ...(hasSessions(config) && config.identitySecret !== undefined ? { sessionSecret: config.identitySecret } : {}),
    // A session reaches a client of a workspace it is a member of now (FRU-238), and a guest only a
    // site shared with them (FRU-250).
    ...(reachIn === undefined
      ? {}
      : {
          sessionReaches: async (workspace: string, site: string, account: string) =>
            readsSite(await reachIn(workspace, account), site),
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
export async function verifyForClient(token: string, policy: ClientPolicy): Promise<Verified | undefined> {
  const asSite =
    policy.identitySecret === undefined ? undefined : await verifyIdentityToken(token, policy.identitySecret);
  // A site signs its own tokens and may write any claim in them: what says « a session of an
  // account » and « this chain » is the worker key, so a token of a site never carries either (FRU-238).
  if (asSite?.ok === true) return ofASite(asSite);
  if (policy.sessions === undefined) return asSite;

  const asSession = await verifyIdentityToken(token, policy.sessions.secret);
  if (!asSession.ok) return asSite ?? asSession;

  // A session of an account (FRU-238) names no workspace: it reaches this client while the account
  // reads it, read now. A worker that cannot say refuses it.
  const { reaches } = policy.sessions;
  if (asSession.account === true) {
    const account = asSession.reporter.id;
    if (account === undefined || reaches === undefined || !(await reaches(account))) {
      return { ok: false, reason: 'invalid-claims' };
    }

    return { ...asSession, session: true };
  }

  if (asSession.workspace !== policy.sessions.workspace) return { ok: false, reason: 'invalid-claims' };
  // A session of a workspace names the workspace, not the site: a guest of one site holds one that
  // names the workspace (FRU-250). Where the worker can say, the person must read this client now.
  if (reaches !== undefined) {
    const account = asSession.reporter.id;
    if (account === undefined || !(await reaches(account))) return { ok: false, reason: 'invalid-claims' };
  }

  return { ...asSession, session: true };
}

/** A token verified with the key of a site, with nothing of a session of the worker. */
function ofASite(verified: Extract<IdentityResult, { ok: true }>): Verified {
  const { account: _account, chain: _chain, ...site } = verified;

  return site;
}

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
): Promise<
  | { ok: true; reporter: SeedReporter | undefined; channel: Channel; account: boolean }
  | { ok: false; error: 'invalid-identity' | 'identity-required'; reason: string }
> {
  const token = readBearerToken(request.headers.get('Authorization'));
  if (token === undefined) {
    // FRU-330: a site whose notes are « Members only » refuses a note with no session, with the
    // answer of a read that it refuses.
    if (policy.write === 'authenticated') {
      return { ok: false, error: 'identity-required', reason: 'identity-required' };
    }

    return { ok: true, reporter: stripClaimedVerification(claimed), channel: 'script', account: false };
  }

  const verified = await verifyForClient(token, policy);
  if (verified === undefined) return { ok: false, error: 'invalid-identity', reason: 'identity-not-configured' };
  if (!verified.ok) return { ok: false, error: 'invalid-identity', reason: verified.reason };
  // A token that a site signs names nobody of the workspace: it is no session (FRU-330).
  if (!writesWith(policy, verified)) return { ok: false, error: 'identity-required', reason: 'session-required' };

  // FRU-237: a session of the workspace is an extension. A token the site signed is its own page.
  return {
    ok: true,
    reporter: verified.reporter,
    channel: verified.session === true ? 'extension' : 'script',
    // A session of an account (FRU-238): `postFeedback` reads it again before it writes.
    account: verified.session === true && verified.account === true,
  };
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
  context?: RequestContext,
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
    // FRU-330: the refusal of a read says whether a note would be refused too, so the widget of a
    // visitor offers none. Absent: the worker takes a note here.
    const closed = (await writesHere(request, route.policy)) ? {} : { canWrite: false };

    return json(401, { error: 'identity-required', reason: allowed.reason, ...closed }, corsHeaders);
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
            // FRU-295: the verdicts are kept only where a person can give one, so that a fix to check
            // is always one that the person can confirm.
            const verdicts = route.policy.showComments && (await takesChecks(store, target));
            await indexed(noteIndex, (index) =>
              index.refresh(workspace, clientId, placeOf(target), issues, Date.now(), { verdicts }),
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
    const all =
      found.length < 2
        ? found.flat()
        : found.flat().filter((issue) => !seen.has(issue.seed.id) && seen.add(issue.seed.id));
    // Asked at each request, after the cache, whose answer every reader of the page shares.
    const hidden = await hidesTracker(request, config, route.policy);
    // FRU-294: the notes of this reader, and the confirmation of each note done. Never in the cached
    // answer: `mine` is the reader's.
    const own = await notesOfReader(request, config, route.policy, route.client?.workspace, clientId, all, noteIndex);
    const issues: SeedIssue[] = all.map((issue) => {
      const checked = issue.stage === 'ripe' ? checkedOf(issue.comments) : undefined;
      const marked = {
        ...issue,
        ...(checked === undefined ? {} : { checked }),
        ...(own.has(issue.seed.id) ? { mine: true as const } : {}),
      };

      return hidden ? withoutTracker(marked, issue.seed.id) : marked;
    });

    // The stages of the trackers that answered, in the order of `SEED_STAGES` (FRU-188). A site read in
    // several places can show a pin of each of them.
    const reported = await Promise.all(
      targets.map(async (target) => (await store.stagesFor?.(target)) ?? store.stages ?? SEED_STAGES),
    );
    const stages = SEED_STAGES.filter((stage) => reported.some((each) => each.includes(stage)));

    // WARNING: asked at each request, and never in the cached answer. The entry of the cache is
    // shared by everybody who may read the page, and the places are for a member only.
    // FRU-331: whether a note of this reader may carry files, for a reader who may send one (a
    // session of the workspace that reads this site). Asked at each request, like the places.
    const attaches =
      route.client?.workspace !== undefined &&
      clientId !== undefined &&
      (context?.attachments ?? attachmentStoreFor(config)) !== undefined &&
      (await memberOf(request, config, route.client.workspace, clientId)) !== undefined;
    const offered =
      places.length > 0 && (await seesTracker(request, config, route.policy))
        ? {
            destinations: await Promise.all(
              places.map(async (place) => ({
                id: place.id,
                ...(place.label === undefined ? {} : { label: place.label }),
                ...(attaches
                  ? { canAttach: await takesAttachments(store, placedAt(route.client as ClientConfig, place)) }
                  : {}),
              })),
            ),
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
        // FRU-257: whether this reader may write a reply here. A reader of a site that not everybody
        // reads is one the worker let in above. Never in the cached answer: it is the reader's.
        ...(route.policy.showComments && (await takesReplies(store, route.client)) ? { canReply: true } : {}),
        // FRU-330: absent where this reader may leave a note, as on every worker of before.
        ...((await writesHere(request, route.policy)) ? {} : { canWrite: false }),
        // FRU-331: `false` says that the notes of this site stay in Fruitback, or go to a tracker that
        // takes no file: the widget offers no file and says why. Absent: this reader sends none.
        ...(attaches ? { canAttach: await takesAttachments(store, route.client) } : {}),
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
 * The answer to a note of a session of an account that no longer writes, or `undefined` when it still
 * does (FRU-238). A store that does not answer is `502 store-unavailable`, as for the note itself: the
 * widget keeps the note and tries again (raised in review).
 */
async function endedSession(
  stillWrites: () => Promise<boolean>,
  corsHeaders: Record<string, string>,
): Promise<Response | undefined> {
  try {
    if (await stillWrites()) return undefined;
  } catch (error) {
    if (error instanceof StoreError) return json(502, { error: 'store-unavailable' }, corsHeaders);
    throw error;
  }

  return json(401, { error: 'invalid-identity', reason: 'session-ended' }, corsHeaders);
}

async function postFeedback(
  request: Request,
  config: Served,
  store: SeedStore,
  kv: Kv,
  corsHeaders: Record<string, string>,
  clientIp: string,
  noteIndex: NoteIndex | undefined,
  /** Whether the session of the token still writes, read in the store (FRU-238). */
  stillWrites: () => Promise<boolean>,
  context?: RequestContext,
): Promise<Response> {
  // FRU-331: the files of the note, by their ids in transit. Read before the body: a bad list is
  // refused whatever the note says.
  const attachmentIds = attachmentIdsOf(new URL(request.url).searchParams.get('attachments'), MAX_ATTACHMENTS_PER_NOTE);
  if (attachmentIds === null) {
    return json(400, { error: 'invalid-attachments', max: MAX_ATTACHMENTS_PER_NOTE }, corsHeaders);
  }

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
  if (Array.isArray(payload)) {
    // A note with files goes alone: the files of a batch would have to say which note is theirs.
    if (attachmentIds.length > 0) return json(400, { error: 'attachments-in-batch' }, corsHeaders);
    return postBatch(request, config, store, kv, corsHeaders, clientIp, payload, noteIndex, stillWrites);
  }

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
    return json(401, { error: identity.error, reason: identity.reason }, corsHeaders);
  }
  // A note signed by a session of an account is a write: the session is read again (FRU-238).
  const ended = identity.account ? await endedSession(stillWrites, corsHeaders) : undefined;
  if (ended !== undefined) return ended;

  const attributed = { ...seed, ...optionalReporter(identity.reporter) };

  const target = await chosenPlace(request, config, route);
  if (target === null) return json(403, { error: 'destination-not-allowed' }, corsHeaders);

  try {
    // A note of before FRU-331, sent again, names its picture in its seed: it goes with it while the
    // migration keeps it, and the note is never refused for it.
    const noteFiles = {
      files: context?.attachments ?? attachmentStoreFor(config),
      store,
      writer:
        context === undefined
          ? undefined
          : (workspace: string, site: string | undefined) => writerIn(request, config, context, workspace, site),
    };
    const workspaceOfNote = route.client?.workspace;
    const legacy = await legacyAttachment(noteFiles, target, workspaceOfNote, attributed, attachmentIds);
    const named = legacy?.id === undefined ? attachmentIds : [...attachmentIds, legacy.id];
    const taken =
      named.length === 0
        ? undefined
        : await takeFiles(noteFiles, target, workspaceOfNote, attributed.id, clientId, named);
    if (taken !== undefined && !taken.ok) return json(taken.status, taken.body, corsHeaders);
    const { files: answered, ...issue } = await store.create(
      attributed,
      target,
      route.policy,
      taken?.ok === true ? taken.files : undefined,
    );
    // The tracker has the files, or refused them once the note was written: none stays in transit.
    // A file that a delivery carries later stays until that delivery arrives, or its transit ends.
    const filesOutcome = taken?.ok === true ? await settleFiles(taken.store, taken.files, answered) : undefined;
    await invalidatePages(kv, [attributed.page.url]);
    const workspace = route.client?.workspace;
    if (workspace !== undefined && clientId !== undefined) {
      const entry = noteEntry(workspace, clientId, attributed, identity.channel, target, issue);
      await indexed(noteIndex, (index) => index.record([entry], Date.now()));
    }

    const hidden = await hidesTracker(request, config, route.policy);

    return json(
      201,
      {
        issue: hidden ? withoutTracker(issue, attributed.id) : issue,
        ...(filesOutcome === undefined ? {} : { attachments: filesOutcome }),
        // The note named a picture that its place takes no file for: it goes without it, and says why.
        ...(legacy?.notTaken === undefined
          ? {}
          : { attachments: { sent: 0, lost: 0, waiting: 0, notTaken: legacy.notTaken } }),
      },
      corsHeaders,
    );
  } catch (error) {
    if (error instanceof StoreError) {
      // Upstream failed, not the caller: 502 tells the widget to keep the note and retry.
      return json(502, { error: 'store-unavailable', message: error.message }, corsHeaders);
    }
    throw error;
  }
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
  noteIndex: NoteIndex | undefined,
  stillWrites: () => Promise<boolean>,
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
  let account = false;
  for (const seed of seeds) {
    const identity = await attributionFor(request, route.policy, seed.reporter);
    if (!identity.ok) return json(401, { error: identity.error, reason: identity.reason }, corsHeaders);
    attributed.push({ ...seed, ...optionalReporter(identity.reporter) });
    channel = identity.channel;
    account = identity.account;
  }
  // Once for the request, as the token is one (FRU-238).
  const ended = account ? await endedSession(stillWrites, corsHeaders) : undefined;
  if (ended !== undefined) return ended;

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

  // A guest gets no reference of the tracker (FRU-250).
  const answered = (await hidesTracker(request, config, route.policy))
    ? results.map((result) =>
        'issue' in result && result.issue !== undefined
          ? { ...result, issue: withoutTracker(result.issue, result.id) }
          : result,
      )
    : results;
  if (kept.length === 0) return json(502, { error: 'store-unavailable', results: answered }, corsHeaders);

  return json(kept.length === results.length ? 201 : 207, { results: answered }, corsHeaders);
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
