import type { AccountStore } from './accounts.ts';
import { previewPattern, proofState } from './domain-proof.ts';
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
  // A session of an account (FRU-238): the sites of every workspace it is a member of today.
  if (verified.account === true && subject !== undefined) {
    return json(200, await sitesOfAccount(accounts, subject, now ?? Date.now()), headers);
  }
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
  const previewsOf = await previewsIn(accounts, workspaceId, now ?? Date.now());

  return json(
    200,
    {
      workspace: { id: workspaceId, name: workspace?.name ?? '' },
      ...(locale === undefined ? {} : { locale }),
      sites: sites.map((site) => {
        const previews = previewsOf(site.id);

        return {
          id: site.id,
          origin: site.origin,
          visibility: site.visibility,
          ...(previews.length === 0 ? {} : { previews }),
        };
      }),
    },
    headers,
  );
}

/**
 * The previews a site covers (FRU-103): the wildcard of each domain of the workspace that is proven
 * now and names this site. A proof that is lost or that nobody confirmed is not here.
 */
async function previewsIn(accounts: AccountStore, workspace: string, now: number): Promise<(site: string) => string[]> {
  const proven = (await accounts.domains(workspace)).filter(
    (domain) => domain.previewsSite !== undefined && proofState(domain, now) === 'proven',
  );

  return (site) =>
    proven.filter((domain) => domain.previewsSite === site).map((domain) => previewPattern(domain.domain));
}

/**
 * What a session of an account reads (FRU-238): every workspace the account is a member of now, with
 * the role it has there, and the sites of each, each naming its workspace. The memberships are read
 * at this call: a workspace the account left is not here, and an account in none reads an empty list.
 *
 * No `workspace` in the singular: the extension of before reads this answer as « no list », and asks
 * nothing of a session it does not know.
 */
async function sitesOfAccount(accounts: AccountStore, account: string, now: number) {
  const memberships = await accounts.memberships(account);
  const locale = (await accounts.account(account))?.locale;
  const sites = [];
  for (const { workspace } of memberships) {
    const previewsOf = await previewsIn(accounts, workspace.id, now);
    for (const site of await accounts.sites(workspace.id)) {
      const previews = previewsOf(site.id);
      sites.push({
        id: site.id,
        origin: site.origin,
        visibility: site.visibility,
        workspace: workspace.id,
        ...(previews.length === 0 ? {} : { previews }),
      });
    }
  }

  return {
    account: true,
    ...(locale === undefined ? {} : { locale }),
    workspaces: memberships.map(({ workspace, role }) => ({ id: workspace.id, name: workspace.name, role })),
    sites,
  };
}
