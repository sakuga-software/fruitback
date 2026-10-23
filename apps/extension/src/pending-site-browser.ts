import { browser } from 'wxt/browser';
import { PENDING_KEY, type Pending, createPending } from './pending-site.ts';
import { holdsRuleAccess } from './site-grant-browser.ts';
import type { SiteConfig } from './sites.ts';
import { injectIntoOpenTabs } from './tab-injection.ts';
import { browserTabScripting } from './tab-scripting-browser.ts';

/** The pending site over the real storage and permissions. `store` differs by context. */
export function createBrowserPending(store: (pattern: string, site: SiteConfig) => Promise<void>): Pending {
  return createPending({
    read: async () => ((await browser.storage.local.get(PENDING_KEY)) as Record<string, unknown>)[PENDING_KEY],
    write: (pending) => browser.storage.local.set({ [PENDING_KEY]: pending }),
    clear: () => browser.storage.local.remove(PENDING_KEY),
    // FRU-425: `<all_urls>` grants no rule (`site-grant.ts`).
    granted: (pattern) => holdsRuleAccess(pattern),
    store,
    activate: (pattern) => injectIntoOpenTabs(browserTabScripting, pattern),
  });
}
