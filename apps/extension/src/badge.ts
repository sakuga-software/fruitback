import type { Offer } from './cloud.ts';
import type { SiteConfig } from './sites.ts';

/**
 * The badge on the icon of the extension (FRU-604): how many notes of the reviewer, on the site of
 * the tab, the team marked done and the reviewer did not confirm yet (« to check », FRU-295).
 *
 * - **By tab** (`tabId` on every call): two tabs of two sites say each their own count, and a tab of
 *   another site says nothing.
 * - **The count is the worker's** (`toCheck` of `GET /session/sites?origin=`), asked when the tab
 *   changes and on the alarm of the background. Nothing is kept: a stale count says there is nothing
 *   to check (worker.md, FRU-295). A worker that does not answer leaves the badge empty, never zero.
 * - **Only on a site that is on**, in team mode, with the session of an account: the one count the
 *   worker gives for a person.
 * - **In the blue of « done »**, the colour of the stage on the pins (`--stage-done`), white text.
 */

/** `--stage-done` of the popup (`entrypoints/popup/style.css`): the badge says « done ». */
export const BADGE_COLOR = '#5560c4';
export const BADGE_TEXT_COLOR = '#ffffff';

/** The text of the badge for a count: nothing for none or for no answer, `99+` above 99. */
export function badgeText(count: number | undefined): string {
  if (count === undefined || !Number.isSafeInteger(count) || count <= 0) return '';

  return count > 99 ? '99+' : String(count);
}

/** What the badge needs of the browser, so a test hands over its own. */
export type BadgeSeams = {
  action: {
    setBadgeText(details: { tabId: number; text: string }): Promise<void>;
    setBadgeBackgroundColor(details: { tabId: number; color: string }): Promise<void>;
    /** Absent in browsers of before Chrome 110: the browser picks the colour of the text. */
    setBadgeTextColor?: (details: { tabId: number; color: string }) => Promise<void>;
  };
  readSite(origin: string): Promise<SiteConfig | undefined>;
  /** The site of a workspace this origin is, as `offerFor` of `cloud.ts` answers it. */
  offer(origin: string): Promise<Offer | undefined>;
};

/** The origin of a page a badge may speak for: `http` or `https`, else nothing. */
function originOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);

    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Sets the badge of one tab, from the count the worker gives now. Each tab keeps only the answer of
 * its last question: a slow answer for the page of before does not overwrite the page of now.
 * Never throws: a badge that could not be set is said in the log.
 */
export function createBadge(seams: BadgeSeams): (tab: { id?: number; url?: string }) => Promise<void> {
  const asked = new Map<number, number>();
  let question = 0;

  return async (tab) => {
    const tabId = tab.id;
    if (tabId === undefined) return;
    question += 1;
    const mine = question;
    asked.set(tabId, mine);
    let count: number | undefined;
    try {
      const origin = originOf(tab.url);
      const site = origin === undefined ? undefined : await seams.readSite(origin);
      if (origin !== undefined && site !== undefined && site.enabled && site.mode === 'team') {
        count = (await seams.offer(origin))?.site.toCheck;
      }
    } catch (error) {
      console.warn('[fruitback] could not read the notes to check of the tab', error);
      count = undefined;
    }
    if (asked.get(tabId) !== mine) return;
    const text = badgeText(count);
    try {
      await seams.action.setBadgeText({ tabId, text });
      if (text !== '') {
        await seams.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR });
        await seams.action.setBadgeTextColor?.({ tabId, color: BADGE_TEXT_COLOR });
      }
    } catch (error) {
      // A tab closed while the worker answered: nothing to say.
      console.warn('[fruitback] could not set the badge of the tab', error);
    }
  };
}
