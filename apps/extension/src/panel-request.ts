import { type PanelApis, openPanel } from './side-panel.ts';

/**
 * The button of the widget that shows every note opens the side panel of the browser (FRU-469).
 *
 * The widget the extension mounts asks through the bridge (`open-panel-request`), and the background
 * opens the panel of the tab the browser reports as the sender. **The call is made at once, before
 * any `await`**: a browser that wants a gesture of the person keeps it only that long (Firefox's
 * `sidebarAction.open` refuses a call from a message, and the widget then shows its own list).
 *
 * **The page can send this request too**, as for every message of the bridge. Measured on Chromium
 * 156 (Playwright 1.64.1): `sidePanel.open` from a message of a content script opens the panel even
 * with no gesture of the person. So a script of a site the reviewer turned on can open the panel of
 * the extension. It opens a page of the extension that reads nothing of the site and shows what
 * the reviewer already sees; it gives the page nothing. To keep a page from opening it again and
 * again after the reviewer closed it, a tab is answered once in `PANEL_REQUEST_INTERVAL_MS`.
 */

export const PANEL_REQUEST_INTERVAL_MS = 2_000;

export function createPanelGate(now: () => number = Date.now): (tabId: number) => boolean {
  const last = new Map<number, number>();

  return (tabId) => {
    const at = now();
    const before = last.get(tabId);
    if (before !== undefined && at - before < PANEL_REQUEST_INTERVAL_MS) return false;
    last.set(tabId, at);

    return true;
  };
}

/**
 * Opens the panel for the tab of the sender, and answers whether it opened. `false` for a sender
 * with no tab, a tab asked too often, a browser with no panel, or a refusal: the widget then shows
 * its own list. Never rejects.
 */
export function openPanelForTab(
  apis: PanelApis,
  tabId: number | undefined,
  gate: (tabId: number) => boolean,
): Promise<boolean> {
  if (tabId === undefined || !gate(tabId)) return Promise.resolve(false);
  let opened: Promise<void> | undefined;
  try {
    opened = openPanel(apis, { tabId });
  } catch {
    return Promise.resolve(false);
  }
  if (opened === undefined) return Promise.resolve(false);

  return opened.then(
    () => true,
    () => false,
  );
}
