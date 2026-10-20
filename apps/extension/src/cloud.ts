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

/** The notes of a site by stage (FRU-237), as the worker counts them. Absent when its index did not answer. */
export type StageCounts = { seeded: number; green: number; ripening: number; ripe: number; composted: number };

export const STAGES = ['seeded', 'green', 'ripening', 'ripe', 'composted'] as const;

/**
 * A workspace of the session, and the role the person holds there (an account's session only).
 * `canAddSite`: the role may add a site there from the popup (FRU-255), as the worker read it now.
 */
export type Workspace = { id: string; name: string; role?: string; canAddSite?: boolean };

/**
 * `previews`: the wildcards the workspace proved for this site (FRU-103), as the worker lists them now.
 * `workspace`: the one it is a site of. `notes`: its counts (FRU-237), when the worker gave them.
 */
export type WorkspaceSite = {
  id: string;
  origin: string;
  visibility: 'members' | 'everyone';
  workspace: Workspace;
  previews?: string[];
  notes?: StageCounts;
  /**
   * Where the notes of the site go (FRU-295): « Linear · Northwind », or « Fruitback ». Only for a
   * role that sees the tracker. Absent: not known, never « nowhere ».
   */
  destination?: { label: string };
  /**
   * The notes of the person that the team marked done and that they did not confirm (FRU-295), for
   * the session of an account. Absent: not known, never zero.
   */
  toCheck?: number;
};
/**
 * What `GET /session/sites` lists, in either of its two shapes: a pairing's session names one
 * `workspace`; an account's (FRU-238) names its `workspaces`, and each site says which it is of.
 * `locale` is the language of the account behind the session, when it holds one (FRU-131).
 */
export type WorkspaceSites = { workspaces: Workspace[]; sites: WorkspaceSite[]; locale?: string; account: boolean };
/** `pattern` is the rule the click stores: the origin of the site, or the wildcard of its previews. */
export type Offer = { endpoint: string; workspace: Workspace; site: WorkspaceSite; pattern: string };

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
  const { workspace, workspaces, sites, locale, account } = body as Record<string, unknown>;
  if (!Array.isArray(sites)) return undefined;

  const accountShape = account === true;
  const known = accountShape
    ? (Array.isArray(workspaces) ? workspaces : []).flatMap((entry: unknown) => workspaceOf(entry) ?? [])
    : [workspaceOf(workspace)].flatMap((entry) => entry ?? []);
  // A pairing's session with no workspace answers nothing: it is not a list of nothing.
  if (!accountShape && known.length === 0) return undefined;
  const byId = new Map(known.map((each) => [each.id, each]));

  return {
    ...(typeof locale === 'string' && locale !== '' && locale.length <= 35 ? { locale } : {}),
    account: accountShape,
    workspaces: known,
    sites: sites.flatMap((site: unknown) => {
      if (typeof site !== 'object' || site === null) return [];
      const entry = site as Record<string, unknown>;
      if (typeof entry.id !== 'string' || typeof entry.origin !== 'string') return [];
      // An account's site names its workspace; one the list does not hold costs the site.
      const named = typeof entry.workspace === 'string' ? byId.get(entry.workspace) : undefined;
      const of = accountShape ? named : known[0];
      if (of === undefined) return [];
      const visibility = entry.visibility === 'everyone' ? 'everyone' : 'members';
      // A wildcard in another spelling than the one a rule is keyed on is dropped: it would match no rule.
      const previews = Array.isArray(entry.previews)
        ? entry.previews.flatMap((pattern: unknown) => readPreviewPattern(pattern) ?? [])
        : [];
      const notes = countsOf(entry.notes);
      const destination = destinationOf(entry.destination);
      const toCheck = countOf(entry.toCheck);

      return [
        {
          id: entry.id,
          origin: entry.origin,
          visibility,
          workspace: of,
          ...(previews.length === 0 ? {} : { previews }),
          ...(notes === undefined ? {} : { notes }),
          ...(destination === undefined ? {} : { destination }),
          ...(toCheck === undefined ? {} : { toCheck }),
        },
      ];
    }),
  };
}

/** The label of a destination: a short line of text, or nothing. */
function destinationOf(value: unknown): { label: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { label } = value as Record<string, unknown>;
  if (typeof label !== 'string') return undefined;
  const flat = label.replace(/\s+/gu, ' ').trim();

  return flat === '' || flat.length > 200 ? undefined : { label: flat };
}

/** A count the worker gave: a whole number from zero, or nothing. */
function countOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function workspaceOf(value: unknown): Workspace | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { id, name, role, canAddSite } = value as Record<string, unknown>;
  if (typeof id !== 'string' || id === '') return undefined;

  return {
    id,
    name: typeof name === 'string' ? name : '',
    ...(typeof role === 'string' && role !== '' ? { role } : {}),
    ...(canAddSite === true ? { canAddSite: true } : {}),
  };
}

/** Five whole numbers or nothing: a count that is not one would draw a bar that lies. */
function countsOf(value: unknown): StageCounts | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const counts = value as Record<string, unknown>;
  const whole = (stage: string): number | undefined => {
    const count = counts[stage];

    return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
  };
  const [seeded, green, ripening, ripe, composted] = STAGES.map(whole);
  if (seeded === undefined || green === undefined || ripening === undefined || ripe === undefined) return undefined;
  if (composted === undefined) return undefined;

  return { seeded, green, ripening, ripe, composted };
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
    if (site !== undefined) return { endpoint, workspace: site.workspace, site, pattern: origin };
    // FRU-103: a page under a domain the workspace proved is a preview of the site the worker named.
    for (const each of listed.sites) {
      const pattern = each.previews?.find((wildcard) => coversOrigin(wildcard, origin));
      if (pattern !== undefined) return { endpoint, workspace: each.workspace, site: each, pattern };
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
 * `405` is a worker of before FRU-225 with no such route: it keeps no accounts, and its session
 * routes take a POST (measured). A worker of today always has accounts, so it never answers `405`
 * here. Any other failure is no answer: a `401` is about the token, and a `404`, a `429` and a `5xx`
 * are about the moment. A proxy that routes wrong while a worker deploys answers `404`, and that must
 * not read as « no accounts ».
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

/**
 * The workspaces of the account behind `endpoint` where it may add a site (FRU-255), or `undefined`
 * when the worker said nothing. A session of a pairing adds none: it names one workspace, and stays a
 * reader.
 */
export async function addableWorkspaces(endpoint: string, seams: CloudSeams): Promise<Workspace[] | undefined> {
  const listed = await listedBy(endpoint, seams);
  if (listed === undefined) return undefined;

  return listed.account ? listed.workspaces.filter((workspace) => workspace.canAddSite === true) : [];
}

export type AddFailure = 'forbidden' | 'rate-limited' | 'signed-out' | 'unavailable';
export type AddResult = { ok: true; offer: Offer } | { ok: false; reason: AddFailure };

/**
 * `POST /session/sites`: the site of the tab, added to a workspace of the account (FRU-255). The
 * answer is an offer like the one of a site already listed, so the same click turns it on.
 */
export async function addSite(
  endpoint: string,
  workspace: Workspace,
  origin: string,
  seams: Pick<CloudSeams, 'ensureAccess' | 'fetcher'>,
): Promise<AddResult> {
  const access = await seams.ensureAccess(endpoint).catch(() => undefined);
  if (access === undefined || (!access.ok && access.reason === 'unavailable'))
    return { ok: false, reason: 'unavailable' };
  if (!access.ok) return { ok: false, reason: 'signed-out' };

  let response: Response;
  try {
    response = await (seams.fetcher ?? fetch)(`${endpoint}/session/sites`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${access.grant.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: workspace.id, origin }),
      signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (response.status === 403 || response.status === 404) return { ok: false, reason: 'forbidden' };
  if (response.status === 429) return { ok: false, reason: 'rate-limited' };
  if (response.status === 401) return { ok: false, reason: 'signed-out' };
  if (response.status !== 200 && response.status !== 201) return { ok: false, reason: 'unavailable' };

  const body: unknown = await response.json().catch(() => undefined);
  const site = typeof body === 'object' && body !== null ? (body as { site?: unknown }).site : undefined;
  const parsed = parseWorkspaceSites({ account: true, workspaces: [workspace], sites: [site] })?.sites[0];
  // The worker added the site of this tab, in this workspace, or the answer is not believed.
  if (parsed === undefined || parsed.origin !== origin || parsed.workspace.id !== workspace.id) {
    return { ok: false, reason: 'unavailable' };
  }

  return { ok: true, offer: { endpoint, workspace, site: parsed, pattern: origin } };
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
