import { createHash } from 'node:crypto';
import type { AccountStore } from './accounts.ts';
import { normalizeEmail } from './accounts.ts';
import { mintConsoleSession, sessionCookie } from './console-routes.ts';
import type { Kv } from './kv.ts';
import type { SessionStore } from './session.ts';

/**
 * Signing in with GitHub (FRU-97): an OAuth App, the authorization code, `state` and PKCE.
 *
 * **GitHub names the person, never the browser.** The worker asks GitHub for the account's verified
 * addresses with the token GitHub hands it, and uses the primary one. An address GitHub has not
 * verified creates no account and joins none: it would join the account of whoever owns it.
 *
 * Only the identity is asked for (`read:user user:email`). Connecting GitHub as a source of a workspace
 * is a separate consent, with its own rights (FRU-102).
 */

/** `FRUITBACK_GITHUB_OAUTH`: the client id and the client secret of the OAuth App, joined by a colon. */
export type GitHubOAuth = { clientId: string; clientSecret: string };

export function parseGitHubOAuth(value: string): GitHubOAuth | undefined {
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) return undefined;

  return { clientId: value.slice(0, separator).trim(), clientSecret: value.slice(separator + 1).trim() };
}

export const GITHUB_START = '/auth/github';
export const GITHUB_CALLBACK = '/auth/github/callback';

/** Ten minutes to come back from GitHub. A `state` older than that is a page somebody left open. */
const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_COOKIE = 'fruitback_oauth_state';

const AUTHORIZE = 'https://github.com/login/oauth/authorize';
const TOKEN = 'https://github.com/login/oauth/access_token';
const API = 'https://api.github.com';
const CALL_TIMEOUT_MS = 10_000;

export type GitHubContext = {
  oauth: GitHubOAuth;
  /** The worker's public address, which GitHub sends the person back to. */
  publicUrl: string;
  consoleUrl: string;
  accounts: AccountStore;
  sessions: SessionStore;
  kv: Kv;
  secret: string;
  fetcher?: typeof fetch;
  now?: number;
};

function random(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url');
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);

  return new Response(null, { status: 302, headers });
}

/**
 * The cookie that binds the browser that left to the browser that comes back.
 *
 * `SameSite=Lax`, not `Strict`: GitHub sends the person back with a top-level navigation from another
 * site, and a `Strict` cookie is not sent on it. Only on the callback path, and for ten minutes.
 */
function stateCookie(value: string, maxAge: number): string {
  return `${STATE_COOKIE}=${value}; Path=${GITHUB_CALLBACK}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=') || undefined;
  }

  return undefined;
}

/** Back to the console, with a word it can show. The word is ours: nothing from GitHub is echoed. */
function failure(context: GitHubContext, reason: string): Response {
  return redirect(`${context.consoleUrl}/setup?error=${reason}`, [stateCookie('', 0)]);
}

export async function handleGitHub(
  request: Request,
  pathname: string,
  context: GitHubContext,
): Promise<Response | undefined> {
  if (pathname === GITHUB_START) return start(context);
  if (pathname === GITHUB_CALLBACK) return callback(request, context);

  return undefined;
}

async function start(context: GitHubContext): Promise<Response> {
  const state = random(24);
  const verifier = random(48);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  await context.kv.set(`fruitback:oauth:${state}`, verifier, STATE_TTL_MS);

  const url = new URL(AUTHORIZE);
  url.searchParams.set('client_id', context.oauth.clientId);
  url.searchParams.set('redirect_uri', `${context.publicUrl}${GITHUB_CALLBACK}`);
  url.searchParams.set('scope', 'read:user user:email');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('allow_signup', 'true');

  return redirect(url.toString(), [stateCookie(state, STATE_TTL_MS / 1000)]);
}

async function callback(request: Request, context: GitHubContext): Promise<Response> {
  const params = new URL(request.url).searchParams;
  // A person who said no at GitHub comes back with an error and no code.
  if (params.get('error') !== null) return failure(context, 'github-declined');

  const state = params.get('state');
  const code = params.get('code');
  if (state === null || code === null) return failure(context, 'github-failed');

  // The state must be the one this browser left with, and one this worker issued: the first stops a
  // link that signs somebody into the attacker's account, the second a state nobody minted.
  if (readCookie(request, STATE_COOKIE) !== state) return failure(context, 'github-failed');
  const key = `fruitback:oauth:${state}`;
  const verifier = await context.kv.get(key);
  if (verifier === undefined) return failure(context, 'github-failed');
  // Spent once: the Kv has no delete, and an expired entry is what a spent one reads as.
  await context.kv.set(key, '', 1);
  if (verifier === '') return failure(context, 'github-failed');

  const fetcher = context.fetcher ?? fetch;
  const identity = await identify(fetcher, context, code, verifier).catch(() => undefined);
  if (identity === undefined) return failure(context, 'github-failed');
  if (identity.email === undefined) return failure(context, 'github-unverified');

  const account = await context.accounts.signIn({
    provider: 'github',
    subject: identity.id,
    email: identity.email,
    ...(identity.name === undefined ? {} : { name: identity.name }),
  });
  const session = await mintConsoleSession(context, account, context.now ?? Date.now());

  return redirect(`${context.consoleUrl}/`, [sessionCookie(session.refreshToken), stateCookie('', 0)]);
}

type Identity = { id: string; name?: string; email?: string };

async function identify(
  fetcher: typeof fetch,
  context: GitHubContext,
  code: string,
  verifier: string,
): Promise<Identity> {
  const exchanged = await fetcher(TOKEN, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: context.oauth.clientId,
      client_secret: context.oauth.clientSecret,
      code,
      redirect_uri: `${context.publicUrl}${GITHUB_CALLBACK}`,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const token = ((await exchanged.json()) as { access_token?: unknown }).access_token;
  if (!exchanged.ok || typeof token !== 'string' || token === '') throw new Error('no token');

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'fruitback',
  };
  const [user, emails] = await Promise.all([
    fetcher(`${API}/user`, { headers, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) }),
    fetcher(`${API}/user/emails`, { headers, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) }),
  ]);
  if (!user.ok || !emails.ok) throw new Error('no identity');

  const profile = (await user.json()) as { id?: unknown; name?: unknown; login?: unknown };
  if (typeof profile.id !== 'number' && typeof profile.id !== 'string') throw new Error('no id');
  const list = (await emails.json()) as { email?: unknown; primary?: unknown; verified?: unknown }[];
  const primary = Array.isArray(list)
    ? list.find((entry) => entry.primary === true && entry.verified === true)
    : undefined;
  const email = typeof primary?.email === 'string' ? normalizeEmail(primary.email) : undefined;
  const name = typeof profile.name === 'string' && profile.name !== '' ? profile.name : undefined;

  return { id: String(profile.id), ...(name === undefined ? {} : { name }), ...(email === undefined ? {} : { email }) };
}
