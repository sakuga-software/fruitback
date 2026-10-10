import { isWorkerEndpoint, workerOrigin } from './endpoint.ts';
import { isWildcardPattern, lendsSession, parseSitePattern } from './site-patterns.ts';
import type { SiteConfig, SiteMutation } from './sites.ts';

/**
 * Which host access the extension gives back to the browser (FRU-115).
 *
 * « Turn off » used to unregister the scripts and keep the host permission, so the browser went on
 * saying that Fruitback can read the site. An access is now given back when nothing uses it.
 *
 * An access is an origin or a wildcard, in the spelling of a key of the sites map. It is in use when:
 *
 * - a rule that is switched on names it;
 * - a rule that is switched on names a worker on that origin: the access to a worker serves every
 *   site of that worker, so it goes with the last one;
 * - this browser holds a session with a worker on that origin: the refresh and the log out need it.
 *
 * WARNING: nothing here looks at what the browser holds. Only the accesses of the rule that changed
 * are candidates. A sweep of every held access would take back the one a permission prompt has just
 * granted, before the popup stores its site (FRU-118).
 */

/** The accesses that the rules and the sessions use now. */
export function accessInUse(sites: Record<string, SiteConfig>, paired: readonly string[]): Set<string> {
  const used = new Set<string>();
  for (const [pattern, site] of Object.entries(sites)) {
    // The same rules as the registration in the background: these are the rules that run.
    if (!site.enabled || parseSitePattern(pattern) !== pattern || lendsSession(pattern, site)) continue;
    used.add(pattern);
    const worker = originOfWorker(site.endpoint);
    if (worker !== undefined) used.add(worker);
  }
  for (const endpoint of paired) {
    const worker = originOfWorker(endpoint);
    if (worker !== undefined) used.add(worker);
  }

  return used;
}

/**
 * The candidates that nothing uses, each one time.
 *
 * A wildcard that covers an access in use stays. The browser can hold the wildcard only, and to give
 * it back would stop a site that is switched on.
 */
export function accessToReturn(
  candidates: readonly string[],
  sites: Record<string, SiteConfig>,
  paired: readonly string[],
): string[] {
  const used = accessInUse(sites, paired);

  return [...new Set(candidates)].filter(
    (candidate) => !used.has(candidate) && ![...used].some((access) => grantCovers(candidate, access)),
  );
}

/** The accesses of the rules a change touches, as they were before the change. */
export function accessOf(sites: Record<string, SiteConfig>, patterns: readonly string[]): string[] {
  return patterns.flatMap((pattern) => {
    const site = sites[pattern];
    if (site === undefined || parseSitePattern(pattern) !== pattern) return [];
    const worker = originOfWorker(site.endpoint);

    return worker === undefined ? [pattern] : [pattern, worker];
  });
}

/** The patterns a change writes or removes. */
export function patternsOf(mutation: SiteMutation): string[] {
  return mutation.kind === 'remove' ? [mutation.pattern] : Object.keys(mutation.entries);
}

/**
 * Whether the browser's grant for `pattern` also covers `access`.
 *
 * This is the rule of a match pattern, not the rule of `coversOrigin`: a match pattern names no
 * port, so the grant of a wildcard covers every port of its hosts.
 */
function grantCovers(pattern: string, access: string): boolean {
  if (!isWildcardPattern(pattern)) return false;
  const [scheme = '', base = ''] = pattern.split('://*.');
  const [accessScheme = '', rest = ''] = access.split('://');
  const host = hostOf(rest.startsWith('*.') ? rest.slice(2) : rest);

  return accessScheme === scheme && (host === base || host.endsWith(`.${base}`));
}

/** `acme.dev:8443` gives `acme.dev`, and `[::1]:8788` gives `[::1]`. */
function hostOf(authority: string): string {
  return authority.replace(/:\d+$/, '');
}

function originOfWorker(endpoint: string): string | undefined {
  return isWorkerEndpoint(endpoint) ? workerOrigin(endpoint) : undefined;
}

export type AccessReturnSeams = {
  sites: () => Promise<Record<string, SiteConfig>>;
  /** The endpoints this browser holds a session with. */
  paired: () => Promise<string[]>;
  /** Gives one access back to the browser. */
  remove: (access: string) => Promise<unknown>;
};

/**
 * Gives back the candidates that nothing uses. Reads the rules and the sessions at the time of the
 * call, so call it after the change is stored.
 *
 * One access at a time: a browser refuses to remove an access that the manifest requires, and one
 * refusal must not keep the others. A refusal is reported and not thrown, because the change of the
 * rule is already stored and is not wrong.
 */
export function createAccessReturn({
  sites,
  paired,
  remove,
}: AccessReturnSeams): (candidates: readonly string[]) => Promise<void> {
  return async (candidates) => {
    if (candidates.length === 0) return;
    const [stored, endpoints] = await Promise.all([sites(), paired()]);
    for (const access of accessToReturn(candidates, stored, endpoints)) {
      await remove(access).catch((error: unknown) =>
        console.warn(`[fruitback] could not give back the access to ${access}`, error),
      );
    }
  };
}
