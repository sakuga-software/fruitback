import { browser } from 'wxt/browser';
import { matchPatternFor } from '../../src/registration.ts';
import { activateStored } from '../../src/site-editor.ts';
import { type SiteConfig, readAll, writeSite } from '../../src/sites.ts';
import { injectIntoOpenTabs } from '../../src/tab-injection.ts';
import { isHidden, setHidden } from '../../src/page-visibility.ts';
import { browserTabScripting } from '../../src/tab-scripting-browser.ts';
import { msg, t } from '../../src/i18n.ts';
import { holdsSiteAccess } from '../../src/site-grant.ts';
import { wantsSession as siteWantsSession } from '../../src/popup-state.ts';
import { type TabCommand } from '../../src/protocol.ts';
import { browserFamily, extensionsPlace } from '../../src/browser-family.ts';
import { type TabCommandAnswer, parseAnswer, tabCommand } from '../../src/tab-command.ts';
import { make } from '../../src/kit.ts';

import { CLOUD, pending, type PopupTab, render, sessions } from './context.ts';

/** What a screen of the popup does to a site and to its tab (FRU-560): turn on, show or hide, ask the widget. */

/**
 * Whether the browser still grants the sites of a rule: access can be removed in its settings.
 *
 * A read that fails answers « not granted » (FRU-510). Read as granted, the popup said the site was on
 * while nothing could run there, and offered no fix. Read as not granted, it offers « Allow access
 * again », and a request for an access that is held answers at once with no prompt.
 */
export async function holdsAccess(pattern: string): Promise<boolean> {
  // FRU-425: `<all_urls>` grants no rule (`src/site-grant.ts`).
  return holdsSiteAccess(matchPatternFor(pattern), browser.permissions).catch((error: unknown) => {
    console.error('[fruitback] could not read the access of the site', error);

    return false;
  });
}

/**
 * A site of the workspace of this build's Fruitback, mounted by the extension, whose session is gone
 * now: it ended in the console, or a refresh was refused (FRU-238). Read after `accountOf`, which may
 * have forgotten it this very time.
 */
export async function wantsSession(site: SiteConfig): Promise<boolean> {
  return siteWantsSession(site, CLOUD, await sessions.list());
}

export const NOT_NOW_WRITING = msg('A note is being written on the page. Send it or close it first.');
export const NOT_THERE = msg('The page did not answer. Reload it, then try again.');

/** A command to the widget of the tab the popup was opened on (FRU-254). See `tab-command.ts`. */
export async function askTab(tab: PopupTab | undefined, command: TabCommand): Promise<TabCommandAnswer> {
  if (tab?.id === undefined) return { done: false };

  return parseAnswer(await browser.tabs.sendMessage(tab.id, tabCommand(command)).catch(() => undefined));
}

/**
 * FRU-397: another copy of Fruitback runs on this page, an old one or an unpacked one. Its rules and
 * its widget are its own, and nothing in this copy can stop them: removing it is the one thing that
 * helps. Empty until the tab answers, and when it says nothing of another copy.
 */
export function otherCopyLine(tab: PopupTab | undefined, on: boolean): HTMLElement {
  const line = make(document, 'p', 'problem');
  if (!on) return line;
  void askTab(tab, 'counts').then(({ otherCopy }) => {
    if (otherCopy === undefined) return;
    // An address stays as it is (no catalog has it); Safari's words are translated (FRU-380).
    const place = t(extensionsPlace(browserFamily(import.meta.env)));
    line.textContent =
      otherCopy.version === undefined
        ? t(OTHER_COPY, { place })
        : t(OTHER_COPY_VERSION, { version: otherCopy.version, place });
  });

  return line;
}

// Reload first (heavy review of #533): a tab open across an update of this extension keeps the page
// script of the version before, which looks like a copy of before until the page is loaded again.
export const OTHER_COPY = msg(
  'Another copy of Fruitback runs on this page, or the version of before of this one. Reload the page. If this stays, remove the other copy in {place}.',
);
export const OTHER_COPY_VERSION = msg(
  'Another copy of Fruitback ({version}) runs on this page. Reload the page. If this stays, remove that copy in {place}.',
);

/** The tabs already open on a pattern get both scripts. */
export function activateOpenTabs(pattern: string): Promise<void> {
  return injectIntoOpenTabs(browserTabScripting, pattern);
}

/**
 * Ask for this pattern, then store it. For a wildcard, the browser asks for every site it covers.
 *
 * **The request has to come first, and it has to come from this click.** A host permission may only
 * be asked for while a user gesture is being handled, so anything awaited before it — a storage read
 * — loses the gesture and the prompt never appears. And storing first would leave an entry that says
 * "on" for a site the background can never register, which reads as a broken extension.
 *
 * Answers whether access was granted, so a refusal is said on the screen.
 */
export async function turnOn(pattern: string, site: SiteConfig): Promise<boolean> {
  // WARNING: not awaited. An await before `permissions.request` loses the gesture, and the prompt
  // can close this popup: the background then finishes what is remembered here.
  void pending.remember(pattern, site).catch(() => undefined);
  const granted = await browser.permissions.request({ origins: [matchPatternFor(pattern)] });
  // A refusal keeps the values as a draft, so the form shows them again (FRU-117).
  if (!granted) return false;

  try {
    await writeSite(pattern, site);
  } catch (error) {
    // A write the background did not confirm can be stored anyway, and this tab would then hold no
    // widget until its next load (FRU-73). `failed` still says the change was not confirmed.
    await activateStored([pattern], readAll, activateOpenTabs);
    throw error;
  }
  // `registerContentScripts` only reaches future page loads. Every tab already open on the pattern
  // gets the scripts now, this one included, and both files refuse to run twice in one frame.
  await pending.forget().catch(() => undefined);
  await activateOpenTabs(pattern);
  await render();

  return true;
}

/**
 * « Hide Fruitback on this page » (FRU-444, FRU-590). Hidden, the bridge of each tab of the origin posts
 * `unmount` and the background leaves the origin out of the scripts. Shown again, the tabs that
 * loaded while it was hidden get the scripts now, as a site turned on does.
 */
export async function visibility(origin: string): Promise<{ shown: boolean; onChange: (shown: boolean) => void }> {
  const shown = !(await isHidden(browser.storage.local, origin));

  return {
    shown,
    onChange: (next) =>
      void setHidden(browser.storage.local, origin, !next)
        .then(() => (next ? activateOpenTabs(origin) : undefined))
        .then(
          () => render(),
          (error: unknown) => console.error('[fruitback] could not show or hide the widget on this page', error),
        ),
  };
}
