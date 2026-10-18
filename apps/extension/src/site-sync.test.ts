import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { previewsKey } from './proven-previews.ts';
import { createSiteOwner } from './site-writes.ts';
import { TOO_LARGE_FOR_ACCOUNT } from './site-form.ts';
import {
  QUOTA_BYTES_PER_ITEM,
  type SyncArea,
  createSiteSync,
  fits,
  patternOf,
  rulesIn,
  syncKeyOf,
} from './site-sync.ts';
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

/** A rule whose label makes its item in `sync` exactly `bytes` long, key included. */
function ruleOf(pattern: string, bytes: number): Extract<SiteConfig, { mode: 'private' }> & { label: string } {
  const empty = {
    mode: 'private',
    endpoint: 'https://worker.test',
    enabled: true,
    clientId: 'acme',
    label: '',
  } as const;
  const size = new TextEncoder().encode(`${syncKeyOf(pattern)}${JSON.stringify(empty)}`).length;

  return { ...empty, label: 'x'.repeat(bytes - size) };
}

/** One `sync` area, and what each browser hears of its writes. */
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
  const areaOf = (_browser: object): SyncArea => {
    // An event, as `storage.onChanged` is one: the write does not wait for those who hear of it.
    const tell = (changes: Change): void => {
      if (Object.keys(changes).length === 0) return;
      // Every browser hears of a write, the one that wrote too: `storage.onChanged` fires there as well.
      for (const listener of listeners) {
        heard.push(new Promise<void>((resolve) => setImmediate(resolve)).then(() => listener.hear(changes)));
      }
    };

    return {
      get: async () => structuredClone(items),
      async set(entries) {
        // As Chrome does: one item over the quota refuses the whole call, and nothing is written.
        for (const [key, value] of Object.entries(entries)) {
          if (new TextEncoder().encode(`${key}${JSON.stringify(value)}`).length > QUOTA_BYTES_PER_ITEM) {
            throw new Error(`QUOTA_BYTES_PER_ITEM quota exceeded: ${key}`);
          }
        }
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

  // Raised in review: a merge reads what is known, then waits on its writes. A rule stored during
  // that wait was dropped from the list when the merge wrote it back, and came back after a removal.
  it('keeps as known a rule that is stored while a merge waits on the account', async () => {
    const shared = account();
    const here = browserOn(shared, { 'https://acme.dev': ACME });
    const area = shared.areaOf(here.self);
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const slow = createSiteSync({
      enabled: async () => true,
      known: { read: async () => here.self.known, write: async (patterns) => void (here.self.known = patterns) },
      readLocal: async () => here.self.map,
      area: { ...area, set: async (items) => (await held, area.set(items)) },
      apply: async () => {},
    });

    const merging = slow.merge();
    // While the merge waits, the reviewer adds a rule, and its copy ends first.
    await here.sync.stored({ kind: 'write', entries: { 'https://globex.dev': GLOBEX } });
    assert.deepEqual(here.self.known, ['https://globex.dev']);
    release();
    await merging;

    assert.deepEqual(here.self.known, ['https://acme.dev', 'https://globex.dev']);
  });

  // Raised in review: the copy of a removal fails, for a rule that this browser did not know in the
  // account yet. The next merge took the rule back from the account.
  it('carries at the next merge a removal whose copy failed, for a rule that was not known yet', async () => {
    const shared = account();
    const here = browserOn(shared, { 'https://acme.dev': ACME });
    shared.items['site:https://acme.dev'] = ACME;
    const area = shared.areaOf(here.self);
    const away = createSiteSync({
      enabled: async () => true,
      known: { read: async () => here.self.known, write: async (patterns) => void (here.self.known = patterns) },
      readLocal: async () => here.self.map,
      area: { ...area, remove: async () => Promise.reject(new Error('the account is away')) },
      apply: async () => {},
    });

    here.self.map = {};
    await assert.rejects(away.stored({ kind: 'remove', pattern: 'https://acme.dev' }), /the account is away/);
    assert.deepEqual(Object.keys(shared.items), ['site:https://acme.dev']);

    await here.sync.merge();

    assert.deepEqual(shared.items, {});
    assert.deepEqual(here.self.map, {});
    assert.deepEqual(here.self.known, []);
  });

  // Raised in review: the list was forgotten outside the line of its writes, and a merge that still
  // ran wrote it back. The next time the copy was turned on, the merge removed rules by that list.
  it('forgets what was known when the copy is turned off, and a merge that still runs writes nothing back', async () => {
    const shared = account();
    const here = browserOn(shared, { 'https://acme.dev': ACME });
    const area = shared.areaOf(here.self);
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const slow = createSiteSync({
      enabled: async () => here.self.on,
      known: { read: async () => here.self.known, write: async (patterns) => void (here.self.known = patterns) },
      readLocal: async () => here.self.map,
      area: { ...area, set: async (items) => (await held, area.set(items)) },
      apply: async () => {},
    });
    here.self.known = ['https://old.dev'];

    const merging = slow.merge();
    here.self.on = false;
    await slow.forget();
    assert.deepEqual(here.self.known, []);
    release();
    await merging;

    assert.deepEqual(here.self.known, []);
  });

  // Raised in review: a merge decided on what it read at its start. A rule that the reviewer put back
  // here while the merge waited was removed from the account, as one that was removed here.
  it('does not remove from the account a rule that came back here while the merge waited', async () => {
    const shared = account();
    const here = browserOn(shared);
    shared.items['site:https://acme.dev'] = ACME;
    here.self.known = ['https://acme.dev'];
    const area = shared.areaOf(here.self);
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const slow = createSiteSync({
      enabled: async () => true,
      known: {
        read: async () => (await held, here.self.known),
        write: async (patterns) => void (here.self.known = patterns),
      },
      readLocal: async () => here.self.map,
      area,
      apply: async () => {},
    });

    const merging = slow.merge();
    await new Promise((resolve) => setImmediate(resolve));
    here.self.map = { 'https://acme.dev': ACME };
    release();
    await merging;

    assert.deepEqual(shared.items, { 'site:https://acme.dev': ACME });
    assert.deepEqual(here.self.known, ['https://acme.dev']);
  });

  // Raised in review: a change that arrives during a merge was applied between the reading of the
  // merge and its writes. The two run one after the other.
  it('applies a change that arrives during a merge after the merge, not inside it', async () => {
    const shared = account();
    const here = browserOn(shared, { 'https://acme.dev': ACME });
    const area = shared.areaOf(here.self);
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const order: string[] = [];
    const slow = createSiteSync({
      enabled: async () => true,
      known: { read: async () => here.self.known, write: async (patterns) => void (here.self.known = patterns) },
      readLocal: async () => here.self.map,
      area: { ...area, set: async (items) => (await held, order.push('the merge sent'), area.set(items)) },
      apply: async (mutation) => {
        if (mutation.kind === 'write' && Object.keys(mutation.entries).length > 0) order.push('the change was applied');
      },
    });

    const merging = slow.merge();
    // The merge has read both sides, and waits on its write, when another browser adds a rule.
    for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    shared.items['site:https://globex.dev'] = GLOBEX;
    const arriving = slow.changed({ 'site:https://globex.dev': { newValue: GLOBEX } });
    for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, []);
    release();
    await Promise.all([merging, arriving]);

    assert.deepEqual(order, ['the merge sent', 'the change was applied']);
  });

  // Raised in review: the reviewer removes a rule here, and a merge starts before the copy of that
  // removal has ended. The account still held the rule, this browser did not know it there, and the
  // merge took it back.
  it('does not take back a rule whose removal here is not copied yet when the merge starts', async () => {
    const shared = account();
    const self = { map: { 'https://acme.dev': ACME } as Record<string, SiteConfig>, known: [] as string[] };
    shared.items['site:https://acme.dev'] = ACME;
    const area = shared.areaOf(self);
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const sync = createSiteSync({
      enabled: async () => true,
      known: { read: async () => self.known, write: async (patterns) => void (self.known = patterns) },
      readLocal: async () => self.map,
      area: { ...area, remove: async (keys) => (await held, area.remove(keys)) },
      apply: (mutation) => own(mutation),
    });
    const own = createSiteOwner(
      { read: async () => self.map, replace: async (sites) => void (self.map = sites) },
      async (_before, mutation) => sync.stored(mutation),
    );

    await own({ kind: 'remove', pattern: 'https://acme.dev' });
    assert.deepEqual(self.map, {});
    assert.deepEqual(Object.keys(shared.items), ['site:https://acme.dev']);
    const merging = sync.merge();
    for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    release();
    await merging;
    await own({ kind: 'write', entries: {} });

    assert.deepEqual(self.map, {});
    assert.deepEqual(shared.items, {});
  });

  // Raised in review: a browser hears of its own writes to the account. The reviewer switches a rule
  // off, then on at once: the echo of « off » arrived when the map said « on » already, and was applied
  // as a change of another browser. The rule went off again for a moment, and its access was given back.
  it('does not apply the echo of its own write over a later change made here', async () => {
    const shared = account();
    const self = { map: {} as Record<string, SiteConfig>, known: [] as string[] };
    const states: boolean[] = [];
    const sync = createSiteSync({
      enabled: async () => true,
      known: { read: async () => self.known, write: async (patterns) => void (self.known = patterns) },
      readLocal: async () => self.map,
      area: shared.areaOf(self),
      apply: (mutation) => own(mutation),
    });
    const own = createSiteOwner(
      {
        read: async () => self.map,
        replace: async (sites) => {
          const rule = sites['https://acme.dev'];
          if (rule !== undefined && states.at(-1) !== rule.enabled) states.push(rule.enabled);
          self.map = sites;
        },
      },
      async (_before, mutation) => sync.stored(mutation),
    );
    shared.listeners.push({ of: self, hear: (changes) => sync.changed(changes) });

    const off = own({ kind: 'write', entries: { 'https://acme.dev': { ...ACME, enabled: false } } });
    const on = own({ kind: 'write', entries: { 'https://acme.dev': ACME } });
    await Promise.all([off, on]);
    await own({ kind: 'write', entries: {} });
    await shared.idle();
    await own({ kind: 'write', entries: {} });

    assert.deepEqual(states, [false, true]);
    assert.deepEqual(self.map, { 'https://acme.dev': ACME });
    assert.deepEqual(shared.items, { 'site:https://acme.dev': ACME });
  });

  // The same echo, when the copy of the later change has not reached the account yet: the account
  // still says « off », and the map says « on ». The echo waits for that copy to end.
  it('does not apply the echo of its own write while the copy of a later change is on its way', async () => {
    const shared = account();
    const self = { map: {} as Record<string, SiteConfig>, known: [] as string[] };
    const states: boolean[] = [];
    const area = shared.areaOf(self);
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let sets = 0;
    const sync = createSiteSync({
      enabled: async () => true,
      known: { read: async () => self.known, write: async (patterns) => void (self.known = patterns) },
      readLocal: async () => self.map,
      // The first copy goes at once, the second one waits.
      area: { ...area, set: async (items) => ((sets += 1) > 1 ? (await held, area.set(items)) : area.set(items)) },
      apply: (mutation) => own(mutation),
    });
    const own = createSiteOwner(
      {
        read: async () => self.map,
        replace: async (sites) => {
          const rule = sites['https://acme.dev'];
          if (rule !== undefined && states.at(-1) !== rule.enabled) states.push(rule.enabled);
          self.map = sites;
        },
      },
      async (_before, mutation) => sync.stored(mutation),
    );
    shared.listeners.push({ of: self, hear: (changes) => sync.changed(changes) });

    await own({ kind: 'write', entries: { 'https://acme.dev': { ...ACME, enabled: false } } });
    await own({ kind: 'write', entries: { 'https://acme.dev': ACME } });
    for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(states, [false, true]);
    release();
    await own({ kind: 'write', entries: {} });
    await shared.idle();
    await own({ kind: 'write', entries: {} });

    assert.deepEqual(states, [false, true]);
    assert.deepEqual(shared.items, { 'site:https://acme.dev': ACME });
  });

  // FRU-264: the account refuses a whole `set` for one item over its quota. An import of three rules
  // with one large rule copied none of them, and marked none as known.
  it('copies the other rules of a change when the account refuses one of them, and marks only those as known', async () => {
    const shared = account();
    const here = browserOn(shared);
    const there = browserOn(shared);
    const large = ruleOf('https://large.dev', QUOTA_BYTES_PER_ITEM + 1);

    await here.change({
      kind: 'write',
      entries: { 'https://acme.dev': ACME, 'https://large.dev': large, 'https://globex.dev': GLOBEX },
    });

    assert.deepEqual(shared.items, { 'site:https://acme.dev': ACME, 'site:https://globex.dev': GLOBEX });
    assert.deepEqual(here.self.known, ['https://acme.dev', 'https://globex.dev']);
    assert.deepEqual(there.self.map, { 'https://acme.dev': ACME, 'https://globex.dev': GLOBEX });
    // The rule stays here, and the options page tells it by its size.
    assert.deepEqual(here.self.map['https://large.dev'], large);
    assert.equal(fits('https://large.dev', large), false);

    // The other direction: the same rule, made small enough, goes to the account.
    const smaller = ruleOf('https://large.dev', QUOTA_BYTES_PER_ITEM);
    await here.change({ kind: 'write', entries: { 'https://large.dev': smaller } });
    assert.deepEqual(shared.items, {
      'site:https://acme.dev': ACME,
      'site:https://globex.dev': GLOBEX,
      'site:https://large.dev': smaller,
    });
    assert.deepEqual(here.self.known, ['https://acme.dev', 'https://globex.dev', 'https://large.dev']);
    assert.deepEqual(there.self.map, {
      'https://acme.dev': ACME,
      'https://globex.dev': GLOBEX,
      'https://large.dev': smaller,
    });
  });

  it('sends the other rules at a merge when one of them is too large for the account, and marks only those as known', async () => {
    const shared = account();
    const large = ruleOf('https://large.dev', QUOTA_BYTES_PER_ITEM + 1);
    const here = browserOn(shared, {
      'https://acme.dev': ACME,
      'https://large.dev': large,
      'https://globex.dev': GLOBEX,
    });

    await here.sync.merge();
    await shared.idle();

    assert.deepEqual(shared.items, { 'site:https://acme.dev': ACME, 'site:https://globex.dev': GLOBEX });
    assert.deepEqual(here.self.known, ['https://acme.dev', 'https://globex.dev']);
    assert.deepEqual(Object.keys(here.self.map).sort(), [
      'https://acme.dev',
      'https://globex.dev',
      'https://large.dev',
    ]);
  });

  it('measures a rule as the browser measures an item: the key and the JSON, in bytes', () => {
    assert.equal(fits('https://acme.dev', ruleOf('https://acme.dev', QUOTA_BYTES_PER_ITEM)), true);
    assert.equal(fits('https://acme.dev', ruleOf('https://acme.dev', QUOTA_BYTES_PER_ITEM + 1)), false);
    // One « é » is two bytes: a count of characters would let this rule through.
    const accented = ruleOf('https://acme.dev', QUOTA_BYTES_PER_ITEM);
    assert.equal(fits('https://acme.dev', { ...accented, label: `é${accented.label.slice(1)}` }), false);
    assert.ok(
      TOO_LARGE_FOR_ACCOUNT.includes(`${QUOTA_BYTES_PER_ITEM / 1024} KB`),
      'the options page must say the quota that the code applies',
    );
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

    // What another browser, or anything else, left in the account.
    Object.assign(shared.items, {
      'site:https://acme.dev': ACME,
      'site:not a pattern': ACME,
      'site:https://broken.dev': { endpoint: '' },
      'something-else': ACME,
    });
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

  // The previews that a worker lists (FRU-103) are a grant of that worker to this browser, for a
  // time. They are not a rule of the reviewer, and they never go to the account of the browser.
  it('sends no list of previews of a worker to the account, and takes none from it', async () => {
    const shared = account();
    const here = browserOn(shared);
    const listed = { at: 1, previews: { 'https://*.acme.dev': 'site_1' } };

    // A list that something put in the account is not a rule: it reaches no map here.
    shared.items[previewsKey('https://worker.test')] = listed;
    await here.sync.changed({ [previewsKey('https://worker.test')]: { newValue: listed } });
    await here.change({ kind: 'write', entries: { 'https://team.dev': TEAM } });
    await here.sync.merge();
    await shared.idle();

    assert.deepEqual(here.self.map, { 'https://team.dev': TEAM });
    assert.deepEqual(rulesIn(shared.items), { 'https://team.dev': TEAM });
    assert.equal(patternOf(previewsKey('https://worker.test')), undefined);
    const written = shared.writes.flatMap((write) => write.replace(/^(set|remove) /, '').split(','));
    assert.deepEqual(written, ['site:https://team.dev']);
  });

  it('has one place that reaches the account of the browser, and it carries rules only', () => {
    const sources = ['../src/', '../entrypoints/'].flatMap((folder) =>
      readdirSync(new URL(folder, import.meta.url), { recursive: true, encoding: 'utf8' })
        .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.fixture.ts'))
        .map((name) => ({
          name: `${folder}${name}`,
          text: readFileSync(new URL(`${folder}${name}`, import.meta.url), 'utf8'),
        })),
    );
    const code = (text: string): string[] =>
      text
        .split('\n')
        .filter(
          (line) => !/^\s*(\*|\/\*|\/\/)/.test(line) && /\bstorage\s*\.\s*sync\b|\[\s*['"]sync['"]\s*\]/.test(line),
        );

    assert.deepEqual(
      sources.flatMap(({ name, text }) => code(text).map((line) => `${name}: ${line.trim()}`)),
      [
        '../entrypoints/background.ts: get: () => browser.storage.sync.get(null),',
        '../entrypoints/background.ts: set: (items) => browser.storage.sync.set(items),',
        '../entrypoints/background.ts: remove: (keys) => browser.storage.sync.remove(keys),',
      ],
    );
    const sync = readFileSync(new URL('./site-sync.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(sync, /from '[^']*proven-previews/, 'the copy of the rules must not read what a worker listed');
  });
});
