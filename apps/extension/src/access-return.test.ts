import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { accessOf, accessToReturn, createAccessReturn, patternsOf } from './access-return.ts';
import { applyMutation, createSiteOwner } from './site-writes.ts';
import type { SiteConfig, SiteMutation } from './sites.ts';

const WORKER = 'https://feedback.acme.dev';
const on: SiteConfig = { mode: 'private', endpoint: `${WORKER}/fruitback`, clientId: 'acme', enabled: true };
const off: SiteConfig = { ...on, enabled: false };
const team: SiteConfig = { mode: 'team', endpoint: WORKER, enabled: true };

describe('the access a rule gives back (FRU-115)', () => {
  it('gives back the site and its worker when the only rule is switched off', () => {
    const before = { 'https://acme.dev': on };
    const after = { 'https://acme.dev': off };

    assert.deepEqual(accessToReturn(accessOf(before, ['https://acme.dev']), after, []), ['https://acme.dev', WORKER]);
  });

  it('keeps a rule that stays on, so a save of the same rule takes nothing back', () => {
    const sites = { 'https://acme.dev': on };

    assert.deepEqual(accessToReturn(accessOf(sites, ['https://acme.dev']), sites, []), []);
  });

  it('keeps the worker until its last site is off', () => {
    const before = { 'https://acme.dev': on, 'https://globex.dev': team };
    const oneOff = { 'https://acme.dev': off, 'https://globex.dev': team };
    const bothOff = { 'https://acme.dev': off, 'https://globex.dev': { ...team, enabled: false } };

    assert.deepEqual(accessToReturn(accessOf(before, ['https://acme.dev']), oneOff, []), ['https://acme.dev']);
    assert.deepEqual(accessToReturn(accessOf(oneOff, ['https://globex.dev']), bothOff, []), [
      'https://globex.dev',
      WORKER,
    ]);
  });

  it('keeps the worker while this browser holds a session with it, whatever the path of the endpoint', () => {
    const before = { 'https://acme.dev': on };
    const after = { 'https://acme.dev': off };

    assert.deepEqual(accessToReturn(accessOf(before, ['https://acme.dev']), after, [WORKER]), ['https://acme.dev']);
    assert.deepEqual(accessToReturn(accessOf(before, ['https://acme.dev']), after, [`${WORKER}/fruitback`]), [
      'https://acme.dev',
    ]);
    // A session with another worker keeps nothing here.
    assert.deepEqual(accessToReturn(accessOf(before, ['https://acme.dev']), after, ['https://other.dev']), [
      'https://acme.dev',
      WORKER,
    ]);
  });

  it('gives back the old worker when a rule moves to another one', () => {
    const before = { 'https://acme.dev': on };
    const after = { 'https://acme.dev': { ...on, endpoint: 'https://new.acme.dev' } };

    assert.deepEqual(accessToReturn(accessOf(before, ['https://acme.dev']), after, []), [WORKER]);
  });

  it('gives back the access of a rule that is removed, and of one that was off already', () => {
    assert.deepEqual(accessToReturn(accessOf({ 'https://acme.dev': on }, ['https://acme.dev']), {}, []), [
      'https://acme.dev',
      WORKER,
    ]);
    assert.deepEqual(accessToReturn(accessOf({ 'https://acme.dev': off }, ['https://acme.dev']), {}, []), [
      'https://acme.dev',
      WORKER,
    ]);
  });

  it('keeps a wildcard that covers a site, a narrower wildcard or a worker that is still in use', () => {
    const wide = 'https://*.staging.acme.dev';
    const candidates = accessOf({ [wide]: on }, [wide]);
    const offWide = { [wide]: off };

    assert.deepEqual(accessToReturn(candidates, offWide, []), [wide, WORKER]);
    assert.deepEqual(accessToReturn(candidates, { ...offWide, 'https://pr-1.staging.acme.dev': on }, []), []);
    assert.deepEqual(accessToReturn(candidates, { ...offWide, 'https://staging.acme.dev': on }, []), []);
    assert.deepEqual(accessToReturn(candidates, { ...offWide, 'https://*.eu.staging.acme.dev': on }, []), []);
    // The grant of a match pattern covers every port: a worker on a port of those hosts is covered.
    assert.deepEqual(accessToReturn([wide], offWide, ['https://api.staging.acme.dev:8443']), []);
    // Another scheme, and a host that only ends with the same letters, are not covered.
    assert.deepEqual(accessToReturn([wide], { ...offWide, 'http://pr-1.staging.acme.dev': on }, []), [wide]);
    assert.deepEqual(accessToReturn([wide], { ...offWide, 'https://notstaging.acme.dev': on }, []), [wide]);
  });

  it('gives back an exact site under a wildcard that stays on', () => {
    const sites = { 'https://*.staging.acme.dev': on, 'https://pr-1.staging.acme.dev': off };

    assert.deepEqual(accessToReturn(['https://pr-1.staging.acme.dev'], sites, []), ['https://pr-1.staging.acme.dev']);
  });

  it('does not count a rule that runs nowhere: a team wildcard, and a key that is not a pattern', () => {
    const sites = { 'https://*.vercel.app': team, 'acme.dev/': on };

    assert.deepEqual(accessToReturn([WORKER, 'https://*.vercel.app'], sites, []), [WORKER, 'https://*.vercel.app']);
    assert.deepEqual(accessOf(sites, ['acme.dev/', 'https://missing.dev']), []);
  });

  it('names the patterns a change touches', () => {
    assert.deepEqual(patternsOf({ kind: 'remove', pattern: 'https://acme.dev' }), ['https://acme.dev']);
    assert.deepEqual(patternsOf({ kind: 'write', entries: { 'https://a.dev': on, 'https://b.dev': off } }), [
      'https://a.dev',
      'https://b.dev',
    ]);
  });
});

describe('createAccessReturn', () => {
  it('removes each access that nothing uses, and goes on after one the browser refuses', async () => {
    const warned = mock.method(console, 'warn', () => undefined);
    const removed: string[] = [];
    const giveBack = createAccessReturn({
      sites: async () => ({ 'https://kept.dev': on }),
      paired: async () => [],
      remove: async (access) => {
        // A browser refuses to remove an access that the manifest requires.
        if (access === 'https://required.dev') throw new Error('You cannot remove required permissions.');
        removed.push(access);
      },
    });

    await giveBack(['https://required.dev', 'https://kept.dev', 'https://gone.dev', 'https://gone.dev']);

    assert.deepEqual(removed, ['https://gone.dev']);
    assert.equal(warned.mock.calls.length, 1);
    mock.restoreAll();
  });

  it('removes nothing when the sessions cannot be read', async () => {
    const removed: string[] = [];
    const giveBack = createAccessReturn({
      sites: async () => ({}),
      paired: async () => {
        throw new Error('storage');
      },
      remove: async (access) => void removed.push(access),
    });

    await assert.rejects(giveBack(['https://acme.dev']));
    assert.deepEqual(removed, []);
  });
});

describe('the owner of the sites map, with the access given back after each change (FRU-115)', () => {
  /** The background's wiring, over a map in memory. */
  function owner(initial: Record<string, SiteConfig>) {
    let stored = initial;
    const removed: string[] = [];
    const giveBack = createAccessReturn({
      sites: async () => stored,
      paired: async () => [],
      remove: async (access) => void removed.push(access),
    });
    const own = createSiteOwner(
      {
        read: async () => stored,
        replace: async (sites) => {
          stored = sites;
        },
      },
      (before, mutation) => giveBack(accessOf(before, patternsOf(mutation))),
    );

    return { own, removed, stored: () => stored };
  }

  it('gives the access back when a site is switched off, and keeps the worker of the site still on', async () => {
    const { own, removed } = owner({ 'https://acme.dev': on, 'https://globex.dev': on });

    await own({ kind: 'write', entries: { 'https://acme.dev': off } });
    await own({ kind: 'write', entries: { 'https://globex.dev': on } });
    assert.deepEqual(removed, ['https://acme.dev']);

    await own({ kind: 'remove', pattern: 'https://globex.dev' });
    // A change answers when it is stored. The next one waits for its access to be given back.
    await own({ kind: 'write', entries: {} });
    assert.deepEqual(removed, ['https://acme.dev', 'https://globex.dev', WORKER]);
  });

  it('reads the map of before each change, when two changes are sent together', async () => {
    const { own, removed } = owner({ 'https://acme.dev': on });
    const moved: SiteMutation = {
      kind: 'write',
      entries: { 'https://acme.dev': { ...on, endpoint: 'https://b.dev' } },
    };

    await Promise.all([own(moved), own({ kind: 'remove', pattern: 'https://acme.dev' })]);
    // The next change waits for the access of this one.
    await own({ kind: 'write', entries: {} });

    assert.deepEqual(removed, [WORKER, 'https://acme.dev', 'https://b.dev']);
  });

  it('stores the change and applies the next one when the access cannot be given back', async () => {
    const failed = mock.method(console, 'error', () => undefined);
    let stored: Record<string, SiteConfig> = { 'https://acme.dev': on };
    const own = createSiteOwner(
      {
        read: async () => stored,
        replace: async (sites) => {
          stored = sites;
        },
      },
      async (_before, mutation) => {
        if (patternsOf(mutation).length > 0) throw new Error('permissions');
      },
    );

    await own({ kind: 'write', entries: { 'https://acme.dev': off } });
    await own({ kind: 'remove', pattern: 'https://acme.dev' });
    await own({ kind: 'write', entries: {} });

    assert.deepEqual(stored, applyMutation({}, { kind: 'write', entries: {} }));
    assert.equal(failed.mock.calls.length, 2);
    mock.restoreAll();
  });
});
