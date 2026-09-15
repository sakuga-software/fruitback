/**
 * Focus inside the widget's dialogs (SKG-544).
 *
 * For a node focused inside a Shadow root, `document.activeElement` is the host element. These
 * helpers read the active element of the root node that holds the dialog.
 */

const FOCUSABLE = 'button, input, textarea, select, a[href], [tabindex]';

export type FocusHold = {
  /** Keeps the element that has focus now, so that `restore` can give focus back to it. */
  remember(): void;
  /** Gives focus back to the kept element, if focus is in the dialog or nowhere. */
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

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onEscape();

      return;
    }
    if (event.key !== 'Tab') return;

    const items = focusables(dialog);
    const first = items[0];
    const last = items.at(-1);
    if (first === undefined || last === undefined) {
      event.preventDefault();

      return;
    }

    const active = deepActiveElement(document);
    const outside = active === null || !dialog.contains(active);
    if (event.shiftKey && (outside || active === first)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (outside || active === last)) {
      event.preventDefault();
      first.focus();
    }
  }

  dialog.addEventListener('keydown', onKeyDown);

  return {
    remember() {
      const active = deepActiveElement(document);
      // A second open while the dialog has focus keeps the first opener.
      if (active !== null && !dialog.contains(active) && isFocusable(active)) opener = active;
    },
    restore() {
      const active = deepActiveElement(document);
      const lost = active === null || active === document.body || dialog.contains(active);
      if (lost && opener?.isConnected === true) opener.focus();
      opener = null;
    },
    destroy() {
      dialog.removeEventListener('keydown', onKeyDown);
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
