import { json } from './http.ts';
import type { AccountStore } from './accounts.ts';
import { MAX_BODY_BYTES, parseJsonObject, readBoundedText } from './bounded-body.ts';
import { isExtensionOrigin } from './cors.ts';
import {
  CONNECT_INTERVAL_SECONDS,
  CONNECT_TTL_SECONDS,
  CONNECT_WINDOW_MS,
  CONNECTS_PER_ADDRESS,
  type ConnectRow,
  type ConnectStore,
  MAX_WORD_MISSES,
  POLL_WINDOW_SECONDS,
  SLOW_DOWN_SECONDS,
  createConnectionId,
  isClaim,
  isConnectionId,
  isRequestId,
  normalizeWord,
  readBrowserLabel,
  startConnect,
  stateOf,
} from './connect.ts';
import type { Kv } from './kv.ts';
import { ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS, createRefreshToken, digest, mintAccessToken } from './session.ts';

/**
 * The routes of FRU-238: the extension asks, the console approves. `connect.ts` says what is taken
 * from RFC 8628 and why; this file is the HTTP of it.
 *
 * - `POST /session/connect` and `POST /session/connect/claim` answer the extension, with the open CORS
 *   of `/session/*`, and no cookie. The first is metered twice: the limit of every route, and
 *   `CONNECTS_PER_ADDRESS` of its own. The second is polled, and paced by `slow-down`.
 * - `GET /console/connect/<request>`, `POST …/approve` and `POST …/refuse` answer the console, with the
 *   cookie of better-auth. A `POST` takes the `Origin` of the console, and the approval takes the word
 *   the screen showed and the account it showed: an approval is never one click on a link.
 * - `GET /console/me/browsers` and `DELETE /console/me/browsers/<id>`: the sessions of the extension
 *   that belong to the account, and the end of one.
 */

export const CONNECT_PATH = '/session/connect';
export const CLAIM_PATH = '/session/connect/claim';
const CONSOLE_CONNECT = /^\/console\/connect\/([A-Za-z0-9_-]{1,64})(\/approve|\/refuse)?$/;
const BROWSERS_PATH = '/console/me/browsers';
const BROWSER_PATH = /^\/console\/me\/browsers\/([A-Za-z0-9_-]{1,64})$/;

/** Whether this path is one of the console's that `handleConsoleConnect` answers. */
export function isConsoleConnectRoute(pathname: string): boolean {
  return CONSOLE_CONNECT.test(pathname) || pathname === BROWSERS_PATH || BROWSER_PATH.test(pathname);
}

/** The body as an object, `'too-large'` over the cap (FRU-506), or `undefined`: not JSON, not an object. */
async function bodyOf(request: Request): Promise<Record<string, unknown> | 'too-large' | undefined> {
  const text = await readBoundedText(request);
  if (text === null) return 'too-large';
  return parseJsonObject(text);
}

export type ExtensionConnectContext = {
  connect: ConnectStore;
  accounts: AccountStore;
  kv: Kv;
  clientIp: string;
  /** The worker key: it signs the access tokens. */
  secret: string;
  /** `FRUITBACK_CONSOLE_URL`: where the person approves. */
  consoleUrl: string;
  now?: number;
};

/** The two routes of the extension, or `undefined` for another path. */
export async function handleExtensionConnect(
  request: Request,
  pathname: string,
  context: ExtensionConnectContext,
  headers: Record<string, string>,
): Promise<Response | undefined> {
  if (pathname !== CONNECT_PATH && pathname !== CLAIM_PATH) return undefined;
  if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
  const now = context.now ?? Date.now();

  // A page of a site never starts a request: in a browser it cannot hide its `Origin`. A caller
  // outside a browser writes any `Origin`, or none: what stands against it is the word, the account
  // the console shows, and the claim it never learns (`SECURITY.md`).
  const origin = request.headers.get('Origin');
  if (origin !== null && !isExtensionOrigin(origin)) return json(403, { error: 'origin-not-allowed' }, headers);

  const body = await bodyOf(request);
  if (body === 'too-large') return json(413, { error: 'payload-too-large', maxBytes: MAX_BODY_BYTES }, headers);
  if (body === undefined) return json(400, { error: 'invalid-body' }, headers);

  if (pathname === CONNECT_PATH) {
    // Counted before anything is written, a refused one too, as the limit of every route counts.
    const started = await context.kv.incr(`fruitback:connect-ip:${context.clientIp}`, CONNECT_WINDOW_MS);
    if (started > CONNECTS_PER_ADDRESS) return json(429, { error: 'rate-limited' }, headers);

    const made = await startConnect(context.connect, readBrowserLabel(body.browser), now);
    if (made === undefined) return json(429, { error: 'connect-busy' }, headers);

    return json(
      201,
      {
        request: made.request,
        claim: made.claim,
        word: made.word,
        browser: made.browser,
        verificationUri: `${new URL(context.consoleUrl).origin}/connect/${made.request}`,
        expiresIn: CONNECT_TTL_SECONDS,
        interval: CONNECT_INTERVAL_SECONDS,
      },
      headers,
    );
  }

  // A claim that is not one this worker writes is not digested, and answers as one that expired.
  if (!isClaim(body.claim)) {
    return json(
      body.claim === undefined ? 400 : 410,
      { error: body.claim === undefined ? 'invalid-body' : 'connect-expired' },
      headers,
    );
  }
  const claimHash = await digest(body.claim);

  // RFC 8628 `slow_down`: asked again within the interval, the answer says to wait longer. Shared by
  // the replicas through the `Kv` of the database.
  const polls = await context.kv.incr(`fruitback:connect-poll:${claimHash}`, POLL_WINDOW_SECONDS * 1000);
  if (polls > 1) {
    return json(429, { error: 'slow-down', interval: CONNECT_INTERVAL_SECONDS + SLOW_DOWN_SECONDS }, headers);
  }

  const refreshToken = createRefreshToken();
  const tokenHash = await digest(refreshToken);
  // The person as the account says it at the claim, written in the session and in its tokens.
  let person: { name?: string; email?: string } | undefined;
  const claimed = await context.connect.claim({
    claimHash,
    now,
    tokenHash,
    connectionId: createConnectionId(),
    expiresAt: now + REFRESH_TTL_SECONDS * 1000,
    open: async (id) => {
      const account = await context.accounts.account(id);
      // An account suspended after the approval opens nothing (FRU-281).
      person =
        account === undefined || account.suspended === true
          ? undefined
          : {
              ...(account.name === undefined || account.name === '' ? {} : { name: account.name }),
              ...(account.email === '' ? {} : { email: account.email }),
            };

      return person;
    },
  });

  if (claimed.state === 'pending') return json(202, { state: 'pending', interval: CONNECT_INTERVAL_SECONDS }, headers);
  if (claimed.state === 'refused') return json(410, { error: 'connect-refused' }, headers);
  if (claimed.state === 'gone') return json(410, { error: 'connect-expired' }, headers);

  const identity = { subject: claimed.account, ...person, account: true as const };

  return json(
    200,
    {
      refreshToken,
      accessToken: await mintAccessToken(identity, context.secret, now, tokenHash),
      expiresIn: ACCESS_TTL_SECONDS,
      identity,
    },
    headers,
  );
}

export type ConsoleConnectContext = {
  connect: ConnectStore;
  accounts: AccountStore;
  /** The account of the cookie of better-auth, or `undefined`. */
  cookieSession: (request: Request) => Promise<string | undefined>;
  consoleUrl: string;
  now?: number;
};

/** The routes of the console of FRU-238, or `undefined` for another path. */
export async function handleConsoleConnect(
  request: Request,
  pathname: string,
  context: ConsoleConnectContext,
  headers: Record<string, string>,
): Promise<Response | undefined> {
  if (!isConsoleConnectRoute(pathname)) return undefined;
  const now = context.now ?? Date.now();

  // The person of the cookie, and nobody else: a token of the extension names nobody here (FRU-202).
  const subject = await context.cookieSession(request);
  if (subject === undefined) return json(401, { error: 'identity-required' }, headers);
  // A call that changes something comes from the console, and never from a request with no `Origin`:
  // a page of the same site as the worker sends the cookie too (`callerOf` of `console-api.ts`).
  if (request.method !== 'GET' && request.headers.get('Origin') !== new URL(context.consoleUrl).origin) {
    return json(403, { error: 'origin-not-allowed' }, headers);
  }
  const account = await context.accounts.account(subject);
  if (account === undefined || account.suspended === true) {
    return json(401, { error: 'identity-required', reason: 'no-account' }, headers);
  }

  if (pathname === BROWSERS_PATH) {
    if (request.method !== 'GET') return json(405, { error: 'method-not-allowed' }, headers);
    const browsers = await context.connect.browsersOf(account.id, now);

    return json(
      200,
      {
        browsers: browsers.map((each) => ({
          id: each.id,
          browser: each.browser,
          connectedAt: new Date(each.connectedAt).toISOString(),
          usedAt: new Date(each.usedAt).toISOString(),
        })),
      },
      headers,
    );
  }

  const browser = BROWSER_PATH.exec(pathname);
  if (browser !== null) {
    if (request.method !== 'DELETE') return json(405, { error: 'method-not-allowed' }, headers);
    const id = browser[1] as string;
    // Another person's connection answers as one that does not exist.
    if (!isConnectionId(id) || !(await context.connect.endBrowser(account.id, id, now))) {
      return json(404, { error: 'not-found' }, headers);
    }

    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store', ...headers } });
  }

  const [, requestId = '', action] = CONSOLE_CONNECT.exec(pathname) as RegExpExecArray;
  if (!isRequestId(requestId)) return json(404, { error: 'connect-unknown' }, headers);
  const requestHash = await digest(requestId);
  const workspaces = async () =>
    (await context.accounts.memberships(account.id)).map(({ workspace, role }) => ({
      id: workspace.id,
      name: workspace.name,
      role,
    }));

  if (action === undefined) {
    if (request.method !== 'GET') return json(405, { error: 'method-not-allowed' }, headers);
    const row = await context.connect.readRequest(requestHash);
    const state = row === undefined ? undefined : stateOf(row, now);
    if (row === undefined || state === undefined) return json(404, { error: 'connect-unknown' }, headers);
    if (state === 'pending') {
      return json(
        200,
        {
          request: requestId,
          state,
          word: row.word,
          browser: row.browser,
          createdAt: new Date(row.createdAt).toISOString(),
          expiresAt: new Date(row.expiresAt).toISOString(),
          account: {
            id: account.id,
            email: account.email,
            ...(account.name === undefined ? {} : { name: account.name }),
          },
          workspaces: await workspaces(),
        },
        headers,
      );
    }
    // An answered request is shown to the account that answered it, and to nobody else: another
    // person learns nothing of it, not even that it exists.
    if (!answeredBy(row, account.id)) {
      return state === 'expired' && row.outcome === undefined
        ? json(410, { error: 'connect-expired' }, headers)
        : json(404, { error: 'connect-unknown' }, headers);
    }

    return json(200, { request: requestId, state, browser: row.browser }, headers);
  }

  if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
  const body = await bodyOf(request);
  if (body === 'too-large') return json(413, { error: 'payload-too-large', maxBytes: MAX_BODY_BYTES }, headers);
  if (body === undefined || typeof body.account !== 'string') return json(400, { error: 'invalid-body' }, headers);
  // The account the screen showed. A console that changed account between the read and the click
  // would otherwise connect the browser to another person than the one it named.
  if (body.account !== account.id) return json(409, { error: 'account-changed' }, headers);

  const row = await context.connect.readRequest(requestHash);
  if (row === undefined) return json(404, { error: 'connect-unknown' }, headers);

  if (action === '/approve') {
    if (typeof body.word !== 'string') return json(400, { error: 'invalid-body' }, headers);
    // Compared only while the request waits: an answered one says so below, and costs no word.
    if (stateOf(row, now) === 'pending' && normalizeWord(body.word) !== row.word) {
      const left = await context.connect.miss(requestHash, now, MAX_WORD_MISSES);
      if (left !== undefined) return json(422, { error: 'word-mismatch', attemptsLeft: left }, headers);
    }
  }

  const outcome = action === '/approve' ? 'approved' : 'refused';
  const answered = await context.connect.answer({ requestHash, account: account.id, outcome, now });
  if (!answered.ok) {
    const [status, error] = ANSWER_REFUSALS[answered.reason];

    return json(status, { error }, headers);
  }

  return json(
    200,
    outcome === 'approved'
      ? { state: outcome, browser: row.browser, workspaces: await workspaces() }
      : { state: outcome, browser: row.browser },
    headers,
  );
}

/** Why an answer changed nothing, as the console reads it. */
const ANSWER_REFUSALS = {
  already: [409, 'connect-already'],
  expired: [410, 'connect-expired'],
  unknown: [404, 'connect-unknown'],
} as const;

function answeredBy(row: ConnectRow, account: string): boolean {
  return row.account === account;
}
