import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DUPLICATE_PROBLEM, NO_ACCESS_PROBLEM, STORE_PROBLEM, createEditor, latestOnly } from './site-editor.ts';
import { PATTERN_PROBLEM } from './site-form.ts';
import type { SiteConfig } from './sites.ts';

function editor(granted: boolean, current: Record<string, SiteConfig> = {}) {
  const requests: string[] = [];
  const writes: [string, SiteConfig][] = [];
  const seams = createEditor({
    request: async (pattern) => {
      requests.push(pattern);

      return granted;
    },
    write: async (pattern, site) => {
      writes.push([pattern, site]);
    },
    current: () => current,
  });

  return { ...seams, requests, writes };
}

const fields = { sites: '*.staging.acme.dev', mode: 'private' as const, endpoint: 'https://w.test/', clientId: 'acme' };

describe('createEditor', () => {
  it('asks for the pattern in the same turn as the click, before anything is awaited', () => {
    const page = editor(true);

    void page.add(fields);

    assert.deepEqual(page.requests, ['https://*.staging.acme.dev']);
  });

  it('stores the rule after the grant, as the widget will call it', async () => {
    const page = editor(true);

    assert.equal(await page.add(fields), '');
    assert.deepEqual(page.writes, [
      ['https://*.staging.acme.dev', { mode: 'private', endpoint: 'https://w.test', clientId: 'acme', enabled: true }],
    ]);
  });

  /** The background can refuse or fail a change, and the page must say so rather than clear the form. */
  it('answers a problem when the write is not confirmed', async () => {
    const page = createEditor({
      request: async () => true,
      write: async () => {
        throw new Error('the background did not store the site change');
      },
      current: () => ({}),
    });

    assert.equal(await page.add(fields), STORE_PROBLEM);
  });

  it('stores nothing when the grant is refused', async () => {
    const page = editor(false);

    assert.equal(await page.add(fields), NO_ACCESS_PROBLEM);
    assert.deepEqual(page.writes, []);
  });

  it('refuses a bad pattern, a duplicate or a bad field without asking the browser', async () => {
    const existing = {
      'https://*.staging.acme.dev': { mode: 'team', endpoint: 'https://w.test', enabled: true },
    } as const;

    const bad = editor(true);
    assert.equal(await bad.add({ ...fields, sites: 'https://*' }), PATTERN_PROBLEM);
    const duplicate = editor(true, existing);
    assert.equal(await duplicate.add(fields), DUPLICATE_PROBLEM);
    const incomplete = editor(true);
    assert.equal(await incomplete.add({ ...fields, clientId: '' }), 'The client id is required.');

    for (const page of [bad, duplicate, incomplete]) {
      assert.deepEqual(page.requests, []);
      assert.deepEqual(page.writes, []);
    }
  });

  it('switches a rule on only after the grant, and asks before anything is awaited', async () => {
    const site: SiteConfig = { mode: 'team', endpoint: 'https://w.test', enabled: false };
    const refused = editor(false);
    const granted = editor(true);

    const refusal = refused.switchOn('https://acme.dev', site);
    assert.deepEqual(refused.requests, ['https://acme.dev']);
    assert.equal(await refusal, false);
    assert.deepEqual(refused.writes, []);

    assert.equal(await granted.switchOn('https://acme.dev', site), true);
    assert.deepEqual(granted.writes, [['https://acme.dev', { ...site, enabled: true }]]);
  });
});

describe('latestOnly', () => {
  it('tells an older render that a newer one started', () => {
    const begin = latestOnly();
    const first = begin();
    const second = begin();

    assert.equal(first(), false);
    assert.equal(second(), true);
  });
});
