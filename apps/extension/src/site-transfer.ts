import { normalizeWorkerEndpoint } from './endpoint.ts';
import { complaint } from './site-form.ts';
import { parseSitePattern } from './site-patterns.ts';
import { type SiteConfig, parseSite } from './sites.ts';

/**
 * The sites map as a file a team can hand around (SKG-536).
 *
 * The file holds patterns, modes, endpoints and client ids. It holds no credential: a session stays
 * in the browser that paired, and a host permission stays in the browser that granted it. So an
 * imported entry does nothing until this browser grants its pattern, which the options page asks for.
 */

export const SITES_FORMAT = 'fruitback-sites';
export const SITES_FORMAT_VERSION = 1;

export type SitesImport =
  | { ok: true; sites: Record<string, SiteConfig>; skipped: string[] }
  | { ok: false; reason: 'not-json' | 'not-a-sites-file' | 'newer-version' };

export function exportSites(sites: Record<string, SiteConfig>): string {
  const entries = Object.entries(sites)
    .filter(([pattern]) => parseSitePattern(pattern) === pattern)
    .sort(([a], [b]) => a.localeCompare(b));

  return `${JSON.stringify({ format: SITES_FORMAT, version: SITES_FORMAT_VERSION, sites: Object.fromEntries(entries) }, null, 2)}\n`;
}

/**
 * Parsed like the store, then checked like the two editors: an entry that fails either is skipped and
 * named, and the others are kept. An endpoint is stored as the widget calls it, so a file that says
 * `https://worker.test/?tenant=1` does not produce a rule shown as **On** that calls a broken URL.
 *
 * A newer version is refused as a whole. Its entries could carry a field this version drops, and a
 * reviewer would then run a configuration that is not the one their team sent.
 */
export function importSites(text: string): SitesImport {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not-json' };
  }

  if (!isRecord(document) || document.format !== SITES_FORMAT || !isRecord(document.sites)) {
    return { ok: false, reason: 'not-a-sites-file' };
  }
  if (typeof document.version !== 'number' || !Number.isInteger(document.version) || document.version < 1) {
    return { ok: false, reason: 'not-a-sites-file' };
  }
  if (document.version > SITES_FORMAT_VERSION) return { ok: false, reason: 'newer-version' };

  const sites: Record<string, SiteConfig> = {};
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(document.sites)) {
    const pattern = parseSitePattern(key);
    const site = parseSite(value);
    const fields = site && {
      mode: site.mode,
      endpoint: site.endpoint,
      clientId: site.mode === 'private' ? site.clientId : '',
    };
    if (pattern === undefined || site === undefined || fields === undefined || complaint(fields) !== '') {
      skipped.push(key);
    } else {
      const stored = { ...site, endpoint: normalizeWorkerEndpoint(site.endpoint) };
      // The id is stored without its spaces, as both editors store it (SKG-612).
      sites[pattern] = stored.mode === 'private' ? { ...stored, clientId: stored.clientId.trim() } : stored;
    }
  }

  return { ok: true, sites, skipped };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
