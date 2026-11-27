import type { SiteNotesSeams } from './site-notes.ts';

/**
 * A verdict on a note of another page of the site (FRU-734), from the side panel, with the session
 * of the extension. The badge counts the notes to check of the whole site, and the panel lists those
 * of the other pages under « To check »: the widget of the tab cannot send their verdict.
 *
 * Two calls of the worker, both the widget's own:
 *
 * 1. `GET /feedback?url=<page>&client=<site>`: the read of the page of the note, which gives the id
 *    of its issue. The index of the worker keeps the id of the note only.
 * 2. `POST /feedback/<issue>/check?client=<site>` with `{ url, verdict }` (FRU-294).
 *
 * The worker decides who may give a verdict, and on which note: the panel only says what it answered.
 */

export type SiteVerdict = 'fixed' | 'wrong';

/**
 * - `sent`: the store took the verdict.
 * - `refused`: the worker said no to this note now (`403`, `404`, `409`), or the read of its page no
 *   longer has it. A new read of the list shows what it is.
 * - `signed-out`: the session ended.
 * - `failed`: nothing answered, or an answer the panel cannot read. Trying again can work.
 */
export type SiteVerdictOutcome = 'sent' | 'refused' | 'signed-out' | 'failed';

export type SiteVerdictQuery = { site: string; url: string; note: string; verdict: SiteVerdict };

const TIMEOUT_MS = 15_000;

/** Never rejects. */
export async function sendSiteVerdict(
  endpoint: string,
  query: SiteVerdictQuery,
  seams: SiteNotesSeams,
): Promise<SiteVerdictOutcome> {
  const fetcher = seams.fetcher ?? fetch;
  const access = await seams.ensureAccess(endpoint).catch(() => undefined);
  if (access === undefined) return 'failed';
  if (!access.ok) return access.reason === 'session-revoked-or-expired' ? 'signed-out' : 'failed';
  let token = access.grant.accessToken;

  // An access token that was only old: renewed once, then the call is made once more.
  const call = async (url: string, init: RequestInit): Promise<Response | 'signed-out' | undefined> => {
    let response = await send(fetcher, url, init, token);
    if (response?.status !== 401 || seams.renewAccess === undefined) return response;
    const renewed = await seams.renewAccess(endpoint, token).catch(() => undefined);
    if (renewed?.ok !== true) return 'signed-out';
    token = renewed.grant.accessToken;
    response = await send(fetcher, url, init, token);

    return response?.status === 401 ? 'signed-out' : response;
  };

  const client = encodeURIComponent(query.site);
  const read = await call(`${endpoint}/feedback?url=${encodeURIComponent(query.url)}&client=${client}`, {});
  if (read === 'signed-out') return 'signed-out';
  if (read === undefined || !read.ok) return read !== undefined && REFUSED.has(read.status) ? 'refused' : 'failed';
  const issue = issueOf(await read.json().catch(() => undefined), query.note);
  if (issue === undefined) return 'refused';

  const checked = await call(`${endpoint}/feedback/${encodeURIComponent(issue)}/check?client=${client}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: query.url, verdict: query.verdict }),
  });
  if (checked === 'signed-out') return 'signed-out';
  if (checked === undefined) return 'failed';
  if (checked.ok) return 'sent';

  return REFUSED.has(checked.status) ? 'refused' : 'failed';
}

/** The answers that say no to this note now: trying again does not change them. */
const REFUSED = new Set([403, 404, 409]);

async function send(fetcher: typeof fetch, url: string, init: RequestInit, token: string) {
  try {
    return await fetcher(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }
}

/** The id of the issue of `note` in a read of its page, or `undefined`. */
export function issueOf(body: unknown, note: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const issues = (body as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return undefined;
  for (const issue of issues as unknown[]) {
    if (typeof issue !== 'object' || issue === null) continue;
    const { id, note: of } = issue as { id?: unknown; note?: { id?: unknown } };
    if (typeof id === 'string' && of?.id === note) return id;
  }

  return undefined;
}
