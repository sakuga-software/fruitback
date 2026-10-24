import { useEffect, useState } from 'react';
import { type ExtensionBrowser, extensionBrowsers } from './api.ts';

/**
 * Whether the extension is connected to the account, for the screens that offer to install or to
 * connect it (FRU-441). The worker is the only one that knows: `GET /console/me/browsers` lists the
 * browsers of the account where the extension is signed in. The console still cannot tell that the
 * extension is in this browser (`docs/decisions/console.md`).
 */

/**
 * The browser of the extension that was used last. `undefined` for an empty list. The screens name
 * one browser only: « Extension connected · Chrome on macOS ».
 */
export function lastUsed(browsers: readonly ExtensionBrowser[]): ExtensionBrowser | undefined {
  let last: ExtensionBrowser | undefined;
  for (const browser of browsers) {
    if (last === undefined || Date.parse(browser.usedAt) > Date.parse(last.usedAt)) last = browser;
  }

  return last;
}

/**
 * The browser of the extension that has the label of this browser, read from the session of the
 * console that the worker marks `current`. The label is a family and a system (« Chrome on macOS »,
 * FRU-249): another computer with the same browser and system reads the same. `undefined` when no
 * browser of the extension has that label, or when the label of this browser is not known.
 */
export function sameAsThisBrowser(
  browsers: readonly ExtensionBrowser[],
  thisBrowser: string | undefined,
): ExtensionBrowser | undefined {
  if (thisBrowser === undefined || thisBrowser === UNKNOWN_LABEL) return undefined;

  return lastUsed(browsers.filter((browser) => browser.browser === thisBrowser));
}

/** What the worker says of a user agent it cannot read: it names no browser, so it matches none. */
const UNKNOWN_LABEL = 'A browser';

/**
 * The browser of the extension that was used last, once the worker answered. `undefined` while the
 * list is read, when it could not be read, and when it is empty: the screen then offers to install
 * and to connect, as before. A `401` ends no session (`quiet`).
 *
 * The list is read again when the tab is shown again: the person comes back from the tab where they
 * connected the extension.
 */
export function useConnectedExtension(): ExtensionBrowser | undefined {
  const [connected, setConnected] = useState<ExtensionBrowser | undefined>();
  useEffect(() => {
    let stopped = false;
    const read = async () => {
      // A read that fails changes nothing: the screen keeps what it shows.
      const answer = await extensionBrowsers({ quiet: true }).catch((): undefined => undefined);
      if (stopped || answer?.ok !== true) return;
      setConnected(lastUsed(answer.data));
    };
    const shown = () => {
      if (document.visibilityState === 'visible') void read();
    };
    void read();
    document.addEventListener('visibilitychange', shown);

    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', shown);
    };
  }, []);

  return connected;
}
