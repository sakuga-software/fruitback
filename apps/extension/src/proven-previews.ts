import { isWildcardPattern, parseSitePattern } from './site-patterns.ts';

/**
 * The previews a worker said its workspace proved (FRU-103), as this browser remembers them.
 *
 * A wildcard in team mode lends the session of the reviewer to every page it covers (FRU-75), so it
 * covers nothing, with one exception: a wildcard that the worker of the session listed for a site of
 * its workspace, because that workspace proved the domain by a record of its DNS.
 *
 * - **Only an answer of the worker writes this.** `GET /session/sites`, asked with the session of
 *   that worker. A rule cannot carry the grant: a rules file that somebody sent would then lend a
 *   session to `*.vercel.app`. The form and the import still refuse every team wildcard.
 * - **Kept by worker, and by site.** A wildcard counts for the rule whose worker listed it, and
 *   whose site is the one the worker named.
 * - **It ages.** An answer older than `PREVIEWS_FRESH_MS` grants nothing. The background asks again
 *   every `PREVIEWS_REFRESH_MS`, so a proof that the worker lost stops here within that time, and a
 *   worker that cannot be reached stops granting rather than granting for ever.
 */

/** How long an answer of the worker grants its previews. */
export const PREVIEWS_FRESH_MS = 2 * 60 * 60_000;

/** How often the background asks each worker again. */
export const PREVIEWS_REFRESH_MS = 30 * 60_000;

/**
 * What the keys in `storage.local` start with: one key for each worker, `provenPreviews:<endpoint>`.
 * Not `sites`: nothing a person imports or edits reaches it.
 *
 * One key for each worker, and not one map: the popup and the background both write what a worker
 * just listed, and two writers of one map would each read it, change their worker, and write it
 * back, so the later one would put back what the other had just taken out. A write of one key reads
 * nothing.
 */
export const PREVIEWS_KEY = 'provenPreviews';

/** The key of what one worker listed. */
export function previewsKey(endpoint: string): string {
  return `${PREVIEWS_KEY}:${endpoint}`;
}

/** Whether a change of storage touches what a worker listed. */
export function touchesPreviews(keys: readonly string[]): boolean {
  return keys.some((key) => key.startsWith(`${PREVIEWS_KEY}:`));
}

/** What one worker listed: each wildcard, and the site whose previews it is. */
export type ListedPreviews = { at: number; previews: Record<string, string> };

/** By worker endpoint, as a site rule spells it. */
export type ProvenPreviews = Record<string, ListedPreviews>;

/** The wildcards that grant now: by worker endpoint, each wildcard and its site. */
export type FreshPreviews = Record<string, Record<string, string>>;

/**
 * A wildcard as the worker lists it, or `undefined`: `https` only, the one spelling a rule is keyed
 * on. Anything else is dropped, so a worker cannot grant a pattern the form would refuse to spell.
 */
export function readPreviewPattern(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('https://*.')) return undefined;

  return parseSitePattern(value) === value && isWildcardPattern(value) ? value : undefined;
}

/** What storage holds, key by key and entry by entry: a bad entry grants nothing. */
export function parseProven(stored: unknown): ProvenPreviews {
  if (typeof stored !== 'object' || stored === null) return {};
  const proven: ProvenPreviews = {};
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(`${PREVIEWS_KEY}:`) || typeof value !== 'object' || value === null) continue;
    const endpoint = key.slice(PREVIEWS_KEY.length + 1);
    const { at, previews } = value as { at?: unknown; previews?: unknown };
    if (typeof at !== 'number' || !Number.isFinite(at) || typeof previews !== 'object' || previews === null) continue;
    const kept: Record<string, string> = {};
    for (const [pattern, site] of Object.entries(previews)) {
      if (readPreviewPattern(pattern) === pattern && typeof site === 'string' && site !== '') kept[pattern] = site;
    }
    proven[endpoint] = { at, previews: kept };
  }

  return proven;
}

/** What still grants at `now`. An answer dated in the future is no answer: a clock that moved back. */
export function freshPreviews(proven: ProvenPreviews, now: number): FreshPreviews {
  const fresh: FreshPreviews = {};
  for (const [endpoint, listed] of Object.entries(proven)) {
    const age = now - listed.at;
    if (age >= 0 && age <= PREVIEWS_FRESH_MS) fresh[endpoint] = listed.previews;
  }

  return fresh;
}

/** The entry of a worker, from the sites it just listed. */
export function listedPreviews(
  sites: readonly { id: string; previews?: readonly string[] }[],
  now: number,
): ListedPreviews {
  const previews: Record<string, string> = {};
  for (const site of sites) {
    for (const pattern of site.previews ?? []) {
      // The first site wins: a worker lists a wildcard for one site.
      if (!(pattern in previews)) previews[pattern] = site.id;
    }
  }

  return { at: now, previews };
}
