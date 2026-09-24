import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DUPLICATE_PROBLEM,
  NO_ACCESS_PROBLEM,
  STORE_PROBLEM,
  activateStored,
  createEditor,
  latestOnly,
} from './site-editor.ts';
import { PATTERN_PROBLEM } from './site-form.ts';
import type { SiteConfig } from './sites.ts';

function editor(granted: boolean, current: Record<string, SiteConfig> = {}) {
  const requests: string[] = [];
  const writes: [string, SiteConfig][] = [];
  const activated: string[] = [];
  const seams = createEditor({
    stored: async () => ({}),
    activate: async (pattern) => {
      activated.push(pattern);
    },
    request: async (pattern) => {
      requests.push(pattern);

      return granted;
    },
    write: async (pattern, site) => {
      writes.push([pattern, site]);
    },
    current: () => current,
  });

  return { ...seams, requests, writes, activated };
}

const fields = { sites: '*.staging.acme.dev', mode: 'private' as const, endpoint: 'https://w.test/', clientId: 'acme' };

describe('createEditor', () => {
  it('asks for the pattern in the same turn as the click, before anything is awaited', () => {
    const page = editor(true);

    void page.add(fields);

    assert.deepEqual(page.requests, ['https://*.staging.acme.dev']);
  });

  it('stores the rule after the grant, as the widget will call it, then activates the open tabs', async () => {
    const page = editor(true);

    assert.equal(await page.add(fields), '');
    assert.deepEqual(page.writes, [
      ['https://*.staging.acme.dev', { mode: 'private', endpoint: 'https://w.test', clientId: 'acme', enabled: true }],
    ]);
    assert.deepEqual(page.activated, ['https://*.staging.acme.dev']);
  });

  it('answers a problem, and stores nothing, when the browser rejects the request', async () => {
    const page = createEditor({
      activate: async () => assert.fail('activated a rule that was not stored'),
      request: async () => {
        throw new Error('Only permissions specified in the manifest may be requested.');
      },
      write: async () => assert.fail('wrote without a grant'),
      current: () => ({}),
      stored: async () => ({}),
    });

    assert.equal(await page.add(fields), NO_ACCESS_PROBLEM);
  });

  /** The background can refuse or fail a change, and the page must say so rather than clear the form. */
  it('answers a problem when the write is not confirmed', async () => {
    const page = createEditor({
      activate: async () => assert.fail('activated a rule that was not stored'),
      request: async () => true,
      write: async () => {
        throw new Error('the background did not store the site change');
      },
      current: () => ({}),
      stored: async () => ({}),
    });

    assert.equal(await page.add(fields), STORE_PROBLEM);
  });

  it('stores nothing when the grant is refused', async () => {
    const page = editor(false);

    assert.equal(await page.add(fields), NO_ACCESS_PROBLEM);
    assert.deepEqual(page.writes, []);
    assert.deepEqual(page.activated, []);
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
    assert.deepEqual(refused.activated, []);

    assert.equal(await granted.switchOn('https://acme.dev', site), true);
    assert.deepEqual(granted.writes, [['https://acme.dev', { ...site, enabled: true }]]);
    assert.deepEqual(granted.activated, ['https://acme.dev']);
  });
});

describe('createEditor.switchOn', () => {
  it('answers false, and stores nothing, when the browser rejects the request', async () => {
    const page = createEditor({
      activate: async () => assert.fail('activated a rule that was not switched on'),
      request: async () => {
        throw new Error('Only permissions specified in the manifest may be requested.');
      },
      write: async () => assert.fail('wrote without a grant'),
      current: () => ({}),
      stored: async () => ({}),
    });

    assert.equal(
      await page.switchOn('https://acme.dev', { mode: 'team', endpoint: 'https://w.test', enabled: false }),
      false,
    );
  });
});

/**
 * A write goes through the background and can reject **after** it is stored, when only the answer is
 * lost (SKG-612). The rule is then On and the tabs already open on it hold no widget until their
 * next load, with nothing to say why.
 */
describe('a write the background did not confirm', () => {
  const PATTERN = 'https://*.staging.acme.dev';
  const SITE: SiteConfig = { mode: 'private', endpoint: 'https://w.test', clientId: 'acme', enabled: true };

  function unconfirmed(stored: Record<string, SiteConfig>) {
    const activated: string[] = [];
    const page = createEditor({
      activate: async (pattern) => {
        activated.push(pattern);
      },
      request: async () => true,
      write: async () => {
        throw new Error('the background did not store the site change');
      },
      current: () => ({}),
      stored: async () => stored,
    });

    return { ...page, activated };
  }

  it('activates the open tabs when the rule is in storage, and still says it was not confirmed', async () => {
    const page = unconfirmed({ [PATTERN]: SITE });

    assert.equal(await page.add(fields), STORE_PROBLEM);
    assert.deepEqual(page.activated, [PATTERN]);
  });

  it('activates nothing when the rule is not in storage, or is stored switched off', async () => {
    const absent = unconfirmed({});
    const off = unconfirmed({ [PATTERN]: { ...SITE, enabled: false } });

    assert.equal(await absent.add(fields), STORE_PROBLEM);
    assert.equal(await off.add(fields), STORE_PROBLEM);
    assert.deepEqual([...absent.activated, ...off.activated], []);
  });

  it('activates the open tabs of a rule switched on, and still rejects', async () => {
    const page = unconfirmed({ 'https://acme.dev': { ...SITE, enabled: true } });

    await assert.rejects(page.switchOn('https://acme.dev', { ...SITE, enabled: false }));
    assert.deepEqual(page.activated, ['https://acme.dev']);
  });

  it('leaves the tabs alone when storage cannot be read', async () => {
    const activated: string[] = [];

    await activateStored(
      [PATTERN],
      () => Promise.reject(new Error('storage is unreadable')),
      async (pattern) => {
        activated.push(pattern);
      },
    );

    assert.deepEqual(activated, []);
  });

  /** The import writes every entry at once, and each one has its own tabs. */
  it('activates only the patterns storage holds switched on', async () => {
    const activated: string[] = [];
    const stored = {
      [PATTERN]: SITE,
      'https://acme.dev': { ...SITE, enabled: false },
      // On, and not part of this change: its tabs already hold the widget.
      'https://other.dev': SITE,
    };

    await activateStored(
      [PATTERN, 'https://acme.dev', 'https://absent.dev'],
      async () => stored,
      async (pattern) => {
        activated.push(pattern);
      },
    );

    assert.deepEqual(activated, [PATTERN]);
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
