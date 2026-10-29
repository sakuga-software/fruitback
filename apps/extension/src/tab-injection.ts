import { BRIDGE_FILE, PAGE_FILE, matchPatternFor, publicPath } from './registration.ts';

/**
 * Puts both content scripts into the tabs already open on a pattern (FRU-43).
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

export type TabLoads = {
  get: (tabId: number) => Promise<{ status?: string }>;
  onUpdated: {
    addListener: (listener: (tabId: number, change: { status?: string }) => void) => void;
    removeListener: (listener: (tabId: number, change: { status?: string }) => void) => void;
  };
};

/**
 * Resolves when the tab finished its load, or after `within` ms. Never rejects.
 *
 * A tab that `tabs.create` opened right after a rule was written can load before the background
 * registers the scripts: the answer to a write comes when the rule is stored, not registered (FRU-486).
 */
export function tabLoaded(tabs: TabLoads, tabId: number, within = 15_000): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      tabs.onUpdated.removeListener(updated);
      resolve();
    };
    const updated = (id: number, change: { status?: string }) => {
      if (id === tabId && change.status === 'complete') done();
    };
    const timer = setTimeout(done, within);
    tabs.onUpdated.addListener(updated);
    void tabs.get(tabId).then(
      (tab) => (tab.status === 'complete' ? done() : undefined),
      () => done(),
    );
  });
}
