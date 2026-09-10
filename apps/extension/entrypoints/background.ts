import { browser } from 'wxt/browser';
import { readAll } from '../src/sites.ts';
import { matchPatternFor, serialize, syncRegistration } from '../src/registration.ts';

/**
 * Keeps the two content scripts registered for exactly the sites that are switched on (SKG-534).
 *
 * The extension declares no host permission, so nothing runs anywhere until this does it — see
 * wxt.config.ts for why an install-time `<all_urls>` was not acceptable for a review tool.
 *
 * An MV3 service worker is stopped and restarted whenever the browser feels like it, so this keeps
 * no state: every path recomputes the whole set from storage and the granted permissions. Registered
 * scripts survive the worker being killed, which is what makes that affordable.
 */
export default defineBackground(() => {
  // Serialised: four event sources call this, and the read-then-write inside would otherwise race
  // with itself. See `serialize`.
  const sync = serialize(async (): Promise<void> => {
    const sites = await readAll();
    const wanted = Object.entries(sites)
      .filter(([, site]) => site.enabled)
      .map(([origin]) => origin);

    // A permission the reviewer granted once can be revoked in the browser's own settings, without
    // this extension hearing about it in any way it could act on. Registering a script for an origin
    // we no longer hold throws, so the grant is checked rather than assumed.
    const granted: string[] = [];
    for (const origin of wanted) {
      if (await browser.permissions.contains({ origins: [matchPatternFor(origin)] })) granted.push(origin);
    }

    await syncRegistration(browser.scripting, granted);
  });

  browser.runtime.onInstalled.addListener(() => void sync());
  browser.runtime.onStartup.addListener(() => void sync());
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.sites !== undefined) void sync();
  });
  browser.permissions.onRemoved.addListener(() => void sync());

  void sync();
});
