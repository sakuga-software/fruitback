import { type AccountStore, type Reach, type Site, onlyOf, readsSite } from './accounts.ts';
import { QUERY_LENGTH } from './notes-index.ts';

/**
 * The reads of the sites of a workspace that the console asks besides the whole list (FRU-497).
 *
 * - `GET …/sites?limit=&offset=&q=`: one page of the grid of the Sites screen, with the total.
 * - `GET …/sites/choices?q=&after=&limit=`: the id, address and visibility of the sites, by address,
 *   for a list to choose one. No destination and no count.
 * - `GET …/sites/<id>`: one site, for its page.
 *
 * The counts of the notes are read for the sites of the answer only (`summary` with `sites`).
 */

/** How many sites one page of the grid holds: 12 by default, as the screen shows. */
export const SITE_PAGE = { min: 1, default: 12, max: 100 } as const;

/** How many sites one page of `choices` holds. A list to choose from reads them all, in few pages. */
export const SITE_CHOICES = { min: 1, default: 100, max: 500 } as const;

/** The longest address a cursor of `choices` holds: an origin is short, and this bounds the SQL. */
const AFTER_LENGTH = 2048;

type Parsed<T> = { ok: true; query: T } | { ok: false; error: string };

/** The words searched in the host of a site: absent when none, refused past `QUERY_LENGTH`. */
function searchOf(params: URLSearchParams): Parsed<string | undefined> {
  const q = params.get('q')?.trim() || undefined;
  if (q !== undefined && q.length > QUERY_LENGTH) return { ok: false, error: 'invalid-q' };

  return { ok: true, query: q };
}

/** A whole number of the address, between `min` and `max`; `fallback` when it is absent. */
function wholeOf(params: URLSearchParams, name: string, fallback: number, min: number, max: number) {
  const asked = params.get(name);
  const value = asked === null ? fallback : Number(asked);

  return Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

/**
 * The page of sites the address asks for. `undefined` when it asks for none: the address has no
 * `limit`, and the answer is every site, as before FRU-497.
 */
export function readSitePage(
  params: URLSearchParams,
): Parsed<{ q?: string; offset: number; limit: number }> | undefined {
  if (!params.has('limit') && !params.has('offset')) return undefined;
  const limit = wholeOf(params, 'limit', SITE_PAGE.default, SITE_PAGE.min, SITE_PAGE.max);
  if (limit === undefined) return { ok: false, error: 'invalid-limit' };
  const offset = wholeOf(params, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
  if (offset === undefined) return { ok: false, error: 'invalid-offset' };
  const q = searchOf(params);
  if (!q.ok) return q;

  return { ok: true, query: { offset, limit, ...(q.query === undefined ? {} : { q: q.query }) } };
}

/** The page of `choices` the address asks for. */
export function readSiteChoices(params: URLSearchParams): Parsed<{ q?: string; after?: string; limit: number }> {
  const limit = wholeOf(params, 'limit', SITE_CHOICES.default, SITE_CHOICES.min, SITE_CHOICES.max);
  if (limit === undefined) return { ok: false, error: 'invalid-limit' };
  const after = params.get('after') ?? undefined;
  if (after !== undefined && (after === '' || after.length > AFTER_LENGTH))
    return { ok: false, error: 'invalid-after' };
  const q = searchOf(params);
  if (!q.ok) return q;

  return {
    ok: true,
    query: {
      limit,
      ...(after === undefined ? {} : { after }),
      ...(q.query === undefined ? {} : { q: q.query }),
    },
  };
}

/**
 * The choices of one page, and the cursor of the next one: the address of the last site, when a
 * site comes after it. One more row than the page is read to know.
 */
export async function siteChoicesPage(
  accounts: AccountStore,
  workspace: string,
  reach: Reach,
  query: { q?: string; after?: string; limit: number },
) {
  const rows = await accounts.siteChoices(workspace, { ...query, limit: query.limit + 1, ...onlyOf(reach) });
  const sites = rows.slice(0, query.limit);
  const last = sites.at(-1);

  return { sites, ...(rows.length > query.limit && last !== undefined ? { next: last.origin } : {}) };
}

/** One site that this reach reads, or `undefined`: a site of another workspace, gone, or not shared with a guest. */
export async function readableSite(
  accounts: AccountStore,
  workspace: string,
  reach: Reach,
  site: string,
): Promise<Site | undefined> {
  if (!readsSite(reach, site)) return undefined;

  return accounts.site(workspace, site);
}
