import { browser } from 'wxt/browser';

/**
 * Which worker answers for which origin, and whether this origin is switched on.
 *
 * One entry per origin, because that is the unit a reviewer thinks in — "review acme's staging" —
 * and it is also what the worker checks the client id against (`origins` in `FRUITBACK_CLIENTS`).
 * The full editor for this map is SKG-536; what is here is the store and the per-origin switch the
 * popup needs, and nothing more.
 *
 * Parsed on the way out, never trusted: `chrome.storage` survives an upgrade, so a shape written by
 * an older version has to cost that entry rather than the extension.
 */

export type SiteConfig = {
  endpoint: string;
  clientId: string;
  label?: string;
  enabled: boolean;
};

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

/** Tolerant field by field, like the widget's own config store: a bad entry costs its own site. */
export function parseSite(value: unknown): SiteConfig | undefined {
  if (!isRecord(value)) return undefined;

  const { endpoint, clientId, label, enabled } = value;
  if (typeof endpoint !== 'string' || endpoint.length === 0) return undefined;
  if (typeof clientId !== 'string' || clientId.length === 0) return undefined;

  return {
    endpoint,
    clientId,
    // Absent reads as on: an entry exists because somebody added this site.
    enabled: enabled !== false,
    ...(typeof label === 'string' && label.length > 0 ? { label } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
