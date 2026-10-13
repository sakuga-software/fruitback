import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { storage } from './session-storage.fixture.ts';

/**
 * `sites.ts` over a storage area, as the bridge, the relay and the popup call it (FRU-43).
 *
 * `site-patterns.test.ts` tests the resolver. This file tests that `readSite` uses it: a reader that
 * looked up the exact origin would pass every resolver test and still refuse a wildcard site.
 *
 * `wxt/browser` reads `globalThis.chrome` when it is imported, so the global is set before the import.
 * A write goes to the background as a runtime message, and the fake runtime answers it the way
 * `background.ts` does.
 */

const fake = storage();
let answer: 'apply' | 'refuse' = 'apply';
(globalThis as { chrome?: unknown }).chrome = {
  runtime: {
    id: 'fruitback',
    sendMessage: async (message: unknown) => {
      const mutation = parseSiteMutation(message);
      if (mutation === undefined || answer === 'refuse') return undefined;
      await own(mutation);

      return { ok: true };
    },
  },
  storage: { local: fake.area },
};
const {
  findSite,
  readAll,
  readFreshPreviews,
  readSite,
  rememberPreviews,
  removeSite,
  replaceAll,
  writeSite,
  writeSites,
} = await import('./sites.ts');
const { createSiteOwner, parseSiteMutation } = await import('./site-writes.ts');
const own = createSiteOwner({ read: readAll, replace: replaceAll });

const acme = { mode: 'private', endpoint: 'https://worker.test', clientId: 'acme', enabled: true } as const;
const globex = { mode: 'team', endpoint: 'https://worker.test', enabled: true } as const;

describe('sites.ts over storage', () => {
  beforeEach(async () => {
    answer = 'apply';
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

  // FRU-103. The bridge of the page and the relay of the background call `readSite`, and the popup
  // `findSite`: one reader that left the list of the worker out would mount no widget on a preview.
  it('reads a team wildcard for a preview once the worker listed it, and not before', async () => {
    const worker = 'https://worker.test';
    const previews = 'https://*.preview.acme.dev';
    const rule = { mode: 'team', endpoint: worker, enabled: true, mount: { clientId: 'site_1' } } as const;
    const page = 'https://pr-12.preview.acme.dev';
    await writeSite(previews, rule);

    try {
      // Nothing listed: the rule of FRU-75 holds, for the page as for the popup.
      assert.equal(await readSite(page), undefined);
      assert.equal(await findSite(page), undefined);

      await rememberPreviews(worker, { at: Date.now(), previews: { [previews]: 'site_1' } });
      assert.deepEqual(await readSite(page), rule);
      assert.deepEqual(await findSite(page), { pattern: previews, site: rule });

      // Another site of the same worker under that wildcard grants nothing to this rule.
      await rememberPreviews(worker, { at: Date.now(), previews: { [previews]: 'site_2' } });
      assert.equal(await readSite(page), undefined);
    } finally {
      await rememberPreviews(worker, undefined);
    }
  });

  // The bridge is a content script, and the refresh tokens are in the same area (FRU-60). A read of
  // the whole area on a page would load them in a context that must not hold one.
  it('never reads the whole area to find a site: only the rules, and the list of the workers they name', async () => {
    const worker = 'https://worker.test';
    const previews = 'https://*.preview.acme.dev';
    await writeSite(previews, { mode: 'team', endpoint: worker, enabled: true, mount: { clientId: 'site_1' } });
    await rememberPreviews(worker, { at: Date.now(), previews: { [previews]: 'site_1' } });
    // The list of a worker that no rule names, and a session: neither is asked for.
    await rememberPreviews('https://other.test', { at: Date.now(), previews: { [previews]: 'site_1' } });
    await fake.area.set({ 'fruitback:session-run:https://worker.test': { refreshToken: 'not-for-a-page' } });

    try {
      fake.log.length = 0;
      assert.ok(await readSite('https://pr-12.preview.acme.dev'), 'the preview is served');
      assert.ok(await findSite('https://pr-12.preview.acme.dev'));
      await readFreshPreviews();

      assert.deepEqual([...new Set(fake.log)].sort(), ['get provenPreviews:https://worker.test', 'get sites']);
    } finally {
      await rememberPreviews(worker, undefined);
      await rememberPreviews('https://other.test', undefined);
      await fake.area.remove('fruitback:session-run:https://worker.test');
    }
  });

  it('reads an entry stored before FRU-43, by its origin', async () => {
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

  /** The popup and the options page share no lock. Each change reads the map and replaces it. */
  it('keeps both of two changes made at the same time', async () => {
    await writeSite('https://old.dev', acme);

    await Promise.all([
      writeSite('https://acme.dev', acme),
      writeSite('https://globex.dev', globex),
      removeSite('https://old.dev'),
    ]);

    assert.deepEqual(await readAll(), { 'https://acme.dev': acme, 'https://globex.dev': globex });
  });

  it('rejects a change the background did not store', async () => {
    answer = 'refuse';

    await assert.rejects(writeSite('https://acme.dev', acme));
    assert.deepEqual(await readAll(), {});
  });
});
