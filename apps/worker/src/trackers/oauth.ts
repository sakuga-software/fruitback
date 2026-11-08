import { createHash } from 'node:crypto';
import { type AccountStore, can } from '../accounts.ts';
import type { Kv } from '../kv.ts';
import type { OAuthClient } from '../oauth-client.ts';
import {
  STATE_TTL_MS,
  issueTicket,
  random,
  redirect,
  spendState,
  spendTicket,
  stateCookie as cookieOf,
} from '../oauth-flow.ts';
import { isPluginKind, type PluginKind } from './kinds.ts';
import { pluginOf } from './index.ts';
import { type Http, type TrackerPlugin, sealTrackerCredential } from './plugin.ts';

/**
 * The way to the service of a plugin and back (FRU-621), as Linear's (FRU-134): the console gets a
 * ticket, the browser spends it at `/auth/<kind>/start`, and the service sends it back to
 * `/auth/<kind>/callback` with a code.
 *
 * **The service of one person must not land in the workspace of another.** The `state` is bound to
 * the browser that started, by a cookie, and the start is a ticket that only a signed-in owner or
 * admin of the workspace gets. The role and the suspension are read again at the callback.
 */

/** The applications of OAuth of the plugins on this worker, by kind: `FRUITBACK_<KIND>_OAUTH`. */
export type TrackerApps = Readonly<Partial<Record<PluginKind, OAuthClient>>>;

export const startPath = (kind: PluginKind): string => `/auth/${kind}/start`;
export const callbackPath = (kind: PluginKind): string => `/auth/${kind}/callback`;
const ticketsOf = (kind: PluginKind): string => `fruitback:${kind}-ticket:`;
const statesOf = (kind: PluginKind): string => `fruitback:${kind}-oauth:`;
const cookieName = (kind: PluginKind): string => `fruitback_${kind}_state`;

const PATH = /^\/auth\/([a-z]+)\/(start|callback)$/;

/** The plugin of a kind, when it connects by OAuth and this worker has its application. */
export function oauthPlugin(
  kind: unknown,
  apps: TrackerApps | undefined,
): { plugin: TrackerPlugin & { oauth: NonNullable<TrackerPlugin['oauth']> }; client: OAuthClient } | undefined {
  const plugin = pluginOf(kind);
  const client = isPluginKind(kind) ? apps?.[kind] : undefined;
  if (plugin?.oauth === undefined || client === undefined) return undefined;

  return { plugin: plugin as TrackerPlugin & { oauth: NonNullable<TrackerPlugin['oauth']> }, client };
}

export type TrackerOAuthContext = {
  apps: TrackerApps;
  /** The worker's public address, which the service sends the person back to. */
  publicUrl: string;
  consoleUrl: string;
  accounts: AccountStore;
  kv: Kv;
  secretsKey: string;
  http?: Http;
  now?: number;
};

/** The address of a start of the flow, for this person in this workspace, once and for a minute. */
export async function trackerTicket(
  context: { kv: Kv; publicUrl: string },
  kind: PluginKind,
  who: { workspace: string; account: string },
): Promise<string> {
  const ticket = await issueTicket(context.kv, ticketsOf(kind), who);

  return `${context.publicUrl}${startPath(kind)}?ticket=${ticket}`;
}

/** Back to the connectors of the workspace, with a word the console can show. Nothing of the service is echoed. */
function back(context: TrackerOAuthContext, kind: PluginKind, workspace: string | undefined, word: string): Response {
  const where = workspace === undefined ? '/' : `/w/${workspace}/connectors?${kind}=${word}`;

  return redirect(`${context.consoleUrl}${where}`, [cookieOf(cookieName(kind), callbackPath(kind), '', 0)]);
}

/** `undefined`: the path is no route of this flow, or its plugin does not connect by OAuth here. */
export async function handleTrackerOAuth(
  request: Request,
  pathname: string,
  context: TrackerOAuthContext,
): Promise<Response | undefined> {
  if (request.method !== 'GET') return undefined;
  const matched = PATH.exec(pathname);
  const found = matched === null ? undefined : oauthPlugin(matched[1], context.apps);
  if (matched === null || found === undefined) return undefined;
  const kind = found.plugin.kind;

  return matched[2] === 'start' ? start(request, context, kind, found) : callback(request, context, kind, found);
}

async function start(
  request: Request,
  context: TrackerOAuthContext,
  kind: PluginKind,
  { plugin, client }: NonNullable<ReturnType<typeof oauthPlugin>>,
): Promise<Response> {
  const who = await spendTicket(context.kv, ticketsOf(kind), new URL(request.url).searchParams.get('ticket') ?? '');
  if (who === undefined) return back(context, kind, undefined, 'failed');

  const state = random(24);
  const verifier = random(48);
  await context.kv.set(
    `${statesOf(kind)}${state}`,
    JSON.stringify({ verifier, workspace: who.workspace, account: who.account }),
    STATE_TTL_MS,
  );
  const url = plugin.oauth.authorize({
    clientId: client.clientId,
    redirectUri: `${context.publicUrl}${callbackPath(kind)}`,
    state,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
  });

  return redirect(url, [cookieOf(cookieName(kind), callbackPath(kind), state, STATE_TTL_MS / 1_000)]);
}

async function callback(
  request: Request,
  context: TrackerOAuthContext,
  kind: PluginKind,
  { plugin, client }: NonNullable<ReturnType<typeof oauthPlugin>>,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const kept = await spendState(request, context.kv, { cookie: cookieName(kind), prefix: statesOf(kind) });
  if (typeof kept?.verifier !== 'string' || typeof kept.workspace !== 'string' || typeof kept.account !== 'string') {
    return back(context, kind, undefined, 'failed');
  }
  const { verifier, workspace, account } = kept as { verifier: string; workspace: string; account: string };

  // A person who said no at the service comes back with an error and no code.
  if (params.get('error') !== null) return back(context, kind, workspace, 'declined');
  const code = params.get('code');
  if (code === null) return back(context, kind, workspace, 'failed');

  // Asked again here: ten minutes passed, and a role can change in ten minutes.
  const role = await context.accounts.role(workspace, account);
  if (role === undefined || !can(role, 'manage-workspace')) return back(context, kind, workspace, 'forbidden');
  // A flow that started before a suspension keeps no connector after it (FRU-282).
  if ((await context.accounts.suspension(workspace)) !== undefined) return back(context, kind, workspace, 'suspended');

  const http = context.http ?? fetch;
  const now = context.now ?? Date.now();
  const tokens = await plugin.oauth
    .exchange({ code, verifier, redirectUri: `${context.publicUrl}${callbackPath(kind)}`, client }, http, now)
    .catch(() => undefined);
  if (tokens === undefined) return back(context, kind, workspace, 'failed');
  // Asked before anything is kept, like a key: tokens that reach nothing are never stored.
  const named = await plugin.oauth.identify(tokens, http).catch(() => undefined);
  if (named === undefined) return back(context, kind, workspace, 'failed');

  await context.accounts.addConnector(workspace, {
    kind,
    label: named.label,
    sealed: sealTrackerCredential({ via: 'oauth', ...tokens, extra: named.extra ?? {} }, context.secretsKey),
  });

  return back(context, kind, workspace, 'connected');
}
