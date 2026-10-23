import type { TabCommandRequest } from './tab-command.ts';
import { tabCommand } from './tab-command.ts';
import { type Language, translate } from './i18n.ts';

/**
 * « Capture with Fruitback », in the context menu of a page (FRU-423).
 *
 * In team mode the widget mounts by itself, so nobody clicks the icon, and `tabs.captureVisibleTab`
 * is refused for want of `activeTab`. A click on an item of the extension in the context menu is a
 * gesture that grants `activeTab` for the tab, until it navigates, as the click on the icon does.
 * The item then starts the capture of an area in the composer that is open, or starts a note.
 *
 * `contextMenus` adds no warning at install, on Chrome or on Firefox. The item is on every web
 * page; on a page with no widget of the extension, nothing answers, and nothing happens.
 */

export const CAPTURE_MENU_ID = 'fruitback-capture';

/** The English words of the item: the key of its translation. */
export const CAPTURE_MENU_TITLE = 'Capture with Fruitback';

/** The item, as `contextMenus.create` takes it, in the language of the reviewer. */
export function captureMenu(language: Language): {
  id: string;
  title: string;
  contexts: ['page', 'selection', 'image', 'link'];
  documentUrlPatterns: string[];
} {
  return {
    id: CAPTURE_MENU_ID,
    title: translate(language, CAPTURE_MENU_TITLE),
    contexts: ['page', 'selection', 'image', 'link'],
    // A web page: an extension page or a page of the browser holds no widget.
    documentUrlPatterns: ['http://*/*', 'https://*/*'],
  };
}

/**
 * What `contextMenus.onClicked` does: the command « capture-area » to the widget of the tab. A tab
 * with no widget has no bridge to answer, and the refusal is dropped. Answers whether it was sent.
 */
export function runCaptureMenu(
  info: { menuItemId?: string | number },
  tab: { id?: number } | undefined,
  send: (tabId: number, message: TabCommandRequest) => Promise<unknown>,
): boolean {
  if (info.menuItemId !== CAPTURE_MENU_ID || tab?.id === undefined || tab.id < 0) return false;
  void send(tab.id, tabCommand('capture-area')).catch(() => undefined);

  return true;
}
