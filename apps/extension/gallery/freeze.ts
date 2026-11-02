/**
 * The « Frozen » mode of the gallery: a story stays in the state that its `play` gave, and nothing
 * on it reacts. The widget of Fruitback can then take a note on any element of the story.
 *
 * - The children of the root of the story are replaced by copies. A copy has no listener.
 * - The widget of the story is copied into a new open shadow root, with the same sheets, and then
 *   destroyed. The widget of the extension anchors a note through an open shadow root (FRU-580).
 */

export const FROZEN_CLASS = 'gallery-frozen';

/**
 * A copy keeps the attributes, not the state that a script or a person gave to a field: the value of
 * a text field, the `checked` of a box, the `selected` of an option. These come along as attributes.
 */
function withValues<T extends Node>(source: T, copy: T): T {
  if (source.nodeType !== Node.ELEMENT_NODE) return copy;
  const query = 'input, textarea, option';
  const fields = (source as unknown as Element).querySelectorAll(query);
  const copies = (copy as unknown as Element).querySelectorAll(query);
  fields.forEach((field, index) => {
    const target = copies[index];
    if (target !== undefined) copyState(field, target);
  });

  return copy;
}

function copyState(field: Element, target: Element): void {
  if (field.tagName === 'TEXTAREA') {
    target.textContent = (field as HTMLTextAreaElement).value;
  } else if (field.tagName === 'OPTION') {
    target.toggleAttribute('selected', (field as HTMLOptionElement).selected);
  } else {
    const input = field as HTMLInputElement;
    if (input.type === 'checkbox' || input.type === 'radio') target.toggleAttribute('checked', input.checked);
    else target.setAttribute('value', input.value);
  }
}

/**
 * A copy of `host` and of its shadow root, with no listener. The copy adopts the sheets of the root:
 * a sheet of one document can be adopted by more roots of that document.
 */
export function cloneHost(host: HTMLElement): HTMLElement {
  const root = host.shadowRoot;
  const copy = host.ownerDocument.createElement('div');
  for (const { name, value } of host.attributes) {
    if (name !== 'data-fruitback-host') copy.setAttribute(name, value);
  }
  copy.classList.add(FROZEN_CLASS);
  // The layers of the copy keep their `z-index` inside the copy, under the layers of a live widget.
  copy.style.isolation = 'isolate';
  if (root === null) return copy;
  const copyRoot = copy.attachShadow({ mode: 'open' });
  copyRoot.adoptedStyleSheets = [...root.adoptedStyleSheets];
  copyRoot.append(...[...root.childNodes].map((node) => withValues(node, node.cloneNode(true))));

  return copy;
}

/** The children of `root`, copied in place. */
export function freezeChildren(root: Element): void {
  root.replaceChildren(...[...root.childNodes].map((node) => withValues(node, node.cloneNode(true))));
}

/**
 * The corner of the dock of the copy: the other side of the dock of `beside`, the widget that stays
 * live. On the same corner, the dock of the copy covers the live one, and a click on « Leave a note »
 * reaches the copy, which does nothing. A host with no corner has its dock at the bottom right.
 */
export function cornerBeside(beside: string | undefined): string {
  const corner = beside ?? 'bottom-right';
  const [edge = 'bottom', side] = corner.split('-');

  return `${edge}-${side === 'left' ? 'right' : 'left'}`;
}
