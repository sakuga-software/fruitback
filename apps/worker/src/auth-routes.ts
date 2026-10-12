import { type AccountStore, mailboxOf, normalizeEmail, readLocaleTag } from './accounts.ts';
import {
  AUTH_BASE_PATH,
  type Auth,
  CLIENT_IP_HEADER,
  MAGIC_LINK_TTL_SECONDS,
  SERVED_PATHS,
  sendLinkThrough,
} from './auth.ts';
import { EMAIL_LINKS_PER_WINDOW, EMAIL_LINK_WINDOW_MS } from './console-routes.ts';
import type { Kv } from './kv.ts';
import { MailError, type Mailer, signInMessage } from './mail.ts';

/**
 * The console signs in with better-auth (FRU-147), beside the path of before (`console-routes.ts`).
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
};

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

/** Whether this path is one that `handleAuthRoutes` answers. */
export function isAuthRoute(pathname: string): boolean {
  return pathname.startsWith(`${AUTH_BASE_PATH}/`) || pathname === SESSIONS_PATH || SESSION_PATH.test(pathname);
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
 * The person and the session of the cookie of this request, or `undefined`.
 *
 * better-auth reads the session in the database at each call, through the layer of `auth-at-rest.ts`:
 * a session that was ended is refused at the next call.
 */
export async function sessionOfCookie(
  auth: Auth | Promise<Auth>,
  request: Request,
): Promise<{ userId: string; sessionId: string } | undefined> {
  // No cookie of a session, no call: a request of the path of before reads no database here.
  if (!(request.headers.get('Cookie') ?? '').includes('fruitback.session_token=')) return undefined;
  let found: { user?: { id?: unknown }; session?: { id?: unknown } } | null;
  try {
    found = (await (await auth).api.getSession({ headers: request.headers })) as typeof found;
  } catch (error) {
    throw new AuthUnavailable(error instanceof Error ? error.message : String(error), { cause: error });
  }
  const userId = found?.user?.id;
  const sessionId = found?.session?.id;

  return typeof userId === 'string' && typeof sessionId === 'string' ? { userId, sessionId } : undefined;
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
  // The words of the message, never the link (FRU-119), as on the path of before.
  const locale =
    (await context.accounts.localeOf(email)) ??
    readLocaleTag(body?.locale) ??
    readLocaleTag(request.headers.get('Accept-Language')?.split(',')[0]?.split(';')[0]) ??
    'en';

  // The same key as the path of before: the two paths together send three links in the window.
  const sent = await context.kv.incr(`fruitback:mail:${mailboxOf(email)}`, EMAIL_LINK_WINDOW_MS);
  if (sent > EMAIL_LINKS_PER_WINDOW) return json(429, { error: 'too-many-links' }, headers);

  const mailer = context.mailer;
  try {
    await sendLinkThrough(await context.auth, email, headersFor(request, context), async (token) => {
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

  const auth = await context.auth;
  // No `callbackURL`: better-auth then answers JSON and does not redirect. A link that is spent or
  // that never was answers a redirect to an error, which is read as a refusal.
  const answer = (await (auth.api as unknown as { magicLinkVerify(input: object): Promise<Response> }).magicLinkVerify({
    query: { token },
    headers: headersFor(request, context),
    asResponse: true,
  })) as Response;
  if (answer.status !== 200) return json(401, { error: 'link-spent-or-expired' }, headers);

  const opened = (await answer.json()) as { user?: { id?: unknown } };
  const id = typeof opened.user?.id === 'string' ? opened.user.id : undefined;
  const account = id === undefined ? undefined : await context.accounts.account(id);
  if (account === undefined) return json(401, { error: 'link-spent-or-expired' }, headers);

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

  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store', ...headers } });
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

  const path = pathname.slice(AUTH_BASE_PATH.length);
  if (!Object.hasOwn(SERVED_PATHS, path)) return json(404, { error: 'not-found' }, headers);

  const forwarded = new Request(request.url, {
    method: request.method,
    headers: headersFor(request, context),
    ...(SAFE_METHODS.has(request.method) ? {} : { body: await request.arrayBuffer() }),
  });

  return withHeaders(await (await context.auth).handler(forwarded), headers);
}
