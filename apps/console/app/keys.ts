/**
 * The one guard of the shortcuts of the console (FRU-726): « C », « / », j and k, Cmd or Ctrl and A,
 * the copies, and the keys of the panel of a task.
 *
 * A shortcut reads the elements the key went through, `composedPath()`, and not `event.target`. The
 * target of a key typed in a Shadow root is its host element: the Fruitback widget on the console is
 * one, and each « c » of a note opened « New task » and was missing from the note.
 */

/** The inputs that take no text: a key on them (Space on a box) is not typing. */
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

/** The roles that keep their keys: a dialog, a menu and a list of options. */
const OWNERS = new Set(['dialog', 'alertdialog', 'menu', 'listbox']);

/** An element, by its shape: the tests run in Node, with no `Element`. */
function isElement(value: unknown): value is Element {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Element).tagName === 'string' &&
    typeof (value as Element).getAttribute === 'function'
  );
}

/** Whether an element takes typed text: a field, a list, an element you can edit, or a text box. */
export function takesText(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') return !NO_TEXT.has((element.getAttribute('type') ?? 'text').toLowerCase());
  if ((element as HTMLElement).isContentEditable === true) return true;
  const role = element.getAttribute('role');

  return role === 'textbox' || role === 'searchbox' || role === 'combobox';
}

/** The elements the key went through, from its own target up, through every Shadow root. */
function elementsOf(event: Pick<Event, 'composedPath' | 'target'>): Element[] {
  const path = typeof event.composedPath === 'function' ? event.composedPath().filter(isElement) : [];
  if (path.length > 0) return path;
  const up: Element[] = [];
  for (let at: Element | null = isElement(event.target) ? event.target : null; at !== null; at = at.parentElement) {
    up.push(at);
  }

  return up;
}

/** Whether the key is typed in a field, the console's or one in a Shadow root. */
export function typedInField(event: Pick<Event, 'composedPath' | 'target'>): boolean {
  return elementsOf(event).some(takesText);
}

/** Whether a field, a menu, a list of options or a dialog has the key: they keep their keys. */
export function ownsKeys(event: Pick<Event, 'composedPath' | 'target'>): boolean {
  return elementsOf(event).some((element) => takesText(element) || OWNERS.has(element.getAttribute('role') ?? ''));
}

/** Whether an IME composes a word: its keys belong to the word (229 is the key of Safari then). */
export function composes(event: Pick<KeyboardEvent, 'isComposing' | 'keyCode'>): boolean {
  return event.isComposing || event.keyCode === 229;
}

/**
 * Whether a key alone is free for a shortcut of one key (« C », « / », j, k): no Cmd, Ctrl or Alt, no
 * IME that composes, not taken already, and not typed in a field, a menu or a dialog.
 */
export function isBareShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || composes(event)) return false;

  return !ownsKeys(event);
}
