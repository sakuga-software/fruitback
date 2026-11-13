import { createHash } from 'node:crypto';
import { type AccountStore, can } from './accounts.ts';
import { type OAuthClient, parseOAuthClient } from './oauth-client.ts';
import type { Kv } from './kv.ts';
import {
  STATE_TTL_MS,
  issueTicket,
  random,
  redirect,
  spendState,
  spendTicket,
  stateCookie as cookieOf,
} from './oauth-flow.ts';
import { readLinearViewer } from './linear.ts';
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
 *
 * **One pair of tokens for each workspace of Linear (FRU-633).** Linear keeps one installation of the
 * application for each of its workspaces, and a new consent replaces its pair: the refresh token of
 * before answers `invalid_grant`. Measured on 2026-11-13: a connector made in a second workspace of
 * Fruitback ended the connector of the first one. So the pair belongs to the workspace of Linear. Every
 * connector of the instance in that workspace of Linear keeps a copy, a refresh or a consent writes the
 * new pair to all of them, and the pair is revoked only when the last of them goes.
 */

/** `FRUITBACK_LINEAR_OAUTH`: the client id and the client secret of the application, joined by a colon. */
export type LinearOAuth = OAuthClient;
export const parseLinearOAuth = parseOAuthClient;

export const LINEAR_START = '/auth/linear/start';
export const LINEAR_CALLBACK = '/auth/linear/callback';

const AUTHORIZE = 'https://linear.app/oauth/authorize';
const TOKEN = 'https://api.linear.app/oauth/token';
const REVOKE = 'https://api.linear.app/oauth/revoke';
const CALL_TIMEOUT_MS = 10_000;

/** A token this close to its end is refreshed before it is used. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1_000;
const STATE_COOKIE = 'fruitback_linear_state';
const TICKETS = 'fruitback:linear-ticket:';
const STATES = 'fruitback:linear-oauth:';

/**
 * What a Linear connector keeps, sealed. A connector made before FRU-134 holds the key alone, as
 * plain text: it is read as a key.
 */
export type LinearCredential =
  | { via: 'key'; apiKey: string }
  | { via: 'oauth'; accessToken: string; refreshToken: string; expiresAt: number; organization?: string };

/** `organization`: the id of the workspace of Linear. A pair kept before FRU-633 has none. */
export function readCredential(plain: string): LinearCredential {
  if (plain.startsWith('{')) {
    try {
      const { accessToken, refreshToken, expiresAt, organization } = JSON.parse(plain) as Record<string, unknown>;
      if (typeof accessToken === 'string' && typeof refreshToken === 'string' && typeof expiresAt === 'number') {
        return {
          via: 'oauth',
          accessToken,
          refreshToken,
          expiresAt,
          ...(typeof organization === 'string' && organization !== '' ? { organization } : {}),
        };
      }
    } catch {
      // Not JSON: a key, below. No key of Linear starts with a brace.
    }
  }

  return { via: 'key', apiKey: plain };
}

function sealCredential(credential: Extract<LinearCredential, { via: 'oauth' }>, secretsKey: string): string {
  const { accessToken, refreshToken, expiresAt, organization } = credential;

  return seal(JSON.stringify({ accessToken, refreshToken, expiresAt, organization }), secretsKey);
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

/**
 * One refresh at a time for a pair: two would spend one refresh token, and the second is refused. The
 * connectors of one workspace of Linear share a pair, so the key is that workspace when it is known.
 */
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

  const key = credential.organization ?? connector;
  const running = refreshing.get(key);
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
    const next = {
      via: 'oauth',
      ...answer.tokens,
      ...(latest.organization === undefined ? {} : { organization: latest.organization }),
    } as const;
    const sealedNext = sealCredential(next, secretsKey);
    // The refresh ended the pair of before for every connector of this workspace of Linear.
    if (latest.organization === undefined) await accounts.resealConnector(connector, sealedNext);
    else await accounts.shareLinearPair(latest.organization, sealedNext);

    return authorizationOf(next);
  })().finally(() => refreshing.delete(key));
  refreshing.set(key, refresh);

  return refresh;
}

/**
 * Tells Linear the token is over. Best effort: the connector goes whatever Linear answers.
 *
 * WARNING: call this after the connector is removed. A revocation ends the pair of every connector of
 * the workspace of Linear (FRU-633), so it happens only when no connector of the instance holds it. A
 * pair kept before FRU-633 was made for one connector, and no other connector holds it: it is revoked.
 */
export async function revokeLinear(
  sealed: string,
  secretsKey: string | undefined,
  accounts: Pick<AccountStore, 'holdsLinearOrganization'>,
): Promise<void> {
  const plain = secretsKey === undefined ? undefined : open(sealed, secretsKey);
  const credential = plain === undefined ? undefined : readCredential(plain);
  if (credential?.via !== 'oauth') return;
  if (credential.organization !== undefined && (await accounts.holdsLinearOrganization(credential.organization))) {
    return;
  }

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

/**
 * A ticket for one start of the flow, for this person in this workspace.
 *
 * The console gets it with its access token, then sends the browser to the worker with it. A
 * navigation carries no `Authorization`, so the ticket is what says who starts, once and for a minute.
 */
export async function linearTicket(
  context: Pick<LinearOAuthContext, 'kv' | 'publicUrl'>,
  who: { workspace: string; account: string; connector?: string },
): Promise<string> {
  const ticket = await issueTicket(context.kv, TICKETS, who);

  return `${context.publicUrl}${LINEAR_START}?ticket=${ticket}`;
}

function stateCookie(value: string, maxAge: number): string {
  return cookieOf(STATE_COOKIE, LINEAR_CALLBACK, value, maxAge);
}

/**
 * Back to the connectors of the workspace, with a word the console can show. Nothing of Linear is
 * echoed. `connector`: the connector whose panel opens, for a consent that kept an existing one.
 */
function back(context: LinearOAuthContext, workspace: string | undefined, word: string, connector?: string): Response {
  const opens = connector === undefined ? '' : `&connector=${encodeURIComponent(connector)}`;
  const where = workspace === undefined ? '/' : `/w/${workspace}/connectors?linear=${word}${opens}`;

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
  const who = await spendTicket(context.kv, TICKETS, new URL(request.url).searchParams.get('ticket') ?? '');
  if (who === undefined) return back(context, undefined, 'failed');

  const state = random(24);
  const verifier = random(48);
  await context.kv.set(
    `${STATES}${state}`,
    JSON.stringify({ verifier, workspace: who.workspace, account: who.account, connector: who.connector }),
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
  const kept = await spendState(request, context.kv, { cookie: STATE_COOKIE, prefix: STATES });
  if (typeof kept?.verifier !== 'string' || typeof kept.workspace !== 'string' || typeof kept.account !== 'string') {
    return back(context, undefined, 'failed');
  }
  const { verifier, workspace, account } = kept as { verifier: string; workspace: string; account: string };
  const target = typeof kept.connector === 'string' ? kept.connector : undefined;

  // A person who said no at Linear comes back with an error and no code.
  if (params.get('error') !== null) return back(context, workspace, 'declined');
  const code = params.get('code');
  if (code === null) return back(context, workspace, 'failed');

  // Asked again here: ten minutes passed, and a role can change in ten minutes.
  const role = await context.accounts.role(workspace, account);
  if (role === undefined || !can(role, 'manage-workspace')) return back(context, workspace, 'forbidden');
  // A flow that started before a suspension keeps no connector after it (FRU-282).
  if ((await context.accounts.suspension(workspace)) !== undefined) return back(context, workspace, 'suspended');

  // WARNING: this must run before the code is exchanged. The exchange ends the pair of every connector of
  // the workspace of Linear, and a pair kept before FRU-633 can say its workspace only while it works.
  await placeConnectorsOfBefore(context);

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

  // Asked before anything is kept, like a key: a token that Linear refuses is never stored.
  const named = await readLinearViewer(authorizationOf({ via: 'oauth', ...answer.tokens })).catch(() => undefined);
  if (named === undefined || named.organizationId === '') return back(context, workspace, 'failed');
  const organization = named.organizationId;
  const label = `${OAUTH_LABEL_PREFIX}${named.organization === '' ? 'Linear' : named.organization}`;
  const sealed = sealCredential({ via: 'oauth', ...answer.tokens, organization }, context.secretsKey);

  if (target !== undefined) {
    // The exchange ended the pair of before in this workspace of Linear: its connectors take the new
    // one, also when the person consented in another workspace of Linear than the one of `target`.
    if (!(await sameOrganization(context, workspace, target, organization, label))) {
      await context.accounts.shareLinearPair(organization, sealed);

      return back(context, workspace, 'other-organization', target);
    }
    await context.accounts.shareLinearPair(organization, sealed, target);

    return back(context, workspace, 'reconnected', target);
  }

  const revived = await context.accounts.shareLinearPair(organization, sealed);
  // « Connect » again, as the console said before FRU-633: the connector of before comes back with its
  // sites and its settings, and no second connector is made for the same workspace of Linear.
  const linears = (await context.accounts.connectors(workspace)).filter((each) => each.kind === 'linear');
  const own = linears.find((each) => revived.includes(each.id));
  if (own !== undefined) return back(context, workspace, 'reconnected', own.id);
  for (const each of linears) {
    if (!(await sameOrganization(context, workspace, each.id, organization, label))) continue;
    await context.accounts.shareLinearPair(organization, sealed, each.id);

    return back(context, workspace, 'reconnected', each.id);
  }

  await context.accounts.addConnector(workspace, { kind: 'linear', label, sealed, linearOrganization: organization });

  return back(context, workspace, 'connected');
}

/**
 * Whether `target` is a connector made with OAuth of this workspace, in the workspace of Linear
 * `organization`. A pair kept before FRU-633 does not say its workspace of Linear: then the label,
 * which is named after it, says it.
 */
async function sameOrganization(
  context: LinearOAuthContext,
  workspace: string,
  target: string,
  organization: string,
  label: string,
): Promise<boolean> {
  const held = await context.accounts.sealedKey(target);
  if (held === undefined || held.workspaceId !== workspace || held.kind !== 'linear') return false;
  const plain = open(held.sealed, context.secretsKey);
  const credential = plain === undefined ? undefined : readCredential(plain);
  if (credential?.via !== 'oauth') return false;
  if (credential.organization !== undefined) return credential.organization === organization;
  const listed = (await context.accounts.connectors(workspace)).find((each) => each.id === target);

  return listed?.label === label;
}

/**
 * Asks each connector made with OAuth before FRU-633 for its workspace of Linear, and keeps it. A pair
 * that Linear refuses says nothing: its connector waits for a consent in its own panel. A failure here
 * never stops the consent.
 */
async function placeConnectorsOfBefore(context: LinearOAuthContext): Promise<void> {
  const access: LinearAccess = {
    accounts: context.accounts,
    secretsKey: context.secretsKey,
    oauth: context.oauth,
    ...(context.now === undefined ? {} : { now: () => context.now as number }),
  };
  const unplaced = await context.accounts.linearConnectorsWithoutOrganization().catch(() => []);
  await Promise.all(
    unplaced.map(async ({ id, sealed }) => {
      const plain = open(sealed, context.secretsKey);
      if (plain === undefined || readCredential(plain).via !== 'oauth') return;
      try {
        const { organizationId } = await readLinearViewer(await linearAuthorization(id, sealed, access));
        if (organizationId === '') return;
        // Read again: the authorization above can have refreshed the pair.
        const latest = await current(context.accounts, id, context.secretsKey);
        if (latest === undefined) return;
        await context.accounts.setLinearOrganization(
          id,
          organizationId,
          sealCredential({ ...latest, organization: organizationId }, context.secretsKey),
        );
      } catch {
        // Linear refused the pair, or did not answer: the connector stays as it is.
      }
    }),
  );
}
