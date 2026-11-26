import { isElement } from './dom.ts';

/**
 * The keys typed in a field of the widget stay in the widget (FRU-726).
 *
 * A site has shortcuts of its own: « C » for a new task, « / » for the search, j and k for a list.
 * Its handlers listen on `document` or on `window`, and a key typed in a field of the Shadow root
 * comes to them with the host element as its target. So a test of `event.target` does not see a
 * field there, and the page took the « c » of the note for its shortcut.
 *
 * One listener in the capture phase on `window`, set when the widget mounts, stops the events of a
 * field of the widget before the page sees them: no handler of the document, in either phase, and no
 * handler of the window set after the widget, hears them. The widget still needs them, so the
 * listener gives a copy to the field. The copy does not leave the Shadow root (`composed: false`),
 * and a `preventDefault` of the widget on the copy goes back to the key. The browser types the text,
 * pastes, and composes with an IME from the key itself, which nobody cancelled.
 *
 * Not covered: a handler of the page in the capture phase on `window`, set before the widget. It
 * runs before this listener, and nothing can come before it.
 */

/** The events a key, a paste or an IME sends to a field of text. */
const TYPING = ['keydown', 'keypress', 'keyup', 'beforeinput', 'input'] as const;

/** The inputs that take no text: their keys (Space on a box) do not count as typing. */
const NO_TEXT = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

const COPIES = new WeakSet<Event>();

/** Whether an element takes typed text: a field, a list, an element you can edit, or a text box. */
export function takesText(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') return !NO_TEXT.has((element.getAttribute('type') ?? 'text').toLowerCase());
  if ((element as HTMLElement).isContentEditable === true) return true;
  const role = element.getAttribute('role');

  return role === 'textbox' || role === 'searchbox' || role === 'combobox';
}

/** Whether this event is the copy of a key that `keepTyping` gave to a field of the widget. */
export function isTypingCopy(event: Event): boolean {
  return COPIES.has(event);
}

/** Whether a field of the page, out of the widget's `root`, has the focus: the widget's keys then stay off. */
export function pageFieldHasFocus(document: Document, root: Node): boolean {
  // `deepActiveElement` of `focus.ts`, here so that `focus.ts` can read `isTypingCopy` with no cycle.
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;

  return active !== null && !root.contains(active) && takesText(active);
}

/** The copy of a key or of an input event, for the field alone. */
function copyOf(event: Event, view: Window & typeof globalThis): Event {
  const init = { bubbles: true, cancelable: event.cancelable, composed: false };
  if ('key' in event) {
    const key = event as KeyboardEvent;

    return new view.KeyboardEvent(event.type, {
      ...init,
      key: key.key,
      code: key.code,
      location: key.location,
      repeat: key.repeat,
      isComposing: key.isComposing,
      altKey: key.altKey,
      ctrlKey: key.ctrlKey,
      metaKey: key.metaKey,
      shiftKey: key.shiftKey,
    });
  }
  if ('inputType' in event) {
    const input = event as InputEvent;

    return new view.InputEvent(event.type, {
      ...init,
      data: input.data,
      inputType: input.inputType,
      isComposing: input.isComposing,
    });
  }

  return new view.Event(event.type, init);
}

/**
 * Keeps the typing in the fields of `root` away from the page, from now until the returned function
 * is called.
 */
export function keepTyping(root: ShadowRoot): () => void {
  const view = root.ownerDocument.defaultView;
  if (view === null) return () => {};

  const onTyping = (event: Event): void => {
    const [field] = event.composedPath();
    if (!isElement(field) || field.getRootNode() !== root || !takesText(field)) return;
    event.stopImmediatePropagation();
    const copy = copyOf(event, view);
    COPIES.add(copy);
    if (!field.dispatchEvent(copy) && event.cancelable) event.preventDefault();
  };
  for (const type of TYPING) view.addEventListener(type, onTyping, true);

  return () => {
    for (const type of TYPING) view.removeEventListener(type, onTyping, true);
  };
}
