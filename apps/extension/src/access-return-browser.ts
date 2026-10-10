import { browser } from 'wxt/browser';
import { createAccessReturn } from './access-return.ts';
import { matchPatternFor } from './registration.ts';
import type { Sessions } from './session.ts';
import { readAll } from './sites.ts';

/**
 * `access-return.ts` over the real storage and permissions (FRU-115).
 *
 * `sessions` is the one `Sessions` of the context that calls: the background and the popup each
 * build one, and a second one would run the storage upgrade again.
 */
export function createBrowserAccessReturn(
  sessions: Pick<Sessions, 'list'>,
): (candidates: readonly string[]) => Promise<void> {
  return createAccessReturn({
    sites: readAll,
    paired: async () => Object.keys(await sessions.list()),
    remove: (access) => browser.permissions.remove({ origins: [matchPatternFor(access)] }),
  });
}
