import { isSecureWorkerEndpoint } from './endpoint.ts';
import { type ListedPreviews, listedPreviews, readPreviewPattern } from './proven-previews.ts';
import { coversOrigin } from './site-patterns.ts';
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

/** `previews`: the wildcards the workspace proved for this site (FRU-103), as the worker lists them now. */
export type WorkspaceSite = { id: string; origin: string; visibility: 'members' | 'everyone'; previews?: string[] };
/** `locale` is the language of the account behind the session, when it holds one (FRU-131). */
export type WorkspaceSites = { workspace: { id: string; name: string }; sites: WorkspaceSite[]; locale?: string };
/** `pattern` is the rule the click stores: the origin of the site, or the wildcard of its previews. */
export type Offer = { endpoint: string; workspace: { id: string; name: string }; site: WorkspaceSite; pattern: string };

export type CloudSeams = {
  endpoints: () => Promise<string[]>;
  ensureAccess: (endpoint: string) => Promise<AccessResult>;
  fetcher?: typeof fetch;
  /**
   * Keeps the previews a worker just listed (FRU-103), or forgets a worker that keeps no accounts.
   * Called with every answer, so what this browser grants is never older than its last question.
   */
  remember?: (endpoint: string, listed: ListedPreviews | undefined) => Promise<void>;
  /**
   * The mark of the session this browser holds with a worker: nothing when it holds none, and
   * another value once a session started or ended (its epoch). An answer is kept only for the
   * session that asked. Absent, « still paired » is all that is compared.
   */
  sessionOf?: (endpoint: string) => Promise<string | undefined>;
  now?: () => number;
};

/** See `CloudSeams.sessionOf`. */
async function sessionMark(endpoint: string, seams: CloudSeams): Promise<string | undefined> {
  if (seams.sessionOf !== undefined) return seams.sessionOf(endpoint);

  return (await seams.endpoints()).includes(endpoint) ? '' : undefined;
}

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
      const entry = site as { id?: unknown; origin?: unknown; visibility?: unknown; previews?: unknown };
      if (typeof entry.id !== 'string' || typeof entry.origin !== 'string') return [];
      const visibility = entry.visibility === 'everyone' ? 'everyone' : 'members';
      // A wildcard in another spelling than the one a rule is keyed on is dropped: it would match no rule.
      const previews = Array.isArray(entry.previews)
        ? entry.previews.flatMap((pattern: unknown) => readPreviewPattern(pattern) ?? [])
        : [];

      return [{ id: entry.id, origin: entry.origin, visibility, ...(previews.length === 0 ? {} : { previews }) }];
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
export async function offerFor(origin: string, seams: CloudSeams): Promise<Offer | undefined> {
  for (const endpoint of await seams.endpoints()) {
    const listed = await listedBy(endpoint, seams);
    if (listed === undefined) continue;
    // The site itself first: a page that is a site of the workspace is that site, whatever covers it.
    const site = listed.sites.find((each) => each.origin === origin);
    if (site !== undefined) return { endpoint, workspace: listed.workspace, site, pattern: origin };
    // FRU-103: a page under a domain the workspace proved is a preview of the site the worker named.
    for (const each of listed.sites) {
      const pattern = each.previews?.find((wildcard) => coversOrigin(wildcard, origin));
      if (pattern !== undefined) return { endpoint, workspace: listed.workspace, site: each, pattern };
    }
  }

  return undefined;
}

/**
 * What a worker lists now, kept as the previews this browser grants (FRU-103), or `undefined` when
 * it said nothing. A worker that keeps no accounts lists nothing, and what it listed before goes. A
 * worker that did not answer changes nothing: what it listed ages by itself.
 */
async function listedBy(endpoint: string, seams: CloudSeams): Promise<WorkspaceSites | undefined> {
  const { ensureAccess, fetcher = fetch, remember, now = Date.now } = seams;
  if (!isSecureWorkerEndpoint(endpoint)) return undefined;

  const asking = await sessionMark(endpoint, seams);
  if (asking === undefined) return undefined;
  const access = await ensureAccess(endpoint).catch(() => undefined);
  if (access === undefined || !access.ok) return undefined;

  const listed = await ask(endpoint, access.grant.accessToken, fetcher);
  if (listed === undefined) return undefined;
  // WARNING: the answer took a call to the worker, and a logout or a new pairing can land in that
  // time. The background forgets the list at that instant (`session-previews.ts`), and an answer
  // written after it would put back the list of the session of before: nobody asks a worker again
  // once it is logged out, and after a new pairing the list of one account would serve another.
  // So the session is read again, and the answer of a session that is gone is dropped.
  if ((await sessionMark(endpoint, seams)) !== asking) return undefined;
  await remember?.(endpoint, listed === NO_ACCOUNTS ? undefined : listedPreviews(listed.sites, now())).catch(
    () => undefined,
  );
  // And once more after the write: the read above and the write are two steps, and the session can
  // end between them, after the background has already forgotten.
  if ((await sessionMark(endpoint, seams)) !== asking) {
    await remember?.(endpoint, undefined).catch(() => undefined);

    return undefined;
  }

  return listed === NO_ACCOUNTS ? undefined : listed;
}

/**
 * Asks every paired worker again what its workspace proved (FRU-103). The background calls it on a
 * timer: a proof that a worker lost stops granting here at the next call.
 */
export async function refreshPreviews(seams: CloudSeams): Promise<void> {
  for (const endpoint of await seams.endpoints()) await listedBy(endpoint, seams);
}

/** The worker answered, and it keeps no accounts: a self-hosted worker. It is an answer, not an outage. */
const NO_ACCOUNTS = 'no-accounts';

/**
 * One bounded `GET /session/sites`.
 *
 * `405` is a worker with no such route: it keeps no accounts, and its session routes take a POST
 * (measured; `session-sites.test.ts` of the worker pins it). Any other failure is no answer: a `401`
 * is about the token, and a `404`, a `429` and a `5xx` are about the moment. A proxy that routes
 * wrong while a worker deploys answers `404`, and that must not read as « no accounts ».
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

    if (response.status === 405) return NO_ACCOUNTS;

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
