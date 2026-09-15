import { BRIDGE_FILE, PAGE_FILE, matchPatternFor, publicPath } from './registration.ts';

/**
 * Puts both content scripts into the tabs already open on a pattern (SKG-536).
 *
 * `registerContentScripts` reaches only the next page load. The popup injects into its own tab, but a
 * rule added, switched on or granted on the options page covers tabs the options page is not. Without
 * this, the row says **On** and those tabs stay bare until they load again.
 *
 * Both files refuse to run twice in one frame, so a tab that already runs them costs nothing.
 */

export type ScriptFile = ReturnType<typeof publicPath>;

export type TabScripting = {
  query: (matchPattern: string) => Promise<{ id?: number }[]>;
  execute: (tabId: number, file: ScriptFile, world: 'MAIN' | 'ISOLATED') => Promise<void>;
};

/** Never rejects. A tab the browser will not inject into still gets the scripts on its next load. */
export async function injectIntoOpenTabs(scripting: TabScripting, pattern: string): Promise<void> {
  let tabs: { id?: number }[];
  try {
    tabs = await scripting.query(matchPatternFor(pattern));
  } catch {
    return;
  }

  await Promise.all(
    tabs.map(async ({ id }) => {
      if (id === undefined) return;
      try {
        // The same order as the popup: the page world first, then the bridge that posts to it.
        await scripting.execute(id, publicPath(PAGE_FILE), 'MAIN');
        await scripting.execute(id, publicPath(BRIDGE_FILE), 'ISOLATED');
      } catch {
        // An error page, or a page another extension owns. The registration still stands.
      }
    }),
  );
}
