import { t } from './i18n.ts';

/**
 * The kit of the extension (FRU-293): the parts that the popup, the side panel and the page of the
 * extension share, as the mock-up of 2026-10-20 draws them. Each part is a function that builds DOM
 * and binds nothing of `browser`, so `kit.test.ts` reads each one on happy-dom. Their look is in
 * `kit.css`, on the tokens of `entrypoints/popup/style.css`.
 *
 * Every control is a native `button`: Space and Enter press it, and it takes the focus ring of the
 * page. Every target is 44 px or more, except the switch of a table, which sits in a row of 44 px.
 */

const SVG = 'http://www.w3.org/2000/svg';

/** The drop of the mark, in a box of 24: the path of the mock-up. */
const DROP = 'M12 19.9 L7.05 14.95 A7 7 0 1 1 16.95 14.95 Z';

/** The five stages of a note, the names of the contract. */
export type Stage = 'seeded' | 'green' | 'ripening' | 'ripe' | 'composted';

function make<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className: string,
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== '') node.textContent = text;

  return node;
}

function button(document: Document, className: string, onClick?: () => void): HTMLButtonElement {
  const node = make(document, 'button', className);
  node.type = 'button';
  if (onClick !== undefined) node.addEventListener('click', onClick);

  return node;
}

/** The drop of the mark, as a drawing a screen reader skips. Its colour is the `color` of its parent. */
export function dropMark(document: Document, className = 'kit-mark'): SVGSVGElement {
  const drawing = document.createElementNS(SVG, 'svg');
  drawing.setAttribute('viewBox', '0 0 24 24');
  drawing.setAttribute('aria-hidden', 'true');
  drawing.setAttribute('class', className);
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', DROP);
  path.setAttribute('fill', 'currentColor');
  drawing.append(path);

  return drawing;
}

/** The first letter a person reads of a name: a letter or a digit, upper case; « ? » when there is none. */
export function initialOf(name: string): string {
  const letter = [...name.trim()].find((character) => /[\p{L}\p{N}]/u.test(character));

  return letter === undefined ? '?' : letter.toLocaleUpperCase();
}

export type HeadOptions = {
  /** The person signed in: the button shows the initial. Nobody: it shows the gear. */
  account?: { name: string };
  /** What the button of the account opens. Without it, the head has no button. */
  onAccount?: () => void;
};

/** The gear, in a box of 24: what the button of the account shows when nobody is signed in. */
const GEAR =
  'M19.62 10.33 L22.10 10.60 L22.10 13.40 L19.62 13.67 L18.57 16.21 L20.13 18.16 L18.16 20.13 L16.21 18.57 L13.67 19.62 L13.40 22.10 L10.60 22.10 L10.33 19.62 L7.79 18.57 L5.84 20.13 L3.87 18.16 L5.43 16.21 L4.38 13.67 L1.90 13.40 L1.90 10.60 L4.38 10.33 L5.43 7.79 L3.87 5.84 L5.84 3.87 L7.79 5.43 L10.33 4.38 L10.60 1.90 L13.40 1.90 L13.67 4.38 L16.21 5.43 L18.16 3.87 L20.13 5.84 L18.57 7.79 Z M15.10 12 A3.1 3.1 0 1 0 8.90 12 A3.1 3.1 0 1 0 15.10 12 Z';

/** The head of a shell: 52 px, the drop and « Fruitback », and the button of the account. */
export function head(document: Document, options: HeadOptions = {}): HTMLElement {
  const root = make(document, 'div', 'kit-head');
  root.append(dropMark(document), make(document, 'span', 'kit-brand', 'Fruitback'));
  if (options.onAccount !== undefined) {
    const avatar = button(document, 'kit-avatar', options.onAccount);
    avatar.setAttribute('aria-label', t('Account and settings'));
    const dot = make(document, 'span', 'kit-avatar-dot');
    dot.setAttribute('aria-hidden', 'true');
    if (options.account === undefined) {
      const gear = document.createElementNS(SVG, 'svg');
      gear.setAttribute('viewBox', '0 0 24 24');
      gear.setAttribute('class', 'kit-gear');
      const path = document.createElementNS(SVG, 'path');
      path.setAttribute('d', GEAR);
      path.setAttribute('fill-rule', 'evenodd');
      path.setAttribute('fill', 'currentColor');
      gear.append(path);
      dot.append(gear);
    } else {
      dot.textContent = initialOf(options.account.name);
    }
    avatar.append(dot);
    root.append(avatar);
  }

  return root;
}

export type PrimaryOptions = {
  /** `default` 46 px; `tall` 56 px with the drop, the action of a site; `panel` 48 px. */
  size?: 'default' | 'tall' | 'panel';
  type?: 'button' | 'submit';
};

/** The one thing a screen is for, in the accent. */
export function primaryButton(
  document: Document,
  label: string,
  onClick?: () => void,
  options: PrimaryOptions = {},
): HTMLButtonElement {
  const node = button(document, 'kit-primary', onClick);
  if (options.type !== undefined) node.type = options.type;
  const size = options.size ?? 'default';
  node.dataset.size = size;
  if (size === 'tall') node.append(dropMark(document));
  node.append(document.createTextNode(label));

  return node;
}

/** A second action, on the surface with a border: 44 px. */
export function secondaryButton(document: Document, label: string, onClick?: () => void): HTMLButtonElement {
  const node = button(document, 'kit-secondary', onClick);
  node.textContent = label;

  return node;
}

/** « Change »: a word in the accent, in a target of 44 px. */
export function textButton(document: Document, label: string, onClick?: () => void): HTMLButtonElement {
  const node = button(document, 'kit-text', onClick);
  node.textContent = label;

  return node;
}

export type ToggleOptions = {
  checked: boolean;
  /** The accessible name: what the switch turns on. */
  label: string;
  /** `default` 44 × 26; `table` 36 × 22; `preference` 40 × 24. */
  size?: 'default' | 'table' | 'preference';
  /** The visible word beside it, « On », when the mock-up shows one. */
  word?: string;
  /** Called with the new state, after the switch shows it. */
  onChange?: (checked: boolean) => void;
};

/** A switch: a button with `role="switch"`. A press flips it, then says so. */
export function toggle(document: Document, options: ToggleOptions): HTMLElement {
  const node = button(document, 'kit-switch');
  node.setAttribute('role', 'switch');
  node.setAttribute('aria-checked', String(options.checked));
  node.setAttribute('aria-label', options.label);
  node.dataset.size = options.size ?? 'default';
  node.append(make(document, 'span', 'kit-knob'));
  node.addEventListener('click', () => {
    const next = node.getAttribute('aria-checked') !== 'true';
    node.setAttribute('aria-checked', String(next));
    options.onChange?.(next);
  });
  if (options.word === undefined) return node;

  const wrapper = make(document, 'span', 'kit-switch-field');
  const word = make(document, 'span', 'kit-switch-word', options.word);
  word.setAttribute('aria-hidden', 'true');
  wrapper.append(word, node);

  return wrapper;
}

/** The tile of a site: its initial, 40 px. A site that is on is green, an unknown one grey. */
export function siteTile(document: Document, name: string, on: boolean): HTMLElement {
  const tile = make(document, 'span', 'kit-tile', initialOf(name));
  tile.dataset.on = String(on);
  tile.setAttribute('aria-hidden', 'true');

  return tile;
}

export type SiteLineOptions = { host: string; state: string; on: boolean; paused?: boolean };

/** A site as a screen names it: the tile, the host, and the line of its state. */
export function siteLine(document: Document, options: SiteLineOptions): HTMLElement {
  const root = make(document, 'div', 'kit-site');
  const words = make(document, 'span', 'kit-site-words');
  const state = make(document, 'span', 'kit-site-state', options.state);
  if (options.paused === true) state.dataset.paused = 'true';
  words.append(make(document, 'span', 'kit-site-host', options.host), state);
  root.append(siteTile(document, options.host, options.on), words);

  return root;
}

export type DropOptions = {
  stage: Stage;
  /** The number of the note. None: a mark of 12 px. */
  number?: number;
  /** With a number: 24 px in a list, 28 px on a page. */
  size?: 'list' | 'page';
};

/** The drop of a status: the pin of the widget, in a list or as a mark. A screen reader skips it. */
export function statusDrop(document: Document, options: DropOptions): HTMLElement {
  const drop = make(document, 'span', 'kit-drop');
  drop.dataset.stage = options.stage;
  drop.setAttribute('aria-hidden', 'true');
  if (options.number === undefined) {
    drop.dataset.size = 'mark';
  } else {
    drop.dataset.size = options.size ?? 'list';
    drop.append(make(document, 'span', 'kit-drop-number', String(options.number)));
  }

  return drop;
}

export type RowOptions = { title: string; subtitle?: string; stage?: Stage; onClick?: () => void };

/** A row of a list that leads somewhere: the drop, the title and its line, the chevron. */
export function listRow(document: Document, options: RowOptions): HTMLButtonElement {
  const row = button(document, 'kit-row', options.onClick);
  if (options.stage !== undefined) row.append(statusDrop(document, { stage: options.stage }));
  const words = make(document, 'span', 'kit-row-words');
  words.append(make(document, 'span', 'kit-row-title', options.title));
  if (options.subtitle !== undefined) words.append(make(document, 'span', 'kit-row-subtitle', options.subtitle));
  const chevron = make(document, 'span', 'kit-chevron', '›');
  chevron.setAttribute('aria-hidden', 'true');
  row.append(words, chevron);

  return row;
}

export type Definition = { term: string; value: string; action?: HTMLElement };

/** Terms and their values: « Notes go to » / « Linear · Northwind », with « Change » beside it. */
export function definitions(document: Document, entries: Definition[]): HTMLDListElement {
  const list = make(document, 'dl', 'kit-dl');
  for (const { term, value, action } of entries) {
    const group = make(document, 'div', 'kit-dl-entry');
    const words = make(document, 'div', 'kit-dl-words');
    words.append(make(document, 'dt', '', term), make(document, 'dd', '', value));
    group.append(words);
    if (action !== undefined) group.append(action);
    list.append(group);
  }

  return list;
}

/** A problem and what it means: the title in the alert colour with its circle, then the words. */
export function alertBox(document: Document, title: string, body: string): HTMLElement {
  const root = make(document, 'div', 'kit-alert');
  root.setAttribute('role', 'alert');
  const heading = make(document, 'span', 'kit-alert-title');
  const circle = document.createElementNS(SVG, 'svg');
  circle.setAttribute('viewBox', '0 0 24 24');
  circle.setAttribute('aria-hidden', 'true');
  circle.setAttribute('class', 'kit-alert-icon');
  const ring = document.createElementNS(SVG, 'circle');
  for (const [name, value] of [
    ['cx', '12'],
    ['cy', '12'],
    ['r', '9'],
  ] as const) {
    ring.setAttribute(name, value);
  }
  const mark = document.createElementNS(SVG, 'path');
  mark.setAttribute('d', 'M12 7.5v5.5M12 16.5v.01');
  circle.append(ring, mark);
  heading.append(circle, document.createTextNode(title));
  root.append(heading, make(document, 'span', 'kit-alert-body', body));

  return root;
}

/** The keys of a shortcut, each in its `kbd`: « Alt Shift F ». */
export function keys(document: Document, names: string[]): HTMLElement {
  const root = make(document, 'span', 'kit-keys');
  for (const [index, name] of names.entries()) {
    if (index > 0) root.append(document.createTextNode(' '));
    root.append(make(document, 'kbd', 'kit-kbd', name));
  }

  return root;
}

export type TabsOptions = {
  /** The name of the list of tabs. */
  label: string;
  tabs: { id: string; label: string }[];
  selected: string;
  /** `panel` 40 px; `page` 28 px. */
  size?: 'panel' | 'page';
  onSelect?: (id: string) => void;
};

/**
 * Segmented tabs: a rail, one tab chosen. The keyboard of a tab list: the chosen tab is the one
 * stop of Tab, the arrows, Home and End move and choose.
 */
export function segmentedTabs(document: Document, options: TabsOptions): HTMLElement {
  const rail = make(document, 'div', 'kit-tabs');
  rail.setAttribute('role', 'tablist');
  rail.setAttribute('aria-label', options.label);
  rail.dataset.size = options.size ?? 'panel';
  const tabs = options.tabs.map(({ id, label }) => {
    const tab = button(document, 'kit-tab');
    tab.setAttribute('role', 'tab');
    tab.dataset.tab = id;
    tab.textContent = label;

    return tab;
  });
  const choose = (id: string, focus: boolean): void => {
    for (const tab of tabs) {
      const chosen = tab.dataset.tab === id;
      tab.setAttribute('aria-selected', String(chosen));
      tab.tabIndex = chosen ? 0 : -1;
      if (chosen && focus) tab.focus();
    }
    options.onSelect?.(id);
  };
  for (const [index, tab] of tabs.entries()) {
    const chosen = tab.dataset.tab === options.selected;
    tab.setAttribute('aria-selected', String(chosen));
    tab.tabIndex = chosen ? 0 : -1;
    tab.addEventListener('click', () => choose(tab.dataset.tab ?? '', false));
    tab.addEventListener('keydown', (event) => {
      const last = tabs.length - 1;
      const to = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: last }[event.key];
      if (to === undefined) return;
      event.preventDefault();
      const next = tabs[(to + tabs.length) % tabs.length];
      if (next !== undefined) choose(next.dataset.tab ?? '', true);
    });
    rail.append(tab);
  }

  return rail;
}
