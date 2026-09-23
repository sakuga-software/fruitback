import { browser } from 'wxt/browser';
import { type ResolvedSite, resolveSite } from './site-patterns.ts';

/**
 * Which worker answers for which origin, in which mode, and whether this origin is switched on.
 *
 * One entry per pattern (SKG-536): an exact origin, or a host wildcard such as
 * `https://*.staging.acme.dev`. `site-patterns.ts` says which entry answers for an origin, and every
 * reader asks it through `readSite`, or through `findSite` when it also needs the pattern the entry
 * is stored under. The popup switches the entry for its tab and names its pattern, and the options
 * page edits all of them.
 *
 * A pattern is a convenience for the reviewer and grants nothing on the worker. The worker still
 * compares the page's exact origin with `origins` in `FRUITBACK_CLIENTS`.
 *
 * Parsed on the way out, never trusted: `chrome.storage` survives an upgrade, so a shape written by
 * an older version has to cost that entry rather than the extension.
 */

/**
 * Which of the three modes this origin is in (SKG-539).
 *
 * `private` is SKG-534: the site embeds nothing and the extension mounts the widget, so the entry
 * carries the client id nobody else can supply. `team` is SKG-596: the site embeds its own dormant
 * widget and the extension only announces itself and relays, so the client id comes from the site's
 * own build and this entry has none. The public mode is not here at all — it needs no extension.
 *
 * **The endpoint is required in both.** In team mode the site declares its own endpoint to the
 * widget, and this one is what the relay checks that declaration against: see `relay.ts`.
 */
export type SiteMode = 'private' | 'team';

export type SiteConfig = { endpoint: string; enabled: boolean } & (
  | { mode: 'private'; clientId: string; label?: string }
  | { mode: 'team' }
);

const KEY = 'sites';

/** The entry that answers for this origin, whether it names the origin or covers it with a wildcard. */
export async function readSite(origin: string): Promise<SiteConfig | undefined> {
  return (await findSite(origin))?.site;
}

/** The same entry, with the pattern it is stored under. The popup names that pattern. */
export async function findSite(origin: string): Promise<ResolvedSite | undefined> {
  return resolveSite(await readAll(), origin);
}

export async function readAll(): Promise<Record<string, SiteConfig>> {
  const stored = await browser.storage.local.get(KEY);
  const raw = (stored as Record<string, unknown>)[KEY];
  if (!isRecord(raw)) return {};

  const sites: Record<string, SiteConfig> = {};
  for (const [origin, value] of Object.entries(raw)) {
    const site = parseSite(value);
    if (site !== undefined) sites[origin] = site;
  }

  return sites;
}

/** `pattern` must come from `parseSitePattern`. A key in another spelling covers nothing. */
export async function writeSite(pattern: string, site: SiteConfig): Promise<void> {
  await writeSites({ [pattern]: site });
}

/** Adds or replaces these entries and keeps the others. An import writes all of its entries at once. */
export async function writeSites(entries: Record<string, SiteConfig>): Promise<void> {
  await mutate({ kind: 'write', entries });
}

export async function removeSite(pattern: string): Promise<void> {
  await mutate({ kind: 'remove', pattern });
}

/** The channel of a change to the map. The background is the only context that applies one. */
export const SITE_MUTATION = 'fruitback:site-mutation';

export type SiteMutation = { kind: 'write'; entries: Record<string, SiteConfig> } | { kind: 'remove'; pattern: string };

/**
 * Sends the change to the background, which applies one change at a time (`site-writes.ts`).
 *
 * Rejects when the background did not store it, so a page does not report a rule that is not there.
 */
async function mutate(mutation: SiteMutation): Promise<void> {
  const answer: unknown = await browser.runtime.sendMessage({ channel: SITE_MUTATION, mutation });
  if (!isRecord(answer) || answer.ok !== true) throw new Error('the background did not store the site change');
}

/** The background's write of the whole map. Nothing else calls it: see `createSiteOwner`. */
export async function replaceAll(sites: Record<string, SiteConfig>): Promise<void> {
  await browser.storage.local.set({ [KEY]: sites });
}

/**
 * Tolerant field by field, like the widget's own config store: a bad entry costs its own site.
 *
 * **An absent mode reads as private.** Every entry written before SKG-596 has no `mode` and a real
 * client id, and it has to keep mounting the widget exactly as it did — a stored shape is the one
 * thing a release cannot re-run.
 */
export function parseSite(value: unknown): SiteConfig | undefined {
  if (!isRecord(value)) return undefined;

  const { endpoint, clientId, label, enabled, mode } = value;
  if (typeof endpoint !== 'string' || endpoint.length === 0) return undefined;

  // Absent reads as on: an entry exists because somebody added this site.
  const common = { endpoint, enabled: enabled !== false };

  if (mode === 'team') return { ...common, mode: 'team' };

  if (typeof clientId !== 'string' || clientId.length === 0) return undefined;

  return {
    ...common,
    mode: 'private',
    clientId,
    ...(typeof label === 'string' && label.length > 0 ? { label } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
