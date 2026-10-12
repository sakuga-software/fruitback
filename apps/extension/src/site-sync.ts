import { parseSitePattern } from './site-patterns.ts';
import { type SiteConfig, type SiteMutation, parseSite } from './sites.ts';

/**
 * The rules of sites, in the reviewer's other browsers too, when the reviewer asks for it (FRU-72).
 *
 * **Off until the reviewer turns it on.** `storage.sync` is kept by the account of the browser
 * (Google, Mozilla, …), so a rule that is synchronised leaves this computer: the address of a
 * staging site, the address of its worker, a client id. Nobody decides that for a reviewer.
 *
 * **The map in `local` stays the one that everything reads.** Nothing changes for the bridge, the
 * relay, the popup or the registration, and no stored shape moves: a browser that never turns this
 * on, and a version of before, read what they always read. `sync` holds a copy, **one key for each
 * pattern** (`site:<pattern>`): two browsers that change two rules do not write one item, and the
 * quota of 8 KB is for one rule, not for all of them.
 *
 * Three moves, and no other:
 *
 * - **a change made here** goes to `sync` as that change: the entries written, or the key removed;
 * - **a change that arrives** from another browser is applied to the map here, by the one writer of
 *   the map (`createSiteOwner`), and is not sent back;
 * - **`merge`**, when the reviewer turns it on and when the browser starts: each side takes the rules
 *   it does not have, **except a rule that this browser knew in the account** (`KnownRules`, in
 *   `local`): that one was removed on one side while the other was closed, and the removal is carried
 *   (raised in review: a browser closed during a removal brought the rule back). A browser that holds
 *   fewer rules erases none of the others' by starting: the rules it never knew are taken, not removed.
 *   Turning the copy off forgets what was known, so a later merge takes and removes nothing it cannot
 *   tell apart.
 *
 * **What does not travel: the access, and the session.** A host permission is of one browser. A rule
 * that arrives runs nowhere until the reviewer grants access there: the options page says « No
 * access in this browser » beside it, with the button that grants it. The session of a worker is in
 * `local` and never here.
 */

/** In `local`: whether this browser copies its rules to `sync`. Absent is off. */
export const SYNC_SETTING = 'syncRules';

/** In `local`: the patterns this browser knows to be in the account (`KnownRules`). */
export const KNOWN_SETTING = 'syncedRules';

/** The key of a rule in `sync`. */
export const SYNC_PREFIX = 'site:';

export function syncKeyOf(pattern: string): string {
  return `${SYNC_PREFIX}${pattern}`;
}

/** The pattern that a key of `sync` names, or `undefined` for a key that is not a rule. */
export function patternOf(key: string): string | undefined {
  if (!key.startsWith(SYNC_PREFIX)) return undefined;
  const pattern = key.slice(SYNC_PREFIX.length);

  return parseSitePattern(pattern) === pattern ? pattern : undefined;
}

export type SyncArea = {
  get(): Promise<Record<string, unknown>>;
  set(items: Record<string, SiteConfig>): Promise<void>;
  remove(keys: string[]): Promise<void>;
};

/**
 * The patterns that this browser knows to be in the account: written there from here, or taken from
 * there. A merge tells by it a rule that was never copied from one that was removed elsewhere.
 */
export type KnownRules = { read(): Promise<string[]>; write(patterns: string[]): Promise<void> };

export type SiteSyncSeams = {
  enabled: () => Promise<boolean>;
  known: KnownRules;
  readLocal: () => Promise<Record<string, SiteConfig>>;
  area: SyncArea;
  /** The one writer of the map. A mutation that comes from here is marked with `markArrived`. */
  apply: (mutation: SiteMutation) => Promise<void>;
};

/** The rules that `sync` holds, each one parsed like a stored one. A bad item costs its own rule. */
export function rulesIn(items: Record<string, unknown>): Record<string, SiteConfig> {
  const rules: Record<string, SiteConfig> = {};
  for (const [key, value] of Object.entries(items)) {
    const pattern = patternOf(key);
    const site = parseSite(value);
    if (pattern !== undefined && site !== undefined) rules[pattern] = site;
  }

  return rules;
}

function same(first: SiteConfig | undefined, second: SiteConfig | undefined): boolean {
  return JSON.stringify(sorted(first)) === JSON.stringify(sorted(second));
}

function sorted(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;

  return Object.fromEntries(
    Object.entries(value)
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([key, each]) => [key, sorted(each)]),
  );
}

export function createSiteSync({ enabled, known, readLocal, area, apply }: SiteSyncSeams) {
  /** The mutations that came from `sync`: they are stored here, and not sent back there. */
  const arrived = new WeakSet<SiteMutation>();
  const remember = async (add: string[], drop: string[] = []): Promise<void> => {
    const now = new Set(await known.read());
    for (const pattern of add) now.add(pattern);
    for (const pattern of drop) now.delete(pattern);
    await known.write([...now].sort());
  };

  return {
    /** A change that the one writer just stored. Sent to `sync` unless it came from there. */
    async stored(mutation: SiteMutation): Promise<void> {
      if (arrived.has(mutation) || !(await enabled())) return;

      if (mutation.kind === 'remove') {
        await area.remove([syncKeyOf(mutation.pattern)]);
        await remember([], [mutation.pattern]);

        return;
      }
      const remote = rulesIn(await area.get());
      const changed = Object.entries(mutation.entries).filter(([pattern, site]) => !same(remote[pattern], site));
      if (changed.length > 0) {
        await area.set(Object.fromEntries(changed.map(([pattern, site]) => [syncKeyOf(pattern), site])));
      }
      await remember(Object.keys(mutation.entries));
    },

    /** What `storage.onChanged` says of the `sync` area: applied here, rule by rule. */
    async changed(changes: Record<string, { newValue?: unknown }>): Promise<void> {
      if (!(await enabled())) return;
      const local = await readLocal();
      const entries: Record<string, SiteConfig> = {};

      for (const [key, change] of Object.entries(changes)) {
        const pattern = patternOf(key);
        if (pattern === undefined) continue;

        if (change.newValue === undefined) {
          await remember([], [pattern]);
          if (local[pattern] === undefined) continue;
          const mutation: SiteMutation = { kind: 'remove', pattern };
          arrived.add(mutation);
          await apply(mutation);
          continue;
        }
        const site = parseSite(change.newValue);
        // The same rule is here already: nothing to write, and nothing that would echo.
        if (site !== undefined && !same(local[pattern], site)) entries[pattern] = site;
      }

      if (Object.keys(entries).length === 0) return;
      const mutation: SiteMutation = { kind: 'write', entries };
      arrived.add(mutation);
      await apply(mutation);
      await remember(Object.keys(entries));
    },

    /**
     * Each side takes the rules it does not have, **unless this browser knew the rule in the account**:
     * then it was removed on one side while the other was closed, or while its copy failed, and the
     * removal is what is carried. A rule of both stays as it is on each.
     */
    async merge(): Promise<void> {
      if (!(await enabled())) return;
      const [local, remote, before] = [await readLocal(), rulesIn(await area.get()), new Set(await known.read())];
      const valid = (pattern: string): boolean => parseSitePattern(pattern) === pattern;

      // In the account, not here.
      const takeHere: Record<string, SiteConfig> = {};
      const removeThere: string[] = [];
      for (const [pattern, site] of Object.entries(remote)) {
        if (local[pattern] !== undefined) continue;
        if (before.has(pattern)) removeThere.push(pattern);
        else takeHere[pattern] = site;
      }
      // Here, not in the account.
      const sendThere: Record<string, SiteConfig> = {};
      const removeHere: string[] = [];
      for (const [pattern, site] of Object.entries(local)) {
        if (!valid(pattern) || remote[pattern] !== undefined) continue;
        if (before.has(pattern)) removeHere.push(pattern);
        else sendThere[pattern] = site;
      }

      if (Object.keys(takeHere).length > 0) {
        const mutation: SiteMutation = { kind: 'write', entries: takeHere };
        arrived.add(mutation);
        await apply(mutation);
      }
      for (const pattern of removeHere) {
        const mutation: SiteMutation = { kind: 'remove', pattern };
        arrived.add(mutation);
        await apply(mutation);
      }
      if (removeThere.length > 0) await area.remove(removeThere.map(syncKeyOf));
      if (Object.keys(sendThere).length > 0) {
        await area.set(
          Object.fromEntries(Object.entries(sendThere).map(([pattern, site]) => [syncKeyOf(pattern), site])),
        );
      }

      const both = [...Object.keys(remote), ...Object.keys(sendThere)].filter(
        (pattern) => !removeThere.includes(pattern) && !removeHere.includes(pattern),
      );
      await known.write([...new Set(both)].sort());
    },
  };
}
