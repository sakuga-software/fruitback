import type { AccountStore } from './accounts.ts';
import { readBearerToken, verifyIdentityToken } from './identity.ts';

/**
 * The sites of the workspace a session belongs to (FRU-101, the first step of it).
 *
 * The extension asks this with the access token of its session, and offers to turn on, in one click,
 * a tab whose origin is one of these sites. Nothing is typed: the worker is the one the session
 * belongs to, and the client id is the site's.
 *
 * Only a session that names a workspace gets an answer, and only while its person is still a member
 * of it: the role is read here, as the console's routes read it.
 */
export const SESSION_SITES_PATH = '/session/sites';

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

export async function handleSessionSites(
  request: Request,
  accounts: AccountStore,
  secret: string,
  headers: Record<string, string>,
  now?: number,
): Promise<Response> {
  if (request.method !== 'GET') return json(405, { error: 'method-not-allowed' }, headers);

  const token = readBearerToken(request.headers.get('Authorization'));
  if (token === undefined) return json(401, { error: 'identity-required' }, headers);
  const verified = await verifyIdentityToken(token, secret, now);
  if (!verified.ok) return json(401, { error: 'identity-required', reason: verified.reason }, headers);

  const subject = verified.reporter.id;
  const workspaceId = verified.workspace;
  if (subject === undefined || workspaceId === undefined) {
    return json(401, { error: 'identity-required', reason: 'no-workspace' }, headers);
  }

  const role = await accounts.role(workspaceId, subject);
  if (role === undefined) return json(401, { error: 'identity-required', reason: 'not-a-member' }, headers);

  const workspace = (await accounts.memberships(subject)).find((each) => each.workspace.id === workspaceId)?.workspace;
  const sites = await accounts.sites(workspaceId);
  // The language the person reads (FRU-119), so the extension and its widget speak it too (FRU-131).
  const locale = (await accounts.account(subject))?.locale;

  return json(
    200,
    {
      workspace: { id: workspaceId, name: workspace?.name ?? '' },
      ...(locale === undefined ? {} : { locale }),
      sites: sites.map((site) => ({ id: site.id, origin: site.origin, visibility: site.visibility })),
    },
    headers,
  );
}
