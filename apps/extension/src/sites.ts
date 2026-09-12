import { browser } from 'wxt/browser';

/**
 * Which worker answers for which origin, in which mode, and whether this origin is switched on.
 *
 * One entry per origin, because that is the unit a reviewer thinks in — "review acme's staging" —
 * and it is also what the worker checks the client id against (`origins` in `FRUITBACK_CLIENTS`).
 * The full editor for this map is SKG-536; what is here is the store and the per-origin switch the
 * popup needs, and nothing more.
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

export async function readSite(origin: string): Promise<SiteConfig | undefined> {
  const sites = await readAll();

  return sites[origin];
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

export async function writeSite(origin: string, site: SiteConfig): Promise<void> {
  const sites = await readAll();

  await browser.storage.local.set({ [KEY]: { ...sites, [origin]: site } });
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
