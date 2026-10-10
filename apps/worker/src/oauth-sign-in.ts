import { createHash } from 'node:crypto';
import type { AccountStore, Provider } from './accounts.ts';
import { mintConsoleSession, sessionCookie } from './console-routes.ts';
import type { Kv } from './kv.ts';
import type { SessionStore } from './session.ts';

/**
 * Signing in with a provider (FRU-97, FRU-135): the authorization code, `state` and PKCE.
 *
 * **The provider names the person, never the browser.** Each provider says here how to ask it who
 * the person is, and answers an address only when it verified that address. An address a provider
 * did not verify creates no account and joins none: it would join the account of whoever owns it.
 *
 * The steps are the same for every provider, so they are here once. A provider is its addresses, the
 * scope it is asked, and `identify`.
 */

/** `<client id>:<client secret>` of an OAuth application, as a variable of the environment gives it. */
export type OAuthClient = { clientId: string; clientSecret: string };

export function parseOAuthClient(value: string): OAuthClient | undefined {
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) return undefined;

  return { clientId: value.slice(0, separator).trim(), clientSecret: value.slice(separator + 1).trim() };
}

/** Who the provider says the person is. `email` is absent when the provider verified no address. */
export type Identity = { id: string; name?: string; email?: string };

export type Exchange = { client: OAuthClient; redirectUri: string; code: string; verifier: string };

export type SignInProvider = {
  /** The name the accounts keep, and the first word of what the console is told on a failure. */
  name: Extract<Provider, 'github' | 'google'>;
  start: string;
  callback: string;
  authorize: string;
  /** What the authorize address takes beside the client, the callback, the state and the challenge. */
  params: Readonly<Record<string, string>>;
  /** Exchanges the code and asks the provider who this is. It throws when the provider does not say. */
  identify(fetcher: typeof fetch, exchange: Exchange): Promise<Identity>;
};

/** The route that says which providers this worker has. It answers booleans, and no client id. */
export const SIGN_IN_PROVIDERS = '/auth/providers';

/** Ten minutes to come back from the provider. A `state` older than that is a page somebody left open. */
const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_COOKIE = 'fruitback_oauth_state';
export const PROVIDER_CALL_TIMEOUT_MS = 10_000;

export type SignInContext = {
  oauth: OAuthClient;
  /** The worker's public address, which the provider sends the person back to. */
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
 * `SameSite=Lax`, not `Strict`: the provider sends the person back with a top-level navigation from
 * another site, and a `Strict` cookie is not sent on it. Only on the callback path of this provider,
 * and for ten minutes.
 */
function stateCookie(provider: SignInProvider, value: string, maxAge: number): string {
  return `${STATE_COOKIE}=${value}; Path=${provider.callback}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=') || undefined;
  }

  return undefined;
}

/** Back to the console, with a word it can show. The word is ours: nothing from the provider is echoed. */
function failure(provider: SignInProvider, context: SignInContext, reason: string): Response {
  return redirect(`${context.consoleUrl}/setup?error=${provider.name}-${reason}`, [stateCookie(provider, '', 0)]);
}

export async function handleSignIn(
  request: Request,
  pathname: string,
  provider: SignInProvider,
  context: SignInContext,
): Promise<Response | undefined> {
  if (pathname === provider.start) return start(provider, context);
  if (pathname === provider.callback) return callback(request, provider, context);

  return undefined;
}

async function start(provider: SignInProvider, context: SignInContext): Promise<Response> {
  const state = random(24);
  const verifier = random(48);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  // The provider is in the key: a state of one provider must not finish the flow of another.
  await context.kv.set(`fruitback:oauth:${provider.name}:${state}`, verifier, STATE_TTL_MS);

  const url = new URL(provider.authorize);
  url.searchParams.set('client_id', context.oauth.clientId);
  url.searchParams.set('redirect_uri', `${context.publicUrl}${provider.callback}`);
  for (const [name, value] of Object.entries(provider.params)) url.searchParams.set(name, value);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');

  return redirect(url.toString(), [stateCookie(provider, state, STATE_TTL_MS / 1000)]);
}

async function callback(request: Request, provider: SignInProvider, context: SignInContext): Promise<Response> {
  const params = new URL(request.url).searchParams;
  // A person who said no at the provider comes back with an error and no code.
  if (params.get('error') !== null) return failure(provider, context, 'declined');

  const state = params.get('state');
  const code = params.get('code');
  if (state === null || code === null) return failure(provider, context, 'failed');

  // The state must be the one this browser left with, and one this worker issued: the first stops a
  // link that signs somebody into the attacker's account, the second a state nobody minted.
  if (readCookie(request, STATE_COOKIE) !== state) return failure(provider, context, 'failed');
  const key = `fruitback:oauth:${provider.name}:${state}`;
  const verifier = await context.kv.get(key);
  if (verifier === undefined) return failure(provider, context, 'failed');
  // Spent once: the Kv has no delete, and an expired entry is what a spent one reads as.
  await context.kv.set(key, '', 1);
  if (verifier === '') return failure(provider, context, 'failed');

  const identity = await provider
    .identify(context.fetcher ?? fetch, {
      client: context.oauth,
      redirectUri: `${context.publicUrl}${provider.callback}`,
      code,
      verifier,
    })
    .catch(() => undefined);
  if (identity === undefined) return failure(provider, context, 'failed');
  if (identity.email === undefined) return failure(provider, context, 'unverified');

  const account = await context.accounts.signIn({
    provider: provider.name,
    subject: identity.id,
    email: identity.email,
    ...(identity.name === undefined ? {} : { name: identity.name }),
  });
  const session = await mintConsoleSession(context, account, context.now ?? Date.now());

  return redirect(`${context.consoleUrl}/`, [sessionCookie(session.refreshToken), stateCookie(provider, '', 0)]);
}
