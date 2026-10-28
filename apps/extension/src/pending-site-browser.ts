import { browser } from 'wxt/browser';
import { type AddOutcome, PENDING_KEY, type Pending, type PendingAdd, createPending } from './pending-site.ts';
import { matchPatternFor } from './registration.ts';
import { holdsSiteAccess } from './site-grant.ts';
import type { SiteConfig } from './sites.ts';
import { injectIntoOpenTabs } from './tab-injection.ts';
import { browserTabScripting } from './tab-scripting-browser.ts';

/** The pending site over the real storage and permissions. `store` differs by context. */
export function createBrowserPending(
  store: (pattern: string, site: SiteConfig) => Promise<void>,
  add?: (pattern: string, intent: PendingAdd) => Promise<AddOutcome>,
): Pending {
  return createPending({
    read: async () => ((await browser.storage.local.get(PENDING_KEY)) as Record<string, unknown>)[PENDING_KEY],
    write: (pending) => browser.storage.local.set({ [PENDING_KEY]: pending }),
    clear: () => browser.storage.local.remove(PENDING_KEY),
    // FRU-425: `<all_urls>` grants no rule (`site-grant.ts`).
    granted: (pattern) => holdsSiteAccess(matchPatternFor(pattern), browser.permissions),
    store,
    activate: (pattern) => injectIntoOpenTabs(browserTabScripting, pattern),
    ...(add === undefined ? {} : { add }),
  });
}
