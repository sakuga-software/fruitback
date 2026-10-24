import { hiddenUnder } from './page-visibility.ts';

/**
 * Which origins the two content scripts are registered for, kept in step with what is switched on.
 *
 * This is the whole reason the extension asks for no host permission at install (FRU-41). Nothing
 * runs on a page until somebody turned that site on **and** granted the origin; turning it off
 * unregisters, so the scripts stop running on the reviewer's next navigation there.
 *
 * Written against a narrow slice of `browser.scripting` rather than the namespace, so it is testable
 * with `node --test` and no browser at all — the same trick `engine.ts` plays on react-grab.
 */

export const BRIDGE_SCRIPT_ID = 'fruitback-bridge';
export const PAGE_SCRIPT_ID = 'fruitback-page';

/**
 * The built files, named once.
 *
 * Registering them and injecting them into an already-open tab are two different APIs that must
 * agree on the same paths, and a typo in either is silent — the script simply never runs.
 */
export const BRIDGE_FILE = 'content-scripts/bridge.js';
export const PAGE_FILE = 'content-scripts/page.js';

/**
 * The same file, spelled the way `scripting.executeScript` wants it.
 *
 * `registerContentScripts` takes a path relative to the extension root and `executeScript` takes one
 * rooted at it. Both reach the same file and the difference is one character, which is exactly why
 * it gets one named function instead of a slash written twice from memory.
 */
export function publicPath<T extends typeof BRIDGE_FILE | typeof PAGE_FILE>(file: T): `/${T}` {
  return `/${file}`;
}

export type RegisteredScript = {
  id: string;
  matches: string[];
  js: string[];
  runAt: 'document_idle';
  world?: 'MAIN' | 'ISOLATED';
  allFrames?: boolean;
  /** FRU-444: the origins of the pattern where the reviewer hid the widget. */
  excludeMatches?: string[];
};

export type ScriptRegistrar = {
  getRegisteredContentScripts(): Promise<{ id: string; excludeMatches?: string[] }[]>;
  registerContentScripts(scripts: RegisteredScript[]): Promise<void>;
  updateContentScripts(scripts: RegisteredScript[]): Promise<void>;
  unregisterContentScripts(filter: { ids: string[] }): Promise<void>;
};

/**
 * `https://acme.dev` → `https://acme.dev/*`, which is the shape both APIs want. A stored wildcard
 * gives a valid match pattern the same way: `https://*.acme.dev` → `https://*.acme.dev/*`.
 */
export function matchPatternFor(origin: string): string {
  return `${origin}/*`;
}

/**
 * One sync at a time, however many events ask for one.
 *
 * Install, startup, a storage change and a revoked permission all call this, and `syncRegistration`
 * reads the registered set and then writes it. Two overlapping runs both see an id as absent and
 * both register it, which the API rejects — so a rapid toggle threw and left the previous origins
 * registered, on a site somebody had just switched off. Raised in review.
 *
 * A chain rather than a lock: a run that fails must not wedge the next one, so the tail is caught.
 */
export function serialize<T extends unknown[]>(run: (...args: T) => Promise<void>): (...args: T) => Promise<void> {
  let tail: Promise<void> = Promise.resolve();

  return (...args: T) => {
    tail = tail.then(() => run(...args)).catch(() => undefined);

    return tail;
  };
}

/** The ids of the two scripts of one origin. Each origin has its own pair (FRU-74). */
export function scriptIdsFor(origin: string): { bridge: string; page: string } {
  return { bridge: `${BRIDGE_SCRIPT_ID}:${origin}`, page: `${PAGE_SCRIPT_ID}:${origin}` };
}

function isOurs(id: string): boolean {
  return [BRIDGE_SCRIPT_ID, PAGE_SCRIPT_ID].some((ours) => id === ours || id.startsWith(`${ours}:`));
}

/**
 * Register and unregister so that exactly `origins` are covered, **one origin per call** (FRU-74).
 *
 * Measured on 2026-10-12: Chromium 145 refuses a whole `registerContentScripts` call when one of its
 * patterns is invalid (« Invalid port »), and registers none of the others; Firefox 146 accepts
 * patterns that match nothing. With one pair of scripts for every origin, a single pattern the
 * browser refuses stopped the extension on every site, with one line in the console. Each origin has
 * its own pair now, registered in its own call: a refusal costs that origin, and is said.
 *
 * The scripts of an origin change only with the hidden origins it covers (FRU-444): an origin that
 * stays keeps its pair, one that goes is unregistered, a new one is registered. A pair whose hidden
 * origins changed is unregistered and registered again, in its own call. The pair of before FRU-74
 * (one id for every origin) is unregistered at the first sync.
 *
 * Answers the origins the browser refused.
 */
export async function syncRegistration(
  scripting: ScriptRegistrar,
  origins: readonly string[],
  hidden: readonly string[] = [],
): Promise<string[]> {
  const registered = (await scripting.getRegisteredContentScripts()).filter((script) => isOurs(script.id));
  const existing = new Set(registered.map((script) => script.id));
  const excludedNow = new Map(registered.map((script) => [script.id, [...(script.excludeMatches ?? [])].sort()]));
  const wanted = new Set(origins.flatMap((origin) => Object.values(scriptIdsFor(origin))));

  const stale = [...existing].filter((id) => !wanted.has(id));
  if (stale.length > 0) await scripting.unregisterContentScripts({ ids: stale });

  const refused: string[] = [];
  for (const origin of origins) {
    const ids = scriptIdsFor(origin);
    const excluded = hiddenUnder(origin, hidden).map((each) => matchPatternFor(each));
    const scripts = scriptsFor(origin, ids, excluded);
    // The browser answers the patterns it holds, in its own order.
    const changed = scripts.filter(
      (script) => existing.has(script.id) && excludedNow.get(script.id)?.join(' ') !== excluded.join(' '),
    );
    if (changed.length > 0) {
      await scripting.unregisterContentScripts({ ids: changed.map((script) => script.id) });
      for (const script of changed) existing.delete(script.id);
    }
    const missing = scripts.filter((script) => !existing.has(script.id));
    if (missing.length === 0) continue;
    try {
      await scripting.registerContentScripts(missing);
    } catch (error) {
      refused.push(origin);
      console.warn(`[fruitback] the browser refused the scripts of ${origin}`, error);
    }
  }

  return refused;
}

function scriptsFor(origin: string, ids: { bridge: string; page: string }, excluded: string[]): RegisteredScript[] {
  const matches = [matchPatternFor(origin)];
  // Absent rather than empty: the pair of an origin with nothing hidden is the pair of before FRU-444.
  const leftOut = excluded.length === 0 ? {} : { excludeMatches: excluded };

  return [
    { id: ids.bridge, matches, ...leftOut, js: [BRIDGE_FILE], runAt: 'document_idle', world: 'ISOLATED' },
    // The widget, in the page's own world. See entrypoints/page.content.ts for why that is not a
    // preference: from the isolated world every fiber the seed's `source` comes from is invisible.
    { id: ids.page, matches, ...leftOut, js: [PAGE_FILE], runAt: 'document_idle', world: 'MAIN' },
  ];
}
