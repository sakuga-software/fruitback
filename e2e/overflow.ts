import type { Page } from '@playwright/test';

/**
 * What runs past its box or past the side of the screen (FRU-350), for the specs of each surface.
 *
 * A text runs past its box when the box scrolls it (`scrollWidth` above `clientWidth`) and no
 * ellipsis says it is cut on purpose. A box runs past the screen when part of it is out on the right
 * or on the left, outside a list that scrolls sideways. Shadow roots are read too: the widget lives
 * in one. Elements drawn for screen readers only (1 px, or out of the screen) are not counted.
 *
 * Answers one line per fault, so a failure names the element and its words.
 */
export const LONG_URL =
  'https://preview-branch-feature-very-long-name-1234.staging.acme.dev/checkout/payment-method/confirmation?session=8f3a1c9e2b7d4f60a5e1c3b9d7f2a4e6';
export const LONG_WORD = 'Anticonstitutionnellement-réorganisationnellement';
/** A French note: longer words, a non-breaking space before the colon, and an address with no space. */
export const LONG_NOTE = `Le libellé « Valider ma commande et passer au paiement sécurisé » déborde du bouton sur mobile : ${LONG_URL} ${LONG_WORD}`;

export const WIDTHS = [320, 390, 1280] as const;
export const LANGUAGES = ['en', 'fr'] as const;

/**
 * The faults of the page `page` shows now. Empty when nothing runs past anything.
 *
 * `within`: the selector of the host of a shadow root, to read that root alone. The widget is
 * measured so: the page it sits on is the client's, and how it lays itself out is not the widget's.
 */
export function overflows(page: Page, within?: string): Promise<string[]> {
  return page.evaluate(overflowsInDocument, within);
}

/** The same check, as a function the page can run itself: the side panel is reached as a target. */
export function overflowsInDocument(within?: string): string[] {
  const width = document.documentElement.clientWidth;
  const faults: string[] = [];
  const name = (element: Element): string => {
    const classes = typeof element.className === 'string' ? element.className.trim().split(/\s+/).filter(Boolean) : [];
    const words = (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 48);

    return `${element.tagName.toLowerCase()}${classes.map((each) => `.${each}`).join('')} « ${words} »`;
  };
  /** The nearest box that scrolls or clips sideways, around `element`. */
  const clipper = (element: Element): Element | undefined => {
    for (
      let node: Element | null = element.parentElement ?? (element.getRootNode() as ShadowRoot).host ?? null;
      node;
    ) {
      if (getComputedStyle(node).overflowX !== 'visible') return node;
      node = node.parentElement ?? (node.getRootNode() as ShadowRoot).host ?? null;
    }

    return undefined;
  };
  const visit = (root: Document | ShadowRoot): void => {
    for (const element of root.querySelectorAll<HTMLElement>('*')) {
      if (element.shadowRoot !== null) visit(element.shadowRoot);
      const ownText = [...element.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '',
      );
      const field = element instanceof HTMLTextAreaElement;
      if (!ownText && !field) continue;
      const style = getComputedStyle(element);
      if (style.visibility !== 'visible' || style.display === 'none' || style.display === 'contents') continue;
      if (Number(style.opacity) === 0) continue;
      const box = element.getBoundingClientRect();
      // Drawn for screen readers only, or out of sight on purpose.
      if (box.width <= 2 || box.height <= 2 || box.right <= 0 || box.left >= width) continue;
      if (style.clipPath !== 'none' || (style.clip !== 'auto' && style.clip !== '')) continue;
      // In a box that scrolls or clips sideways: a label that stays on one line may scroll there, as
      // the tabs of a rail do; a text that could wrap and runs past it is cut.
      const around = clipper(element);
      if (around !== undefined) {
        const room = around.getBoundingClientRect();
        const oneLine = style.whiteSpace === 'nowrap' || style.whiteSpace === 'pre';
        const scrolls = ['auto', 'scroll'].includes(getComputedStyle(around).overflowX);
        // A table in a box that scrolls sideways is read by scrolling it: its columns are not cut.
        const scrolledTable = scrolls && element.closest('table') !== null && around.contains(element.closest('table'));
        if (!oneLine && !scrolledTable && (box.right > room.right + 1 || box.left < room.left - 1)) {
          faults.push(`past its box (${Math.round(box.right)} past ${Math.round(room.right)}): ${name(element)}`);
          continue;
        }
        if (getComputedStyle(around).overflowX !== 'hidden' && getComputedStyle(around).overflowX !== 'clip') continue;
      }
      if (box.right > width + 1 || box.left < -1) {
        faults.push(
          `past the screen (${Math.round(box.left)} to ${Math.round(box.right)} of ${width}): ${name(element)}`,
        );
        continue;
      }
      // Squeezed into a column: a text of several letters in less than three of its em.
      const words = field
        ? ''
        : [...element.childNodes]
            .map((node) => (node.nodeType === Node.TEXT_NODE ? node.textContent : ''))
            .join('')
            .trim();
      const em = Number.parseFloat(style.fontSize);
      if (words.length > 6 && box.width < 3 * em && box.height > 3 * em) {
        faults.push(`squeezed (${Math.round(box.width)} px wide): ${name(element)}`);
        continue;
      }
      const inline = style.display === 'inline';
      const meant = style.textOverflow === 'ellipsis';
      if (!inline && !meant && element.scrollWidth > element.clientWidth + 1) {
        faults.push(`cut (${element.scrollWidth} in ${element.clientWidth}): ${name(element)}`);
      }
    }
  };
  if (within !== undefined) {
    const host = document.querySelector(within);
    if (host === null) return [`nothing matches ${within}`];
    visit(host.shadowRoot ?? (host as unknown as Document));

    return faults;
  }
  visit(document);
  const sideways = document.documentElement.scrollWidth - width;
  if (sideways > 1) faults.push(`the page scrolls sideways by ${sideways} px`);

  return faults;
}
