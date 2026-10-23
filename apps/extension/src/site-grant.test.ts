import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { covers, grantedForSite, holdsSiteAccess } from './site-grant.ts';

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

  it('reads the grants of the browser', async () => {
    const permissions = { getAll: async () => ({ origins: ['<all_urls>', 'https://acme.dev/*'] }) };
    assert.equal(await holdsSiteAccess('https://acme.dev/*', permissions), true);
    assert.equal(await holdsSiteAccess('https://removed.dev/*', permissions), false);
    assert.equal(await holdsSiteAccess('https://acme.dev/*', { getAll: async () => ({}) }), false);
  });

  // The pages cannot run under `node --test`: their sources are read. Every place that decides
  // whether a rule runs reads the grant this way, never `permissions.contains`.
  it('is how the background, the options page, the popup and a pending site read a grant', () => {
    for (const path of [
      '../entrypoints/background.ts',
      '../entrypoints/options/main.ts',
      '../entrypoints/popup/main.ts',
      './pending-site-browser.ts',
    ]) {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8');
      assert.match(source, /holdsSiteAccess\(matchPatternFor\(pattern\), browser\.permissions\)/, path);
      assert.doesNotMatch(source, /permissions\.contains\(\{ origins: \[matchPatternFor/, path);
    }
  });
});
