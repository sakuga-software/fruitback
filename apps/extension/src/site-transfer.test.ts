import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SITES_FORMAT, SITES_FORMAT_VERSION, exportSites, importSites } from './site-transfer.ts';
import type { SiteConfig } from './sites.ts';

const sites: Record<string, SiteConfig> = {
  'https://*.staging.acme.dev': {
    mode: 'private',
    endpoint: 'https://feedback.acme.dev',
    clientId: 'acme',
    label: 'Acme',
    enabled: true,
  },
  'https://globex.dev': { mode: 'team', endpoint: 'https://feedback.globex.dev', enabled: false },
};

const file = (body: Record<string, unknown>): string =>
  JSON.stringify({ format: SITES_FORMAT, version: SITES_FORMAT_VERSION, ...body });

describe('exportSites and importSites', () => {
  it('reads back exactly what it wrote', () => {
    assert.deepEqual(importSites(exportSites(sites)), { ok: true, sites, skipped: [] });
  });

  it('writes no key that is not a pattern', () => {
    const exported = JSON.parse(exportSites({ ...sites, 'not a pattern': sites['https://globex.dev']! }));

    assert.deepEqual(Object.keys(exported.sites).sort(), Object.keys(sites).sort());
  });

  it('skips and names an entry that does not parse, and keeps the others', () => {
    const result = importSites(
      file({
        sites: {
          ...sites,
          'https://*': sites['https://globex.dev'],
          'https://nobody.dev': { mode: 'private', endpoint: 'https://feedback.acme.dev' },
        },
      }),
    );

    assert.deepEqual(result, { ok: true, sites, skipped: ['https://*', 'https://nobody.dev'] });
  });

  it('stores a key under the spelling the store keys on', () => {
    const result = importSites(file({ sites: { '*.Staging.Acme.dev': sites['https://*.staging.acme.dev'] } }));

    assert.ok(result.ok);
    assert.deepEqual(Object.keys(result.sites), ['https://*.staging.acme.dev']);
  });

  /** A file written by hand from an old popup entry: no mode, a client id. It reads as private mode. */
  it('reads an entry with no mode as private, like the store does', () => {
    const result = importSites(
      file({ sites: { 'https://acme.dev': { endpoint: 'https://w.test', clientId: 'acme' } } }),
    );

    assert.deepEqual(result, {
      ok: true,
      sites: { 'https://acme.dev': { mode: 'private', endpoint: 'https://w.test', clientId: 'acme', enabled: true } },
      skipped: [],
    });
  });

  it('refuses a file that is not a sites file, or is from a newer version', () => {
    assert.deepEqual(importSites('{'), { ok: false, reason: 'not-json' });
    for (const text of [
      '[]',
      'null',
      JSON.stringify({ version: 1, sites: {} }),
      JSON.stringify({ format: SITES_FORMAT, sites: {} }),
      JSON.stringify({ format: SITES_FORMAT, version: '1', sites: {} }),
      JSON.stringify({ format: SITES_FORMAT, version: 0, sites: {} }),
      JSON.stringify({ format: SITES_FORMAT, version: 1, sites: [] }),
    ]) {
      assert.deepEqual(importSites(text), { ok: false, reason: 'not-a-sites-file' }, text);
    }
    assert.deepEqual(importSites(file({ version: SITES_FORMAT_VERSION + 1, sites })), {
      ok: false,
      reason: 'newer-version',
    });
  });
});
