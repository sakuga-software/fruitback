import { t } from './i18n.ts';
import { head, secondaryButton } from './kit.ts';

/**
 * The side panel of the browser (FRU-296): its place in the manifest, the gesture that opens it, and
 * the page it shows. This ticket draws the frame only: the head of the shell, « Notes on this page »,
 * and what the panel knows of the tab it follows. The list of the notes is FRU-299.
 *
 * No `browser` here: the APIs come in as arguments, so `side-panel.test.ts` reads every part under
 * `node --test`. `entrypoints/sidepanel/main.ts` binds them.
 */

/**
 * The two shapes of the API, as each browser names it. Chrome: `chrome.sidePanel` (`sidePanel`
 * permission, `side_panel.default_path`). Firefox: `browser.sidebarAction` (`sidebar_action`).
 */
export type PanelApis = {
  sidePanel?: {
    open(options: { tabId?: number; windowId?: number }): Promise<void>;
    setPanelBehavior?(behavior: { openPanelOnActionClick: boolean }): Promise<void>;
  };
  sidebarAction?: { open(): Promise<void> };
};

/**
 * Opens the panel of the browser, from the click that called it.
 *
 * **Call it before any `await` of the click.** Both browsers open the panel only inside the
 * handler of a gesture of the person, and an `await` before the call drops the gesture: Chrome then
 * rejects with « may only be called in response to a user gesture ».
 *
 * Answers whether the browser has a panel to open. The promise of the browser is answered too, for
 * a refusal to be reported.
 */
export function openPanel(apis: PanelApis, where: { tabId?: number; windowId?: number }): Promise<void> | undefined {
  if (apis.sidePanel !== undefined) {
    // Chrome opens the panel of the whole window when it has no panel for this tab alone, which is
    // the case here: the manifest declares one global panel, and it follows the active tab.
    return where.tabId !== undefined
      ? apis.sidePanel.open({ tabId: where.tabId })
      : apis.sidePanel.open({ windowId: where.windowId ?? -2 });
  }
  if (apis.sidebarAction !== undefined) return apis.sidebarAction.open();

  return undefined;
}

/**
 * The panel, or the list of the page when the browser has no panel or refuses to open it (a Firefox
 * that does not take the gesture, a Chrome that throws): what was asked is shown either way.
 * `openPanel` is called first, in the click. Answers what was shown, or `nothing` when the page did
 * not answer either.
 */
export async function openPanelOrPage(
  apis: PanelApis,
  where: { tabId?: number; windowId?: number },
  inPage: () => Promise<boolean>,
): Promise<'panel' | 'page' | 'nothing'> {
  let opened: Promise<void> | undefined;
  try {
    opened = openPanel(apis, where);
  } catch (error) {
    opened = Promise.reject(error);
  }
  if (opened !== undefined) {
    try {
      await opened;

      return 'panel';
    } catch (error) {
      console.error('[fruitback] the side panel did not open', error);
    }
  }

  return (await inPage()) ? 'page' : 'nothing';
}

/**
 * The click on the toolbar icon keeps the popup. The panel opens from the popup, and later from the
 * preference « Open notes in the sidebar » (FRU-302). Chrome's default is the same; it is written
 * here so that the choice is in the code, not in a default that can change.
 */
export async function keepPopupOnActionClick(apis: PanelApis): Promise<void> {
  await apis.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false });
}

/** What the panel knows of the tab it follows. */
export type PanelTab =
  /** No tab yet, or one the panel cannot read: a page of the browser, a site with no access. */
  | { kind: 'not-on' }
  /** A site a rule covers and that is on: the widget of the tab holds its notes. */
  | { kind: 'on'; host: string; tabId: number };

export type PanelOptions = {
  tab: PanelTab;
  /** Closes the panel: `window.close()` of its page. */
  onClose: () => void;
  /** Shows the list of the widget in the page, until the panel lists the notes itself (FRU-299). */
  onShowOnPage: () => void;
};

function make<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className: string,
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== '') node.className = className;
  if (text !== '') node.textContent = text;

  return node;
}

const SVG = 'http://www.w3.org/2000/svg';

/** The cross of « Close the sidebar », 15 px, in the colour of its button. */
function cross(document: Document): SVGSVGElement {
  const drawing = document.createElementNS(SVG, 'svg');
  drawing.setAttribute('viewBox', '0 0 16 16');
  drawing.setAttribute('aria-hidden', 'true');
  drawing.setAttribute('class', 'panel-cross');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', 'M3.5 3.5 L12.5 12.5 M12.5 3.5 L3.5 12.5');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.8');
  path.setAttribute('stroke-linecap', 'round');
  drawing.append(path);

  return drawing;
}

/** The page of the panel: the head of the shell, the title and its close button, and the tab. */
export function panelPage(document: Document, options: PanelOptions): HTMLElement {
  const root = make(document, 'div', 'side-panel');
  const top = make(document, 'header', 'panel-head');
  const title = make(document, 'h2', 'panel-title', t('Notes on this page'));
  title.id = 'panel-title';
  const close = make(document, 'button', 'panel-close');
  close.type = 'button';
  close.setAttribute('aria-label', t('Close the sidebar'));
  close.append(cross(document));
  close.addEventListener('click', options.onClose);
  top.append(title, close);

  const body = make(document, 'section', 'panel-body');
  body.setAttribute('aria-labelledby', title.id);
  body.append(...tabState(document, options));
  root.append(head(document), top, body);

  return root;
}

/** What the panel says of the tab: its site, or why it shows nothing. */
export function tabState(document: Document, options: PanelOptions): Node[] {
  const { tab } = options;
  if (tab.kind === 'not-on') {
    return [
      make(document, 'p', 'panel-state-title', t('Fruitback is not on for this page.')),
      make(document, 'p', 'panel-state-text', t('Turn it on from the Fruitback button in the toolbar.')),
    ];
  }

  const site = make(document, 'p', 'panel-site', tab.host);
  site.dataset.host = tab.host;

  return [site, secondaryButton(document, t('Show the notes on the page'), options.onShowOnPage)];
}

/** The host of an address the panel may show: `http` and `https` only. */
export function webHost(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);

    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.host : undefined;
  } catch {
    return undefined;
  }
}
