import { parseSitePattern } from './site-patterns.ts';
import { type SiteConfig, type SiteMutation, parseSite } from './sites.ts';

/**
 * The rules of sites, in the reviewer's other browsers too, when the reviewer asks for it (FRU-72).
 *
 * **Off until the reviewer turns it on.** `storage.sync` is kept by the account of the browser
 * (Google, Mozilla, …), so a rule that is synchronised leaves this computer, whole: the address of a
 * staging site, the address of its worker, a client id, the label of its button, the name of its
 * workspace (`mount.workspace`). Nobody decides that for a reviewer. `docs/privacy.md` lists the
 * fields: a field added to `SiteConfig` travels too, and must be added there.
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
 *   the map (`createSiteOwner`), and is not sent back. What is applied is what the account holds
 *   when the change is read: this browser hears of its own writes too, and an old one must not undo
 *   a later change made here;
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
 * `local` and never here. The previews that a worker listed (FRU-103, `proven-previews.ts`) are in
 * `local` too, under their own keys: they are a grant of that worker to this browser, not a rule of
 * the reviewer. A team wildcard that arrives as a rule covers nothing until the worker of the session
 * of this browser lists it. `site-sync.test.ts` holds both.
 */

/** In `local`: whether this browser copies its rules to `sync`. Absent is off. */
export const SYNC_SETTING = 'syncRules';

/** In `local`: the patterns this browser knows to be in the account (`KnownRules`). */
export const KNOWN_SETTING = 'syncedRules';

/**
 * What `storage.sync` keeps for one item, in bytes: the key and the JSON of the value. The browser
 * refuses a whole `set` that holds one larger item.
 */
export const QUOTA_BYTES_PER_ITEM = 8192;

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

/**
 * Whether the account can keep this rule, measured as the browser measures an item. A rule that does
 * not fit is never sent, so the options page tells it with this function and needs no other record.
 */
export function fits(pattern: string, site: SiteConfig): boolean {
  const bytes = new TextEncoder().encode(`${syncKeyOf(pattern)}${JSON.stringify(site)}`).length;

  return bytes <= QUOTA_BYTES_PER_ITEM;
}

/** The items of the rules that the account can keep. A larger one would make the browser refuse them all. */
function itemsThatFit(rules: Record<string, SiteConfig>): Record<string, SiteConfig> {
  return Object.fromEntries(
    Object.entries(rules)
      .filter(([pattern, site]) => fits(pattern, site))
      .map(([pattern, site]) => [syncKeyOf(pattern), site]),
  );
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
  /**
   * What is known changes by additions and removals, one after the other, and never by a list that
   * was read earlier: a merge waits on several writes, and a change stored meanwhile must not be
   * forgotten by the list the merge read at its start (raised in review).
   */
  let remembering: Promise<void> = Promise.resolve();
  const remember = (add: string[], drop: string[] = []): Promise<void> => {
    const next = remembering.then(async () => {
      // Turned off meanwhile: `forget` emptied the list, and a merge that still runs writes nothing back.
      if (!(await enabled())) return;
      const now = new Set(await known.read());
      for (const pattern of add) now.add(pattern);
      for (const pattern of drop) now.delete(pattern);
      await known.write([...now].sort());
    });
    remembering = next.catch(() => undefined);

    return next;
  };

  /**
   * A merge and a change that arrives run one after the other: each one decides on what it read, and
   * the other would write between its reading and its writes (raised in review). `stored` is not in
   * this line: it runs inside the one writer of the map, which a merge waits on, so the two would
   * wait on each other. A merge waits for the changes made here to end, then reads again before it
   * takes, removes or sends, for that reason.
   */
  let line: Promise<void> = Promise.resolve();
  const inLine = (work: () => Promise<void>): Promise<void> => {
    const next = line.then(work);
    line = next.catch(() => undefined);

    return next;
  };

  return {
    /** A change that the one writer just stored. Sent to `sync` unless it came from there. */
    async stored(mutation: SiteMutation): Promise<void> {
      if (arrived.has(mutation) || !(await enabled())) return;

      if (mutation.kind === 'remove') {
        try {
          await area.remove([syncKeyOf(mutation.pattern)]);
        } catch (error) {
          // The account may still hold the rule. Known and not here: the next merge removes it there,
          // and does not take it back (raised in review, for a rule that was not known yet).
          await remember([mutation.pattern]);
          throw error;
        }
        await remember([], [mutation.pattern]);

        return;
      }
      const remote = rulesIn(await area.get());
      const changed = Object.entries(mutation.entries).filter(([pattern, site]) => !same(remote[pattern], site));
      const items = itemsThatFit(Object.fromEntries(changed));
      if (Object.keys(items).length > 0) await area.set(items);
      const inAccount = Object.entries(mutation.entries).filter(([pattern, site]) => fits(pattern, site));
      await remember(inAccount.map(([pattern]) => pattern));
    },

    /**
     * The reviewer turned the copy off: what was known of the account is forgotten, so a later merge
     * takes and removes nothing it cannot tell apart. In the same line as `remember`: a merge or a
     * copy that still runs does not write the list back after it (raised in review).
     */
    forget(): Promise<void> {
      const next = remembering.then(() => known.write([]));
      remembering = next.catch(() => undefined);

      return next;
    },

    /** What `storage.onChanged` says of the `sync` area: applied here, rule by rule. */
    changed(changes: Record<string, { newValue?: unknown }>): Promise<void> {
      return inLine(() => takeChanges(changes));
    },

    /**
     * Each side takes the rules it does not have, **unless this browser knew the rule in the account**:
     * then it was removed on one side while the other was closed, or while its copy failed, and the
     * removal is what is carried. A rule of both stays as it is on each.
     */
    merge(): Promise<void> {
      return inLine(mergeNow);
    },
  };

  async function takeChanges(changes: Record<string, { newValue?: unknown }>): Promise<void> {
    if (!(await enabled())) return;
    // A browser hears of its own writes too, and a change says what the account held when it was
    // made, not what it holds now. A change made here since then may be stored, with its copy still
    // on its way: the map is then ahead of what the change says, and the change would put the map
    // back (raised in review: a rule switched off then on went off again, and lost its access). So
    // the changes made here end first, as for a merge, and what is applied is what the account holds
    // now. The change only names the rules to look at.
    const settled: SiteMutation = { kind: 'write', entries: {} };
    arrived.add(settled);
    await apply(settled);
    const [local, held] = [await readLocal(), await area.get()];
    const entries: Record<string, SiteConfig> = {};

    for (const key of Object.keys(changes)) {
      const pattern = patternOf(key);
      if (pattern === undefined) continue;

      if (held[key] === undefined) {
        await remember([], [pattern]);
        if (local[pattern] === undefined) continue;
        const mutation: SiteMutation = { kind: 'remove', pattern };
        arrived.add(mutation);
        await apply(mutation);
        continue;
      }
      const site = parseSite(held[key]);
      // The same rule is here already: nothing to write, and nothing that would echo.
      if (site !== undefined && !same(local[pattern], site)) entries[pattern] = site;
    }

    if (Object.keys(entries).length === 0) return;
    const mutation: SiteMutation = { kind: 'write', entries };
    arrived.add(mutation);
    await apply(mutation);
    await remember(Object.keys(entries));
  }

  async function mergeNow(): Promise<void> {
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

    // The reviewer may have changed a rule here since the reading above. An empty change waits in
    // the one writer of the map until each change before it is stored and its copy has ended: a rule
    // that is removed here is then out of the account too, and is not taken back (raised in review).
    // What takes, removes or sends is decided again on what both sides hold after that.
    const settled: SiteMutation = { kind: 'write', entries: {} };
    arrived.add(settled);
    await apply(settled);
    const [localNow, remoteNow] = [await readLocal(), rulesIn(await area.get())];
    const taken: Record<string, SiteConfig> = {};
    for (const pattern of Object.keys(takeHere)) {
      const site = remoteNow[pattern];
      if (site !== undefined && localNow[pattern] === undefined) taken[pattern] = site;
    }
    if (Object.keys(taken).length > 0) {
      const mutation: SiteMutation = { kind: 'write', entries: taken };
      arrived.add(mutation);
      await apply(mutation);
    }
    const goneHere = removeHere.filter(
      (pattern) => localNow[pattern] !== undefined && remoteNow[pattern] === undefined,
    );
    const goneThere = removeThere.filter((pattern) => localNow[pattern] === undefined);
    const sent: Record<string, SiteConfig> = {};
    for (const pattern of Object.keys(sendThere)) {
      const site = localNow[pattern];
      if (site !== undefined && fits(pattern, site)) sent[pattern] = site;
    }

    for (const pattern of goneHere) {
      const mutation: SiteMutation = { kind: 'remove', pattern };
      arrived.add(mutation);
      await apply(mutation);
    }
    if (goneThere.length > 0) await area.remove(goneThere.map(syncKeyOf));
    if (Object.keys(sent).length > 0) {
      await area.set(Object.fromEntries(Object.entries(sent).map(([pattern, site]) => [syncKeyOf(pattern), site])));
    }

    const inBoth = [...Object.keys(remoteNow), ...Object.keys(sent)].filter((pattern) => !goneThere.includes(pattern));
    await remember(inBoth, [...goneThere, ...goneHere]);
  }
}
