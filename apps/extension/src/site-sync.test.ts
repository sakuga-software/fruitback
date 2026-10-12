import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSiteOwner } from './site-writes.ts';
import { type SyncArea, createSiteSync, patternOf, rulesIn, syncKeyOf } from './site-sync.ts';
import type { SiteConfig, SiteMutation } from './sites.ts';

/**
 * The rules of sites in two browsers of one reviewer (FRU-72): two maps in `local`, one `sync` area
 * between them, and the one writer of each map. A change of `sync` reaches the other browser as
 * `storage.onChanged` does: only when a value did change.
 */

const ACME: SiteConfig = { mode: 'private', endpoint: 'https://worker.test', enabled: true, clientId: 'acme' };
const GLOBEX: SiteConfig = { mode: 'private', endpoint: 'https://worker.test', enabled: true, clientId: 'globex' };
const TEAM: SiteConfig = {
  mode: 'team',
  endpoint: 'https://worker.test',
  enabled: true,
  mount: { clientId: 'site_1' },
};

type Change = Record<string, { newValue?: unknown }>;

/** One `sync` area, and what each browser hears of the writes of the other. */
function account() {
  const items: Record<string, unknown> = {};
  const listeners: { of: object; hear: (changes: Change) => Promise<void> }[] = [];
  const writes: string[] = [];
  /** What the browsers are doing with the changes they heard of. */
  const heard: Promise<void>[] = [];
  /** Until every change was heard, and what it started ended too. */
  const idle = async (): Promise<void> => {
    while (heard.length > 0) await heard.shift();
  };
  const areaOf = (browser: object): SyncArea => {
    // An event, as `storage.onChanged` is one: the write does not wait for those who hear of it.
    const tell = (changes: Change): void => {
      if (Object.keys(changes).length === 0) return;
      for (const listener of listeners) {
        if (listener.of === browser) continue;
        heard.push(new Promise<void>((resolve) => setImmediate(resolve)).then(() => listener.hear(changes)));
      }
    };

    return {
      get: async () => structuredClone(items),
      async set(entries) {
        const changes: Change = {};
        for (const [key, value] of Object.entries(entries)) {
          if (JSON.stringify(items[key]) === JSON.stringify(value)) continue;
          items[key] = structuredClone(value);
          changes[key] = { newValue: structuredClone(value) };
        }
        writes.push(`set ${Object.keys(entries).join(',')}`);
        tell(changes);
      },
      async remove(keys) {
        const changes: Change = {};
        for (const key of keys) {
          if (!(key in items)) continue;
          delete items[key];
          changes[key] = {};
        }
        writes.push(`remove ${keys.join(',')}`);
        tell(changes);
      },
    };
  };

  return { items, listeners, writes, areaOf, idle };
}

/** A browser: its map, its one writer, and its copy to `sync` when `on`. */
function browserOn(shared: ReturnType<typeof account>, start: Record<string, SiteConfig> = {}, on = true) {
  const self = { on, map: { ...start }, known: [] as string[] };
  const sync = createSiteSync({
    enabled: async () => self.on,
    known: { read: async () => self.known, write: async (patterns) => void (self.known = patterns) },
    readLocal: async () => self.map,
    area: shared.areaOf(self),
    apply: (mutation) => own(mutation),
  });
  const own = createSiteOwner(
    { read: async () => self.map, replace: async (sites) => void (self.map = sites) },
    async (_before, mutation) => sync.stored(mutation),
  );
  shared.listeners.push({ of: self, hear: (changes) => sync.changed(changes) });

  return {
    self,
    sync,
    /** A change as the popup or the options page makes one, and the end of what follows it. */
    async change(mutation: SiteMutation): Promise<void> {
      await own(mutation);
      // The writer runs its changes one after the other, with what follows each: an empty change
      // ends when the copy of the one before it has ended.
      await own({ kind: 'write', entries: {} });
      await shared.idle();
    },
  };
}

describe('the rules of a reviewer in two browsers (FRU-72)', () => {
  it('carries a rule that is added, changed and removed here to the other browser', async () => {
    const shared = account();
    const here = browserOn(shared);
    const there = browserOn(shared);

    await here.change({ kind: 'write', entries: { 'https://acme.dev': ACME } });
    assert.deepEqual(there.self.map, { 'https://acme.dev': ACME });
    assert.deepEqual(shared.items, { 'site:https://acme.dev': ACME });

    await there.change({ kind: 'write', entries: { 'https://acme.dev': { ...ACME, enabled: false } } });
    assert.equal(here.self.map['https://acme.dev']?.enabled, false);

    await here.change({ kind: 'remove', pattern: 'https://acme.dev' });
    assert.deepEqual(there.self.map, {});
    assert.deepEqual(shared.items, {});
  });

  it('does not send back what arrived: one write for one change, whatever the number of browsers', async () => {
    const shared = account();
    const here = browserOn(shared);
    browserOn(shared);
    browserOn(shared);

    await here.change({ kind: 'write', entries: { 'https://acme.dev': ACME, 'https://*.globex.dev': GLOBEX } });
    await here.change({ kind: 'remove', pattern: 'https://acme.dev' });

    assert.deepEqual(shared.writes, [
      'set site:https://acme.dev,site:https://*.globex.dev',
      'remove site:https://acme.dev',
    ]);
  });

  it('keeps one item for each rule, so two browsers that change two rules lose neither', async () => {
    const shared = account();
    const here = browserOn(shared, { 'https://acme.dev': ACME });
    const there = browserOn(shared, { 'https://acme.dev': ACME });

    await Promise.all([
      here.change({ kind: 'write', entries: { 'https://globex.dev': GLOBEX } }),
      there.change({ kind: 'write', entries: { 'https://team.dev': TEAM } }),
    ]);
    await shared.idle();

    const all = { 'https://acme.dev': ACME, 'https://globex.dev': GLOBEX, 'https://team.dev': TEAM };
    assert.deepEqual(here.self.map, all);
    assert.deepEqual(there.self.map, all);
  });

  it('merges without removing what it never knew: a browser that holds fewer rules erases none by turning it on', async () => {
    const shared = account();
    const here = browserOn(shared, { 'https://acme.dev': ACME, 'https://globex.dev': GLOBEX });
    await here.sync.merge();
    assert.deepEqual(Object.keys(shared.items).sort(), ['site:https://acme.dev', 'site:https://globex.dev']);

    const late = browserOn(shared, { 'https://team.dev': TEAM, 'https://acme.dev': { ...ACME, enabled: false } });
    await late.sync.merge();
    await shared.idle();

    assert.deepEqual(Object.keys(shared.items).sort(), [
      'site:https://acme.dev',
      'site:https://globex.dev',
      'site:https://team.dev',
    ]);
    assert.deepEqual(Object.keys(late.self.map).sort(), ['https://acme.dev', 'https://globex.dev', 'https://team.dev']);
    // A rule of both stays as it is on each side: the merge decides nothing between them.
    assert.equal(late.self.map['https://acme.dev']?.enabled, false);
    assert.equal(here.self.map['https://acme.dev']?.enabled, true);
    assert.deepEqual(here.self.map['https://team.dev'], TEAM);
  });

  /**
   * Raised in review: Bob removes a rule in one browser while his other browser is closed. At its
   * start, that browser held the rule and the account did not: an additive merge sent it back, and
   * the rule came back everywhere.
   */
  it('carries a removal made while this browser was closed, and does not bring the rule back', async () => {
    const shared = account();
    const here = browserOn(shared);
    const there = browserOn(shared);
    await here.change({ kind: 'write', entries: { 'https://acme.dev': ACME, 'https://globex.dev': GLOBEX } });
    assert.deepEqual(there.self.known, ['https://acme.dev', 'https://globex.dev']);

    // Closed: it hears nothing of the removal.
    shared.listeners.splice(1, 1);
    await here.change({ kind: 'remove', pattern: 'https://acme.dev' });
    assert.ok(there.self.map['https://acme.dev'] !== undefined);

    await there.sync.merge();
    await shared.idle();

    assert.deepEqual(Object.keys(there.self.map), ['https://globex.dev']);
    assert.deepEqual(Object.keys(shared.items), ['site:https://globex.dev']);
    assert.deepEqual(Object.keys(here.self.map), ['https://globex.dev']);
  });

  it('finishes a removal made here whose copy failed, at the next merge', async () => {
    const shared = account();
    const here = browserOn(shared);
    await here.change({ kind: 'write', entries: { 'https://acme.dev': ACME } });

    // The account is away when the rule is removed here.
    const away = browserOn(shared, {}, true);
    shared.listeners.splice(-1, 1);
    here.self.map = {};
    assert.deepEqual(Object.keys(shared.items), ['site:https://acme.dev']);
    void away;

    await here.sync.merge();

    assert.deepEqual(shared.items, {});
    assert.deepEqual(here.self.known, []);
  });

  it('sends nothing and takes nothing while the reviewer has not turned it on', async () => {
    const shared = account();
    const here = browserOn(shared);
    const off = browserOn(shared, { 'https://private.dev': GLOBEX }, false);

    await off.change({ kind: 'write', entries: { 'https://secret-staging.dev': ACME } });
    await off.change({ kind: 'remove', pattern: 'https://private.dev' });
    await off.sync.merge();
    assert.deepEqual(shared.items, {});
    assert.deepEqual(shared.writes, []);

    await here.change({ kind: 'write', entries: { 'https://acme.dev': ACME } });
    assert.deepEqual(off.self.map, { 'https://secret-staging.dev': ACME });
  });

  it('takes from the account only what is a rule, and a bad item costs its own rule', async () => {
    const shared = account();
    const here = browserOn(shared);

    await here.sync.changed({
      'site:https://acme.dev': { newValue: ACME },
      'site:not a pattern': { newValue: ACME },
      'site:https://broken.dev': { newValue: { endpoint: '' } },
      'something-else': { newValue: ACME },
      'site:https://never-here.dev': {},
    });

    assert.deepEqual(here.self.map, { 'https://acme.dev': ACME });
    assert.deepEqual(rulesIn({ 'site:https://acme.dev': ACME, 'site:x': ACME, other: 1 }), {
      'https://acme.dev': ACME,
    });
    assert.equal(patternOf(syncKeyOf('https://*.acme.dev')), 'https://*.acme.dev');
    assert.equal(patternOf('sites'), undefined);
  });

  // Raised in review: the whole rule travels, its label and the name of its workspace included, and
  // `docs/privacy.md` must say each field. A field added to `SiteConfig` fails here until it is said.
  it('sends the whole rule and nothing beside it, and the privacy page names each field', async () => {
    const shared = account();
    const here = browserOn(shared);
    const labelled: SiteConfig = { ...ACME, label: 'Review' };
    const mounted: SiteConfig = { ...TEAM, mount: { clientId: 'site_1', workspace: 'Acme' } };

    await here.change({ kind: 'write', entries: { 'https://acme.dev': labelled, 'https://team.dev': mounted } });

    assert.deepEqual(shared.items, { 'site:https://acme.dev': labelled, 'site:https://team.dev': mounted });
    const fields = new Set(
      Object.values(shared.items).flatMap((rule) => [
        ...Object.keys(rule as object),
        ...Object.keys((rule as { mount?: object }).mount ?? {}).map((key) => `mount.${key}`),
      ]),
    );
    assert.deepEqual([...fields].sort(), [
      'clientId',
      'enabled',
      'endpoint',
      'label',
      'mode',
      'mount',
      'mount.clientId',
      'mount.workspace',
    ]);
    const privacy = readFileSync(new URL('../../../docs/privacy.md', import.meta.url), 'utf8').replaceAll(/\s+/g, ' ');
    for (const said of [
      'its pattern',
      'the address of its worker',
      'a client id',
      'whether it is on',
      'the label of the launch button',
      'the name of the workspace',
    ]) {
      assert.ok(privacy.includes(said), `docs/privacy.md does not say « ${said} »`);
    }
  });
});
