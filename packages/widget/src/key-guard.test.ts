import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type MountedPage, keyboardEventCtor, mountPage } from './dom.fixture.ts';
import { isTypingCopy, keepTyping, pageFieldHasFocus, takesText } from './key-guard.ts';

/**
 * A key typed in a field of the widget never reaches the shortcuts of the page (FRU-726). The page
 * here has the four places a site listens: the document and the window, in each phase. Each test
 * also presses a key the page must still hear, so an empty list of the page's keys proves something.
 */

type Heard = string[];

function mount(): { page: MountedPage; root: ShadowRoot; heard: Heard; stop: () => void } {
  const page = mountPage('<input id="search" type="text"><div id="host"></div>');
  const root = page.query('#host').attachShadow({ mode: 'open' });
  root.innerHTML =
    '<textarea id="note"></textarea><input id="box" type="checkbox"><div id="rich" contenteditable="true"><b id="bold">x</b></div><button id="send">Send</button>';
  const stop = keepTyping(root);
  const heard: Heard = [];
  for (const type of ['keydown', 'keypress', 'keyup', 'beforeinput', 'input']) {
    page.document.addEventListener(type, () => heard.push(`document ${type}`));
    page.document.addEventListener(type, () => heard.push(`document capture ${type}`), true);
    page.view.addEventListener(type, () => heard.push(`window ${type}`));
    page.view.addEventListener(type, () => heard.push(`window capture ${type}`), true);
  }

  return { page, root, heard, stop };
}

function press(page: MountedPage, on: Element, key: string, type = 'keydown'): KeyboardEvent {
  const Key = keyboardEventCtor(page);
  const event = new Key(type, { key, bubbles: true, cancelable: true, composed: true });
  on.dispatchEvent(event);

  return event;
}

let stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
});

describe('keepTyping', () => {
  it('keeps the keys of a field of the widget from the document and the window, in both phases', () => {
    const { page, root, heard, stop } = mount();
    stops.push(stop);
    const note = root.getElementById('note') as Element;
    for (const type of ['keydown', 'keypress', 'keyup']) press(page, note, 'c', type);
    assert.deepEqual(heard, []);

    // The control: the same key in a field of the page reaches all four.
    press(page, page.query('#search'), 'c');
    assert.deepEqual(heard.sort(), [
      'document capture keydown',
      'document keydown',
      'window capture keydown',
      'window keydown',
    ]);
  });

  it('gives the field a copy of the key, and a cancel of the copy cancels the key', () => {
    const { page, root, stop } = mount();
    stops.push(stop);
    const note = root.getElementById('note') as Element;
    const got: { key: string; copy: boolean; composed: boolean }[] = [];
    note.addEventListener('keydown', (event) => {
      const key = event as KeyboardEvent;
      got.push({ key: key.key, copy: isTypingCopy(event), composed: event.composed });
      if (key.key === 'Enter') event.preventDefault();
    });
    const c = press(page, note, 'c');
    const enter = press(page, note, 'Enter');

    assert.deepEqual(got, [
      { key: 'c', copy: true, composed: false },
      { key: 'Enter', copy: true, composed: false },
    ]);
    // The browser types the « c » from the key itself, which nobody cancelled.
    assert.equal(c.defaultPrevented, false);
    assert.equal(enter.defaultPrevented, true);
  });

  it('counts a text the widget edits, and not a box or a button', () => {
    const { page, root, heard, stop } = mount();
    stops.push(stop);
    // Inside an element you can edit: the key's own target is the bold text in it.
    press(page, root.getElementById('bold') as Element, 'c');
    assert.deepEqual(heard, []);

    press(page, root.getElementById('box') as Element, ' ');
    press(page, root.getElementById('send') as Element, 'c');
    assert.equal(heard.filter((each) => each === 'document keydown').length, 2);
  });

  it('lets the page hear every key again once stopped', () => {
    const { page, root, heard, stop } = mount();
    stop();
    press(page, root.getElementById('note') as Element, 'c');
    assert.equal(heard.length, 4);
  });
});

describe('takesText', () => {
  it('answers for fields, lists, text boxes and editable elements only', () => {
    const page = mountPage(
      '<input id="a"><input id="b" type="search"><input id="c" type="checkbox"><input id="d" type="submit"><select id="e"></select><textarea id="f"></textarea><div id="g" role="textbox"></div><div id="h" contenteditable="true"></div><div id="i" contenteditable="false"></div><button id="j"></button><button id="k" role="combobox"></button>',
    );
    const takes = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'].filter((id) =>
      takesText(page.query(`#${id}`)),
    );
    assert.deepEqual(takes, ['a', 'b', 'e', 'f', 'g', 'h']);
  });
});

describe('pageFieldHasFocus', () => {
  it('answers for a field of the page, and not for a field of the widget or a button of the page', () => {
    const page = mountPage('<input id="search"><button id="go">Go</button><div id="host"></div>');
    const root = page.query('#host').attachShadow({ mode: 'open' });
    root.innerHTML = '<textarea id="note"></textarea>';

    (page.query('#search') as HTMLElement).focus();
    assert.equal(pageFieldHasFocus(page.document, root), true);
    (root.getElementById('note') as HTMLElement).focus();
    assert.equal(pageFieldHasFocus(page.document, root), false);
    (page.query('#go') as HTMLElement).focus();
    assert.equal(pageFieldHasFocus(page.document, root), false);
  });
});
