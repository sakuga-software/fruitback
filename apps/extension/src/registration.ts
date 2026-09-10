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
      js: ['content-scripts/bridge.js'],
      runAt: 'document_idle',
      world: 'ISOLATED',
    },
    {
      // The widget, in the page's own world. See entrypoints/page.content.ts for why that is not a
      // preference: from the isolated world every fiber the seed's `source` comes from is invisible.
      id: PAGE_SCRIPT_ID,
      matches,
      js: ['content-scripts/page.js'],
      runAt: 'document_idle',
      world: 'MAIN',
    },
  ];

  const toUpdate = scripts.filter((script) => existing.has(script.id));
  const toRegister = scripts.filter((script) => !existing.has(script.id));

  if (toUpdate.length > 0) await scripting.updateContentScripts(toUpdate);
  if (toRegister.length > 0) await scripting.registerContentScripts(toRegister);
}
