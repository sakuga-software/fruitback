import type { AccountStore, Connector } from '../accounts.ts';
import { noteConnectorCall } from '../connector-health.ts';
import { json } from '../http.ts';
import type { Kv } from '../kv.ts';
import { StoreError } from '../store.ts';
import { isPluginKind } from './kinds.ts';
import { pluginOf, shippedPlugins } from './index.ts';
import { type TrackerApps, oauthPlugin, trackerTicket } from './oauth.ts';
import {
  type Http,
  TrackerInputRefused,
  TrackerKeyForbidden,
  TrackerKeyRefused,
  type TrackerPlugin,
  sealTrackerCredential,
  trackerAccess,
} from './plugin.ts';

/**
 * The routes of the console for the connectors of a plugin (FRU-621), under the path of a workspace:
 * connect one by a token, start the way to its service by OAuth, list its places. `console-connectors.ts`
 * checks the caller and the role first, then hands these the body or the path.
 */

export type PluginRouteContext = {
  accounts: AccountStore;
  secretsKey?: string;
  kv?: Kv;
  publicUrl?: string;
  trackerApps?: TrackerApps;
  trackerHttp?: Http;
  now?: number;
};

const CONNECTORS_UNAVAILABLE = { error: 'connectors-unavailable' } as const;
/** The longest search of a place, as for the teams of Linear. */
const MAX_PLACE_SEARCH = 100;

const clockOf = (context: PluginRouteContext): (() => number) | undefined => {
  const moment = context.now;

  return moment === undefined ? undefined : () => moment;
};

/** What the console offers for each plugin of this build: its kind, and whether it connects by OAuth here. */
export function pluginOffers(context: PluginRouteContext): { kind: string; oauth: boolean; token: boolean }[] {
  const ready = context.secretsKey !== undefined && context.publicUrl !== undefined && context.kv !== undefined;

  return shippedPlugins().map((plugin) => ({
    kind: plugin.kind,
    oauth: ready && oauthPlugin(plugin.kind, context.trackerApps) !== undefined,
    token: plugin.connect !== undefined,
  }));
}

/** How a plugin reaches its service for a connector of this request. */
export function accessOf(context: PluginRouteContext, plugin: TrackerPlugin, connector: string, sealed: string) {
  const clock = clockOf(context);

  return trackerAccess(plugin, connector, sealed, {
    accounts: context.accounts,
    secretsKey: context.secretsKey,
    client: context.trackerApps?.[plugin.kind],
    ...(context.trackerHttp === undefined ? {} : { http: context.trackerHttp }),
    ...(clock === undefined ? {} : { now: clock }),
  });
}

/**
 * A read of a plugin whose failure is a service that is down: an answer the plugin cannot read (a
 * body that is not JSON, a shape it does not know) is a `StoreError`, so the console reads `502` and
 * never `500` (balanced review of #864).
 */
export async function readOf<T>(plugin: TrackerPlugin, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof StoreError) throw error;
    console.error(
      `[fruitback] ${plugin.name} answered what its connector cannot read: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw new StoreError(`${plugin.name} answered what its connector cannot read`);
  }
}

/**
 * A call to the service of a connector. What it answers is noted on the connector, as for a note
 * (FRU-102): a refusal makes it « Needs attention », and an answer ends it.
 */
export async function askPlugin<T>(context: PluginRouteContext, connector: string, ask: () => Promise<T>): Promise<T> {
  const clock = clockOf(context);
  try {
    const answer = await ask();
    await noteConnectorCall(context.accounts, connector, undefined, clock);

    return answer;
  } catch (error) {
    await noteConnectorCall(context.accounts, connector, error, clock);
    throw error;
  }
}

/**
 * `POST /connectors` with the kind of a plugin and the token a person typed. The service is asked
 * before anything is kept: a token it refuses is never stored.
 */
export async function connectPlugin(
  body: Readonly<Record<string, unknown>>,
  workspace: string,
  context: PluginRouteContext,
  headers: Record<string, string>,
  view: (connector: Connector) => unknown,
): Promise<Response> {
  const plugin = pluginOf(body.kind);
  if (plugin?.connect === undefined) return json(400, { error: 'invalid-connector' }, headers);
  if (context.secretsKey === undefined) return json(404, CONNECTORS_UNAVAILABLE, headers);
  let made: Awaited<ReturnType<NonNullable<TrackerPlugin['connect']>>>;
  try {
    const clock = clockOf(context) ?? Date.now;
    made = await plugin.connect(body, { http: context.trackerHttp ?? fetch, now: clock });
  } catch (error) {
    if (error instanceof TrackerInputRefused) return json(400, { error: error.code }, headers);
    // Only a refusal of the token is the person's to fix. A service that is down answers `502`, and
    // the token is not kept either way.
    if (error instanceof TrackerKeyRefused) return json(400, { error: 'key-refused' }, headers);
    if (error instanceof TrackerKeyForbidden) return json(400, { error: 'key-lacks-access' }, headers);
    if (error instanceof StoreError) return json(502, { error: 'store-unavailable' }, headers);
    throw error;
  }
  const connector = await context.accounts.addConnector(workspace, {
    kind: plugin.kind,
    label: made.label,
    sealed: sealTrackerCredential({ via: 'token', token: made.token, extra: made.extra ?? {} }, context.secretsKey),
  });

  return json(201, view(connector), headers);
}

/** `POST /connectors/<kind>/oauth`: where the browser goes to connect the service of a plugin. */
export async function startPluginOAuth(
  kind: string,
  who: { workspace: string; account: string },
  context: PluginRouteContext,
  headers: Record<string, string>,
): Promise<Response> {
  const found = oauthPlugin(kind, context.trackerApps);
  if (
    !isPluginKind(kind) ||
    found === undefined ||
    context.kv === undefined ||
    context.publicUrl === undefined ||
    context.secretsKey === undefined
  ) {
    return json(404, CONNECTORS_UNAVAILABLE, headers);
  }
  const url = await trackerTicket({ kv: context.kv, publicUrl: context.publicUrl }, kind, who);

  return json(201, { url }, headers);
}

/**
 * `GET /connectors/<id>/places?q=…&after=…`: a page of the places of a connector of a plugin, for the
 * person who chooses a destination. `undefined`: the connector is no connector of a plugin here.
 */
export async function listPluginPlaces(
  request: Request,
  connector: string,
  workspace: string,
  context: PluginRouteContext,
  headers: Record<string, string>,
): Promise<Response> {
  if (context.secretsKey === undefined) return json(404, CONNECTORS_UNAVAILABLE, headers);
  const kept = await context.accounts.sealedKey(connector);
  const plugin = kept === undefined ? undefined : pluginOf(kept.kind);
  // A connector of another workspace, or of another kind, answers like one that does not exist.
  if (kept === undefined || kept.workspaceId !== workspace || plugin === undefined) {
    return json(404, { error: 'not-found' }, headers);
  }
  const asked = new URL(request.url).searchParams;
  const search = asked.get('q')?.trim() ?? '';
  const after = asked.get('after') ?? undefined;
  if (search.length > MAX_PLACE_SEARCH || (after !== undefined && (after === '' || after.length > 200))) {
    return json(400, { error: 'invalid-query' }, headers);
  }
  const access = accessOf(context, plugin, connector, kept.sealed);
  const page = await askPlugin(context, connector, () =>
    readOf(plugin, () =>
      plugin.places(access, { ...(search === '' ? {} : { search }), ...(after === undefined ? {} : { after }) }),
    ),
  );

  return json(200, page, headers);
}

/** Best effort, before a connector of a plugin goes: its service forgets the token. */
export async function disconnectPlugin(context: PluginRouteContext, connector: string, sealed: string, kind: string) {
  const plugin = pluginOf(kind);
  if (plugin?.disconnect === undefined) return;
  await plugin
    .disconnect(accessOf(context, plugin, connector, sealed), context.trackerApps?.[plugin.kind])
    .catch(() => undefined);
}
