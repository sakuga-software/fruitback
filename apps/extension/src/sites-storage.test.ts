import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { storage } from './session-storage.fixture.ts';

/**
 * `sites.ts` over a storage area, as the bridge, the relay and the popup call it (SKG-536).
 *
 * `site-patterns.test.ts` tests the resolver. This file tests that `readSite` uses it: a reader that
 * looked up the exact origin would pass every resolver test and still refuse a wildcard site.
 *
 * `wxt/browser` reads `globalThis.chrome` when it is imported, so the global is set before the import.
 */

const fake = storage();
(globalThis as { chrome?: unknown }).chrome = { runtime: {}, storage: { local: fake.area } };
const { findSite, readAll, readSite, removeSite, writeSite, writeSites } = await import('./sites.ts');

const acme = { mode: 'private', endpoint: 'https://worker.test', clientId: 'acme', enabled: true } as const;
const globex = { mode: 'team', endpoint: 'https://worker.test', enabled: true } as const;

describe('sites.ts over storage', () => {
  beforeEach(async () => {
    await fake.area.remove('sites');
  });

  afterEach(async () => {
    await fake.area.remove('sites');
  });

  it('reads the entry a wildcard stores for a subdomain of it', async () => {
    await writeSite('https://*.staging.acme.dev', acme);

    assert.deepEqual(await readSite('https://pr-12.staging.acme.dev'), acme);
    assert.deepEqual(await findSite('https://staging.acme.dev'), { pattern: 'https://*.staging.acme.dev', site: acme });
    assert.equal(await readSite('https://acme.dev'), undefined);
  });

  it('reads an entry stored before SKG-536, by its origin', async () => {
    await fake.area.set({
      sites: { 'http://localhost:5177': { endpoint: 'http://localhost:8788', clientId: 'acme' } },
    });

    assert.deepEqual(await readSite('http://localhost:5177'), {
      mode: 'private',
      endpoint: 'http://localhost:8788',
      clientId: 'acme',
      enabled: true,
    });
  });

  it('adds, replaces and removes one entry and keeps the others', async () => {
    await writeSite('https://acme.dev', acme);
    await writeSites({ 'https://globex.dev': globex, 'https://acme.dev': { ...acme, enabled: false } });

    assert.deepEqual(await readAll(), {
      'https://acme.dev': { ...acme, enabled: false },
      'https://globex.dev': globex,
    });

    await removeSite('https://acme.dev');

    assert.deepEqual(await readAll(), { 'https://globex.dev': globex });
  });
});
