import { type AccountStore, mailboxOf, normalizeEmail, readLocaleTag } from './accounts.ts';
import {
  ACCOUNT_SUSPENDED,
  AUTH_BASE_PATH,
  type Auth,
  CLIENT_IP_HEADER,
  MAGIC_LINK_TTL_SECONDS,
  SERVED_PATHS,
  sendLinkThrough,
} from './auth.ts';
import { UNKNOWN_BROWSER } from './browser-label.ts';
import { adminLinkAt, endAdminLink } from './first-admin.ts';
import type { Kv } from './kv.ts';
import { MailError, type Mailer, providerLinkedMessage, signInMessage } from './mail.ts';
import {
  ACCOUNT_OF_ANOTHER,
  LINK_NEEDS_CONFIRMATION,
  type LinkAdapter,
  pendingLinkKey,
  readPending,
  refusalOf,
} from './provider-link.ts';
import type { SessionStore } from './session.ts';
import { INVITATION_REQUIRED, asOperatorLink } from './sign-up.ts';

/**
 * The console signs in with better-auth (FRU-147): since FRU-150, the one way.
 *
 * - **`/console/auth/<path>` reaches better-auth for the paths of `SERVED_PATHS` only.** Any other path
 *   answers `404` here, before better-auth reads it: a route that a plugin adds stays closed until it
 *   is named there.
 * - **The link of the e-mail keeps its token after the `#`**, as the link of before does: a fragment
 *   never reaches a server, so no proxy writes it in a log. `POST /console/auth/email` asks
 *   better-auth for the link, and writes `<console>/sign-in#<token>`. `POST /console/auth/email/redeem`
 *   takes the token in its body and spends it in the process. **It hands the browser the `Set-Cookie`
 *   of better-auth and nothing else of its answer**: that answer holds the token of the session.
 * - **A session is named by its id, never by its token** (FRU-181). `GET /console/sessions` lists the
 *   sessions of the person with no token, and `DELETE /console/sessions/<id>` ends one.
 *
 * A request that carries the cookie can be sent by a page of another site of the same « site » as the
 * worker (`demo.fruitback.com`), so a call that changes something takes the `Origin` of the console,
 * and no request with no `Origin`: see `mutationAllowed`.
 */

export type AuthRouteContext = {
  auth: Auth | Promise<Auth>;
  accounts: AccountStore;
  mailer: Mailer | undefined;
  kv: Kv;
  /** `FRUITBACK_CONSOLE_URL`: the origin the cookie may be sent from, and the address of the link. */
  consoleUrl: string;
  /** The address `resolveClientIp` read, which better-auth keeps when `trackIp` is on. */
  clientIp: string;
  trackIp: boolean;
  /** The sessions of the extensions: a new primary address is written on them (FRU-450). */
  sessions?: Pick<SessionStore, 'readdressSessionsOf'>;
};

/** Links per address, per window: enough for a lost one, too few to fill someone's mailbox (FRU-98). */
export const EMAIL_LINKS_PER_WINDOW = 3;
export const EMAIL_LINK_WINDOW_MS = 15 * 60 * 1000;

/** The routes of the worker that this file answers, beside the ones of better-auth. */
export const EMAIL_LINK_PATH = `${AUTH_BASE_PATH}/email`;
export const EMAIL_REDEEM_PATH = `${AUTH_BASE_PATH}/email/redeem`;
export const SESSIONS_PATH = '/console/sessions';
/**
 * `GET /console/auth/start/<provider>` (FRU-148): a sign-in with a provider, started by a navigation.
 *
 * `/sign-in/social` answers the address of the provider to a `fetch`, and sets the cookie of the state
 * on that answer. WebKit kept no such cookie when the console and the worker are not one site
 * (measured in FRU-147, on `*.fruitback.localhost`), and the way back failed with `state_mismatch`. A
 * navigation sets it in the first party, in every engine: the console sends the browser here, and this
 * answers `302` to the provider with the cookie.
 */
const START_PATH = new RegExp(`^${AUTH_BASE_PATH}/start/(github|google)$`);
const SESSION_PATH = /^\/console\/sessions\/([A-Za-z0-9_-]{1,80})$/;

/**
 * The ways a person signs in (FRU-249). `GET /console/me/sign-in` says which providers are linked to
 * their account; `DELETE /console/me/sign-in/<provider>` takes one away. `POST /console/auth/link/<provider>`
 * starts a link, by a navigation (a form), for the reason of `START_PATH` (FRU-415: a `POST`, no
 * longer a `GET`). `/console/me/sign-in/pending` reads, confirms or cancels the link that came back.
 */
export const SIGN_IN_PATH = '/console/me/sign-in';
const SIGN_IN_ONE = /^\/console\/me\/sign-in\/(github|google)$/;
export const PENDING_LINK_PATH = '/console/me/sign-in/pending';
/** The way back from a provider, served by better-auth. */
const CALLBACK_PATH = new RegExp(`^${AUTH_BASE_PATH}/callback/(github|google)$`);
/** The names of the providers in the alert of a link. */
const PROVIDER_NAMES: Record<string, string> = { github: 'GitHub', google: 'Google' };
const LINK_PATH = new RegExp(`^${AUTH_BASE_PATH}/link/(github|google)$`);
/** The providers a person links and unlinks. The link of the e-mail is not one: it has no row. */
const LINKABLE = ['github', 'google'] as const;
/** A workspace id, as the console puts it in the address of « My account ». */
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** Whether this path is one that `handleAuthRoutes` answers. */
export function isAuthRoute(pathname: string): boolean {
  return (
    pathname.startsWith(`${AUTH_BASE_PATH}/`) ||
    pathname === SESSIONS_PATH ||
    SESSION_PATH.test(pathname) ||
    pathname === SIGN_IN_PATH ||
    pathname === PENDING_LINK_PATH ||
    SIGN_IN_ONE.test(pathname)
  );
}

/** A token of better-auth: 32 letters (1.7.7). Bounded, so a body cannot make the worker digest a megabyte. */
const LINK_TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

async function readBody(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await request.text());

    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a request that carries the cookie of a session may change something.
 *
 * `SameSite=Strict` does not keep out a page of the same site, and `demo.fruitback.com` is one. So a
 * call that is not a read must come from the console: its `Origin`, and no request without one. A
 * browser sends `Origin` on every `POST` and `DELETE`, and a form of another page sends its own.
 */
export function mutationAllowed(request: Request, consoleUrl: string): boolean {
  if (SAFE_METHODS.has(request.method)) return true;

  return request.headers.get('Origin') === new URL(consoleUrl).origin;
}

/**
 * The headers better-auth is given for a request: the ones the caller sent, and the address the
 * worker read, in `CLIENT_IP_HEADER`, over whatever the caller wrote there. Off, the header is taken
 * out and better-auth reads no address.
 */
export function headersFor(request: Request, context: Pick<AuthRouteContext, 'clientIp' | 'trackIp'>): Headers {
  const headers = new Headers(request.headers);
  headers.delete(CLIENT_IP_HEADER);
  if (context.trackIp) headers.set(CLIENT_IP_HEADER, context.clientIp);

  return headers;
}

/**
 * better-auth did not answer: a schema that is not the one it expects, a database that is down. The
 * caller answers `502 auth-unavailable`, with the headers of CORS, and writes the reason in its log.
 */
export class AuthUnavailable extends Error {}

/**
 * The `Set-Cookie` that renews the cookie of a session, for the request whose reading renewed the
 * session (FRU-208). Kept beside the request and not handed back by `sessionOfCookie`: three routes
 * read a session, each with several answers, and `handleRequest` adds it to whichever one leaves.
 */
const renewals = new WeakMap<Request, string[]>();

/** The cookie of a session of better-auth in a `Set-Cookie`, with or without the `__Secure-` prefix. */
const SESSION_SET_COOKIE = /^(?:__Secure-)?fruitback\.session_token=[^;]+;/;

/**
 * The answer, with the cookie of the session renewed when the reading of this request renewed the
 * session (FRU-208).
 *
 * better-auth moves the end of a session that was last renewed more than `SESSION_RENEWAL_SECONDS`
 * ago, and sets the cookie again with a new `Max-Age` (read in `api/routes/session.mjs` of 1.7.7, and
 * measured). A call in the process answers the session and drops that header: the row lived on and
 * the cookie of the browser ended 7 days after the sign-in, whatever the person did.
 */
export function withRenewedCookie(request: Request, answer: Response): Response {
  const cookies = renewals.get(request);
  if (cookies === undefined) return answer;
  const headers = new Headers(answer.headers);
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);

  return new Response(answer.body, { status: answer.status, statusText: answer.statusText, headers });
}

/**
 * The person and the session of the cookie of this request, or `undefined`.
 *
 * better-auth reads the session in the database at each call, through the layer of `auth-at-rest.ts`:
 * a session that was ended is refused at the next call. A session of a suspended account is refused
 * too (FRU-281): better-auth reads `banned` with the session, and checks nothing with it.
 *
 * WARNING: every route of the worker that reads the cookie reads it here. A guard test holds it.
 */
export async function sessionOfCookie(
  auth: Auth | Promise<Auth>,
  request: Request,
): Promise<{ userId: string; sessionId: string } | undefined> {
  // No cookie of a session, no call: a request that names nobody reads no database here.
  if (!(request.headers.get('Cookie') ?? '').includes('fruitback.session_token=')) return undefined;
  type Found = { user?: { id?: unknown; banned?: unknown }; session?: { id?: unknown } } | null;
  let read: { headers?: Headers; response?: Found } | null;
  try {
    // `returnHeaders`: the headers better-auth would set on its own route, beside what it answers.
    read = (await (await auth).api.getSession({ headers: request.headers, returnHeaders: true })) as typeof read;
  } catch (error) {
    throw new AuthUnavailable(error instanceof Error ? error.message : String(error), { cause: error });
  }
  const userId = read?.response?.user?.id;
  const sessionId = read?.response?.session?.id;
  if (typeof userId !== 'string' || typeof sessionId !== 'string') return undefined;
  if (read?.response?.user?.banned === true) return undefined;
  // Only the cookie of the session, and only for a session that is there: nothing else better-auth
  // sets on a reading goes to the browser by this way.
  const renewed = (read?.headers?.getSetCookie() ?? []).filter((each) => SESSION_SET_COOKIE.test(each));
  if (renewed.length > 0) renewals.set(request, renewed);

  return { userId, sessionId };
}

/** The answer of better-auth with the headers of CORS of the console added: it sets none. */
function withHeaders(answer: Response, headers: Record<string, string>): Response {
  const merged = new Headers(answer.headers);
  for (const [name, value] of Object.entries(headers)) merged.set(name, value);

  return new Response(answer.body, { status: answer.status, statusText: answer.statusText, headers: merged });
}

/** The page of the console that says why a sign-in failed, with the code of better-auth. */
function failed(consoleUrl: string, code: string): Response {
  const back = new URL('/setup', consoleUrl);
  back.searchParams.set('error', code);

  return new Response(null, { status: 302, headers: { Location: back.href, 'Cache-Control': 'no-store' } });
}

async function startWithProvider(request: Request, provider: string, context: AuthRouteContext): Promise<Response> {
  if (request.method !== 'GET') return json(405, { error: 'method-not-allowed' }, {});
  // FRU-211: a page of another site does not start a sign-in. This route calls better-auth in the
  // process, so the check better-auth makes on its own route does not run. The person lands on the
  // sign-in screen of the console, and starts from there if they want to. A browser that sends no
  // `Sec-Fetch-Site` is served as before: the header cannot be asked of a browser that has none.
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site')
    return failed(context.consoleUrl, 'started_from_another_site');
  const auth = await context.auth;
  const consoleOrigin = new URL(context.consoleUrl).origin;
  // A provider that this worker does not have: the console says so. Read in the options, and not in
  // a failure of the call: a database that is down is not a provider that is not set up.
  const configured = (auth.options.socialProviders ?? {}) as Record<string, unknown>;
  if (!Object.hasOwn(configured, provider)) return failed(context.consoleUrl, 'oauth_provider_not_found');

  // A rejection goes up: the caller answers `502`, and writes the reason in the log.
  const answer = await (auth.api as unknown as { signInSocial(input: object): Promise<Response> }).signInSocial({
    body: { provider, callbackURL: `${consoleOrigin}/`, errorCallbackURL: `${consoleOrigin}/setup` },
    headers: headersFor(request, context),
    asResponse: true,
  });
  const body = answer.ok ? ((await answer.json()) as { url?: unknown }) : undefined;
  if (typeof body?.url !== 'string') {
    // better-auth refused, and said why in its own log line. The person is told that it did not finish.
    console.error(`[fruitback] better-auth answered ${answer.status} to the start of a sign-in with ${provider}`);

    return failed(context.consoleUrl, 'internal_server_error');
  }

  const headers = new Headers({ Location: body.url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  for (const cookie of answer.headers.getSetCookie()) headers.append('Set-Cookie', cookie);

  return new Response(null, { status: 302, headers });
}

async function sendLink(
  request: Request,
  context: AuthRouteContext,
  headers: Record<string, string>,
): Promise<Response> {
  if (context.mailer === undefined) return json(404, { error: 'not-found' }, headers);
  if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);

  const body = await readBody(request);
  const email = typeof body?.email === 'string' ? normalizeEmail(body.email) : undefined;
  if (email === undefined) return json(400, { error: 'invalid-email' }, headers);
  // FRU-450: another address of an account, which something proved, opens that account. better-auth
  // knows one address of an account, so the link is the one of its primary address, and goes here.
  const owner = await context.accounts.ownerOfAddress(email);
  const holder = owner === undefined ? undefined : await context.accounts.account(owner);
  const signsIn = holder?.email ?? email;
  // The words of the message, never the link (FRU-119).
  const locale =
    holder?.locale ??
    (await context.accounts.localeOf(email)) ??
    readLocaleTag(body?.locale) ??
    readLocaleTag(request.headers.get('Accept-Language')?.split(',')[0]?.split(';')[0]) ??
    'en';

  // Three links to one mailbox in the window: the address without its `+suffix` (FRU-209).
  const sent = await context.kv.incr(`fruitback:mail:${mailboxOf(email)}`, EMAIL_LINK_WINDOW_MS);
  if (sent > EMAIL_LINKS_PER_WINDOW) return json(429, { error: 'too-many-links' }, headers);

  const mailer = context.mailer;
  try {
    await sendLinkThrough(await context.auth, signsIn, headersFor(request, context), async (token) => {
      // The token is after the `#`: a fragment is never sent to a server, so no proxy logs it.
      const link = `${new URL(context.consoleUrl).origin}/sign-in#${token}`;
      await mailer.send(signInMessage(email, link, MAGIC_LINK_TTL_SECONDS / 60, locale));
    });
  } catch (error) {
    if (error instanceof MailError) {
      console.error(`[fruitback] ${error.message}`);

      return json(502, { error: 'mail-unavailable' }, headers);
    }
    throw error;
  }

  // The same answer whether the address has an account or not: a caller must not learn who signed up.
  return json(202, { sent: true }, headers);
}

/**
 * Whether better-auth refused this sign-in with `code`. 1.7.7 puts the code in the `error` of the
 * redirect. An answer in JSON carries it as `code`: both are read, so a refusal never reads as a link
 * that is spent.
 */
async function refusedWith(answer: Response, code: string): Promise<boolean> {
  const location = answer.headers.get('Location');
  if (location !== null) return new URL(location, 'http://unused.invalid').searchParams.get('error') === code;
  try {
    return ((await answer.clone().json()) as { code?: unknown } | null)?.code === code;
  } catch {
    return false;
  }
}

/** Whether better-auth refused to create the account of this sign-in: see `sign-up.ts`. */
export function refusedSignUp(answer: Response): Promise<boolean> {
  return refusedWith(answer, INVITATION_REQUIRED);
}

async function redeemLink(
  request: Request,
  context: AuthRouteContext,
  headers: Record<string, string>,
): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
  // The console only. Another page that spends a link of its own in this browser signs the person in
  // to the account of that page (a login CSRF): `consoleCors` refuses another origin, and this
  // refuses a request with none.
  if (!mutationAllowed(request, context.consoleUrl)) return json(403, { error: 'origin-not-allowed' }, headers);
  const body = await readBody(request);
  const token = typeof body?.token === 'string' ? body.token.trim() : '';
  if (!LINK_TOKEN.test(token)) return json(400, { error: 'invalid-code' }, headers);

  // FRU-221. A link that the operator made for an administrator is checked again here: an instance
  // that got an owner since, or a link that another one replaced, is refused as a link that is
  // spent. A `Kv` that does not answer rejects, and nothing is spent: see `adminLinkAt`.
  const links = { kv: context.kv, owners: () => context.accounts.owners() };
  const made = await adminLinkAt(links, token);
  if (made.is === 'refuse') {
    await endAdminLink(context.kv, token);
    console.warn(`[fruitback] a sign-in link made for an administrator was refused: ${made.why}`);

    return json(401, { error: 'link-spent-or-expired' }, headers);
  }

  const auth = await context.auth;
  // No `callbackURL`: better-auth then answers JSON and does not redirect. A link that is spent or
  // that never was answers a redirect to an error, which is read as a refusal.
  const verify = () =>
    (auth.api as unknown as { magicLinkVerify(input: object): Promise<Response> }).magicLinkVerify({
      query: { token },
      headers: headersFor(request, context),
      asResponse: true,
    });
  // FRU-278: the link of an operator creates the account of its address, whoever may sign up.
  const answer = made.is === 'spend' ? await asOperatorLink(made.email, verify) : await verify();
  if (answer.status !== 200) {
    // The link is spent: better-auth spends it before it looks for the account.
    if (await refusedSignUp(answer)) return json(403, { error: 'invitation-required' }, headers);
    // FRU-281: the hook of a new session refuses a suspended account. The person who holds the link
    // learns why, because the link went to the mailbox of the account.
    if (await refusedWith(answer, ACCOUNT_SUSPENDED)) return json(403, { error: 'account-suspended' }, headers);

    return json(401, { error: 'link-spent-or-expired' }, headers);
  }

  const opened = (await answer.json()) as { user?: { id?: unknown } };
  const id = typeof opened.user?.id === 'string' ? opened.user.id : undefined;
  const account = id === undefined ? undefined : await context.accounts.account(id);
  if (account === undefined) return json(401, { error: 'link-spent-or-expired' }, headers);
  if (made.is === 'spend') {
    await endAdminLink(context.kv, token);
    // Who, and never the link: an operator who did not open it reads here that somebody did.
    console.log(
      `[fruitback] the sign-in link made for ${made.email} was used: that person is signed in to the console`,
    );
  }

  // The language of the browser that opened the link, kept if the account has none yet.
  const locale = readLocaleTag(body?.locale);
  if (account.locale === undefined && locale !== undefined) await context.accounts.setLocale(account.id, locale);
  const cookies = answer.headers.getSetCookie();
  const out = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  for (const cookie of cookies) out.append('Set-Cookie', cookie);

  // The account, and not the answer of better-auth: that one holds the token of the session.
  return new Response(
    JSON.stringify({ account: { ...account, ...(account.locale === undefined && locale ? { locale } : {}) } }),
    { status: 200, headers: out },
  );
}

type SessionRow = {
  id: string;
  createdAt: Date | string;
  expiresAt: Date | string;
  updatedAt: Date | string;
  userAgent?: string | null;
  ipAddress?: string | null;
  browser?: string | null;
};

/** The adapter of better-auth, the one with the layer of `auth-at-rest.ts` in front of it. */
type SessionAdapter = {
  findMany(input: { model: 'session'; where: { field: string; value: string }[] }): Promise<SessionRow[]>;
  delete(input: { model: 'session'; where: { field: string; value: string }[] }): Promise<void>;
};

async function sessions(
  request: Request,
  pathname: string,
  context: AuthRouteContext,
  headers: Record<string, string>,
): Promise<Response> {
  const auth = await context.auth;
  const mine = await sessionOfCookie(auth, request);
  if (mine === undefined) return json(401, { error: 'identity-required' }, headers);
  if (!mutationAllowed(request, context.consoleUrl)) return json(403, { error: 'origin-not-allowed' }, headers);
  const adapter = (await auth.$context).adapter as unknown as SessionAdapter;
  const instant = (value: Date | string): string => new Date(value).toISOString();

  if (pathname === SESSIONS_PATH) {
    if (request.method !== 'GET') return json(405, { error: 'method-not-allowed' }, headers);
    const rows = await adapter.findMany({ model: 'session', where: [{ field: 'userId', value: mine.userId }] });
    const now = Date.now();

    return json(
      200,
      {
        sessions: rows
          .filter((row) => new Date(row.expiresAt).getTime() > now)
          .map((row) => ({
            id: row.id,
            createdAt: instant(row.createdAt),
            lastUsedAt: instant(row.updatedAt),
            expiresAt: instant(row.expiresAt),
            // The short label (FRU-249). A session opened before it has none.
            browser: row.browser ?? UNKNOWN_BROWSER,
            ...(row.userAgent ? { userAgent: row.userAgent } : {}),
            ...(row.ipAddress ? { ipAddress: row.ipAddress } : {}),
            current: row.id === mine.sessionId,
          })),
      },
      headers,
    );
  }

  if (request.method !== 'DELETE') return json(405, { error: 'method-not-allowed' }, headers);
  const id = SESSION_PATH.exec(pathname)?.[1] ?? '';
  // Of this person only: an id of another one answers as an id that does not exist.
  const where = [
    { field: 'id', value: id },
    { field: 'userId', value: mine.userId },
  ];
  const found = await adapter.findMany({ model: 'session', where });
  if (found.length === 0) return json(404, { error: 'not-found' }, headers);
  await adapter.delete({ model: 'session', where });
  // The session of this cookie is the one that ended: its cookie is not renewed (FRU-208).
  if (id === mine.sessionId) renewals.delete(request);

  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store', ...headers } });
}

/** The rows of `account` of a person, through the adapter of better-auth: which providers they linked. */
type AccountAdapter = {
  findMany(input: {
    model: 'account';
    where: { field: string; value: string }[];
  }): Promise<{ id: string; providerId: string }[]>;
};

/**
 * One change of the ways to sign in at a time for a person, in this process (FRU-249). Two unlinks
 * at the same moment each counted the other provider as left, and took both: a person on a worker
 * that sends no e-mail could no longer sign in. Two replicas do not share it, as for `oneAtATime`
 * of `auth-organization.ts`.
 */
const unlinking = new Map<string, Promise<unknown>>();

export async function onePersonAtATime<T>(person: string, run: () => Promise<T>): Promise<T> {
  const before = unlinking.get(person) ?? Promise.resolve();
  const mine = before.then(run, run);
  const settled = mine.catch(() => undefined);
  unlinking.set(person, settled);
  try {
    return await mine;
  } finally {
    if (unlinking.get(person) === settled) unlinking.delete(person);
  }
}

/**
 * `GET /console/me/sign-in` and `DELETE /console/me/sign-in/<provider>` (FRU-249).
 *
 * The list: `email` says whether this worker sends the link of the e-mail, which signs in every
 * account; a provider is there when this worker has it, or when the account has it linked.
 *
 * **A provider goes only when another way to sign in stays**: the link of the e-mail on a worker that
 * sends it, or the other provider, linked and set up on this worker. Otherwise `409 last-sign-in`.
 * better-auth asks for a session opened in the last day (`SESSION_FRESH_SECONDS`): an older one
 * answers `403 sign-in-again`.
 */
async function signInMethods(
  request: Request,
  pathname: string,
  context: AuthRouteContext,
  headers: Record<string, string>,
): Promise<Response> {
  const auth = await context.auth;
  const mine = await sessionOfCookie(auth, request);
  if (mine === undefined) return json(401, { error: 'identity-required' }, headers);
  if (!mutationAllowed(request, context.consoleUrl)) return json(403, { error: 'origin-not-allowed' }, headers);
  const adapter = (await auth.$context).adapter as unknown as AccountAdapter;
  const configured = (auth.options.socialProviders ?? {}) as Record<string, unknown>;
  const rowsOf = () => adapter.findMany({ model: 'account', where: [{ field: 'userId', value: mine.userId }] });

  if (pathname === SIGN_IN_PATH) {
    if (request.method !== 'GET') return json(405, { error: 'method-not-allowed' }, headers);
    const rows = await rowsOf();
    const methods: Record<string, unknown> = { email: context.mailer !== undefined };
    for (const provider of LINKABLE) {
      const linked = rows.some((row) => row.providerId === provider);
      if (linked || Object.hasOwn(configured, provider)) methods[provider] = { linked };
    }

    return json(200, methods, headers);
  }

  if (request.method !== 'DELETE') return json(405, { error: 'method-not-allowed' }, headers);
  const provider = SIGN_IN_ONE.exec(pathname)?.[1] ?? '';

  return onePersonAtATime(mine.userId, async () => {
    const rows = await rowsOf();
    const row = rows.find((each) => each.providerId === provider);
    if (row === undefined) return json(404, { error: 'not-linked' }, headers);
    const another = LINKABLE.some(
      (other) =>
        other !== provider && Object.hasOwn(configured, other) && rows.some((each) => each.providerId === other),
    );
    if (context.mailer === undefined && !another) return json(409, { error: 'last-sign-in' }, headers);
    // FRU-450: the provider takes its address away. The primary address stays proved: when this
    // provider alone proves it, the person chooses another primary address first.
    if (await context.accounts.providerHoldsPrimary(mine.userId, provider)) {
      return json(409, { error: 'primary-address' }, headers);
    }

    const answer = await (auth.api as unknown as { unlinkAccount(input: object): Promise<Response> }).unlinkAccount({
      body: { accountId: row.id },
      headers: headersFor(request, context),
      asResponse: true,
    });
    if (answer.status === 403) return json(403, { error: 'sign-in-again' }, headers);
    if (!answer.ok) throw new AuthUnavailable(`better-auth answered ${answer.status} to an unlink`);
    // The provider is unlinked: its address goes. A failure here does not answer `500` for an unlink
    // that is done; the list of the addresses takes the provider away at its next read.
    try {
      await context.accounts.noteProviderAddress(mine.userId, provider, undefined, Date.now());
    } catch (error) {
      console.error(`[fruitback] the address of ${provider} was not taken away at its unlink: ${String(error)}`);
    }

    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store', ...headers } });
  });
}

/**
 * `POST /console/auth/link/<provider>?workspace=<id>` (FRU-249, FRU-415): starts a link of a provider
 * to the account of the cookie. The console sends it by a form, so the browser navigates and keeps
 * the cookie of the state, as for `START_PATH`. The person comes back to « My account » of that
 * workspace with `?confirm=<provider>` (a link to confirm), `?linked=<provider>` (linked already), or
 * `?provider=<provider>&error=<code>` (FRU-416). `provider` is one of `LINK_PATH`, never a value of
 * the request.
 *
 * **A `GET` starts nothing** (FRU-415): a page of the same site sends the cookie with a navigation,
 * and could start a link. A `POST` must carry the `Origin` of the console, which no other page sends.
 *
 * **The way back writes no row.** `guardLink` of `provider-link.ts` refuses, or keeps the link for the
 * confirmation of `pendingLink`: the address of the provider is known only there.
 */
async function linkProvider(request: Request, provider: string, context: AuthRouteContext): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, {});
  const consoleOrigin = new URL(context.consoleUrl).origin;
  const workspace = new URL(request.url).searchParams.get('workspace') ?? '';
  const page = WORKSPACE_ID.test(workspace) ? `/w/${workspace}/account` : '/';
  const back = (code: string): Response => {
    const to = new URL(page, consoleOrigin);
    to.searchParams.set('provider', provider);
    to.searchParams.set('error', code);

    return new Response(null, { status: 303, headers: { Location: to.href, 'Cache-Control': 'no-store' } });
  };
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site' || !mutationAllowed(request, context.consoleUrl)) {
    return back('started_from_another_site');
  }
  const auth = await context.auth;
  const configured = (auth.options.socialProviders ?? {}) as Record<string, unknown>;
  if (!Object.hasOwn(configured, provider)) return back('oauth_provider_not_found');
  if ((await sessionOfCookie(auth, request)) === undefined) return back('identity_required');

  const answer = await (
    auth.api as unknown as { linkSocialAccount(input: object): Promise<Response> }
  ).linkSocialAccount({
    body: {
      provider,
      callbackURL: `${consoleOrigin}${page}?linked=${provider}`,
      // better-auth adds `&error=<code>` to an address that has a query already.
      errorCallbackURL: `${consoleOrigin}${page}?provider=${provider}`,
      disableRedirect: true,
    },
    headers: headersFor(request, context),
    asResponse: true,
  });
  const body = answer.ok ? ((await answer.json()) as { url?: unknown }) : undefined;
  if (typeof body?.url !== 'string') {
    console.error(`[fruitback] better-auth answered ${answer.status} to the start of a link with ${provider}`);

    return back('internal_server_error');
  }
  // `303`: the browser goes to the provider with a `GET`, after the `POST` of the form.
  const headers = new Headers({ Location: body.url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  for (const cookie of answer.headers.getSetCookie()) headers.append('Set-Cookie', cookie);

  return new Response(null, { status: 303, headers });
}

/**
 * `/console/me/sign-in/pending` (FRU-415): the link that came back from the provider and waits.
 *
 * - `GET` answers `{provider, email}`, for the session that started it, or `404 no-pending-link`.
 * - `POST` confirms it: every condition of `refusalOf` is read again, the row of `account` is written
 *   with the id of the provider account, and an alert goes to the address of the account.
 *   `409 <code>` when a condition no longer holds. The pending link is spent once.
 * - `DELETE` cancels it.
 *
 * Each takes the cookie of the console and its `Origin`, as every change of the ways to sign in.
 */
async function pendingLink(request: Request, context: AuthRouteContext, headers: Record<string, string>) {
  const auth = await context.auth;
  const mine = await sessionOfCookie(auth, request);
  if (mine === undefined) return json(401, { error: 'identity-required' }, headers);
  if (!mutationAllowed(request, context.consoleUrl)) return json(403, { error: 'origin-not-allowed' }, headers);
  const adapter = (await auth.$context).internalAdapter as unknown as LinkAdapter;
  const key = pendingLinkKey(mine.userId);
  const none = () => json(404, { error: 'no-pending-link' }, headers);
  const waiting = async () => {
    const pending = readPending(await adapter.findVerificationValue(key));

    // Another session of the person does not see it: the one that started the link confirms it.
    return pending?.session === mine.sessionId ? pending : undefined;
  };

  if (request.method === 'GET') {
    const pending = await waiting();

    return pending === undefined ? none() : json(200, { provider: pending.provider, email: pending.email }, headers);
  }
  if (request.method === 'DELETE') {
    if ((await waiting()) === undefined) return none();
    await adapter.deleteVerificationByIdentifier(key);

    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store', ...headers } });
  }
  if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);

  return onePersonAtATime(mine.userId, async () => {
    if ((await waiting()) === undefined) return none();
    // Spent once: of two confirmations, one finds it.
    const spent = await adapter.consumeVerificationValue(key);
    const pending = readPending(spent);
    if (spent === null || pending === undefined || pending.session !== mine.sessionId) return none();
    const link = {
      userId: mine.userId,
      providerId: pending.provider,
      accountId: pending.accountId,
      email: pending.email,
    };
    const refusal = await refusalOf(adapter, link, context.accounts);
    if (refusal === 'linked') return json(200, { provider: pending.provider }, headers);
    if (refusal !== undefined) return json(409, { error: refusal }, headers);
    try {
      // The identity is the id of the provider account. No token: there is none to keep.
      await adapter.createAccount({ userId: link.userId, providerId: link.providerId, accountId: link.accountId });
    } catch (error) {
      // `account_providerId_accountId_key`: another account took it in between, on another replica.
      // Read again, so that only that conflict answers `409`.
      const owner = await adapter
        .findAccountByKey({ providerId: link.providerId, accountId: link.accountId })
        .catch(() => null);
      if (owner !== null && owner.userId !== link.userId) return json(409, { error: ACCOUNT_OF_ANOTHER }, headers);
      // Any other failure: the link waits again, for a confirmation that is tried again, and the
      // caller answers `502`.
      await adapter
        .createVerificationValue({ identifier: key, value: spent.value, expiresAt: spent.expiresAt })
        .catch(() => undefined);
      throw new AuthUnavailable(`the link with ${link.providerId} was not written: ${String(error)}`, { cause: error });
    }
    // FRU-450: the address the provider verified is one of the account now.
    try {
      await context.accounts.noteProviderAddress(link.userId, link.providerId, link.email, Date.now());
    } catch (error) {
      console.error(`[fruitback] the address of a link with ${link.providerId} was not kept: ${String(error)}`);
    }
    await alertOfLink(context, mine.userId, pending);

    return json(200, { provider: pending.provider }, headers);
  });
}

/**
 * The alert of a link (FRU-415), to the address of the account, in its language. A worker with no
 * mailer sends none. A failure to send is logged, and does not undo the link: the person confirmed it.
 */
async function alertOfLink(
  context: AuthRouteContext,
  userId: string,
  pending: { provider: string; email: string; workspace?: string },
): Promise<void> {
  const mailer = context.mailer;
  if (mailer === undefined) return;
  // After the write: nothing here may fail the confirmation, which is done.
  try {
    const account = await context.accounts.account(userId);
    if (account === undefined) return;
    const origin = new URL(context.consoleUrl).origin;
    const link = pending.workspace === undefined ? `${origin}/` : `${origin}/w/${pending.workspace}/account`;
    const message = providerLinkedMessage(
      account.email,
      { provider: PROVIDER_NAMES[pending.provider] ?? pending.provider, address: pending.email, link },
      account.locale,
    );
    await mailer.send(message);
  } catch (error) {
    console.error(`[fruitback] the alert of a link with ${pending.provider} was not sent: ${String(error)}`);
  }
}

/**
 * The way back of a link that waits for its confirmation: better-auth writes it as an error of
 * `guardLink`, and the console reads `?confirm=<provider>` in its place.
 */
function confirmInstead(answer: Response): Response {
  const location = answer.headers.get('Location');
  if (location === null) return answer;
  let to: URL;
  try {
    to = new URL(location);
  } catch {
    return answer;
  }
  if (to.searchParams.get('error') !== LINK_NEEDS_CONFIRMATION) return answer;
  const provider = to.searchParams.get('provider') ?? '';
  to.search = '';
  to.searchParams.set('confirm', provider);
  const headers = new Headers(answer.headers);
  headers.set('Location', to.href);

  return new Response(answer.body, { status: answer.status, headers });
}

/**
 * The answer for a path of `isAuthRoute`, or `undefined` for another path.
 *
 * WARNING: better-auth rejects, and does not answer `500`, when the schema of its database is not
 * the one it expects (FRU-144). The caller turns a rejection into `502`.
 */
export async function handleAuthRoutes(
  request: Request,
  pathname: string,
  context: AuthRouteContext,
  headers: Record<string, string>,
): Promise<Response | undefined> {
  if (!isAuthRoute(pathname)) return undefined;
  if (pathname === EMAIL_LINK_PATH) return sendLink(request, context, headers);
  if (pathname === EMAIL_REDEEM_PATH) return redeemLink(request, context, headers);
  // A navigation, and not a call of the console: no header of CORS.
  const started = START_PATH.exec(pathname);
  if (started !== null) return startWithProvider(request, started[1] ?? '', context);
  if (pathname === SESSIONS_PATH || SESSION_PATH.test(pathname)) return sessions(request, pathname, context, headers);
  if (pathname === PENDING_LINK_PATH) return pendingLink(request, context, headers);
  if (pathname === SIGN_IN_PATH || SIGN_IN_ONE.test(pathname))
    return signInMethods(request, pathname, context, headers);
  const linking = LINK_PATH.exec(pathname);
  if (linking !== null) return linkProvider(request, linking[1] ?? '', context);

  const path = pathname.slice(AUTH_BASE_PATH.length);
  if (!Object.hasOwn(SERVED_PATHS, path)) return json(404, { error: 'not-found' }, headers);
  // FRU-212: the rule of the worker's own routes, before better-auth reads the request. better-auth
  // 1.7.7 takes a `Referer` when there is no `Origin` (`origin || referer`, with no option to ask
  // for the `Origin`), and checks nothing for a request with no cookie. Nothing legitimate writes
  // here without the `Origin` of the console: GitHub and Google come back by a `GET`. A provider
  // that comes back by a form (`response_mode=form_post`, Apple) would need its route named here.
  if (!mutationAllowed(request, context.consoleUrl)) return json(403, { error: 'origin-not-allowed' }, headers);

  const forwarded = new Request(request.url, {
    method: request.method,
    headers: headersFor(request, context),
    ...(SAFE_METHODS.has(request.method) ? {} : { body: await request.arrayBuffer() }),
  });

  const answer = await (await context.auth).handler(forwarded);

  return withHeaders(CALLBACK_PATH.test(pathname) ? confirmInstead(answer) : answer, headers);
}
