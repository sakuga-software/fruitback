import type { AccountStore } from './accounts.ts';
import { normalizeEmail } from './accounts.ts';
import type { WorkerConfig } from './env.ts';
import type { Kv } from './kv.ts';
import { MailError, type Mailer, signInMessage } from './mail.ts';
import {
  ACCESS_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
  type SessionStore,
  createPairing,
  digest,
  redeemPairing,
  refreshSession,
  revokeSession,
} from './session.ts';

/**
 * Signing in to the console, and keeping the console signed in (FRU-98).
 *
 * **A sign-in ends in a pairing code, like every other session.** The link proves an address; the
 * worker then mints a code for the account and spends it at once. The console holds what the
 * extension holds: a short access token, and a refresh token that rotates.
 *
 * **The refresh token is a cookie the console's script cannot read.** `HttpOnly`, `Secure`,
 * `SameSite=Strict`, on the paths of the console session only. A script injected into the console can
 * use the session while the page is open, and cannot carry the refresh token away. The access token
 * lives in the page's memory.
 */

/** A link is opened within minutes or not at all. Longer, and an old mailbox is a way in. */
export const EMAIL_LINK_TTL_SECONDS = 15 * 60;

/** Links per address, per window: enough for a lost one, too few to fill someone's mailbox. */
export const EMAIL_LINKS_PER_WINDOW = 3;
export const EMAIL_LINK_WINDOW_MS = 15 * 60 * 1000;

const COOKIE = 'fruitback_console';
const COOKIE_PATH = '/console/session';

/** 256 bits, base64url. It travels in a URL fragment and is never typed. */
function newLinkCode(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}

export type ConsoleContext = {
  accounts: AccountStore;
  sessions: SessionStore;
  mailer: Mailer | undefined;
  kv: Kv;
  secret: string;
  now?: number;
};

/** The console's origin, the one origin these routes answer with credentials. */
export function consoleOrigin(config: WorkerConfig): string | undefined {
  return config.consoleUrl === undefined ? undefined : new URL(config.consoleUrl).origin;
}

/**
 * CORS for the console routes: the console's origin and no other, with credentials.
 *
 * A request with no `Origin` is not a browser, so there is no cookie it could have carried by
 * accident; it is answered like any other caller of this worker.
 */
export function consoleCors(
  request: Request,
  config: WorkerConfig,
): { allowed: boolean; headers: Record<string, string> } {
  const origin = request.headers.get('Origin');
  if (origin === null) return { allowed: true, headers: {} };
  if (origin !== consoleOrigin(config)) return { allowed: false, headers: {} };

  return {
    allowed: true,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      Vary: 'Origin',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  };
}

export function isConsoleRoute(pathname: string): boolean {
  return pathname.startsWith('/auth/') || pathname.startsWith('/console/');
}

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

function sessionCookie(token: string): string {
  return `${COOKIE}=${token}; Path=${COOKIE_PATH}; Max-Age=${REFRESH_TTL_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

function clearedCookie(): string {
  return `${COOKIE}=; Path=${COOKIE_PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

/** The refresh token in the request's cookie, or `undefined`. */
export function readSessionCookie(request: Request): string | undefined {
  const header = request.headers.get('Cookie');
  if (header === null) return undefined;

  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) {
      const value = rest.join('=');

      return value === '' ? undefined : value;
    }
  }

  return undefined;
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
 * The routes of the console session, or `undefined` for a path that is not one of them.
 *
 * `/auth/email` answers the same whether the address has an account or not: a caller must not learn
 * who signed up. It is limited per address on top of the limit per IP every route has.
 */
export async function handleConsoleSession(
  request: Request,
  pathname: string,
  config: WorkerConfig,
  context: ConsoleContext,
  headers: Record<string, string>,
): Promise<Response | undefined> {
  const now = context.now ?? Date.now();

  if (pathname === '/auth/email') {
    if (context.mailer === undefined || config.consoleUrl === undefined)
      return json(404, { error: 'not-found' }, headers);
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);

    const body = await readBody(request);
    const email = typeof body?.email === 'string' ? normalizeEmail(body.email) : undefined;
    if (email === undefined) return json(400, { error: 'invalid-email' }, headers);

    const sent = await context.kv.incr(`fruitback:mail:${email}`, EMAIL_LINK_WINDOW_MS);
    if (sent > EMAIL_LINKS_PER_WINDOW) return json(429, { error: 'too-many-links' }, headers);

    const code = newLinkCode();
    await context.accounts.createEmailLink({
      codeHash: await digest(code),
      email,
      expiresAt: now + EMAIL_LINK_TTL_SECONDS * 1000,
    });

    // The code is after the `#`: a fragment is never sent to a server, so no proxy logs it.
    const link = `${config.consoleUrl}/sign-in#${code}`;
    try {
      await context.mailer.send(signInMessage(email, link, EMAIL_LINK_TTL_SECONDS / 60));
    } catch (error) {
      if (error instanceof MailError) {
        console.error(`[fruitback] ${error.message}`);

        return json(502, { error: 'mail-unavailable' }, headers);
      }
      throw error;
    }

    return json(202, { sent: true }, headers);
  }

  if (pathname === '/auth/email/redeem') {
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);

    const body = await readBody(request);
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    if (code === '') return json(400, { error: 'invalid-code' }, headers);

    const email = await context.accounts.spendEmailLink(await digest(code), now);
    if (email === undefined) return json(401, { error: 'link-spent-or-expired' }, headers);

    const account = await context.accounts.signIn({ provider: 'email', subject: email, email });

    return openConsoleSession(context, account, headers, now);
  }

  if (pathname === '/console/session/refresh') {
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);

    const token = readSessionCookie(request);
    if (token === undefined) return json(401, { error: 'session-revoked-or-expired' }, headers);

    const refreshed = await refreshSession(context.sessions, token, context.secret, now);
    if (!refreshed.ok) {
      return json(401, { error: refreshed.reason }, { ...headers, 'Set-Cookie': clearedCookie() });
    }

    return json(
      200,
      { accessToken: refreshed.accessToken, expiresIn: refreshed.expiresIn },
      { ...headers, 'Set-Cookie': sessionCookie(refreshed.refreshToken) },
    );
  }

  if (pathname === '/console/session/logout') {
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);

    const token = readSessionCookie(request);
    if (token !== undefined) await revokeSession(context.sessions, token, now);

    return new Response(null, { status: 204, headers: { ...headers, 'Set-Cookie': clearedCookie() } });
  }

  return undefined;
}

/**
 * A session for an account, opened by a code the worker mints and spends itself.
 *
 * The session names no workspace. A console session reads the account's own data through the console
 * routes, which check the role on every call, and reads no site: the `ws` check refuses it there.
 */
export async function openConsoleSession(
  context: ConsoleContext,
  account: { id: string; email: string; name?: string },
  headers: Record<string, string>,
  now: number,
): Promise<Response> {
  const { code } = await createPairing(
    context.sessions,
    { subject: account.id, email: account.email, ...(account.name === undefined ? {} : { name: account.name }) },
    now,
  );
  const redeemed = await redeemPairing(context.sessions, code, context.secret, now);
  if (!redeemed.ok) throw new Error('A code minted a moment ago could not be spent');

  return json(
    200,
    { accessToken: redeemed.session.accessToken, expiresIn: ACCESS_TTL_SECONDS, account },
    { ...headers, 'Set-Cookie': sessionCookie(redeemed.session.refreshToken) },
  );
}
