import type { AccessFailure, AccessResult } from './session.ts';

/**
 * The notes of a whole site, for the scope « Whole site » of the side panel (FRU-307): one page of
 * `GET /session/notes` of the worker (FRU-306), with the session of the extension.
 *
 * **The worker is the one source.** The panel holds the answer it shows while it is open, and asks
 * again for each new search, scope or « Show more »: nothing is kept in storage, nothing is read from
 * an older answer. The answer holds excerpts of 64 characters at most, never a reply: a row opens the
 * page of its note, and the widget reads it there.
 *
 * No `browser` here: the session and `fetch` come in as seams, so `site-notes.test.ts` reads every
 * answer under `node --test`.
 */

/** The path of the route, after the endpoint of the worker. */
export const SITE_NOTES_PATH = '/session/notes';

/** The most notes one answer holds (`PAGE_SIZES.max` of the worker). */
export const SITE_PAGE_SIZE = 50;

/** As long as a read of the popup may take: the panel says « could not be read » after it. */
const READ_TIMEOUT_MS = 10_000;

const STAGES = ['new', 'todo', 'progress', 'done', 'closed'] as const;
export type SiteStage = (typeof STAGES)[number];

/** A note of the site, as the index of the worker keeps it. */
export type SiteNote = {
  /** The id the widget gave the note: the widget finds it on its page by this. */
  seed: string;
  excerpt: string;
  page: { url: string; path: string };
  stage: SiteStage;
  /** The name of the author, when the worker gives one: a member of the workspace. */
  author?: string;
  /** The author is the reader. */
  mine?: true;
  /** The issue in the tracker, for a role that sees it. */
  reference?: string;
  referenceUrl?: string;
  createdAt: string;
};

export type SitePage = { notes: SiteNote[]; total: number; next?: string };

/**
 * What a read answered. `signed-out`: the session ended, the popup signs in again. `unavailable`: a
 * worker of before FRU-306, or a site the session does not read. `failed`: nothing answered.
 */
export type SiteRead = { ok: true; page: SitePage } | { ok: false; reason: 'signed-out' | 'unavailable' | 'failed' };

export type SiteNotesSeams = {
  ensureAccess: (endpoint: string) => Promise<AccessResult>;
  /** A new token because the worker refused this one: `Sessions.renewAccess`. */
  renewAccess?: (endpoint: string, refused: string) => Promise<AccessResult>;
  fetcher?: typeof fetch;
};

export type SiteQuery = { site: string; q?: string; cursor?: string };

/** One page of the notes of `site`, the newest first. Never rejects. */
export async function readSiteNotes(endpoint: string, query: SiteQuery, seams: SiteNotesSeams): Promise<SiteRead> {
  const access = await seams.ensureAccess(endpoint).catch(() => undefined);
  if (access === undefined) return { ok: false, reason: 'failed' };
  if (!access.ok) return { ok: false, reason: ACCESS_REFUSED[access.reason] };

  let answer = await ask(endpoint, query, access.grant.accessToken, seams.fetcher ?? fetch);
  // An access token that was only old: renewed once, then asked once more.
  if (answer === 401 && seams.renewAccess !== undefined) {
    const renewed = await seams.renewAccess(endpoint, access.grant.accessToken).catch(() => undefined);
    if (renewed?.ok !== true) return { ok: false, reason: renewed === undefined ? 'failed' : 'signed-out' };
    answer = await ask(endpoint, query, renewed.grant.accessToken, seams.fetcher ?? fetch);
  }
  if (answer === 401) return { ok: false, reason: 'signed-out' };
  if (answer === 404 || answer === 405) return { ok: false, reason: 'unavailable' };
  if (typeof answer === 'number' || answer === undefined) return { ok: false, reason: 'failed' };

  const page = parseSitePage(answer);

  return page === undefined ? { ok: false, reason: 'failed' } : { ok: true, page };
}

/**
 * A session that could not give a token. `not-paired` and `insecure-endpoint`: this browser holds no
 * session that may read there, so the site has no whole-site list here.
 */
const ACCESS_REFUSED: Record<AccessFailure, 'signed-out' | 'unavailable' | 'failed'> = {
  'session-revoked-or-expired': 'signed-out',
  unavailable: 'failed',
  'not-paired': 'unavailable',
  'insecure-endpoint': 'unavailable',
};

/** The address of one read: the site, the words, where the page starts. */
export function siteNotesUrl(endpoint: string, query: SiteQuery): string {
  const params = new URLSearchParams({ site: query.site, limit: String(SITE_PAGE_SIZE) });
  const words = query.q?.trim();
  if (words !== undefined && words !== '') params.set('q', words);
  if (query.cursor !== undefined) params.set('cursor', query.cursor);

  return `${endpoint}${SITE_NOTES_PATH}?${params.toString()}`;
}

/** The body of a `200`, the status of anything else, or `undefined` when nothing answered. */
async function ask(endpoint: string, query: SiteQuery, token: string, fetcher: typeof fetch): Promise<unknown> {
  try {
    const response = await fetcher(siteNotesUrl(endpoint, query), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (!response.ok) return response.status;

    return await response.json();
  } catch {
    return undefined;
  }
}

const MAX_TEXT = 2_000;

function text(value: unknown, max = MAX_TEXT): string | undefined {
  return typeof value === 'string' && value.length <= max ? value : undefined;
}

/** An answer of the worker, parsed field by field: a bad note costs that note, not the list. */
export function parseSitePage(value: unknown): SitePage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { notes, total, next } = value as Record<string, unknown>;
  if (!Array.isArray(notes) || typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) {
    return undefined;
  }
  const parsed = notes.slice(0, SITE_PAGE_SIZE).flatMap((note) => {
    const one = parseSiteNote(note);

    return one === undefined ? [] : [one];
  });
  const cursor = text(next, 500);

  return { notes: parsed, total, ...(cursor === undefined ? {} : { next: cursor }) };
}

function parseSiteNote(value: unknown): SiteNote | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const note = value as Record<string, unknown>;
  const seed = text(note.seed, 200);
  const excerpt = text(note.excerpt);
  const stage = STAGES.find((each) => each === note.stage);
  const createdAt = text(note.createdAt, 64);
  const page = typeof note.page === 'object' && note.page !== null ? (note.page as Record<string, unknown>) : {};
  const url = text(page.url);
  const path = text(page.path);
  if (seed === undefined || seed === '' || excerpt === undefined || stage === undefined) return undefined;
  if (createdAt === undefined || url === undefined || path === undefined || !webUrl(url)) return undefined;
  const author =
    typeof note.author === 'object' && note.author !== null ? (note.author as Record<string, unknown>) : {};
  const name = text(author.name, 200);
  const reference = text(note.reference, 200);
  const referenceUrl = text(note.referenceUrl);

  return {
    seed,
    excerpt,
    page: { url, path },
    stage,
    ...(name === undefined || name.trim() === '' ? {} : { author: name }),
    ...(author.kind === 'you' ? { mine: true as const } : {}),
    ...(reference === undefined || reference === '' ? {} : { reference }),
    ...(referenceUrl === undefined || !webUrl(referenceUrl) ? {} : { referenceUrl }),
    createdAt,
  };
}

/** Only an `http` or `https` address opens from the panel: a `javascript:` one never does. */
function webUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);

    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}
