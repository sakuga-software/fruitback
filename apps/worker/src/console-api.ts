import {
  type AccountStore,
  type Action,
  type Site,
  VISIBILITIES,
  type Visibility,
  can,
  siteOrigin,
} from './accounts.ts';
import { readBearerToken, verifyIdentityToken } from './identity.ts';
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

export type ConsoleApiContext = { accounts: AccountStore; sessions: SessionStore; secret: string; now?: number };

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
function siteView(site: Site): { id: string; origin: string; visibility: Visibility } {
  return { id: site.id, origin: site.origin, visibility: site.visibility };
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
  const isApi = pathname === '/console/me' || pathname === '/console/workspaces' || WORKSPACE_PATH.test(pathname);
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

      return json(200, { sites: (await context.accounts.sites(workspaceId as string)).map(siteView) }, headers);
    }
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
    if (!allowed('manage-sites')) return forbidden();

    const body = await readBody(request);
    const origin = typeof body?.url === 'string' ? siteOrigin(body.url) : undefined;
    if (origin === undefined) return json(400, { error: 'invalid-url' }, headers);
    const visibility = visibilityOf(body?.visibility ?? 'members');
    if (visibility === undefined) return json(400, { error: 'invalid-visibility' }, headers);

    const site = await context.accounts.addSite(workspaceId as string, { origin, visibility });

    return json(201, siteView(site), headers);
  }

  const removal = /^\/sites\/([A-Za-z0-9_-]+)$/.exec(rest);
  if (removal !== null) {
    if (request.method !== 'DELETE') return json(405, { error: 'method-not-allowed' }, headers);
    if (!allowed('manage-sites')) return forbidden();

    const removed = await context.accounts.removeSite(workspaceId as string, removal[1] as string);

    return removed ? new Response(null, { status: 204, headers }) : json(404, { error: 'not-found' }, headers);
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
