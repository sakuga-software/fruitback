import type { ConsoleApiContext, TrackerContext } from './console-api.ts';
import { json } from './http.ts';
import { readJsonObject } from './bounded-body.ts';
import {
  type Account,
  type Action,
  type Connector,
  type ConnectorAttention,
  type ConnectorSettings,
  readConnectorSettings,
  workspaceName,
} from './accounts.ts';
import { noteConnectorCall } from './connector-health.ts';
import {
  type GithubApp,
  GithubInstallationGone,
  type ListedRepositories,
  openInstallation,
  readGithubRepository,
} from './github-connector.ts';
import { githubAppTicket } from './github-app-flow.ts';
import {
  LinearKeyForbidden,
  LinearKeyRefused,
  MAX_TEAM_SEARCH,
  listLinearStates,
  readLinearTeams,
  readLinearViewer,
} from './linear.ts';
import { isAcceptableSecret, newSecret, parseTargetUrl, sealTarget, targetLabel } from './rest-connector.ts';
import { linearAuthorization, linearTicket, revokeLinear } from './linear-oauth.ts';
import { isAcceptableToken, parseFireUrl, routineLabel, sealRoutine } from './claude-routine.ts';
import { seal } from './secrets.ts';
import { StoreError } from './store.ts';

/**
 * The connectors of a workspace in the console (FRU-507): list, add, name, remove, their deliveries,
 * their settings and states, and the teams or repositories to choose a destination from. Out of
 * `console-api.ts`, which checks the caller, the role and a suspended workspace before it calls
 * `handleConnectors`. `askLinear` and `listRepositories` serve the sites of `console-api.ts` too.
 */

const CONNECTORS_UNAVAILABLE = { error: 'connectors-unavailable' } as const;

/** Whether a workspace can connect Linear with OAuth here: the application, a key to seal with, an address. */
function linearOAuthReady(context: ConsoleApiContext): boolean {
  return context.linearOAuth !== undefined && context.secretsKey !== undefined && context.publicUrl !== undefined;
}

/** Whether a workspace can install the GitHub App here: the App, a key to seal with, an address, a Kv. */
function githubAppReady(context: ConsoleApiContext): boolean {
  return (
    context.githubApp !== undefined &&
    context.secretsKey !== undefined &&
    context.publicUrl !== undefined &&
    context.kv !== undefined
  );
}

function connectorView(connector: Connector): {
  id: string;
  kind: string;
  label: string;
  name?: string;
  createdAt: string;
  attention?: ConnectorAttention;
  settings: ConnectorSettings;
} {
  return {
    id: connector.id,
    kind: connector.kind,
    label: connector.label,
    // Absent for a connector nobody named (FRU-404): the console then names it by its kind.
    ...(connector.name === undefined ? {} : { name: connector.name }),
    createdAt: connector.createdAt,
    settings: connector.settings,
    // Absent for a connector that works: the console draws « Needs attention » from this field only.
    ...(connector.attention === undefined ? {} : { attention: connector.attention }),
  };
}

/**
 * A call to the Linear of a connector, with its stored key. What Linear answers is noted on the
 * connector, as for a note (FRU-102): a refusal makes it « Needs attention », and an answer ends it.
 */
export async function askLinear<T>(
  context: TrackerContext,
  connector: string,
  sealed: string,
  ask: (authorization: string) => Promise<T>,
): Promise<T> {
  const moment = context.now;
  const clock = moment === undefined ? undefined : () => moment;
  try {
    // A key goes as it is. A token of OAuth near its end is refreshed first.
    const authorization = await linearAuthorization(connector, sealed, {
      accounts: context.accounts,
      secretsKey: context.secretsKey,
      oauth: context.linearOAuth,
    });
    const answer = await ask(authorization);
    await noteConnectorCall(context.accounts, connector, undefined, clock);

    return answer;
  } catch (error) {
    await noteConnectorCall(context.accounts, connector, error, clock);
    throw error;
  }
}

/**
 * The repositories of the installation of a `github` connector (FRU-361). An installation that GitHub
 * does not know makes the connector need attention, as a note does (FRU-359).
 *
 * A list that GitHub answers ends only a `connection-ended`: it says that the installation exists,
 * and nothing of the repository of each destination.
 */
export async function listRepositories(
  context: TrackerContext,
  workspace: string,
  connector: string,
  sealed: string,
): Promise<ListedRepositories> {
  const moment = context.now;
  const clock = moment === undefined ? undefined : () => moment;
  const app = context.githubApp as GithubApp;
  let repositories: ListedRepositories;
  try {
    repositories = await app.repositories(openInstallation(sealed, context.secretsKey));
  } catch (error) {
    await noteConnectorCall(context.accounts, connector, error, clock);
    throw error;
  }
  const held = await context.accounts.connectors(workspace);
  if (held.find((each) => each.id === connector)?.attention?.reason === 'connection-ended') {
    await noteConnectorCall(context.accounts, connector, undefined, clock);
  }

  return repositories;
}

/**
 * The routes of the connectors of a workspace, under its path in the console (FRU-507): out of
 * `handleConsoleApi`, which keeps the caller, the role and the guard of a suspended workspace, and
 * calls this after them. `undefined`: the path is no route of a connector.
 */
export async function handleConnectors(
  rest: string,
  request: Request,
  {
    context,
    workspaceId,
    account,
    allowed,
    forbidden,
    headers,
  }: {
    context: ConsoleApiContext;
    workspaceId: string;
    account: Account;
    allowed: (action: Action) => boolean;
    forbidden: () => Response;
    headers: Record<string, string>;
  },
): Promise<Response | undefined> {
  if (rest === '/connectors') {
    if (request.method === 'GET') {
      if (!allowed('see-tracker')) return forbidden();
      const connectors = await context.accounts.connectors(workspaceId as string);

      return json(
        200,
        {
          connectors: connectors.map(connectorView),
          available: context.secretsKey !== undefined,
          // The console offers « Connect with Linear » only where the worker can do it.
          linearOAuth: linearOAuthReady(context),
          // The console offers « Install the GitHub App » only where the worker can do it (FRU-360).
          githubApp: githubAppReady(context),
        },
        headers,
      );
    }
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
    if (!allowed('manage-workspace')) return forbidden();
    if (context.secretsKey === undefined) return json(404, CONNECTORS_UNAVAILABLE, headers);

    const body = await readJsonObject(request);
    if (body?.kind === 'rest') {
      // FRU-122: an address that receives each note. Nothing is asked of it now: it is called when a
      // note is written, and the console shows a delivery that did not arrive.
      const url = parseTargetUrl(body.url);
      if (url === undefined) return json(400, { error: 'invalid-address' }, headers);
      const given = typeof body.secret === 'string' && body.secret !== '' ? body.secret : undefined;
      if (given !== undefined && !isAcceptableSecret(given)) return json(400, { error: 'invalid-secret' }, headers);
      const secret = given ?? newSecret();
      const connector = await context.accounts.addConnector(workspaceId as string, {
        kind: 'rest',
        label: targetLabel(url),
        sealed: sealTarget({ url, secret }, context.secretsKey),
      });

      // A secret the worker made is answered here, once. No route answers it again.
      return json(201, { ...connectorView(connector), ...(given === undefined ? { secret } : {}) }, headers);
    }
    if (body?.kind === 'claude-routine') {
      // FRU-594: the Fire URL and the token of a Claude Code routine. Only the `/fire` of a routine on
      // api.anthropic.com is taken, and the token is sealed and never answered again. Nothing is
      // asked of Anthropic now: a call would start a run. The first call says whether the token works.
      const url = parseFireUrl(body.url);
      if (url === undefined) return json(400, { error: 'invalid-fire-url' }, headers);
      const token = typeof body.token === 'string' ? body.token.trim() : undefined;
      if (!isAcceptableToken(token)) return json(400, { error: 'invalid-token' }, headers);
      const connector = await context.accounts.addConnector(workspaceId as string, {
        kind: 'claude-routine',
        label: routineLabel(url),
        sealed: sealRoutine({ url, token }, context.secretsKey),
      });

      return json(201, connectorView(connector), headers);
    }
    const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
    if (body?.kind !== 'linear' || apiKey === '') return json(400, { error: 'invalid-connector' }, headers);

    // Asked before anything is kept: a key the tracker refuses is never stored.
    let viewer: string;
    try {
      viewer = (await readLinearViewer(apiKey)).viewer;
    } catch (error) {
      // Only a refusal of the key is the person's to fix. A Linear that is down answers `502`, and
      // the key is not kept either way.
      if (error instanceof LinearKeyRefused) return json(400, { error: 'key-refused' }, headers);
      if (error instanceof LinearKeyForbidden) return json(400, { error: 'key-lacks-access' }, headers);
      if (error instanceof StoreError) return json(502, { error: 'store-unavailable' }, headers);
      throw error;
    }
    const connector = await context.accounts.addConnector(workspaceId as string, {
      kind: 'linear',
      label: viewer === '' ? 'Linear' : `Linear · ${viewer}`,
      sealed: seal(apiKey, context.secretsKey),
    });

    return json(201, connectorView(connector), headers);
  }

  // FRU-134: where the browser goes to connect Linear with OAuth. The console sends it there.
  if (rest === '/connectors/linear/oauth') {
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
    if (!allowed('manage-workspace')) return forbidden();
    if (!linearOAuthReady(context) || context.kv === undefined || context.publicUrl === undefined) {
      return json(404, CONNECTORS_UNAVAILABLE, headers);
    }
    const url = await linearTicket(
      { kv: context.kv, publicUrl: context.publicUrl },
      { workspace: workspaceId as string, account: account.id },
    );

    return json(201, { url }, headers);
  }

  // FRU-360: where the browser goes to install the GitHub App. The console sends it there.
  if (rest === '/connectors/github/start') {
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
    if (!allowed('manage-workspace')) return forbidden();
    if (!githubAppReady(context) || context.kv === undefined || context.publicUrl === undefined) {
      return json(404, CONNECTORS_UNAVAILABLE, headers);
    }
    const url = await githubAppTicket(
      { kv: context.kv, publicUrl: context.publicUrl },
      { workspace: workspaceId as string, account: account.id },
    );

    return json(201, { url }, headers);
  }

  // The deliveries of a receiving connector that did not arrive, and a new attempt (FRU-122).
  const late = /^\/connectors\/([A-Za-z0-9_-]+)\/deliveries(?:\/([A-Za-z0-9_-]+)\/retry)?$/.exec(rest);
  if (late !== null) {
    const id = late[1] as string;
    if (late[2] === undefined) {
      if (request.method !== 'GET') return json(405, { error: 'method-not-allowed' }, headers);
      if (!allowed('see-tracker')) return forbidden();
      const kept = await context.accounts.sealedKey(id);
      if (kept === undefined || kept.workspaceId !== workspaceId) return json(404, { error: 'not-found' }, headers);

      const pending = await context.accounts.deliveries(workspaceId as string, id);
      // FRU-594: a routine says the sessions its calls started, beside the calls that did not arrive.
      if (kept.kind === 'claude-routine') {
        return json(
          200,
          { deliveries: pending, sessions: await context.accounts.agentSessions(workspaceId as string, id) },
          headers,
        );
      }

      return json(200, { deliveries: pending }, headers);
    }
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
    if (!allowed('manage-sites')) return forbidden();
    const due = await context.accounts.retryDelivery(workspaceId as string, id, late[2], context.now ?? Date.now());

    return due ? new Response(null, { status: 204, headers }) : json(404, { error: 'not-found' }, headers);
  }

  // What a workspace sets on a tracker (FRU-102): the replies, and the exceptions to the stages.
  const tuned = /^\/connectors\/([A-Za-z0-9_-]+)\/(settings|states)$/.exec(rest);
  if (tuned !== null) {
    const id = tuned[1] as string;
    const writes = tuned[2] === 'settings';
    if (request.method !== (writes ? 'POST' : 'GET')) return json(405, { error: 'method-not-allowed' }, headers);
    if (!allowed('manage-workspace')) return forbidden();
    const kept = await context.accounts.sealedKey(id);
    // A connector of another workspace answers like one that does not exist, and so does an address
    // that only receives: it has no replies and no states.
    if (kept === undefined || kept.workspaceId !== workspaceId || kept.kind !== 'linear') {
      return json(404, { error: 'not-found' }, headers);
    }

    if (writes) {
      const settings = readConnectorSettings(await readJsonObject(request));
      if (settings === undefined) return json(400, { error: 'invalid-settings' }, headers);
      const set = await context.accounts.setConnectorSettings(workspaceId as string, id, settings);
      if (!set) return json(404, { error: 'not-found' }, headers);

      return json(200, { settings }, headers);
    }

    // The states of the teams the sites of this workspace send to through this connector: those are
    // the states a pin can have. A team nobody sends to is not asked.
    if (context.secretsKey === undefined) return json(404, CONNECTORS_UNAVAILABLE, headers);
    const teams = [
      ...new Set(
        (await context.accounts.sites(workspaceId as string)).flatMap((site) =>
          site.destinations.flatMap((place) =>
            place.connector === id && place.teamId !== undefined ? [place.teamId] : [],
          ),
        ),
      ),
    ];
    const states = await askLinear(context, id, kept.sealed, (authorization) => listLinearStates(authorization, teams));

    return json(200, { states, settings: kept.settings }, headers);
  }

  // FRU-361: the repositories of a `github` connector, for the person who chooses a destination.
  const listed = /^\/connectors\/([A-Za-z0-9_-]+)\/repositories$/.exec(rest);
  if (listed !== null) {
    const id = listed[1] as string;
    if (request.method !== 'GET') return json(405, { error: 'method-not-allowed' }, headers);
    if (!allowed('manage-sites')) return forbidden();
    const kept = await context.accounts.sealedKey(id);
    // A connector of another workspace, or of another kind, answers like one that does not exist.
    if (kept === undefined || kept.workspaceId !== workspaceId || kept.kind !== 'github') {
      return json(404, { error: 'not-found' }, headers);
    }
    if (context.githubApp === undefined || context.secretsKey === undefined) {
      return json(404, CONNECTORS_UNAVAILABLE, headers);
    }

    // FRU-500: one repository by its name, for one past the list. `undefined`: the installation does
    // not cover it, or no such repository exists, which the console says the same way.
    const name = new URL(request.url).searchParams.get('name');
    if (name !== null) {
      const wanted = readGithubRepository(name);
      if (wanted === undefined) return json(400, { error: 'invalid-repository' }, headers);
      let found: Awaited<ReturnType<GithubApp['repository']>>;
      try {
        found = await (context.githubApp as GithubApp).repository(
          openInstallation(kept.sealed, context.secretsKey),
          wanted,
        );
      } catch (error) {
        // An installation that is gone makes the connector need attention, as the list does.
        const moment = context.now;
        await noteConnectorCall(context.accounts, id, error, moment === undefined ? undefined : () => moment);
        // The console says what to do about it, where a GitHub that is down is « try again ».
        if (error instanceof GithubInstallationGone) return json(502, { error: 'connection-ended' }, headers);
        throw error;
      }

      return found === undefined
        ? json(404, { error: 'repository-not-found' }, headers)
        : json(200, { repository: found }, headers);
    }

    return json(200, await listRepositories(context, workspaceId as string, id, kept.sealed), headers);
  }

  const connector = /^\/connectors\/([A-Za-z0-9_-]+)(\/teams)?$/.exec(rest);
  if (connector !== null) {
    const id = connector[1] as string;
    if (connector[2] === undefined && request.method === 'POST') {
      // FRU-404: the name a workspace gives its connector, so that two of one kind read apart. `null`
      // or an empty name takes it away. The rule of a name is the one of a workspace.
      if (!allowed('manage-workspace')) return forbidden();
      const given = (await readJsonObject(request))?.name;
      const cleared = given === null || (typeof given === 'string' && given.trim() === '');
      const name = cleared ? undefined : workspaceName(given);
      if (!cleared && name === undefined) return json(400, { error: 'invalid-name' }, headers);
      const renamed = await context.accounts.renameConnector(workspaceId as string, id, name);
      if (!renamed) return json(404, { error: 'not-found' }, headers);
      const kept = (await context.accounts.connectors(workspaceId as string)).find((each) => each.id === id);

      return kept === undefined ? json(404, { error: 'not-found' }, headers) : json(200, connectorView(kept), headers);
    }
    if (connector[2] === undefined) {
      if (request.method !== 'DELETE') return json(405, { error: 'method-not-allowed' }, headers);
      if (!allowed('manage-workspace')) return forbidden();
      // A token of OAuth is revoked at Linear before the connector goes. Linear's answer changes
      // nothing: the connector goes, and a token nobody holds ends in a day.
      const leaving = await context.accounts.sealedKey(id);
      const removed = await context.accounts.removeConnector(workspaceId as string, id);
      if (removed && leaving?.kind === 'linear' && leaving.workspaceId === workspaceId) {
        await revokeLinear(leaving.sealed, context.secretsKey);
      }

      return removed ? new Response(null, { status: 204, headers }) : json(404, { error: 'not-found' }, headers);
    }

    // The teams the key reaches, for the person who chooses a destination: a page of them, and the
    // ones whose name holds `q` (FRU-501). `after` is the `next` of the page before.
    if (request.method !== 'GET') return json(405, { error: 'method-not-allowed' }, headers);
    if (!allowed('manage-sites')) return forbidden();
    if (context.secretsKey === undefined) return json(404, CONNECTORS_UNAVAILABLE, headers);
    const kept = await context.accounts.sealedKey(id);
    // A connector of another workspace answers like one that does not exist.
    if (kept === undefined || kept.workspaceId !== workspaceId) return json(404, { error: 'not-found' }, headers);
    // An address that only receives has no team to choose.
    if (kept.kind !== 'linear') return json(404, { error: 'not-found' }, headers);
    // This read is a call to the tracker like a note is, so what Linear answers is noted too
    // (FRU-102): somebody who opens the panel of a connector that Linear refuses sees it at once.
    const asked = new URL(request.url).searchParams;
    const search = asked.get('q')?.trim() ?? '';
    const after = asked.get('after') ?? undefined;
    if (search.length > MAX_TEAM_SEARCH || (after !== undefined && (after === '' || after.length > 200))) {
      return json(400, { error: 'invalid-query' }, headers);
    }
    const page = await askLinear(context, id, kept.sealed, (authorization) =>
      readLinearTeams(authorization, {
        ...(search === '' ? {} : { search }),
        ...(after === undefined ? {} : { after }),
      }),
    );

    return json(200, page, headers);
  }

  return undefined;
}
