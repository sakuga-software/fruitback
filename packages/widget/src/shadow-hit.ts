/**
 * Hit testing through nested open shadow roots (FRU-580).
 *
 * react-grab 0.2.0 crosses one open shadow root. With two nested ones it recurses until the stack
 * overflows, on every move of the pointer: `elementsFromPoint` of the inner shadow root also returns
 * the outer host, retargeted, and react-grab enters the root of that host again (measured in
 * Chromium). So the widget does its own walk when the point is over a shadow host, and enters each
 * shadow root once.
 */

/** Whether the element on top at this point is a shadow host: then `deepElementAt` answers. */
export function overShadowHost(root: Document, clientX: number, clientY: number): boolean {
  return root.elementFromPoint(clientX, clientY)?.shadowRoot != null;
}

/**
 * The element on top at this point that `accept` takes, through every open shadow root: an element
 * of a shadow root comes before its host. `null` when no element is accepted.
 */
export function deepElementAt(
  root: Document | ShadowRoot,
  clientX: number,
  clientY: number,
  accept: (element: Element) => boolean,
  entered: Set<ShadowRoot> = new Set(),
): Element | null {
  for (const element of root.elementsFromPoint(clientX, clientY)) {
    const shadow = element.shadowRoot;
    if (shadow !== null && shadow !== root && !entered.has(shadow)) {
      entered.add(shadow);
      const inner = deepElementAt(shadow, clientX, clientY, accept, entered);
      if (inner !== null) return inner;
    }
    if (accept(element)) return element;
  }

  return null;
}
