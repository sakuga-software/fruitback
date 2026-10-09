import { isSecureWorkerEndpoint } from './endpoint.ts';
import type { AccessResult } from './session.ts';
import type { SiteConfig } from './sites.ts';

/**
 * A site of the reviewer's workspace, turned on in one click (FRU-101, first step).
 *
 * A session opened from the console belongs to a workspace (FRU-95), and its worker can say which
 * sites that workspace reviews. When the tab is one of them, nothing is left to type: the worker is
 * the session's, the client id is the site's. The entry is team mode, so the relay and every one of
 * its refusals apply, and `mount` says the extension mounts the widget because the site embeds none.
 */

export type WorkspaceSite = { id: string; origin: string; visibility: 'members' | 'everyone' };
export type WorkspaceSites = { workspace: { id: string; name: string }; sites: WorkspaceSite[] };
export type Offer = { endpoint: string; workspace: { id: string; name: string }; site: WorkspaceSite };

export type CloudSeams = {
  endpoints: () => Promise<string[]>;
  ensureAccess: (endpoint: string) => Promise<AccessResult>;
  fetcher?: typeof fetch;
};

/** The answer of `GET /session/sites`, parsed field by field: a bad entry costs that site. */
export function parseWorkspaceSites(body: unknown): WorkspaceSites | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { workspace, sites } = body as { workspace?: unknown; sites?: unknown };
  if (typeof workspace !== 'object' || workspace === null || !Array.isArray(sites)) return undefined;
  const { id, name } = workspace as { id?: unknown; name?: unknown };
  if (typeof id !== 'string' || id === '') return undefined;

  return {
    workspace: { id, name: typeof name === 'string' ? name : '' },
    sites: sites.flatMap((site: unknown) => {
      if (typeof site !== 'object' || site === null) return [];
      const entry = site as { id?: unknown; origin?: unknown; visibility?: unknown };
      if (typeof entry.id !== 'string' || typeof entry.origin !== 'string') return [];
      const visibility = entry.visibility === 'everyone' ? 'everyone' : 'members';

      return [{ id: entry.id, origin: entry.origin, visibility }];
    }),
  };
}

/** Bounded, like every call the extension makes: a worker that never answers must not hold the popup. */
const ASK_TIMEOUT_MS = 5_000;

/**
 * The site of a workspace this origin is, through the first session that knows it, or nothing.
 *
 * Only over https or loopback, like every call that carries the session's token. A worker that does
 * not keep accounts answers no list, and that is not an error here: it is a self-hosted worker.
 */
export async function offerFor(
  origin: string,
  { endpoints, ensureAccess, fetcher = fetch }: CloudSeams,
): Promise<Offer | undefined> {
  for (const endpoint of await endpoints()) {
    if (!isSecureWorkerEndpoint(endpoint)) continue;

    const access = await ensureAccess(endpoint).catch(() => undefined);
    if (access === undefined || !access.ok) continue;

    try {
      const response = await fetcher(`${endpoint}/session/sites`, {
        headers: { Authorization: `Bearer ${access.grant.accessToken}` },
        signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
      });
      if (!response.ok) continue;
      const listed = parseWorkspaceSites(await response.json());
      const site = listed?.sites.find((each) => each.origin === origin);
      if (listed !== undefined && site !== undefined) return { endpoint, workspace: listed.workspace, site };
    } catch {
      continue;
    }
  }

  return undefined;
}

/** The entry the one click stores. */
export function cloudEntry(offer: Offer): SiteConfig {
  return {
    endpoint: offer.endpoint,
    enabled: true,
    mode: 'team',
    mount: { clientId: offer.site.id, ...(offer.workspace.name === '' ? {} : { workspace: offer.workspace.name }) },
  };
}
