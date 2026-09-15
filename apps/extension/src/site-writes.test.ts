import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, createSiteOwner, isExtensionPage, parseSiteMutation } from './site-writes.ts';
import { SITE_MUTATION, type SiteConfig } from './sites.ts';

const acme: SiteConfig = { mode: 'private', endpoint: 'https://w.test', clientId: 'acme', enabled: true };
const globex: SiteConfig = { mode: 'team', endpoint: 'https://w.test', enabled: true };

describe('applyMutation', () => {
  it('adds or replaces entries, and removes one, keeping the others', () => {
    const sites = { 'https://acme.dev': acme };

    assert.deepEqual(applyMutation(sites, { kind: 'write', entries: { 'https://globex.dev': globex } }), {
      'https://acme.dev': acme,
      'https://globex.dev': globex,
    });
    assert.deepEqual(
      applyMutation({ ...sites, 'https://globex.dev': globex }, { kind: 'remove', pattern: 'https://acme.dev' }),
      {
        'https://globex.dev': globex,
      },
    );
  });
});

describe('createSiteOwner', () => {
  /** A storage area whose reads and writes each wait a turn, as `chrome.storage` does. */
  function area(initial: Record<string, SiteConfig> = {}) {
    let stored = initial;
    let failNext = false;

    return {
      failNext: () => {
        failNext = true;
      },
      stored: () => stored,
      read: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));

        return stored;
      },
      replace: async (sites: Record<string, SiteConfig>) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (failNext) {
          failNext = false;
          throw new Error('quota');
        }
        stored = sites;
      },
    };
  }

  it('keeps both of two changes sent at the same time', async () => {
    const storage = area({ 'https://old.dev': acme });
    const own = createSiteOwner(storage);

    await Promise.all([
      own({ kind: 'write', entries: { 'https://acme.dev': acme } }),
      own({ kind: 'write', entries: { 'https://globex.dev': globex } }),
      own({ kind: 'remove', pattern: 'https://old.dev' }),
    ]);

    assert.deepEqual(storage.stored(), { 'https://acme.dev': acme, 'https://globex.dev': globex });
  });

  it('rejects a change that could not be stored, and still applies the next one', async () => {
    const storage = area();
    const own = createSiteOwner(storage);
    storage.failNext();

    await assert.rejects(own({ kind: 'write', entries: { 'https://acme.dev': acme } }));
    await own({ kind: 'write', entries: { 'https://globex.dev': globex } });

    assert.deepEqual(storage.stored(), { 'https://globex.dev': globex });
  });
});

describe('parseSiteMutation', () => {
  const message = (mutation: unknown) => ({ channel: SITE_MUTATION, mutation });

  it('reads a write and a remove', () => {
    assert.deepEqual(parseSiteMutation(message({ kind: 'write', entries: { 'https://*.acme.dev': acme } })), {
      kind: 'write',
      entries: { 'https://*.acme.dev': acme },
    });
    assert.deepEqual(parseSiteMutation(message({ kind: 'remove', pattern: 'https://acme.dev' })), {
      kind: 'remove',
      pattern: 'https://acme.dev',
    });
  });

  it('refuses a change with a key that is not a pattern, or an entry that does not parse', () => {
    for (const mutation of [
      { kind: 'write', entries: { 'https://*': acme } },
      { kind: 'write', entries: { 'https://acme.dev': { mode: 'private', endpoint: 'https://w.test' } } },
      { kind: 'write', entries: [] },
      { kind: 'remove', pattern: '*.acme.dev' },
      { kind: 'clear' },
    ]) {
      assert.equal(parseSiteMutation(message(mutation)), undefined, JSON.stringify(mutation));
    }
    assert.equal(
      parseSiteMutation({ channel: 'fruitback', mutation: { kind: 'remove', pattern: 'https://acme.dev' } }),
      undefined,
    );
  });
});

describe('isExtensionPage', () => {
  const root = 'chrome-extension://abcdef/';

  it('accepts the popup and the options page, in a tab or not', () => {
    assert.equal(isExtensionPage({ id: 'abcdef', url: `${root}popup.html` }, 'abcdef', root), true);
    assert.equal(isExtensionPage({ id: 'abcdef', url: `${root}options.html` }, 'abcdef', root), true);
  });

  /** A content script of this extension has our id and the page's URL. The page writes its input. */
  it('refuses a content script, another extension, and a sender with no URL', () => {
    assert.equal(isExtensionPage({ id: 'abcdef', url: 'https://acme.dev/pricing' }, 'abcdef', root), false);
    assert.equal(
      isExtensionPage({ id: 'abcdef', url: 'chrome-extension://abcdefgh/options.html' }, 'abcdef', root),
      false,
    );
    assert.equal(isExtensionPage({ id: 'other', url: 'chrome-extension://other/options.html' }, 'abcdef', root), false);
    assert.equal(isExtensionPage({ id: 'abcdef' }, 'abcdef', root), false);
  });

  it('refuses everything when the root has no trailing slash, which would match a longer id', () => {
    assert.equal(
      isExtensionPage({ id: 'abcdef', url: 'chrome-extension://abcdefgh/x' }, 'abcdef', 'chrome-extension://abcdef'),
      false,
    );
  });
});
