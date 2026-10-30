import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window as HappyDomWindow } from 'happy-dom';
import { setLanguage } from './i18n.ts';
import {
  alertBox,
  button,
  definitions,
  head,
  helpLink,
  hostOf,
  keys,
  linkButton,
  listRow,
  make,
  listSelect,
  primaryButton,
  providerButton,
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

describe('the builders every screen shares (FRU-511)', () => {
  it('makes an element with its class and its words, and no class attribute for none', () => {
    const document = page();
    const line = make(document, 'p', 'state', 'No rule yet.');
    assert.equal(line.outerHTML, '<p class="state">No rule yet.</p>');
    assert.equal(make(document, 'div', '').hasAttribute('class'), false);
  });

  it('makes a button that submits nothing, and a link button in the class of its screen', () => {
    const document = page();
    let pressed = 0;
    const node = button(document, 'remedy', 'Allow', () => (pressed += 1));
    isNativeButton(node);
    node.click();
    assert.equal(pressed, 1);
    assert.equal(linkButton(document, 'Log out', () => undefined).className, 'link-button');
    assert.equal(linkButton(document, 'Reply', () => undefined, 'panel-link').className, 'panel-link');
  });

  it('names the host of an address with its port, and keeps an address that does not parse', () => {
    assert.equal(hostOf('https://acme.dev:8443/notes'), 'acme.dev:8443');
    assert.equal(hostOf('not an address'), 'not an address');
  });
});

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
    const mark = statusDrop(document, { stage: 'done' });
    assert.equal(mark.dataset.size, 'mark');
    assert.equal(mark.dataset.stage, 'done');
    assert.equal(mark.textContent, '');
    assert.equal(mark.getAttribute('aria-hidden'), 'true');
    const pin = statusDrop(document, { stage: 'progress', number: 3 });
    assert.equal(pin.dataset.size, 'list');
    assert.equal(pin.textContent, '3');
    assert.equal(statusDrop(document, { stage: 'new', number: 1, size: 'page' }).dataset.size, 'page');
  });

  it('makes a row one button, named by its words, the chevron left out', () => {
    const document = page();
    let opened = 0;
    const row = listRow(document, {
      title: '2 fixes to check',
      subtitle: 'Marked done by the team',
      stage: 'done',
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

  it('draws the mark of Google and of GitHub before the word, and names the button by the word (FRU-525)', () => {
    const document = page();
    let pressed = 0;
    for (const [provider, word] of [
      ['google', 'Google'],
      ['github', 'GitHub'],
    ] as const) {
      const node = providerButton(document, provider, () => (pressed += 1));
      isNativeButton(node);
      assert.ok(node.classList.contains('kit-secondary'));
      // The mark comes first, a drawing a screen reader skips; the name is the word alone.
      const mark = node.firstElementChild;
      assert.equal(mark?.tagName.toLowerCase(), 'svg');
      assert.equal(mark?.getAttribute('aria-hidden'), 'true');
      assert.equal(mark?.getAttribute('focusable'), 'false');
      assert.equal((mark as SVGElement).dataset.provider, provider);
      assert.equal(node.textContent, word);
      assert.equal(node.getAttribute('aria-label'), null);
      node.click();
    }
    assert.equal(pressed, 2);
  });

  it('paints the « G » in the four colours of Google, and the GitHub mark in the colour of its word', () => {
    const fills = (provider: 'google' | 'github') =>
      [...providerButton(page(), provider).querySelectorAll('path')].map((path) => path.getAttribute('fill'));
    assert.deepEqual(fills('google'), ['#EA4335', '#4285F4', '#FBBC05', '#34A853']);
    assert.deepEqual(fills('github'), ['currentColor']);
  });

  it('draws the same paths as the buttons of the console, so the two marks cannot drift apart', () => {
    const console = readFileSync(new URL('../../console/app/provider-icons.tsx', import.meta.url), 'utf8');
    const theirs = [...console.matchAll(/(?:d="|')(M[^"']+)["']/g)].map(([, d]) => d);
    const ours = (['google', 'github'] as const).flatMap((provider) =>
      [...providerButton(page(), provider).querySelectorAll('path')].map((path) => path.getAttribute('d')),
    );
    assert.equal(theirs.length, 5, `read ${theirs.length} paths of provider-icons.tsx`);
    assert.deepEqual(ours, theirs);
  });

  it('leads to a page of the guide in a new tab: a link with the book, centred in its line (FRU-528)', () => {
    const row = helpLink(page(), { label: 'How Fruitback works', href: 'https://fruitback.com/reviewing.html#x' });
    assert.ok(row.classList.contains('kit-help'));
    const link = row.querySelector('a');
    assert.equal(row.children.length, 1);
    assert.equal(link?.getAttribute('href'), 'https://fruitback.com/reviewing.html#x');
    assert.equal(link?.target, '_blank');
    assert.equal(link?.rel, 'noreferrer');
    assert.ok(link?.classList.contains('kit-secondary'));
    assert.equal(link?.textContent, 'How Fruitback works');
    const book = link?.firstElementChild;
    assert.equal(book?.tagName.toLowerCase(), 'svg');
    assert.equal(book?.getAttribute('aria-hidden'), 'true');
  });
});

describe('a list to choose from (FRU-535)', () => {
  const build = (open = false) => {
    const document = page();
    const said: string[] = [];
    const root = listSelect(document, {
      label: 'Status',
      trigger: 'Status · All · 9',
      options: [
        { id: '', label: 'All', count: 9 },
        {
          id: 'name:Triage',
          label: 'Triage',
          count: 2,
          drop: { stage: 'new', paint: { fill: '#e0f2fe', ink: '#18181b' } },
        },
        { id: 'name:In Review', label: 'In Review', count: 3, drop: { stage: 'progress' } },
      ],
      selected: '',
      open,
      onOpenChange: (state) => said.push(`open:${state}`),
      onSelect: (id) => said.push(`select:${id}`),
    });
    document.body.append(root);
    const trigger = root.querySelector<HTMLButtonElement>('button.kit-select-trigger');
    const key = (target: Element | null, name: string): void => {
      target?.dispatchEvent(
        new document.defaultView!.KeyboardEvent('keydown', { key: name, bubbles: true }) as unknown as Event,
      );
    };

    return { document, root, trigger, said, key, list: () => root.querySelector('[role="listbox"]') };
  };

  it('is a button that says the choice, and a list box, never a native select', () => {
    const { root, trigger, list } = build();

    assert.equal(trigger?.type, 'button');
    assert.equal(trigger?.textContent?.includes('Status · All · 9'), true);
    assert.equal(trigger?.getAttribute('aria-haspopup'), 'listbox');
    assert.equal(trigger?.getAttribute('aria-expanded'), 'false');
    assert.equal(list(), null, 'closed, the list is not drawn');
    assert.equal(root.querySelector('select'), null);
  });

  it('opens on a click, with each option, its drop and its number, and the choice selected', () => {
    const { document, trigger, said, list } = build();
    trigger?.click();

    assert.equal(trigger?.getAttribute('aria-expanded'), 'true');
    assert.ok(document.activeElement === list());
    assert.equal(list()?.getAttribute('aria-label'), 'Status');
    const options = [...(list()?.querySelectorAll('[role="option"]') ?? [])];
    assert.deepEqual(
      options.map((option) => [option.textContent, option.getAttribute('aria-selected')]),
      [
        ['All9', 'true'],
        ['Triage2', 'false'],
        ['In Review3', 'false'],
      ],
    );
    assert.equal(options[1]?.querySelector<HTMLElement>('.kit-drop')?.style.background, '#e0f2fe');
    assert.deepEqual(said, ['open:true']);
  });

  it('moves with the arrows, chooses with Enter, and gives the focus back to its button', () => {
    const { document, trigger, said, key, list } = build();
    key(trigger, 'ArrowDown');
    assert.ok(document.activeElement === list(), 'an arrow on the button opens the list');
    key(list(), 'ArrowDown');
    key(list(), 'ArrowDown');
    key(list(), 'ArrowDown');
    const active = list()?.getAttribute('aria-activedescendant');
    assert.equal(list()?.querySelector(`#${active}`)?.textContent, 'In Review3', 'the last stays the last');
    key(list(), 'Home');
    key(list(), 'ArrowDown');
    const listbox = list();
    key(listbox, 'Enter');

    assert.deepEqual(said, ['open:true', 'open:false', 'select:name:Triage']);
    assert.equal(list(), null);
    assert.equal(trigger?.getAttribute('aria-expanded'), 'false');
    assert.ok(document.activeElement === trigger);
  });

  it('closes on Escape with nothing chosen, and on a click outside', () => {
    const { document, trigger, said, key, list } = build();
    trigger?.click();
    key(list(), 'Escape');
    assert.equal(list(), null);
    assert.ok(document.activeElement === trigger);

    trigger?.click();
    document.body.dispatchEvent(new document.defaultView!.Event('pointerdown', { bubbles: true }) as unknown as Event);
    assert.equal(list(), null);
    // The focus was in the list: it goes back to the button, not to the body (review of #730).
    assert.ok(document.activeElement === trigger);
    assert.deepEqual(said, ['open:true', 'open:false', 'open:true', 'open:false']);
  });

  it('leaves one click-outside listener when a page draws an open list again, and closes the new one (review of #730)', () => {
    const document = page();
    const listening = new Set<unknown>();
    const add = document.addEventListener.bind(document);
    const remove = document.removeEventListener.bind(document);
    document.addEventListener = ((type: string, listener: unknown, capture?: unknown) => {
      if (type === 'pointerdown') listening.add(listener);
      add(type, listener as EventListener, capture as boolean);
    }) as typeof document.addEventListener;
    document.removeEventListener = ((type: string, listener: unknown, capture?: unknown) => {
      if (type === 'pointerdown') listening.delete(listener);
      remove(type, listener as EventListener, capture as boolean);
    }) as typeof document.removeEventListener;
    const said: string[] = [];
    const draw = () =>
      listSelect(document, {
        label: 'Status',
        trigger: 'Status · All · 2',
        options: [
          { id: '', label: 'All' },
          { id: 'a', label: 'A' },
        ],
        selected: '',
        open: true,
        onOpenChange: (open) => said.push(`open:${open}`),
      });
    document.body.replaceChildren(draw());
    // The panel draws again while the list is open, and puts the focus back on the new list.
    const again = draw();
    document.body.replaceChildren(again);
    again.querySelector<HTMLElement>('[role="listbox"]')?.focus();
    assert.equal(listening.size, 1, 'the list drawn before still listens');

    document.body.dispatchEvent(new document.defaultView!.Event('pointerdown', { bubbles: true }) as unknown as Event);
    assert.equal(again.querySelector('[role="listbox"]'), null);
    assert.ok(document.activeElement === again.querySelector('.kit-select-trigger'));
    assert.deepEqual(said, ['open:false']);
    assert.equal(listening.size, 0);
  });

  it('is drawn open when asked: a page that draws again keeps it open', () => {
    const { trigger, list } = build(true);

    assert.equal(trigger?.getAttribute('aria-expanded'), 'true');
    assert.notEqual(list(), null);
  });

  it('lies over what follows it, in its sheet', () => {
    const sheet = readFileSync(new URL('./kit.css', import.meta.url), 'utf8');
    const rule = /\n\.kit-select-list \{([^}]*)\}/.exec(sheet)?.[1] ?? '';
    assert.match(rule, /position: absolute/);
    assert.match(rule, /z-index: \d+/);
    assert.match(/\n\.kit-select \{([^}]*)\}/.exec(sheet)?.[1] ?? '', /position: relative/);
  });
});
