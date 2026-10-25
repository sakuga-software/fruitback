import type { AccountStore } from './accounts.ts';
import { MAX_BODY_BYTES, readBoundedText } from './bounded-body.ts';
import { handleExtensionConnect } from './connect-routes.ts';
import type { CorsDecision } from './cors.ts';
import { type WorkerConfig, hasSessions } from './env.ts';
import type { Kv } from './kv.ts';
import type { NoteIndex } from './notes-index.ts';
import { pairPage, pairsByCode } from './pair-page.ts';
import type { RequestContext, Served } from './request-context.ts';
import {
  type SessionIdentity,
  type SessionStore,
  createPairing as openPairing,
  redeemPairing,
  refreshSession,
  revokeSession,
} from './session.ts';
import { SESSION_NOTES_PATH, handleSessionNotes } from './session-notes.ts';
import { SESSION_SITES_PATH, handleSessionSites } from './session-sites.ts';
import { StoreError } from './store.ts';
import { connectStoreFor, sessionStoreFor } from './worker-stores.ts';

/**
 * The routes of the extension's sessions (FRU-363), out of `app.ts` so that a review reads them in
 * one file: the pairing page, `/session/pair`, `/session/refresh` and `/session/revoke`, the notes
 * and the sites of a session, and the connection that a person approves in the console. `app.ts`
 * sends a request here once its CORS, its method and the limit of its caller let it through.
 */

/** What `app.ts` knows of one request to `/session/`, and the routes of this file do not. */
export type SessionSeams = {
  served: Served;
  context: RequestContext;
  /** `undefined` on a worker with no accounts. */
  accounts: AccountStore | undefined;
  kv: Kv;
  noteIndex: NoteIndex | undefined;
  cors: CorsDecision;
  /** `sessionWrites` of `app.ts`: the person of a session still valid in the store, the check of every write. */
  sessionWrites: (request: Request, config: Served, context: RequestContext) => Promise<SessionIdentity | undefined>;
};

/** The pairing page (`PAIR_PATH`): a document a browser opens from a link, with no CORS header. */
export async function handlePairing(request: Request, served: Served, context: RequestContext): Promise<Response> {
  // It exists only where the sessions do, like the three routes below: a worker without the
  // extension does not advertise the page.
  if (context.sessionStore === undefined && !hasSessions(served)) {
    return json(404, { error: 'not-found' });
  }
  if (!pairsByCode(served.publicUrl)) return json(404, { error: 'not-found' });
  if (request.method !== 'GET') return json(405, { error: 'method-not-allowed' });

  return pairPage();
}

export async function handleSessionRoutes(request: Request, pathname: string, seams: SessionSeams): Promise<Response> {
  const { served, context, accounts, kv, noteIndex, cors, sessionWrites } = seams;
  try {
    // FRU-306: the notes of a whole site, for the side panel. The session is read again in the store.
    if (pathname === SESSION_NOTES_PATH && accounts !== undefined && served.identitySecret !== undefined) {
      return await handleSessionNotes(request, {
        accounts,
        noteIndex,
        session: () => sessionWrites(request, served, context),
        headers: cors.headers,
      });
    }

    // FRU-101: what the extension may turn on in one click, for a worker that keeps accounts.
    if (pathname === SESSION_SITES_PATH && accounts !== undefined && served.identitySecret !== undefined) {
      // FRU-255: the write reads the session again in the store, through `sessionWrites`, the
      // check of every route that writes for an extension.
      const writes = { kv, session: () => sessionWrites(request, served, context) };

      return await handleSessionSites(
        request,
        accounts,
        served.identitySecret,
        cors.headers,
        undefined,
        noteIndex,
        writes,
      );
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
    // note path's outage rather than as a bare `500`, so the extension can tell "retry later" from
    // "this request was wrong" — and so the answer carries the CORS headers it needs to read it.
    if (error instanceof StoreError) return json(502, { error: 'store-unavailable' }, cors.headers);
    throw error;
  }
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
    // The Cloud pairs no extension by a code (FRU-325). A session paired before still refreshes.
    if (!pairsByCode(config.publicUrl)) return json(404, { error: 'not-found' }, headers);
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
    // An extension that refreshes for a workspace: its person is seen there today (FRU-249).
    if (refreshed.ok && refreshed.identity.workspace !== undefined) {
      await config.seenIn?.(refreshed.identity.workspace, refreshed.identity.subject);
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
    return config.accountActive !== undefined && (await config.accountActive(identity.subject));
  if (config.roleIn === undefined || identity.workspace === undefined) return true;

  return (await config.roleIn(identity.workspace, identity.subject)) !== undefined;
}

/** Mints a pairing code. Not reachable over HTTP — see `handleSession` and `main.ts`. */
export async function createPairingCommand(
  config: WorkerConfig,
  identity: { subject: string; name?: string; email?: string; workspace?: string },
  /** The store a test opened. Absent, the one of the configuration. */
  held?: SessionStore,
): Promise<{ code: string; expiresAt: number }> {
  const store = held ?? sessionStoreFor(config);
  if (store === undefined) {
    throw new Error('FRUITBACK_DATABASE_URL is not set, so this worker keeps no sessions');
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

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
