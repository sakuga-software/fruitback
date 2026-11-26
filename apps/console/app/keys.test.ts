import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { elementsOf, isBareShortcut, ownsKeys, takesText, typedInField } from './keys.ts';

/**
 * The guard of the shortcuts of the console (FRU-726). Node has no DOM, so an element here is its
 * shape: a tag, its attributes, and whether you can edit it.
 */
type Fake = Element & { parentElement: Fake | null };

function element(tag: string, attributes: Record<string, string> = {}, parent: Fake | null = null): Fake {
  const editable = attributes.contenteditable;

  return {
    tagName: tag.toUpperCase(),
    getAttribute: (name: string) => attributes[name] ?? null,
    isContentEditable: editable !== undefined && editable !== 'false',
    parentElement: parent,
  } as unknown as Fake;
}

/** A key as a browser gives it: its own target first in its path, then up to the document. */
function key(init: Partial<KeyboardEvent> & { path: Element[]; target?: Element }): KeyboardEvent {
  const { path, target, ...rest } = init;

  return {
    key: 'c',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 67,
    defaultPrevented: false,
    composedPath: () => path,
    target: target ?? path[0] ?? null,
    ...rest,
  } as unknown as KeyboardEvent;
}

const body = element('body');
const host = element('div', { 'data-fruitback-host': '' }, body);
const note = element('textarea', {}, null);

describe('the guard of the shortcuts (FRU-726)', () => {
  it('sees the field of the widget in its Shadow root, where the target is the host', () => {
    // The target of a key typed in a Shadow root is its host: the defect of FRU-726.
    const typed = key({ path: [note, host, body], target: host });
    assert.equal(typedInField(typed), true);
    assert.equal(isBareShortcut(typed), false);

    // The control: the same key on the page is free.
    assert.equal(isBareShortcut(key({ path: [body] })), true);
  });

  it('leaves the key to a field, an element you edit, a text box, a menu and a dialog of the console', () => {
    const cases: [string, Element][] = [
      ['input', element('input', {}, body)],
      ['search', element('input', { type: 'search' }, body)],
      ['select', element('select', {}, body)],
      ['editable', element('span', {}, element('div', { contenteditable: 'true' }, body))],
      ['textbox', element('div', { role: 'textbox' }, body)],
      ['menu', element('button', {}, element('div', { role: 'menu' }, body))],
      ['dialog', element('button', {}, element('div', { role: 'dialog' }, body))],
    ];
    for (const [name, target] of cases) {
      const path: Element[] = [];
      for (let at: Fake | null = target as Fake; at !== null; at = at.parentElement) path.push(at);
      // The editable span inherits its editing: the browser says so on the span.
      if (name === 'editable') Object.assign(target, { isContentEditable: true });
      assert.equal(ownsKeys(key({ path })), true, name);
    }
  });

  it('reads the parents of the target when the key has no path', () => {
    const field = element('input', {}, body);
    assert.equal(ownsKeys(key({ path: [], target: field })), true);
    assert.equal(ownsKeys(key({ path: [], target: body })), false);
  });

  it('takes no key with Cmd, Ctrl or Alt, while an IME composes, or once taken', () => {
    for (const init of [
      { metaKey: true },
      { ctrlKey: true },
      { altKey: true },
      { isComposing: true },
      { keyCode: 229 },
      { defaultPrevented: true },
    ]) {
      assert.equal(isBareShortcut(key({ path: [body], ...init })), false, JSON.stringify(init));
    }
  });

  it('reads the parents of the target for the panel too, when the key has no path', () => {
    const panel = element('aside', { role: 'dialog' }, body);
    const button = element('button', {}, panel);
    assert.deepEqual(elementsOf(key({ path: [], target: button })), [button, panel, body]);
  });

  it('leaves Cmd or Ctrl and A to the page on a button that says combobox, as before', () => {
    const select = element('button', { role: 'combobox' }, body);
    assert.equal(ownsKeys(key({ path: [select, body], metaKey: true, key: 'a' })), false);
  });

  it('counts a box, a radio and a button as no field', () => {
    for (const type of ['checkbox', 'radio', 'button', 'submit']) {
      assert.equal(takesText(element('input', { type })), false, type);
    }
    assert.equal(takesText(element('button')), false);
    assert.equal(takesText(element('div', { contenteditable: 'false' })), false);
  });
});
