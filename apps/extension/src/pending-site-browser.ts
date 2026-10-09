import { browser } from 'wxt/browser';
import { PENDING_KEY, type Pending, createPending } from './pending-site.ts';
import { matchPatternFor } from './registration.ts';
import type { SiteConfig } from './sites.ts';
import { injectIntoOpenTabs } from './tab-injection.ts';
import { browserTabScripting } from './tab-scripting-browser.ts';

/** The pending site over the real storage and permissions. `store` differs by context. */
export function createBrowserPending(store: (pattern: string, site: SiteConfig) => Promise<void>): Pending {
  return createPending({
    read: async () => ((await browser.storage.local.get(PENDING_KEY)) as Record<string, unknown>)[PENDING_KEY],
    write: (pending) => browser.storage.local.set({ [PENDING_KEY]: pending }),
    clear: () => browser.storage.local.remove(PENDING_KEY),
    granted: (pattern) => browser.permissions.contains({ origins: [matchPatternFor(pattern)] }),
    store,
    activate: (pattern) => injectIntoOpenTabs(browserTabScripting, pattern),
  });
}
