import {
  type AccountStore,
  type Action,
  type Connector,
  type Destination,
  type Site,
  VISIBILITIES,
  type Visibility,
  can,
  siteOrigin,
  readLocaleTag,
} from './accounts.ts';
import { readBearerToken, verifyIdentityToken } from './identity.ts';
import { listLinearTeams } from './linear.ts';
import { open, seal } from './secrets.ts';
import { StoreError } from './store.ts';
import { PAIRING_TTL_SECONDS, type SessionStore, createPairing } from './session.ts';

/**
 * What the console reads and writes (FRU-99): the account, its workspaces, their sites, and the code
 * that connects a browser (FRU-100).
 *
 * **Every call is a person, checked twice.** The access token says who, and the role this person has
 * in the workspace, read from the accounts on every call, says what. A token says nothing about a
 * role: a member removed a minute ago still holds a token for ten minutes, and the role is what stops
 * them.
 */

export type ConsoleApiContext = {
  accounts: AccountStore;
  sessions: SessionStore;
  secret: string;
  now?: number;
  /** What opens and closes the connector keys (FRU-121). Absent, a workspace connects no tracker. */
  secretsKey?: string;
};

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
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

/** A workspace name is a label a person reads: one line, and short. */
const MAX_NAME = 80;

function workspaceName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.replace(/\s+/g, ' ').trim();

  return name === '' || name.length > MAX_NAME ? undefined : name;
}

function visibilityOf(value: unknown): Visibility | undefined {
  return (VISIBILITIES as readonly unknown[]).includes(value) ? (value as Visibility) : undefined;
}

/** The fields of a site the console shows, and the client id a script tag names. */
type SiteView = { id: string; origin: string; visibility: Visibility; destination?: Destination };

/** WARNING: the destination names the tracker, so it is for a role that may see the tracker only. */
function siteView(site: Site, seesTracker: boolean): SiteView {
  return {
    id: site.id,
    origin: site.origin,
    visibility: site.visibility,
    ...(seesTracker && site.destination !== undefined ? { destination: site.destination } : {}),
  };
}

const CONNECTORS_UNAVAILABLE = { error: 'connectors-unavailable' } as const;

function connectorView(connector: Connector): { id: string; kind: string; label: string; createdAt: string } {
  return { id: connector.id, kind: connector.kind, label: connector.label, createdAt: connector.createdAt };
}

const ID = /^[A-Za-z0-9_-]{1,80}$/;

function destinationOf(body: Record<string, unknown> | undefined): Destination | undefined {
  const { connector, teamId, projectId } = body ?? {};
  if (typeof connector !== 'string' || !ID.test(connector) || typeof teamId !== 'string' || !ID.test(teamId)) {
    return undefined;
  }
  if (projectId !== undefined && projectId !== null && (typeof projectId !== 'string' || !ID.test(projectId))) {
    return undefined;
  }

  return { connector, teamId, ...(typeof projectId === 'string' ? { projectId } : {}) };
}

const WORKSPACE_PATH = /^\/console\/workspaces\/([A-Za-z0-9_-]+)(\/.*)?$/;

/**
 * The console's routes under `/console/`, except the session ones, or `undefined` for a path that is
 * not one of them.
 */
export async function handleConsoleApi(
  request: Request,
  pathname: string,
  context: ConsoleApiContext,
  headers: Record<string, string>,
): Promise<Response | undefined> {
  const isApi =
    pathname === '/console/me' ||
    pathname === '/console/me/locale' ||
    pathname === '/console/workspaces' ||
    WORKSPACE_PATH.test(pathname);
  if (!isApi) return undefined;

  const token = readBearerToken(request.headers.get('Authorization'));
  if (token === undefined) return json(401, { error: 'identity-required' }, headers);
  const verified = await verifyIdentityToken(token, context.secret, context.now);
  if (!verified.ok) return json(401, { error: 'identity-required', reason: verified.reason }, headers);

  const subject = verified.reporter.id;
  if (subject === undefined) return json(401, { error: 'identity-required', reason: 'invalid-claims' }, headers);
  const account = await context.accounts.account(subject);
  if (account === undefined) return json(401, { error: 'identity-required', reason: 'no-account' }, headers);

  if (pathname === '/console/me') {
    if (request.method !== 'GET') return json(405, { error: 'method-not-allowed' }, headers);
    const memberships = await context.accounts.memberships(account.id);

    return json(
      200,
      { account, workspaces: memberships.map(({ workspace, role }) => ({ ...workspace, role })) },
      headers,
    );
  }

  // The language the person reads (FRU-119). Their own account only: the subject of the token.
  if (pathname === '/console/me/locale') {
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
    const body = (await request.json().catch(() => undefined)) as { locale?: unknown } | undefined;
    const locale = body?.locale === null ? undefined : readLocaleTag(body?.locale);
    if (body?.locale !== null && locale === undefined) return json(400, { error: 'invalid-locale' }, headers);
    await context.accounts.setLocale(account.id, locale);

    return json(200, { account: { ...account, locale } }, headers);
  }

  if (pathname === '/console/workspaces') {
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
    const name = workspaceName((await readBody(request))?.name);
    if (name === undefined) return json(400, { error: 'invalid-name' }, headers);
    const workspace = await context.accounts.createWorkspace(name, account.id);

    return json(201, { ...workspace, role: 'owner' }, headers);
  }

  const [, workspaceId, rest = ''] = WORKSPACE_PATH.exec(pathname) as RegExpExecArray;
  const role = await context.accounts.role(workspaceId as string, account.id);
  // Not a member answers like a workspace that does not exist: a caller must not learn which ids are real.
  if (role === undefined) return json(404, { error: 'not-found' }, headers);
  const allowed = (action: Action): boolean => can(role, action);
  const forbidden = (): Response => json(403, { error: 'forbidden', role }, headers);

  if (rest === '/sites') {
    if (request.method === 'GET') {
      if (!allowed('read-feedback')) return forbidden();

      const seesTracker = allowed('see-tracker');
      const sites = await context.accounts.sites(workspaceId as string);

      return json(200, { sites: sites.map((site) => siteView(site, seesTracker)) }, headers);
    }
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
    if (!allowed('manage-sites')) return forbidden();

    const body = await readBody(request);
    const origin = typeof body?.url === 'string' ? siteOrigin(body.url) : undefined;
    if (origin === undefined) return json(400, { error: 'invalid-url' }, headers);
    const visibility = visibilityOf(body?.visibility ?? 'members');
    if (visibility === undefined) return json(400, { error: 'invalid-visibility' }, headers);

    const site = await context.accounts.addSite(workspaceId as string, { origin, visibility });

    return json(201, siteView(site, allowed('see-tracker')), headers);
  }

  const removal = /^\/sites\/([A-Za-z0-9_-]+)$/.exec(rest);
  if (removal !== null) {
    if (request.method !== 'DELETE') return json(405, { error: 'method-not-allowed' }, headers);
    if (!allowed('manage-sites')) return forbidden();

    const removed = await context.accounts.removeSite(workspaceId as string, removal[1] as string);

    return removed ? new Response(null, { status: 204, headers }) : json(404, { error: 'not-found' }, headers);
  }

  // Where the notes of a site go (FRU-121): a connector of this workspace, or the worker's own store.
  const destination = /^\/sites\/([A-Za-z0-9_-]+)\/destination$/.exec(rest);
  if (destination !== null) {
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
    if (!allowed('manage-sites')) return forbidden();

    const body = await readBody(request);
    const wanted = body?.connector === null ? undefined : destinationOf(body);
    if (body?.connector !== null && wanted === undefined) return json(400, { error: 'invalid-destination' }, headers);
    const set = await context.accounts.setDestination(workspaceId as string, destination[1] as string, wanted);

    return set ? json(200, { destination: wanted ?? null }, headers) : json(404, { error: 'not-found' }, headers);
  }

  if (rest === '/connectors') {
    if (request.method === 'GET') {
      if (!allowed('see-tracker')) return forbidden();
      const connectors = await context.accounts.connectors(workspaceId as string);

      return json(
        200,
        { connectors: connectors.map(connectorView), available: context.secretsKey !== undefined },
        headers,
      );
    }
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
    if (!allowed('manage-workspace')) return forbidden();
    if (context.secretsKey === undefined) return json(404, CONNECTORS_UNAVAILABLE, headers);

    const body = await readBody(request);
    const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
    if (body?.kind !== 'linear' || apiKey === '') return json(400, { error: 'invalid-connector' }, headers);

    // Asked before anything is kept: a key the tracker refuses is never stored.
    let viewer: string;
    try {
      viewer = (await listLinearTeams(apiKey)).viewer;
    } catch (error) {
      if (error instanceof StoreError) return json(400, { error: 'key-refused' }, headers);
      throw error;
    }
    const connector = await context.accounts.addConnector(workspaceId as string, {
      kind: 'linear',
      label: viewer === '' ? 'Linear' : `Linear · ${viewer}`,
      sealed: seal(apiKey, context.secretsKey),
    });

    return json(201, connectorView(connector), headers);
  }

  const connector = /^\/connectors\/([A-Za-z0-9_-]+)(\/teams)?$/.exec(rest);
  if (connector !== null) {
    const id = connector[1] as string;
    if (connector[2] === undefined) {
      if (request.method !== 'DELETE') return json(405, { error: 'method-not-allowed' }, headers);
      if (!allowed('manage-workspace')) return forbidden();
      const removed = await context.accounts.removeConnector(workspaceId as string, id);

      return removed ? new Response(null, { status: 204, headers }) : json(404, { error: 'not-found' }, headers);
    }

    // The teams the key reaches, for the person who chooses a destination.
    if (request.method !== 'GET') return json(405, { error: 'method-not-allowed' }, headers);
    if (!allowed('manage-sites')) return forbidden();
    if (context.secretsKey === undefined) return json(404, CONNECTORS_UNAVAILABLE, headers);
    const kept = await context.accounts.sealedKey(id);
    // A connector of another workspace answers like one that does not exist.
    if (kept === undefined || kept.workspaceId !== workspaceId) return json(404, { error: 'not-found' }, headers);
    const apiKey = open(kept.sealed, context.secretsKey);
    if (apiKey === undefined) return json(502, { error: 'store-unavailable' }, headers);

    return json(200, { teams: (await listLinearTeams(apiKey)).teams }, headers);
  }

  if (rest === '/connect') {
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
    if (!allowed('read-feedback')) return forbidden();

    // FRU-100: a code for this person, in this workspace. The console puts it after the `#` of the
    // worker's pairing page, and the extension reads it from there (FRU-92).
    const { code, expiresAt } = await createPairing(
      context.sessions,
      {
        subject: account.id,
        email: account.email,
        workspace: workspaceId as string,
        ...(account.name === undefined ? {} : { name: account.name }),
      },
      context.now,
    );

    return json(201, { code, expiresIn: PAIRING_TTL_SECONDS, expiresAt: new Date(expiresAt).toISOString() }, headers);
  }

  if (rest === '') {
    if (request.method !== 'DELETE') return json(405, { error: 'method-not-allowed' }, headers);
    if (!allowed('delete-workspace')) return forbidden();
    await context.accounts.deleteWorkspace(workspaceId as string);

    return new Response(null, { status: 204, headers });
  }

  return json(404, { error: 'not-found' }, headers);
}
