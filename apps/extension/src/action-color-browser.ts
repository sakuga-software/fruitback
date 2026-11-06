import { browser } from 'wxt/browser';
import { ACTION_COLOR_KEY, paintAction } from './action-color.ts';

/**
 * The colour of the note button (FRU-601) on a page of the extension: read from storage, written on
 * the root of the page, and written again when it changes, so an open side panel follows
 * « Appearance » with no reload. A read that fails leaves the red of Fruitback.
 */
export function followActionColor(document: Document): void {
  const root = document.documentElement;
  void browser.storage.local
    .get(ACTION_COLOR_KEY)
    .then((stored) => paintAction(root, stored[ACTION_COLOR_KEY]))
    .catch(() => undefined);
  browser.storage.onChanged.addListener((changes, area) => {
    const change = changes[ACTION_COLOR_KEY];
    if (area === 'local' && change !== undefined) paintAction(root, change.newValue);
  });
}
