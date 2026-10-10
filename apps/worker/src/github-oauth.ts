import { normalizeEmail } from './accounts.ts';
import {
  type Exchange,
  type Identity,
  type OAuthClient,
  PROVIDER_CALL_TIMEOUT_MS,
  type SignInContext,
  type SignInProvider,
  handleSignIn,
  parseOAuthClient,
} from './oauth-sign-in.ts';

/**
 * Signing in with GitHub (FRU-97): an OAuth App. The steps are in `oauth-sign-in.ts`.
 *
 * The worker asks GitHub for the account's verified addresses with the token GitHub hands it, and
 * uses the primary one. Only the identity is asked for (`read:user user:email`). Connecting GitHub as
 * a source of a workspace is a separate consent, with its own rights (FRU-102).
 */

/** `FRUITBACK_GITHUB_OAUTH`: the client id and the client secret of the OAuth App, joined by a colon. */
export type GitHubOAuth = OAuthClient;
export const parseGitHubOAuth = parseOAuthClient;

export const GITHUB_START = '/auth/github';
export const GITHUB_CALLBACK = '/auth/github/callback';

const TOKEN = 'https://github.com/login/oauth/access_token';
const API = 'https://api.github.com';

export type GitHubContext = SignInContext;

export function handleGitHub(
  request: Request,
  pathname: string,
  context: GitHubContext,
): Promise<Response | undefined> {
  return handleSignIn(request, pathname, GITHUB, context);
}

async function identify(fetcher: typeof fetch, { client, redirectUri, code, verifier }: Exchange): Promise<Identity> {
  const exchanged = await fetcher(TOKEN, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(PROVIDER_CALL_TIMEOUT_MS),
  });
  const token = ((await exchanged.json()) as { access_token?: unknown }).access_token;
  if (!exchanged.ok || typeof token !== 'string' || token === '') throw new Error('no token');

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'fruitback',
  };
  const [user, emails] = await Promise.all([
    fetcher(`${API}/user`, { headers, signal: AbortSignal.timeout(PROVIDER_CALL_TIMEOUT_MS) }),
    fetcher(`${API}/user/emails`, { headers, signal: AbortSignal.timeout(PROVIDER_CALL_TIMEOUT_MS) }),
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

const GITHUB: SignInProvider = {
  name: 'github',
  start: GITHUB_START,
  callback: GITHUB_CALLBACK,
  authorize: 'https://github.com/login/oauth/authorize',
  params: { scope: 'read:user user:email', allow_signup: 'true' },
  identify,
};
