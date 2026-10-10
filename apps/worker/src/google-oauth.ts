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
 * Signing in with Google (FRU-135). The steps are in `oauth-sign-in.ts`.
 *
 * Only the identity is asked for (`openid email profile`). The worker asks Google who the token is
 * for, over TLS, at Google's own address: it reads no token by itself, so there is no signature of a
 * token to check here. The address is used only when Google says it is verified.
 */

/** `FRUITBACK_GOOGLE_OAUTH`: the client id and the client secret of the OAuth client, joined by a colon. */
export type GoogleOAuth = OAuthClient;
export const parseGoogleOAuth = parseOAuthClient;

export const GOOGLE_START = '/auth/google';
export const GOOGLE_CALLBACK = '/auth/google/callback';

const TOKEN = 'https://oauth2.googleapis.com/token';
const USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

export function handleGoogle(
  request: Request,
  pathname: string,
  context: SignInContext,
): Promise<Response | undefined> {
  return handleSignIn(request, pathname, GOOGLE, context);
}

async function identify(fetcher: typeof fetch, { client, redirectUri, code, verifier }: Exchange): Promise<Identity> {
  const exchanged = await fetcher(TOKEN, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }).toString(),
    signal: AbortSignal.timeout(PROVIDER_CALL_TIMEOUT_MS),
  });
  const token = ((await exchanged.json()) as { access_token?: unknown }).access_token;
  if (!exchanged.ok || typeof token !== 'string' || token === '') throw new Error('no token');

  const asked = await fetcher(USERINFO, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(PROVIDER_CALL_TIMEOUT_MS),
  });
  if (!asked.ok) throw new Error('no identity');
  const profile = (await asked.json()) as { sub?: unknown; email?: unknown; email_verified?: unknown; name?: unknown };
  if (typeof profile.sub !== 'string' || profile.sub === '') throw new Error('no id');

  // `true` only. Google also answers the string "true" on some older routes: this route answers a boolean.
  const email =
    profile.email_verified === true && typeof profile.email === 'string' ? normalizeEmail(profile.email) : undefined;
  const name = typeof profile.name === 'string' && profile.name !== '' ? profile.name : undefined;

  return { id: profile.sub, ...(name === undefined ? {} : { name }), ...(email === undefined ? {} : { email }) };
}

const GOOGLE: SignInProvider = {
  name: 'google',
  start: GOOGLE_START,
  callback: GOOGLE_CALLBACK,
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  // `select_account`: a person with several Google accounts chooses, and is not signed in with the first.
  params: { response_type: 'code', scope: 'openid email profile', prompt: 'select_account' },
  identify,
};
