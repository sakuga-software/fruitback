import type { NoteIssue, NoteReporter } from '@fruitback/shared';
import { type IdentityResult, readBearerToken, stripClaimedVerification, verifyIdentityToken } from './identity.ts';
import {
  type ClientConfig,
  type ClientMap,
  type ClientPolicy,
  type ClientResolution,
  normalizeClientId,
  openReadClients,
  resolveClient,
} from './clients.ts';
import { type AccountStore, can, readsSite } from './accounts.ts';
import { withRenewedCookie } from './auth-routes.ts';
import { consoleCors, isConsoleRoute } from './console-cors.ts';
import { createConnectorStores, createRoutedStore } from './connectors.ts';
import { type GithubApp, githubAppFor } from './github-connector.ts';
import { DELIVERY_HEADER, LOOP_STATUS } from './rest-connector.ts';
import { type WorkerConfig, type WorkerEnv, hasAccounts, hasSessions, readAllowedOrigins, readConfig } from './env.ts';
import { type ReplyAuthor, type NoteStore, StoreError } from './store.ts';
import { watchedStore } from './connector-health.ts';
import { type CorsDecision, diagnosticCorsHeaders, isExtensionOrigin, openCors, resolveCors } from './cors.ts';
import { PAIR_PATH } from './pair-page.ts';
import { checkRateLimit } from './rate-limit.ts';
import { KvError } from './kv.ts';
import { type Channel, type NoteIndex } from './notes-index.ts';
import { sessionStillValid } from './session-check.ts';
import { ATTACHMENTS_PATH } from './attachments.ts';
import { handleAttachment } from './attachment-routes.ts';
import { handleConsole } from './console-routes.ts';
import { handlePairing, handleSessionRoutes } from './session-routes.ts';
import { CHECK_PATH, REPLY_PATH, STATUS_PATH, postCheck, postReply, postStatus } from './reply-routes.ts';
import { EDIT_PATH, postEdit } from './edit-routes.ts';
import { getFeedback, postFeedback } from './feedback-routes.ts';
import { MCP_PATH, handleMcp } from './mcp.ts';
import { KEY_PREFIX, resolveAgentKey } from './agent-keys.ts';
import { handleOAuth, isOAuthRoute, issuerOf, resolveAccessToken, resourceMetadataUrl } from './oauth.ts';
import { agentTools } from './agent-tools.ts';
import type { SessionIdentity } from './session.ts';
import { type RequestContext, type Served, type Verified, withSites } from './request-context.ts';
import { placedAt, routingFailure } from './note-helpers.ts';

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
  issues: readonly NoteIssue[],
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
      issues.map((issue) => issue.note.id),
    );

    return new Set([...authors].flatMap(([note, author]) => (author === account ? [note] : [])));
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

/** The GitHub App of the connectors, as the options of `createConnectorStores` take it. */
function githubAppOf(context: RequestContext, served: WorkerConfig): { githubApp?: GithubApp } {
  if (context.githubApp !== undefined) return { githubApp: context.githubApp };

  return served.githubConnector === undefined ? {} : { githubApp: githubAppFor(served.githubConnector) };
}

export async function handleRequest(request: Request, env: WorkerEnv, context: RequestContext): Promise<Response> {
  const seen: { cors?: Record<string, string> } = {};
  let answer: Response;
  try {
    answer = await routed(request, env, context, seen);
  } catch (error) {
    // FRU-495: a route reads its site when it resolves its `client`, below the CORS and the rate
    // limit. A database that stops between the two answers as the accounts that do not answer, with
    // the CORS headers of the route, and never a `500`.
    if (error instanceof SiteUnread) {
      console.error(`[fruitback] the accounts did not answer: ${error.unread.message}`);
      answer = json(502, { error: 'store-unavailable' }, seen.cors ?? {});
    } else if (error instanceof KvError) {
      // FRU-67. The `Kv` answered the rate limit and then stopped: a route below it counts a message,
      // or keeps a ticket, and nothing there catches this. On memory a `Kv` never throws, so this is
      // the answer of a database that went away between two calls of one request: the same `503` as
      // the limiter's, with the CORS headers of the route, and never a `500` with no header.
      console.error(`[fruitback] the Kv did not answer: ${error.message}`);
      answer = json(503, { error: 'limiter-unavailable' }, seen.cors ?? {});
    } else {
      throw error;
    }
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

  // With accounts, the sites the console wrote are this worker's clients (FRU-96). A request reads the
  // one it names, and the origin it comes from, when it needs them (FRU-495): a site added a second
  // ago is served now. Everything below reads the served configuration and nothing else.
  const accounts = context.accounts ?? accountStoreFor(config.config);
  const served: Served = accounts === undefined ? config.config : withSites(config.config, accounts);

  // The session routes answer the extension, which is not a site on the allowlist and cannot be put
  // on one — see `openCors`. Resolved before the gate, so the preflight succeeds too.
  const session = pathname.startsWith('/session/');
  // The pairing page is opened from a link, by a browser, as a document. No site reads it through
  // CORS, so the list of client sites does not apply and it answers with no CORS header at all.
  const pairing = pathname === PAIR_PATH;
  const site = async (): Promise<CorsDecision> => resolveCors(request, await originsServed(request, served));
  const extension = (): Promise<CorsDecision> | CorsDecision => (session ? openCors(request) : site());
  // The console's routes answer the console and no site, with the cookie of its session (FRU-98).
  const consoleRoute = hasAccounts(served) && isConsoleRoute(pathname);
  const chosen = (): Promise<CorsDecision> | CorsDecision =>
    consoleRoute ? consoleCors(request, served) : extension();
  // FRU-467: the routes of OAuth take no cookie, and a client in a page reads them (RFC 8414, 7591).
  const oauthRoute = isOAuthRoute(pathname);
  const routeCors = (): Promise<CorsDecision> | CorsDecision => (oauthRoute ? openCors(request) : chosen());
  let cors: CorsDecision;
  try {
    cors = pairing ? { allowed: true, headers: {} } : await routeCors();
  } catch (error) {
    if (error instanceof StoreError) return accountsDown(request, error);
    throw error;
  }
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

  if (oauthRoute) {
    const issuer = issuerOf(served.publicUrl);
    if (accounts === undefined || issuer === undefined || served.consoleUrl === undefined) {
      return json(404, { error: 'not-found' }, cors.headers);
    }

    return (
      (await handleOAuth(
        request,
        pathname,
        { accounts, kv, issuer, consoleUrl: served.consoleUrl, clientIp: context.clientIp },
        cors.headers,
      )) ?? json(404, { error: 'not-found' }, cors.headers)
    );
  }

  if (consoleRoute && accounts !== undefined) {
    return handleConsole(request, pathname, {
      served,
      context,
      accounts,
      kv,
      noteIndex,
      cors,
      ...githubAppOf(context, served),
    });
  }

  if (pairing) return handlePairing(request, served, context);

  if (session) {
    return handleSessionRoutes(request, pathname, {
      served,
      context,
      accounts,
      kv,
      noteIndex,
      cors,
      sessionWrites,
      ...githubAppOf(context, served),
    });
  }

  // Resolved once here, not inside each handler: see `RequestContext.store`.
  const storeOfRequest = (): NoteStore => {
    const own = context.store ?? storeFor(served);

    // FRU-121: a site that chose a destination writes and reads through the connector of its workspace.
    return accounts === undefined
      ? own
      : createRoutedStore(
          own,
          createConnectorStores(accounts, served.secretsKey, Date.now, served.linearOAuth, {
            // FRU-331: a delivery carries the address of a file on this worker, which needs both.
            filesReachable: served.publicUrl !== undefined && served.secretsKey !== undefined,
            ...githubAppOf(context, served),
          }),
        );
  };

  // FRU-463: the remote MCP server, for an agent key of a workspace (FRU-461).
  if (pathname === MCP_PATH) {
    if (accounts === undefined) return json(404, { error: 'not-found' }, cors.headers);

    const issuer = served.consoleUrl === undefined ? undefined : issuerOf(served.publicUrl);

    return handleMcp(request, {
      // An agent key of the console (FRU-461), or an access token of OAuth (FRU-467).
      grantOf: (key) =>
        key.startsWith(KEY_PREFIX)
          ? resolveAgentKey(accounts, key, Date.now())
          : resolveAccessToken(accounts, key, Date.now()),
      ...(issuer === undefined ? {} : { resourceMetadata: resourceMetadataUrl(issuer) }),
      suspended: async (workspace) => (await accounts.suspension(workspace)) !== undefined,
      // The last use of a key is what the console shows (FRU-462): a failure to write it refuses nothing.
      used: (grant) =>
        accounts.markAgentKeyUsed(grant.key, Date.now()).catch((error: unknown) => {
          console.error(
            `[fruitback] the last use of an agent key was not written: ${error instanceof Error ? error.message : String(error)}`,
          );
        }),
      tools: (grant) =>
        agentTools({
          grant,
          // As the routes of the page: each call through a connector is noted on it (FRU-464).
          store: watchedStore(storeOfRequest(), accounts),
          accounts,
          kv,
          noteIndex,
          replyLength: REPLY_LENGTH,
          route: (site) => routeFor(request, served, site),
        }),
    });
  }

  if (pathname === ATTACHMENTS_PATH || pathname.startsWith(`${ATTACHMENTS_PATH}/`)) {
    try {
      return await handleAttachment(request, pathname, {
        files: context.attachments ?? attachmentStoreFor(served),
        store: storeOfRequest(),
        headers: cors.headers,
        secretsKey: served.secretsKey,
        kv: () => context.kv ?? kvFor(served),
        route: async (site) => {
          const route = await routeFor(request, served, site);
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
  const statusOfNote = STATUS_PATH.exec(pathname)?.[1];
  const editOf = EDIT_PATH.exec(pathname)?.[1];
  if (
    pathname !== '/feedback' &&
    replyTo === undefined &&
    checkOf === undefined &&
    statusOfNote === undefined &&
    editOf === undefined
  ) {
    return json(404, { error: 'not-found' }, cors.headers);
  }

  const store = storeOfRequest();
  // The checks of the caller that the routes of the notes call, which stay in this file.
  const checks = {
    routeFor,
    replyAuthorFor,
    endedSession,
    sessionWrites,
    writerIn,
    hidesTracker,
    REPLY_LENGTH,
    authorizeRead,
    writesHere,
    notesOfReader,
    memberOf,
    seesTracker,
    signsNotes,
    attributionFor,
    chosenPlace,
  };

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

  // FRU-367: the status of a note that the worker keeps.
  if (statusOfNote !== undefined) {
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, cors.headers);

    return postStatus(
      request,
      statusOfNote,
      served,
      watchedStore(store, accounts),
      kv,
      cors.headers,
      { accounts, noteIndex, context },
      checks,
    );
  }

  // FRU-475: the text of a note, edited by the person who left it.
  if (editOf !== undefined) {
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, cors.headers);

    return postEdit(
      request,
      editOf,
      served,
      watchedStore(store, accounts),
      kv,
      cors.headers,
      { accounts, noteIndex, context },
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
    ? getFeedback(request, served, watchedStore(store, accounts), kv, cors.headers, noteIndex, context, checks)
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
        checks,
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
 * The site of a request that the accounts did not answer (FRU-495). `handleRequest` answers it with
 * `502 store-unavailable`. Its own class, so that a `StoreError` of a store that a route reads still
 * reaches the route, which answers it.
 */
class SiteUnread extends Error {
  readonly unread: StoreError;

  constructor(unread: StoreError) {
    super(unread.message);
    this.unread = unread;
  }
}

/**
 * The map of clients of one request on a worker with accounts: the site it names, or none (FRU-495).
 * Never `undefined`: that is a single-client worker, which answers anybody.
 */
async function namedClient(
  clientNamed: (site: string) => Promise<ClientConfig | undefined>,
  clientId: string | undefined,
): Promise<ClientMap> {
  const id = normalizeClientId(clientId);
  let client: ClientConfig | undefined;
  try {
    client = id === undefined ? undefined : await clientNamed(id);
  } catch (error) {
    if (error instanceof StoreError) throw new SiteUnread(error);
    throw error;
  }

  return id === undefined || client === undefined ? {} : { [id]: client };
}

/**
 * The origins that the routes of the widget answer: `ALLOWED_ORIGINS`, and the origin of the request
 * when a site of the accounts has it (FRU-495). The store is asked only for an origin of a page that
 * the list does not hold already.
 */
async function originsServed(request: Request, config: Served): Promise<string[]> {
  const origin = request.headers.get('Origin');
  const { allowedOrigins, servesOrigin } = config;
  if (origin === null || servesOrigin === undefined) return allowedOrigins;
  if (isExtensionOrigin(origin) || allowedOrigins.includes(origin)) return allowedOrigins;

  return (await servesOrigin(origin)) ? [...allowedOrigins, origin] : allowedOrigins;
}

/**
 * The answer when the accounts do not answer the CORS of a request. Said in the log, because the
 * answer says nothing: a database on a network fails in more ways than a file, and the message of
 * the store holds no address (FRU-141).
 */
function accountsDown(request: Request, error: StoreError): Response {
  console.error(`[fruitback] the accounts did not answer: ${error.message}`);

  return json(502, { error: 'store-unavailable' }, diagnosticCorsHeaders(request));
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
async function routeFor(request: Request, config: Served, clientId: string | undefined): Promise<ClientResolution> {
  const { reachIn, clientNamed } = config;

  return resolveClient({
    // FRU-495: on a worker with accounts, the one site the request names, never every site.
    clients: clientNamed === undefined ? config.clients : await namedClient(clientNamed, clientId),
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
  claimed: NoteReporter | undefined,
): Promise<
  | { ok: true; reporter: NoteReporter | undefined; channel: Channel; account: boolean }
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

/**
 * FRU-123: a member chose where the note goes. The name is in the query, and the body stays the
 * note: the relay of the extension carries a query and no other header. Absent, the note goes to
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

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}
