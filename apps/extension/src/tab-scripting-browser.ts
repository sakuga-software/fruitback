import { browser } from 'wxt/browser';
import type { TabScripting } from './tab-injection.ts';

/** `tab-injection.ts` bound to the real browser, for the popup, the options page and the welcome page. */
export const browserTabScripting: TabScripting = {
  query: (matchPattern) => browser.tabs.query({ url: matchPattern }),
  execute: async (tabId, file, world) => {
    await browser.scripting.executeScript({ target: { tabId }, files: [file], world });
  },
};
