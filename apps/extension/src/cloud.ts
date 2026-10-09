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
/** `locale` is the language of the account behind the session, when it holds one (FRU-131). */
export type WorkspaceSites = { workspace: { id: string; name: string }; sites: WorkspaceSite[]; locale?: string };
export type Offer = { endpoint: string; workspace: { id: string; name: string }; site: WorkspaceSite };

export type CloudSeams = {
  endpoints: () => Promise<string[]>;
  ensureAccess: (endpoint: string) => Promise<AccessResult>;
  fetcher?: typeof fetch;
};

/** The answer of `GET /session/sites`, parsed field by field: a bad entry costs that site. */
export function parseWorkspaceSites(body: unknown): WorkspaceSites | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { workspace, sites, locale } = body as { workspace?: unknown; sites?: unknown; locale?: unknown };
  if (typeof workspace !== 'object' || workspace === null || !Array.isArray(sites)) return undefined;
  const { id, name } = workspace as { id?: unknown; name?: unknown };
  if (typeof id !== 'string' || id === '') return undefined;

  return {
    ...(typeof locale === 'string' && locale !== '' && locale.length <= 35 ? { locale } : {}),
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

    const listed = await ask(endpoint, access.grant.accessToken, fetcher);
    if (listed === undefined || listed === NO_ACCOUNTS) continue;
    const site = listed.sites.find((each) => each.origin === origin);
    if (site !== undefined) return { endpoint, workspace: listed.workspace, site };
  }

  return undefined;
}

/** The worker answered, and it keeps no accounts: a self-hosted worker. It is an answer, not an outage. */
const NO_ACCOUNTS = 'no-accounts';

/**
 * One bounded `GET /session/sites`.
 *
 * `405` is a worker with no such route: it keeps no accounts, and its session routes take a POST
 * (measured; `session-sites.test.ts` of the worker pins it). `404` is read the same way. Any other
 * failure is no answer: a `401` is about the token, a `429` and a `5xx` are about the moment.
 */
async function ask(
  endpoint: string,
  accessToken: string,
  fetcher: typeof fetch,
): Promise<WorkspaceSites | typeof NO_ACCOUNTS | undefined> {
  try {
    const response = await fetcher(`${endpoint}/session/sites`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
    });

    if (response.status === 405 || response.status === 404) return NO_ACCOUNTS;

    return response.ok ? parseWorkspaceSites(await response.json()) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The language of the reviewer's account, from the first session whose worker says one (FRU-131).
 *
 * `no-answer` is not « no language »: a worker this browser is paired with did not answer, and no
 * other one said a language. The answer is no language only when every worker answered: with no
 * session at all, or with only workers that keep no accounts or hold no language.
 */
export async function accountLanguage({
  endpoints,
  ensureAccess,
  fetcher = fetch,
}: CloudSeams): Promise<{ locale?: string; from?: string } | 'no-answer'> {
  // WARNING: one worker that did not answer is enough to say nothing. The worker that is down can be
  // the one that holds the account, and « the others say no language » would then erase a language
  // that is still true.
  let silent = false;
  for (const endpoint of (await endpoints()).filter(isSecureWorkerEndpoint)) {
    const access = await ensureAccess(endpoint).catch(() => undefined);
    const listed = access?.ok === true ? await ask(endpoint, access.grant.accessToken, fetcher) : undefined;
    if (listed === undefined) {
      silent = true;
      continue;
    }
    // `from` is the worker that said it: the caller checks that its session is still there.
    if (listed !== NO_ACCOUNTS && listed.locale !== undefined) return { locale: listed.locale, from: endpoint };
  }

  return silent ? 'no-answer' : {};
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
