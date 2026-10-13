import type { AccountStore } from './accounts.ts';
import { previewPattern, proofState } from './domain-proof.ts';
import { readBearerToken, verifyIdentityToken } from './identity.ts';
import { type NoteIndex, noNotes } from './notes-index.ts';

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
  noteIndex?: NoteIndex,
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
  // The previews a site covers (FRU-103): the wildcard of each domain of the workspace that is proven
  // now and names this site. A proof that is lost or that nobody confirmed is not here.
  const instant = now ?? Date.now();
  const proven = (await accounts.domains(workspaceId)).filter(
    (domain) => domain.previewsSite !== undefined && proofState(domain, instant) === 'proven',
  );
  // FRU-237: what the popup counts on a site (06, 07). What did not arrive stays in the console.
  // An index that does not answer costs the counts, never the sites.
  const notes = await noteIndex?.summary(workspaceId).catch((error: unknown) => {
    console.error(
      `[fruitback] the index of the notes did not answer: ${error instanceof Error ? error.message : String(error)}`,
    );

    return undefined;
  });
  const previewsOf = (site: string): string[] =>
    proven.filter((domain) => domain.previewsSite === site).map((domain) => previewPattern(domain.domain));

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
          ...(notes === undefined ? {} : (notes.get(site.id) ?? noNotes())),
        };
      }),
    },
    headers,
  );
}
