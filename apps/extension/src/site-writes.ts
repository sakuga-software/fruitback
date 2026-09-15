import { parseSitePattern } from './site-patterns.ts';
import { SITE_MUTATION, type SiteConfig, type SiteMutation, parseSite } from './sites.ts';

/**
 * The background as the only writer of the sites map (SKG-536).
 *
 * The popup and the options page share no lock, and a change reads the whole map and then replaces
 * it. Two changes close together could each drop the other's entry, or bring a removed rule back. So
 * both pages send the change to the background, and the background applies one change at a time.
 *
 * One key per pattern would remove the race too. It was not taken: a reader would then have to list
 * the whole `local` area, and the bridge runs in a content script, where the refresh token must not
 * be read.
 */

export function applyMutation(sites: Record<string, SiteConfig>, mutation: SiteMutation): Record<string, SiteConfig> {
  if (mutation.kind === 'write') return { ...sites, ...mutation.entries };

  const { [mutation.pattern]: _removed, ...rest } = sites;

  return rest;
}

export type SitesArea = {
  read: () => Promise<Record<string, SiteConfig>>;
  replace: (sites: Record<string, SiteConfig>) => Promise<void>;
};

/** Applies each change after the one before it has been stored. A change that fails does not stop the next. */
export function createSiteOwner(area: SitesArea): (mutation: SiteMutation) => Promise<void> {
  let tail: Promise<unknown> = Promise.resolve();

  return (mutation) => {
    const run = tail.then(async () => area.replace(applyMutation(await area.read(), mutation)));
    tail = run.catch(() => undefined);

    return run;
  };
}

/** A change as a runtime message carries it, or `undefined`. Every entry is parsed, like a stored one. */
export function parseSiteMutation(message: unknown): SiteMutation | undefined {
  if (!isRecord(message) || message.channel !== SITE_MUTATION || !isRecord(message.mutation)) return undefined;

  const { kind, pattern, entries } = message.mutation;
  if (kind === 'remove') {
    return typeof pattern === 'string' && parseSitePattern(pattern) === pattern ? { kind, pattern } : undefined;
  }
  if (kind !== 'write' || !isRecord(entries)) return undefined;

  const parsed: Record<string, SiteConfig> = {};
  for (const [key, value] of Object.entries(entries)) {
    const site = parseSite(value);
    if (parseSitePattern(key) !== key || site === undefined) return undefined;
    parsed[key] = site;
  }

  return { kind, entries: parsed };
}

/**
 * Whether a runtime message comes from one of this extension's own pages.
 *
 * A content script can send a runtime message too, and its input is written by the page. Its sender
 * URL is the page's, so it is refused here: a page must not add a rule for itself.
 *
 * `root` is the extension's own URL with a trailing slash. It is compared as a prefix, because
 * `new URL` answers `null` as the origin of a `chrome-extension:` URL outside a browser.
 */
export function isExtensionPage(sender: { id?: string; url?: string }, extensionId: string, root: string): boolean {
  return sender.id === extensionId && root.endsWith('/') && sender.url !== undefined && sender.url.startsWith(root);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
