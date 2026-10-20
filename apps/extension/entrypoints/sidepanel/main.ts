import { browser } from 'wxt/browser';
import { language, setLanguage } from '../../src/i18n.ts';
import { storedLanguage } from '../../src/language.ts';
import { type PanelTab, panelPage, webHost } from '../../src/side-panel.ts';
import { readSite } from '../../src/sites.ts';
import { tabCommand } from '../../src/tab-command.ts';

/**
 * The side panel (FRU-296). It follows the active tab of its window, and reads nothing from a
 * worker: the widget of the tab holds the notes, and FRU-299 asks it for them.
 *
 * The address of a tab is given to the extension only for a site it has access to, or after the
 * click on the toolbar icon (`activeTab`). A site that is on has that access: any other tab reads as
 * « not on », which is what it is.
 */

setLanguage((await storedLanguage(browser.storage.local)) ?? navigator.language);
document.documentElement.lang = language();

const app = document.querySelector('#app');

/** Each read counts one: an older read that answers late does not draw over a newer one. */
let reads = 0;

async function current(): Promise<PanelTab> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const host = webHost(tab?.url);
  if (tab?.id === undefined || host === undefined || tab.url === undefined) return { kind: 'not-on' };
  const site = await readSite(new URL(tab.url).origin).catch(() => undefined);

  return site?.enabled === true ? { kind: 'on', host, tabId: tab.id } : { kind: 'not-on' };
}

async function draw(): Promise<void> {
  reads += 1;
  const mine = reads;
  const tab = await current();
  if (mine !== reads || app === null) return;
  app.replaceChildren(
    panelPage(document, {
      tab,
      onClose: () => window.close(),
      onShowOnPage: () => {
        if (tab.kind === 'on')
          void browser.tabs.sendMessage(tab.tabId, tabCommand('show-notes')).catch(() => undefined);
      },
    }),
  );
  if (app.firstElementChild instanceof HTMLElement) app.firstElementChild.dataset.tab = tab.kind;
}

void draw();
// The panel follows the tab: another tab of the window, a new address in this one, or a rule
// switched from the popup.
browser.tabs.onActivated.addListener(() => void draw());
browser.tabs.onUpdated.addListener((_id, change, tab) => {
  if (tab.active && (change.url !== undefined || change.status === 'complete')) void draw();
});
browser.windows.onFocusChanged.addListener(() => void draw());
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.sites !== undefined) void draw();
});
