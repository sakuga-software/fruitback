import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { covers, grantedForSite, holdsSiteAccess, withGrant, withoutRemoved } from './site-grant.ts';

/** The grant of a rule, without the grants of every site (FRU-425, review of #560). */
describe('the grant of the sites of a rule', () => {
  it('does not count <all_urls>, nor the pattern of every web page', () => {
    assert.equal(grantedForSite('https://acme.dev/*', ['<all_urls>']), false);
    assert.equal(grantedForSite('https://acme.dev/*', ['*://*/*']), false);
    assert.equal(grantedForSite('https://acme.dev/*', ['<all_urls>', 'https://acme.dev/*']), true);
  });

  it('counts a grant of the site itself, or of a pattern that covers it', () => {
    assert.equal(grantedForSite('https://acme.dev/*', ['https://acme.dev/*']), true);
    assert.equal(grantedForSite('http://localhost:5177/*', ['http://localhost:5177/*']), true);
    assert.equal(grantedForSite('https://staging.acme.dev/*', ['https://*.acme.dev/*']), true);
    assert.equal(grantedForSite('https://*.staging.acme.dev/*', ['https://*.acme.dev/*']), true);
    assert.equal(grantedForSite('https://acme.dev/*', ['https://*.acme.dev/*']), true);
    assert.equal(grantedForSite('https://acme.dev/*', ['*://acme.dev/*']), true);
  });

  it('does not count a grant of another site, scheme or a narrower pattern', () => {
    assert.equal(grantedForSite('https://acme.dev/*', ['https://other.dev/*']), false);
    assert.equal(grantedForSite('https://acme.dev/*', ['http://acme.dev/*']), false);
    assert.equal(grantedForSite('https://*.acme.dev/*', ['https://staging.acme.dev/*']), false);
    assert.equal(grantedForSite('https://notacme.dev/*', ['https://*.acme.dev/*']), false);
    assert.equal(grantedForSite('https://acme.dev/*', ['https://acme.dev/admin/*']), false);
    assert.equal(covers('not a pattern', 'https://acme.dev/*'), false);
  });

  it('reads the grants of the browser, and a site the reviewer asked for that it still holds', async () => {
    const seams = (origins: string[], recorded: string[], held: boolean) => ({
      getAll: async () => ({ origins }),
      contains: async () => held,
      recorded: async () => recorded,
    });
    assert.equal(
      await holdsSiteAccess('https://acme.dev/*', seams(['<all_urls>', 'https://acme.dev/*'], [], true)),
      true,
    );
    // Measured on Chromium: with <all_urls> held, a request for a site adds nothing to `getAll`.
    assert.equal(await holdsSiteAccess('https://new.dev/*', seams(['<all_urls>'], ['https://new.dev/*'], true)), true);
    // A site removed in the browser before the switch was turned on: not asked for, not granted.
    assert.equal(await holdsSiteAccess('https://removed.dev/*', seams(['<all_urls>'], [], true)), false);
    // Asked for once, and the browser no longer holds it.
    assert.equal(await holdsSiteAccess('https://new.dev/*', seams([], ['https://new.dev/*'], false)), false);
  });

  it('records a site once, and forgets the sites the browser removed, but not on the removal of every site', () => {
    assert.deepEqual(withGrant(['https://a.dev/*'], 'https://b.dev/*'), ['https://a.dev/*', 'https://b.dev/*']);
    assert.deepEqual(withGrant(['https://a.dev/*'], 'https://a.dev/*'), ['https://a.dev/*']);
    const recorded = ['https://a.dev/*', 'https://staging.b.dev/*'];
    assert.deepEqual(withoutRemoved(recorded, ['https://a.dev/*']), ['https://staging.b.dev/*']);
    assert.deepEqual(withoutRemoved(recorded, ['https://*.b.dev/*']), ['https://a.dev/*']);
    assert.deepEqual(withoutRemoved(recorded, ['<all_urls>']), recorded);
  });

  // The pages cannot run under `node --test`: their sources are read. Every place that decides
  // whether a rule runs reads the grant this way, never `permissions.contains`.
  it('is how the background, the options page, the popup and a pending site read and ask for a grant', () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
    for (const path of [
      '../entrypoints/background.ts',
      '../entrypoints/options/main.ts',
      '../entrypoints/popup/main.ts',
      './pending-site-browser.ts',
    ]) {
      const source = read(path);
      assert.match(source, /holdsRuleAccess\(pattern\)/, path);
      assert.doesNotMatch(source, /permissions\.contains\(\{ origins: \[matchPatternFor/, path);
      // A request for the sites of a rule goes through `requestRuleAccess`, which records the yes.
      assert.doesNotMatch(source, /request\(\{ origins: \[matchPatternFor\((?:pattern|origin)\)/, path);
    }
    // The request is the first call of `requestRuleAccess`: nothing awaited before it.
    assert.match(
      read('./site-grant-browser.ts'),
      /const wanted = matchPatternFor\(pattern\);\s*return browser\.permissions\.request\(\{ origins: \[wanted\] \}\)/,
    );
    assert.match(
      read('../entrypoints/background.ts'),
      /onRemoved\.addListener\(\(removed\) => \{\s*void forgetRemovedAccess/,
    );
  });
});
