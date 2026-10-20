import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window as HappyDomWindow } from 'happy-dom';
import { setLanguage } from './i18n.ts';
import {
  alertBox,
  definitions,
  head,
  keys,
  listRow,
  primaryButton,
  secondaryButton,
  segmentedTabs,
  siteLine,
  statusDrop,
  textButton,
  toggle,
} from './kit.ts';

/**
 * The kit of the extension (FRU-293), read on happy-dom: the role and the name of each part, the
 * state a switch says, and the keyboard of the tabs. A native button is what gives Space and Enter
 * to every control, so each one is checked to be a button of type button. The measures and the
 * colours are `e2e/popup-layout.spec.ts`'s, on computed styles.
 */

function page(): Document {
  return new HappyDomWindow({ url: 'chrome-extension://fruitback/popup.html' }).document as unknown as Document;
}

function isNativeButton(node: Element | null): void {
  assert.equal(node?.tagName, 'BUTTON');
  assert.equal((node as HTMLButtonElement).type, 'button');
}

afterEach(() => setLanguage('en'));

describe('the kit of the extension (FRU-293)', () => {
  it('heads a shell with the drop and the name, and the button of the account', () => {
    const document = page();
    let opened = 0;
    const root = head(document, { account: { name: 'mathieu' }, onAccount: () => (opened += 1) });
    assert.equal(root.querySelector('.kit-brand')?.textContent, 'Fruitback');
    assert.equal(root.querySelector('svg.kit-mark')?.getAttribute('aria-hidden'), 'true');
    const avatar = root.querySelector('button.kit-avatar');
    isNativeButton(avatar);
    assert.equal(avatar?.getAttribute('aria-label'), 'Account and settings');
    // The initial is drawn, and the name of the button says what it opens.
    assert.equal(avatar?.textContent, 'M');
    assert.equal(avatar?.querySelector('.kit-avatar-dot')?.getAttribute('aria-hidden'), 'true');
    (avatar as HTMLButtonElement).click();
    assert.equal(opened, 1);
  });

  it('heads a shell with no button when it opens nothing, and with the gear when nobody is signed in', () => {
    assert.equal(head(page()).querySelector('button'), null);
    const root = head(page(), { onAccount: () => {} });
    const avatar = root.querySelector('button.kit-avatar');
    assert.equal(avatar?.getAttribute('aria-label'), 'Account and settings');
    assert.equal(avatar?.textContent, '');
    assert.ok(avatar?.querySelector('.kit-avatar-dot svg.kit-gear') !== null);
  });

  it('names the account in French', () => {
    setLanguage('fr');
    const root = head(page(), { account: { name: 'Camille' }, onAccount: () => {} });
    assert.equal(root.querySelector('button')?.getAttribute('aria-label'), 'Compte et réglages');
  });

  it('gives each button its words, its size, and its click', () => {
    const document = page();
    const pressed: string[] = [];
    const main = primaryButton(document, 'Turn on', () => pressed.push('main'));
    const tall = primaryButton(document, 'Leave feedback', () => pressed.push('tall'), { size: 'tall' });
    const second = secondaryButton(document, 'Turn off for this site', () => pressed.push('second'));
    const change = textButton(document, 'Change', () => pressed.push('change'));
    for (const node of [main, tall, second, change]) {
      isNativeButton(node);
      node.click();
    }
    assert.deepEqual(pressed, ['main', 'tall', 'second', 'change']);
    assert.equal(main.dataset.size, 'default');
    assert.equal(main.querySelector('svg'), null);
    // The tall action draws the drop before its words; the drop says nothing.
    assert.equal(tall.dataset.size, 'tall');
    assert.equal(tall.textContent, 'Leave feedback');
    assert.equal(tall.querySelector('svg')?.getAttribute('aria-hidden'), 'true');
    assert.equal(primaryButton(document, 'Add', undefined, { type: 'submit' }).type, 'submit');
  });

  it('flips a switch on a press, says it in aria-checked, then tells the screen', () => {
    const document = page();
    const said: boolean[] = [];
    const node = toggle(document, {
      checked: false,
      label: 'Fruitback on staging.acme.dev',
      onChange: (on) => said.push(on),
    });
    isNativeButton(node);
    assert.equal(node.getAttribute('role'), 'switch');
    assert.equal(node.getAttribute('aria-label'), 'Fruitback on staging.acme.dev');
    assert.equal(node.getAttribute('aria-checked'), 'false');
    assert.equal(node.dataset.size, 'default');
    node.click();
    assert.equal(node.getAttribute('aria-checked'), 'true');
    node.click();
    assert.equal(node.getAttribute('aria-checked'), 'false');
    assert.deepEqual(said, [true, false]);
  });

  it('writes the word beside a switch, out of its name', () => {
    const document = page();
    const field = toggle(document, {
      checked: true,
      label: 'Fruitback on staging.acme.dev',
      word: 'On',
      size: 'table',
    });
    assert.equal(field.className, 'kit-switch-field');
    assert.equal(field.querySelector('.kit-switch-word')?.getAttribute('aria-hidden'), 'true');
    const node = field.querySelector('[role="switch"]');
    assert.equal(node?.getAttribute('aria-checked'), 'true');
    assert.equal((node as HTMLElement).dataset.size, 'table');
  });

  it('names a site by its host, with a tile that says nothing', () => {
    const document = page();
    const on = siteLine(document, { host: 'staging.acme.dev', state: 'On · notes go to Linear', on: true });
    const tile = on.querySelector('.kit-tile') as HTMLElement;
    assert.equal(tile.textContent, 'S');
    assert.equal(tile.dataset.on, 'true');
    assert.equal(tile.getAttribute('aria-hidden'), 'true');
    assert.equal(on.textContent, 'Sstaging.acme.devOn · notes go to Linear');
    const paused = siteLine(document, { host: 'staging.acme.dev', state: 'Paused', on: true, paused: true });
    assert.equal((paused.querySelector('.kit-site-state') as HTMLElement).dataset.paused, 'true');
  });

  it('draws a drop of a status as a mark, or as a pin with its number', () => {
    const document = page();
    const mark = statusDrop(document, { stage: 'ripe' });
    assert.equal(mark.dataset.size, 'mark');
    assert.equal(mark.dataset.stage, 'ripe');
    assert.equal(mark.textContent, '');
    assert.equal(mark.getAttribute('aria-hidden'), 'true');
    const pin = statusDrop(document, { stage: 'ripening', number: 3 });
    assert.equal(pin.dataset.size, 'list');
    assert.equal(pin.textContent, '3');
    assert.equal(statusDrop(document, { stage: 'seeded', number: 1, size: 'page' }).dataset.size, 'page');
  });

  it('makes a row one button, named by its words, the chevron left out', () => {
    const document = page();
    let opened = 0;
    const row = listRow(document, {
      title: '2 fixes to check',
      subtitle: 'Marked done by the team',
      stage: 'ripe',
      onClick: () => (opened += 1),
    });
    isNativeButton(row);
    assert.equal(row.querySelector('.kit-chevron')?.getAttribute('aria-hidden'), 'true');
    assert.equal(row.querySelector('.kit-drop')?.getAttribute('aria-hidden'), 'true');
    const named = [...row.querySelectorAll('.kit-row-words > span')].map((span) => span.textContent);
    assert.deepEqual(named, ['2 fixes to check', 'Marked done by the team']);
    row.click();
    assert.equal(opened, 1);
  });

  it('lists terms and values in a dl, with the action beside its value', () => {
    const document = page();
    const list = definitions(document, [
      { term: 'Notes go to', value: 'Linear · Northwind', action: textButton(document, 'Change') },
      { term: 'Who sees the notes', value: 'Your team and invited guests' },
    ]);
    assert.equal(list.tagName, 'DL');
    assert.deepEqual(
      [...list.querySelectorAll('dt')].map((term) => term.textContent),
      ['Notes go to', 'Who sees the notes'],
    );
    assert.deepEqual(
      [...list.querySelectorAll('dd:not(.kit-dl-action)')].map((value) => value.textContent),
      ['Linear · Northwind', 'Your team and invited guests'],
    );
    assert.equal(list.querySelectorAll('button').length, 1);
  });

  it('says a problem in an alert, its circle left out', () => {
    const document = page();
    const box = alertBox(
      document,
      "Fruitback can't open this page",
      'Access to staging.acme.dev was removed in your browser settings. Your notes are safe.',
    );
    assert.equal(box.getAttribute('role'), 'alert');
    assert.equal(box.querySelector('.kit-alert-title')?.textContent, "Fruitback can't open this page");
    assert.equal(box.querySelector('svg')?.getAttribute('aria-hidden'), 'true');
  });

  it('writes each key of a shortcut in a kbd', () => {
    const root = keys(page(), ['Alt', 'Shift', 'F']);
    assert.deepEqual(
      [...root.querySelectorAll('kbd')].map((key) => key.textContent),
      ['Alt', 'Shift', 'F'],
    );
    assert.equal(root.textContent, 'Alt Shift F');
  });

  it('gives tabs the keyboard of a tab list: one stop, the arrows, Home and End', () => {
    const document = page();
    const chosen: string[] = [];
    const rail = segmentedTabs(document, {
      label: 'Notes',
      tabs: [
        { id: 'open', label: 'Open · 3' },
        { id: 'done', label: 'Done · 1' },
        { id: 'all', label: 'All' },
      ],
      selected: 'open',
      onSelect: (id) => chosen.push(id),
    });
    document.body.append(rail);
    assert.equal(rail.getAttribute('role'), 'tablist');
    assert.equal(rail.getAttribute('aria-label'), 'Notes');
    const tabs = [...rail.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    for (const tab of tabs) isNativeButton(tab);
    const state = () => tabs.map((tab) => `${tab.getAttribute('aria-selected')}/${tab.tabIndex}`);
    assert.deepEqual(state(), ['true/0', 'false/-1', 'false/-1']);

    const press = (tab: HTMLElement, key: string) =>
      tab.dispatchEvent(new (document.defaultView as unknown as typeof globalThis).KeyboardEvent('keydown', { key }));
    press(tabs[0] as HTMLElement, 'ArrowRight');
    assert.deepEqual(state(), ['false/-1', 'true/0', 'false/-1']);
    assert.equal(document.activeElement, tabs[1]);
    press(tabs[1] as HTMLElement, 'End');
    press(tabs[2] as HTMLElement, 'ArrowRight');
    assert.deepEqual(state(), ['true/0', 'false/-1', 'false/-1']);
    press(tabs[0] as HTMLElement, 'ArrowLeft');
    press(tabs[2] as HTMLElement, 'Home');
    (tabs[1] as HTMLElement).click();
    assert.deepEqual(chosen, ['done', 'all', 'open', 'all', 'open', 'done']);
  });

  it('writes no colour in its sheet: each one is a token', () => {
    const sheet = readFileSync(new URL('./kit.css', import.meta.url), 'utf8');
    assert.deepEqual(
      [...sheet.matchAll(/#[0-9a-f]{3,8}\b|rgba?\(/gi)].map(([colour]) => colour),
      [],
    );
  });
});
