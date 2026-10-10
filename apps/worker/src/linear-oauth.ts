import { createHash } from 'node:crypto';
import { type AccountStore, can } from './accounts.ts';
import { type GitHubOAuth, parseGitHubOAuth } from './github-oauth.ts';
import type { Kv } from './kv.ts';
import { listLinearTeams } from './linear.ts';
import { open, seal } from './secrets.ts';
import { StoreError } from './store.ts';

/**
 * Connecting Linear with OAuth (FRU-134), in place of a personal API key.
 *
 * A personal key reaches everything its person reaches, and stops with that person. Here a workspace
 * of Linear installs the application: the token is the application's (`actor=app`), it lasts a day,
 * and its refresh token changes at each refresh. The worker keeps both sealed, like a key.
 *
 * **The Linear of one person must not land in the workspace of another.** Somebody who starts the
 * flow and sends its address to a victim would get the victim's consent on their own `state`. So the
 * `state` is bound to the browser that started, by a cookie, and it is started by a ticket that only
 * a signed-in owner or admin can get.
 */

/** `FRUITBACK_LINEAR_OAUTH`: the client id and the client secret of the application, joined by a colon. */
export type LinearOAuth = GitHubOAuth;
export const parseLinearOAuth = parseGitHubOAuth;

export const LINEAR_START = '/auth/linear/start';
export const LINEAR_CALLBACK = '/auth/linear/callback';

const AUTHORIZE = 'https://linear.app/oauth/authorize';
const TOKEN = 'https://api.linear.app/oauth/token';
const REVOKE = 'https://api.linear.app/oauth/revoke';
const CALL_TIMEOUT_MS = 10_000;

/** A minute to go from the console to the worker. The ticket is spent by that one navigation. */
export const TICKET_TTL_MS = 60 * 1_000;
/** Ten minutes to come back from Linear. A `state` older than that is a page somebody left open. */
export const STATE_TTL_MS = 10 * 60 * 1_000;
/** A token this close to its end is refreshed before it is used. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1_000;
const STATE_COOKIE = 'fruitback_linear_state';

/**
 * What a Linear connector keeps, sealed. A connector made before FRU-134 holds the key alone, as
 * plain text: it is read as a key.
 */
export type LinearCredential =
  | { via: 'key'; apiKey: string }
  | { via: 'oauth'; accessToken: string; refreshToken: string; expiresAt: number };

export function readCredential(plain: string): LinearCredential {
  if (plain.startsWith('{')) {
    try {
      const { accessToken, refreshToken, expiresAt } = JSON.parse(plain) as Record<string, unknown>;
      if (typeof accessToken === 'string' && typeof refreshToken === 'string' && typeof expiresAt === 'number') {
        return { via: 'oauth', accessToken, refreshToken, expiresAt };
      }
    } catch {
      // Not JSON: a key, below. No key of Linear starts with a brace.
    }
  }

  return { via: 'key', apiKey: plain };
}

function sealCredential(credential: Extract<LinearCredential, { via: 'oauth' }>, secretsKey: string): string {
  const { accessToken, refreshToken, expiresAt } = credential;

  return seal(JSON.stringify({ accessToken, refreshToken, expiresAt }), secretsKey);
}

/** The value of `Authorization` for Linear: a personal key goes raw, a token of OAuth goes with `Bearer`. */
export function authorizationOf(credential: LinearCredential): string {
  return credential.via === 'key' ? credential.apiKey : `Bearer ${credential.accessToken}`;
}

/** The label of a connector made with OAuth. The console reads the prefix to say how it is connected. */
export const OAUTH_LABEL_PREFIX = 'Linear OAuth · ';

type Tokens = { accessToken: string; refreshToken: string; expiresAt: number };

/** The answer of the token route, or `undefined` for one that holds no usable token. */
function readTokens(body: unknown, now: number): Tokens | undefined {
  const { access_token: access, refresh_token: refresh, expires_in: lasts } = (body ?? {}) as Record<string, unknown>;
  if (typeof access !== 'string' || access === '' || typeof refresh !== 'string' || refresh === '') return undefined;
  if (typeof lasts !== 'number' || !(lasts > 0)) return undefined;

  return { accessToken: access, refreshToken: refresh, expiresAt: now + lasts * 1_000 };
}

async function askTokens(form: Record<string, string>, now: number): Promise<{ status: number; tokens?: Tokens }> {
  const response = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const tokens = response.ok ? readTokens(await response.json().catch(() => undefined), now) : undefined;

  return { status: response.status, ...(tokens === undefined ? {} : { tokens }) };
}

export type LinearAccess = {
  accounts: AccountStore;
  secretsKey: string | undefined;
  oauth: LinearOAuth | undefined;
  now?: () => number;
};

/** The pair of tokens the store holds for a connector now, or nothing for a connector that holds a key or is gone. */
async function current(
  accounts: AccountStore,
  connector: string,
  secretsKey: string,
): Promise<Extract<LinearCredential, { via: 'oauth' }> | undefined> {
  const kept = await accounts.sealedKey(connector);
  const plain = kept === undefined ? undefined : open(kept.sealed, secretsKey);
  const credential = plain === undefined ? undefined : readCredential(plain);

  return credential?.via === 'oauth' ? credential : undefined;
}

/**
 * Linear refused to refresh the tokens of a connection (FRU-102): somebody revoked the application,
 * or the refresh token is spent. It does not come back alone, so the console asks for a new consent.
 */
export class LinearConnectionEnded extends StoreError {}

/** One refresh at a time for a connector: two would spend one refresh token, and the second is refused. */
const refreshing = new Map<string, Promise<string>>();

/**
 * The value of `Authorization` for a Linear connector, with a token that is not about to end.
 *
 * WARNING: a refresh changes the refresh token, and the new pair is written before it is used. A
 * refresh whose answer is lost can be asked again with the same token for 30 minutes (Linear's
 * grace), so a failure to write is a `StoreError` now and a new refresh at the next call.
 *
 * It throws a `StoreError` for a connector that cannot be used: the caller answers `502`, and never
 * falls back to another store.
 */
export async function linearAuthorization(
  connector: string,
  sealed: string,
  { accounts, secretsKey, oauth, now = Date.now }: LinearAccess,
): Promise<string> {
  if (secretsKey === undefined) throw new StoreError('This worker has no key to open a connector with');
  const plain = open(sealed, secretsKey);
  if (plain === undefined) throw new StoreError('The key of this connector could not be opened');
  const credential = readCredential(plain);
  if (credential.via === 'key' || credential.expiresAt - now() > REFRESH_MARGIN_MS) return authorizationOf(credential);

  const running = refreshing.get(connector);
  if (running !== undefined) return running;

  const refresh = (async (): Promise<string> => {
    // WARNING: the caller read `sealed` before it came here, and another refresh can have finished
    // in that time. What the store holds now is read again: a pair that is fresh is used as it is,
    // and a refresh spends the refresh token of the store, never one that was spent already.
    const latest = await current(accounts, connector, secretsKey);
    if (latest === undefined) throw new StoreError('The connector of this site is gone');
    if (latest.expiresAt - now() > REFRESH_MARGIN_MS) return authorizationOf(latest);
    if (oauth === undefined) throw new StoreError('This worker has no Linear application to refresh a token with');
    let answer: Awaited<ReturnType<typeof askTokens>>;
    try {
      answer = await askTokens(
        {
          grant_type: 'refresh_token',
          refresh_token: latest.refreshToken,
          client_id: oauth.clientId,
          client_secret: oauth.clientSecret,
        },
        now(),
      );
    } catch {
      throw new StoreError('Linear could not be reached');
    }
    if (answer.tokens === undefined) {
      if (answer.status === 400 || answer.status === 401) {
        throw new LinearConnectionEnded('The connection to Linear ended. Connect Linear again.');
      }
      throw new StoreError('Linear did not refresh the connection');
    }
    const next = { via: 'oauth', ...answer.tokens } as const;
    await accounts.resealConnector(connector, sealCredential(next, secretsKey));

    return authorizationOf(next);
  })().finally(() => refreshing.delete(connector));
  refreshing.set(connector, refresh);

  return refresh;
}

/** Tells Linear the token is over. Best effort: the connector goes whatever Linear answers. */
export async function revokeLinear(sealed: string, secretsKey: string | undefined): Promise<void> {
  const plain = secretsKey === undefined ? undefined : open(sealed, secretsKey);
  const credential = plain === undefined ? undefined : readCredential(plain);
  if (credential?.via !== 'oauth') return;

  await fetch(REVOKE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Bearer ${credential.accessToken}`,
    },
    body: new URLSearchParams({ token: credential.refreshToken, token_type_hint: 'refresh_token' }).toString(),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  }).catch(() => undefined);
}

export type LinearOAuthContext = {
  oauth: LinearOAuth;
  /** The worker's public address, which Linear sends the person back to. */
  publicUrl: string;
  consoleUrl: string;
  accounts: AccountStore;
  kv: Kv;
  secretsKey: string;
  now?: number;
};

function random(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url');
}

/**
 * A ticket for one start of the flow, for this person in this workspace.
 *
 * The console gets it with its access token, then sends the browser to the worker with it. A
 * navigation carries no `Authorization`, so the ticket is what says who starts, once and for a minute.
 */
export async function linearTicket(
  context: Pick<LinearOAuthContext, 'kv' | 'publicUrl'>,
  who: { workspace: string; account: string },
): Promise<string> {
  const ticket = random(24);
  await context.kv.set(`fruitback:linear-ticket:${ticket}`, JSON.stringify(who), TICKET_TTL_MS);

  return `${context.publicUrl}${LINEAR_START}?ticket=${ticket}`;
}

/** Reads a value of the Kv once. The Kv has no delete: an entry that ends in a millisecond reads as spent. */
async function spend(kv: Kv, key: string): Promise<Record<string, unknown> | undefined> {
  const kept = await kv.get(key);
  if (kept === undefined || kept === '') return undefined;
  await kv.set(key, '', 1);

  try {
    return JSON.parse(kept) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);

  return new Response(null, { status: 302, headers });
}

/** `SameSite=Lax`, not `Strict`: Linear sends the person back with a navigation from another site. */
function stateCookie(value: string, maxAge: number): string {
  return `${STATE_COOKIE}=${value}; Path=${LINEAR_CALLBACK}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=') || undefined;
  }

  return undefined;
}

/** Back to the connectors of the workspace, with a word the console can show. Nothing of Linear is echoed. */
function back(context: LinearOAuthContext, workspace: string | undefined, word: string): Response {
  const where = workspace === undefined ? '/' : `/w/${workspace}/connectors?linear=${word}`;

  return redirect(`${context.consoleUrl}${where}`, [stateCookie('', 0)]);
}

export async function handleLinearOAuth(
  request: Request,
  pathname: string,
  context: LinearOAuthContext,
): Promise<Response | undefined> {
  if (request.method !== 'GET') return undefined;
  if (pathname === LINEAR_START) return start(request, context);
  if (pathname === LINEAR_CALLBACK) return callback(request, context);

  return undefined;
}

async function start(request: Request, context: LinearOAuthContext): Promise<Response> {
  const ticket = new URL(request.url).searchParams.get('ticket') ?? '';
  const who = /^[\w-]{16,64}$/.test(ticket) ? await spend(context.kv, `fruitback:linear-ticket:${ticket}`) : undefined;
  if (typeof who?.workspace !== 'string' || typeof who.account !== 'string') return back(context, undefined, 'failed');

  const state = random(24);
  const verifier = random(48);
  await context.kv.set(
    `fruitback:linear-oauth:${state}`,
    JSON.stringify({ verifier, workspace: who.workspace, account: who.account }),
    STATE_TTL_MS,
  );

  const url = new URL(AUTHORIZE);
  url.searchParams.set('client_id', context.oauth.clientId);
  url.searchParams.set('redirect_uri', `${context.publicUrl}${LINEAR_CALLBACK}`);
  url.searchParams.set('response_type', 'code');
  // The worker creates issues and labels, and reads issues and their comments.
  url.searchParams.set('scope', 'read,write');
  // The application is the actor: the connector does not stop when its person leaves the team.
  url.searchParams.set('actor', 'app');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
  url.searchParams.set('code_challenge_method', 'S256');

  return redirect(url.toString(), [stateCookie(state, STATE_TTL_MS / 1_000)]);
}

async function callback(request: Request, context: LinearOAuthContext): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const state = params.get('state') ?? '';
  // The state must be the one this browser left with, and one this worker issued.
  if (state === '' || readCookie(request, STATE_COOKIE) !== state) return back(context, undefined, 'failed');
  const kept = await spend(context.kv, `fruitback:linear-oauth:${state}`);
  if (typeof kept?.verifier !== 'string' || typeof kept.workspace !== 'string' || typeof kept.account !== 'string') {
    return back(context, undefined, 'failed');
  }
  const { verifier, workspace, account } = kept as { verifier: string; workspace: string; account: string };

  // A person who said no at Linear comes back with an error and no code.
  if (params.get('error') !== null) return back(context, workspace, 'declined');
  const code = params.get('code');
  if (code === null) return back(context, workspace, 'failed');

  // Asked again here: ten minutes passed, and a role can change in ten minutes.
  const role = await context.accounts.role(workspace, account);
  if (role === undefined || !can(role, 'manage-workspace')) return back(context, workspace, 'forbidden');

  const now = context.now ?? Date.now();
  const answer = await askTokens(
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${context.publicUrl}${LINEAR_CALLBACK}`,
      client_id: context.oauth.clientId,
      client_secret: context.oauth.clientSecret,
      code_verifier: verifier,
    },
    now,
  ).catch(() => undefined);
  if (answer?.tokens === undefined) return back(context, workspace, 'failed');

  const credential = { via: 'oauth', ...answer.tokens } as const;
  // Asked before anything is kept, like a key: a token that reads no team is never stored.
  const named = await listLinearTeams(authorizationOf(credential)).catch(() => undefined);
  if (named === undefined) return back(context, workspace, 'failed');

  await context.accounts.addConnector(workspace, {
    kind: 'linear',
    label: `${OAUTH_LABEL_PREFIX}${named.organization === '' ? 'Linear' : named.organization}`,
    sealed: sealCredential(credential, context.secretsKey),
  });

  return back(context, workspace, 'connected');
}
