import { browser } from 'wxt/browser';
import { matchPatternFor } from './registration.ts';
import { type GrantSeams, SITE_GRANTS_KEY, holdsSiteAccess, withGrant, withoutRemoved } from './site-grant.ts';

/** `site-grant.ts` over the browser's permissions and the local storage of the extension. */

async function recorded(): Promise<string[]> {
  const stored = (await browser.storage.local.get(SITE_GRANTS_KEY))[SITE_GRANTS_KEY];

  return Array.isArray(stored) ? stored.filter((each): each is string => typeof each === 'string') : [];
}

const seams: GrantSeams = {
  getAll: () => browser.permissions.getAll(),
  contains: (wanted) => browser.permissions.contains(wanted),
  recorded,
};

/** Whether the browser grants the sites of the rule `pattern`, by a grant for them. */
export function holdsRuleAccess(pattern: string): Promise<boolean> {
  return holdsSiteAccess(matchPatternFor(pattern), seams);
}

/**
 * Asks the browser for the sites of the rule `pattern`. **The request is the first call**: call this
 * in the click, before anything is awaited. A yes is recorded before this answers, so the rule that
 * is written after reads as granted.
 */
export function requestRuleAccess(pattern: string): Promise<boolean> {
  const wanted = matchPatternFor(pattern);

  return browser.permissions.request({ origins: [wanted] }).then(async (granted) => {
    if (granted) await browser.storage.local.set({ [SITE_GRANTS_KEY]: withGrant(await recorded(), wanted) });

    return granted;
  });
}

/** Forgets the sites whose access the browser removed. */
export async function forgetRemovedAccess(removed: readonly string[]): Promise<void> {
  const before = await recorded();
  const after = withoutRemoved(before, removed);
  if (after.length !== before.length) await browser.storage.local.set({ [SITE_GRANTS_KEY]: after });
}
