import { type PanelApis, openPanel } from './side-panel.ts';

/**
 * The button of the widget that shows every note opens the side panel of the browser (FRU-469).
 *
 * The widget the extension mounts asks through the bridge (`open-panel-request`), and the background
 * opens the panel of the tab the browser reports as the sender. **The call is made at once, before
 * any `await`**: the browser keeps the gesture of the person only that long.
 *
 * **Measured on Chromium 156 (Playwright 1.64.1)**, with a probe extension and no `evaluate` of
 * Playwright before the page acts (an `evaluate` carries a gesture, and spoiled a first measure):
 * `sidePanel.open` from the message of a content script opens the panel after a click on the page,
 * and is refused with « may only be called in response to a user gesture » after a timer of the page.
 *
 * **The page can send this request too**, as for every message of the bridge. So the bridge carries
 * it only while the window holds the activation of a gesture (`hasGesture`): the isolated world reads
 * it, and no script of the page makes it. A script of a site the reviewer turned on can then open the
 * panel only in the seconds after a click or a key of the person on that page, and a tab is answered
 * once in `PANEL_REQUEST_INTERVAL_MS`. It gains nothing: the panel is a page of the extension that
 * reads nothing of the site, and the answer says only whether it opened.
 */

/** Whether the window holds the activation of a gesture of the person now. Unknown: no. */
export function hasGesture(navigator: { userActivation?: { isActive: boolean } }): boolean {
  return navigator.userActivation?.isActive === true;
}

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
