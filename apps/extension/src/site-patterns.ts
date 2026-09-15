import type { SiteConfig } from './sites.ts';

/**
 * Which stored entry answers for an origin (SKG-536).
 *
 * A key of the sites map is a pattern. It is an exact origin, `https://acme.dev`, or a scheme and a
 * host wildcard, `https://*.staging.acme.dev`. Every key written before SKG-536 is an exact origin,
 * so every entry a browser already holds stays valid with no upgrade.
 *
 * The bridge, the relay and the popup all call `resolveSite`. If one of them looked up the exact
 * origin instead, a page could mount the widget and then have its relayed calls refused.
 */

const WILDCARD = '*.';

/**
 * The pattern a person typed, in the one spelling the store keys on, or `undefined`.
 *
 * With no scheme, `https://` is used. A wildcard is the whole first label only, and it takes no
 * port: a match pattern cannot say which ports it covers in every browser. A bare `*` is refused,
 * because it is the permission for every site that SKG-534 refused to ask for.
 */
export function parseSitePattern(input: string): string | undefined {
  const value = input.trim().replace(/\/\*?$/, '');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  const separator = withScheme.indexOf('://');
  const scheme = withScheme.slice(0, separator).toLowerCase();
  const rest = withScheme.slice(separator + 3);

  if (scheme !== 'http' && scheme !== 'https') return undefined;
  if (rest === '' || /[/?#@\\\s]/.test(rest)) return undefined;

  const wildcard = rest.startsWith(WILDCARD);
  const host = wildcard ? rest.slice(WILDCARD.length) : rest;
  if (host === '' || host.includes('*')) return undefined;

  let url: URL;
  try {
    url = new URL(`${scheme}://${host}`);
  } catch {
    return undefined;
  }

  if (!wildcard) return url.origin;
  if (url.port !== '' || url.host !== host.toLowerCase()) return undefined;

  return `${scheme}://${WILDCARD}${url.hostname}`;
}

/**
 * Whether a pattern covers an origin.
 *
 * `*.staging.acme.dev` covers `staging.acme.dev` too, as it does in a match pattern. A wildcard
 * covers the default port only. If a browser registers the scripts on another port as well, this
 * answers no there and the widget does not mount. The opposite error would show a site as on where
 * nothing runs.
 */
export function coversOrigin(pattern: string, origin: string): boolean {
  if (!pattern.includes(`://${WILDCARD}`)) return pattern === origin;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  const [scheme = '', base = ''] = pattern.split(`://${WILDCARD}`);

  return (
    url.origin === origin &&
    url.protocol === `${scheme}:` &&
    url.port === '' &&
    (url.hostname === base || url.hostname.endsWith(`.${base}`))
  );
}

export type ResolvedSite = { pattern: string; site: SiteConfig };

/**
 * The entry that answers for an origin, or `undefined` when no entry covers it.
 *
 * An exact origin wins over every wildcard, and a longer wildcard wins over a shorter one. So a
 * reviewer can switch one subdomain off, or send it to another client, under a rule for all of
 * them. A key that is not a pattern covers nothing.
 */
export function resolveSite(sites: Record<string, SiteConfig>, origin: string): ResolvedSite | undefined {
  const exact = sites[origin];
  if (exact !== undefined && parseSitePattern(origin) === origin) return { pattern: origin, site: exact };

  let best: ResolvedSite | undefined;
  for (const [pattern, site] of Object.entries(sites)) {
    if (!pattern.includes(`://${WILDCARD}`) || parseSitePattern(pattern) !== pattern) continue;
    if (!coversOrigin(pattern, origin)) continue;
    if (best === undefined || pattern.length > best.pattern.length) best = { pattern, site };
  }

  return best;
}

export function isWildcardPattern(pattern: string): boolean {
  return pattern.includes(`://${WILDCARD}`);
}
