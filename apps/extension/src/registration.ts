/**
 * Which origins the two content scripts are registered for, kept in step with what is switched on.
 *
 * This is the whole reason the extension asks for no host permission at install (SKG-534). Nothing
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
};

export type ScriptRegistrar = {
  getRegisteredContentScripts(): Promise<{ id: string }[]>;
  registerContentScripts(scripts: RegisteredScript[]): Promise<void>;
  updateContentScripts(scripts: RegisteredScript[]): Promise<void>;
  unregisterContentScripts(filter: { ids: string[] }): Promise<void>;
};

/** `https://acme.dev` → `https://acme.dev/*`, which is the shape both APIs want. */
export function matchPatternFor(origin: string): string {
  return `${origin}/*`;
}

/**
 * Register, update or unregister so that exactly `origins` are covered.
 *
 * The three cases are separate calls in the API and picking the wrong one throws: registering an id
 * that exists is an error, and so is updating one that does not. An empty set has to unregister
 * rather than update with no matches — `matches: []` is refused, which would leave the previous
 * origins registered and the extension running on a site somebody just switched off.
 */
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

export async function syncRegistration(scripting: ScriptRegistrar, origins: readonly string[]): Promise<void> {
  const existing = new Set((await scripting.getRegisteredContentScripts()).map((script) => script.id));
  const ours = [BRIDGE_SCRIPT_ID, PAGE_SCRIPT_ID].filter((id) => existing.has(id));

  if (origins.length === 0) {
    if (ours.length > 0) await scripting.unregisterContentScripts({ ids: ours });

    return;
  }

  const matches = origins.map(matchPatternFor);
  const scripts: RegisteredScript[] = [
    {
      id: BRIDGE_SCRIPT_ID,
      matches,
      js: [BRIDGE_FILE],
      runAt: 'document_idle',
      world: 'ISOLATED',
    },
    {
      // The widget, in the page's own world. See entrypoints/page.content.ts for why that is not a
      // preference: from the isolated world every fiber the seed's `source` comes from is invisible.
      id: PAGE_SCRIPT_ID,
      matches,
      js: [PAGE_FILE],
      runAt: 'document_idle',
      world: 'MAIN',
    },
  ];

  const toUpdate = scripts.filter((script) => existing.has(script.id));
  const toRegister = scripts.filter((script) => !existing.has(script.id));

  if (toUpdate.length > 0) await scripting.updateContentScripts(toUpdate);
  if (toRegister.length > 0) await scripting.registerContentScripts(toRegister);
}
