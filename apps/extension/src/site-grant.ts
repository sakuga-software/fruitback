/**
 * Whether the browser grants a rule its sites, **by a grant for those sites** (FRU-425, review of
 * #560).
 *
 * `permissions.contains` answers `true` for every origin once `<all_urls>` is held: with « Allow
 * captures on every site » on, a site whose access the reviewer removed in the browser's settings
 * would read as granted again, and its scripts would be registered with no new consent for it. So
 * the grant of a rule is read from `permissions.getAll`, without the grants that cover every site:
 * `<all_urls>`, and the pattern of every web page (which nothing of the extension asks for). Those
 * give the capture, not a site.
 */

/** The grants that cover every site, which never count as the grant of one rule. */
const EVERY_SITE = new Set(['<all_urls>', '*://*/*']);

type Parsed = { scheme: string; host: string; path: string };

function parse(pattern: string): Parsed | undefined {
  const match = /^(\*|[a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)$/i.exec(pattern);
  if (match === null) return undefined;

  return { scheme: (match[1] ?? '').toLowerCase(), host: (match[2] ?? '').toLowerCase(), path: match[3] ?? '' };
}

function coversHost(granted: string, wanted: string): boolean {
  if (granted === wanted) return true;
  if (!granted.startsWith('*.')) return false;
  const suffix = granted.slice(1);
  const bare = granted.slice(2);
  const plain = wanted.startsWith('*.') ? wanted.slice(2) : wanted;

  return plain === bare || plain.endsWith(suffix);
}

/** Whether the match pattern `granted` covers every address of the match pattern `wanted`. */
export function covers(granted: string, wanted: string): boolean {
  const g = parse(granted);
  const w = parse(wanted);
  if (g === undefined || w === undefined) return false;
  const scheme = g.scheme === w.scheme || (g.scheme === '*' && (w.scheme === 'http' || w.scheme === 'https'));
  const path = g.path === '/*' || g.path === w.path;

  return scheme && path && coversHost(g.host, w.host);
}

/** Whether one of `origins` (from `permissions.getAll`) grants `wanted`, leaving out a grant of every site. */
export function grantedForSite(wanted: string, origins: readonly string[]): boolean {
  return origins.some((origin) => !EVERY_SITE.has(origin) && covers(origin, wanted));
}

/** The grant of the match pattern `wanted`, read from the browser. */
export async function holdsSiteAccess(
  wanted: string,
  permissions: { getAll: () => Promise<{ origins?: string[] }> },
): Promise<boolean> {
  return grantedForSite(wanted, (await permissions.getAll()).origins ?? []);
}
