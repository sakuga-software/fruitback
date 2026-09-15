/**
 * Focus inside the widget's dialogs (SKG-544).
 *
 * For a node focused inside a Shadow root, `document.activeElement` is the host element. These
 * helpers read the active element of the root node that holds the dialog.
 */

const FOCUSABLE = 'button, input, textarea, select, a[href], [tabindex]';

/**
 * The dialogs open in each document, the last opened last.
 *
 * Two can be open at once: the gear opens the panel over an open popover. Only the last one keeps Tab,
 * or the two traps move focus back and forth.
 */
const OPEN_DIALOGS = new WeakMap<Document, HTMLElement[]>();

export type FocusHold = {
  /** Marks the dialog as open, and keeps the element that has focus now for `restore`. */
  remember(): void;
  /** Marks the dialog as closed, and gives focus back to the kept element if focus is in the dialog or nowhere. */
  restore(): void;
  destroy(): void;
};

/** The element that has focus, through every open Shadow root. */
export function deepActiveElement(document: Document): Element | null {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;

  return active;
}

/** The controls of `container` that Tab can reach, in document order. */
export function focusables(container: Element): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) =>
      (element as HTMLButtonElement).disabled !== true && element.tabIndex >= 0 && !hiddenInside(element, container),
  );
}

/**
 * Keeps Tab and Shift+Tab inside `dialog`, and calls `onEscape` on Escape.
 *
 * The Escape stops at the dialog. Other listeners on the document also close something on Escape,
 * and one key press must close only the dialog that has focus.
 */
export function holdFocus(dialog: HTMLElement, onEscape: () => void): FocusHold {
  const document = dialog.ownerDocument;
  let opener: HTMLElement | null = null;
  const open = OPEN_DIALOGS.get(document) ?? [];
  OPEN_DIALOGS.set(document, open);

  const isLastOpened = () => {
    const last = open.at(-1);

    return last === undefined || last === dialog;
  };
  const forget = () => {
    const index = open.indexOf(dialog);
    if (index !== -1) open.splice(index, 1);
  };

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onEscape();

      return;
    }
    if (event.key === 'Tab' && isLastOpened()) keepTabInside(event);
  }

  /**
   * Tab after a click on the page moved focus out of the open dialog.
   *
   * The page is not inert, and that Tab never reaches the dialog's own listener.
   */
  function onDocumentKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Tab' || dialog.hidden || !dialog.isConnected || !isLastOpened()) return;

    const active = deepActiveElement(document);
    if (active !== null && dialog.contains(active)) return;

    keepTabInside(event);
  }

  function keepTabInside(event: KeyboardEvent): void {
    const items = focusables(dialog);
    const first = items[0];
    const last = items.at(-1);
    if (first === undefined || last === undefined) {
      event.preventDefault();

      return;
    }

    // An element outside the cycle counts as outside the dialog: a send button disabled in flight, or the page.
    const active = deepActiveElement(document);
    const index = items.findIndex((item) => item === active);
    if (event.shiftKey && index <= 0) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (index === -1 || index === items.length - 1)) {
      event.preventDefault();
      first.focus();
    }
  }

  dialog.addEventListener('keydown', onKeyDown);
  document.addEventListener('keydown', onDocumentKeyDown, true);

  return {
    remember() {
      forget();
      open.push(dialog);
      const active = deepActiveElement(document);
      // A second open while the dialog has focus keeps the first opener.
      if (active !== null && !dialog.contains(active) && isFocusable(active)) opener = active;
    },
    restore() {
      forget();
      const active = deepActiveElement(document);
      const lost = active === null || active === document.body || dialog.contains(active);
      if (lost && opener?.isConnected === true) opener.focus();
      opener = null;
    },
    destroy() {
      forget();
      dialog.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keydown', onDocumentKeyDown, true);
    },
  };
}

function isFocusable(element: Element): element is HTMLElement {
  return typeof (element as HTMLElement).focus === 'function' && element !== element.ownerDocument.body;
}

function hiddenInside(element: Element, container: Element): boolean {
  for (let node: Element | null = element; node !== null && node !== container; node = node.parentElement) {
    if (node.hasAttribute('hidden')) return true;
  }

  return false;
}
