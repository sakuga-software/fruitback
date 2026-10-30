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
export type Stage = 'new' | 'todo' | 'progress' | 'done' | 'closed';

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
  /**
   * The colour of a status that a team chose, and its text (FRU-370), in place of the stage's. Both
   * `#rrggbb`, checked by `parsePanelNotes`. The edge of the drop stays.
   */
  paint?: { fill: string; ink: string };
};

/** The drop of a status: the pin of the widget, in a list or as a mark. A screen reader skips it. */
export function statusDrop(document: Document, options: DropOptions): HTMLElement {
  const drop = make(document, 'span', 'kit-drop');
  drop.dataset.stage = options.stage;
  drop.setAttribute('aria-hidden', 'true');
  if (options.paint !== undefined) {
    drop.style.background = options.paint.fill;
    drop.style.setProperty('--drop-on', options.paint.ink);
  }
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
  // A `div` of a `dl` holds `dt` and `dd` only (axe `dlitem`, `definition-list`): the action is in a
  // `dd` of its own, which the grid of the entry puts on the right of the term and its value.
  for (const { term, value, action } of entries) {
    const group = make(document, 'div', 'kit-dl-entry');
    group.append(make(document, 'dt', '', term), make(document, 'dd', '', value));
    if (action !== undefined) {
      const holder = make(document, 'dd', 'kit-dl-action');
      holder.append(action);
      group.append(holder);
    }
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

/** The keys that open the list from its button. */
const OPENS = { ArrowDown: true, ArrowUp: true };

/** What a key does in the open list, beside the moves. */
const LIST_KEYS: Record<string, 'choose' | 'close' | 'leave'> = {
  Enter: 'choose',
  ' ': 'choose',
  Escape: 'close',
  Tab: 'leave',
};

/**
 * The click-outside listener of the open list of each `listSelect`, by document and id. A page that
 * draws again builds a new list while the old one is still open: the new one takes the old
 * listener off at once, so one listener per list is on the document (review of #730).
 */
const OPEN_LISTS = new WeakMap<Document, Map<string, () => void>>();

export type ListSelectOption = {
  id: string;
  label: string;
  /** The number of notes of this option, after its name. */
  count?: number;
  /** The drop before the name: a status of a team wears its colour (FRU-370). */
  drop?: DropOptions;
};

export type ListSelectOptions = {
  /** The name of the list, and of its button with the choice: « Status ». */
  label: string;
  /** What the button says: « Status · In review · 3 ». */
  trigger: string;
  options: ListSelectOption[];
  selected: string;
  /** Drawn open: a page that draws again keeps the list open (`onOpenChange`). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * The option the keyboard is on, by its id, while the list is open: a page that draws again puts
   * it back (`onActiveChange`). Absent: the option selected.
   */
  active?: string;
  onActiveChange?: (id: string) => void;
  onSelect?: (id: string) => void;
};

/**
 * A list to choose one option from, drawn over what follows it (FRU-535): a button, and a `listbox`
 * under it, never a native `select`. The keyboard of a list box: the arrows, Home and End move,
 * Enter and Space choose, Escape and Tab close; the focus goes back to the button when it closes. A
 * click outside closes it. Its place over the content is `kit.css`'s.
 */
export function listSelect(document: Document, options: ListSelectOptions): HTMLElement {
  const root = make(document, 'div', 'kit-select');
  const id = `kit-select-${options.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const trigger = button(document, 'kit-select-trigger');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-controls', `${id}-list`);
  const chosen = options.options.find((option) => option.id === options.selected);
  if (chosen?.drop !== undefined) trigger.append(statusDrop(document, chosen.drop));
  trigger.append(make(document, 'span', 'kit-select-words', options.trigger));
  const caret = make(document, 'span', 'kit-select-caret', '▾');
  caret.setAttribute('aria-hidden', 'true');
  trigger.append(caret);

  const list = make(document, 'ul', 'kit-select-list');
  list.id = `${id}-list`;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', options.label);
  list.tabIndex = -1;
  const items = options.options.map((option, index) => {
    const item = make(document, 'li', 'kit-select-option');
    item.id = `${id}-${index}`;
    item.dataset.option = option.id;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(option.id === options.selected));
    if (option.drop !== undefined) item.append(statusDrop(document, option.drop));
    item.append(make(document, 'span', 'kit-select-name', option.label));
    if (option.count !== undefined) item.append(make(document, 'span', 'kit-select-count', String(option.count)));
    item.addEventListener('click', () => choose(index));
    // The pointer must not take the focus off the list before the click chooses.
    item.addEventListener('mousedown', (event) => event.preventDefault());
    list.append(item);

    return item;
  });

  const at = (id: string | undefined): number => items.findIndex((item) => item.dataset.option === id);
  // A list drawn open again starts on the option the keyboard was on, not on the one selected.
  let active = Math.max(
    0,
    options.open === true && at(options.active) !== -1 ? at(options.active) : at(options.selected),
  );
  const mark = (index: number): void => {
    const before = active;
    active = Math.min(Math.max(index, 0), items.length - 1);
    for (const [at, item] of items.entries()) item.dataset.active = String(at === active);
    const item = items[active];
    if (item !== undefined) {
      list.setAttribute('aria-activedescendant', item.id);
      item.scrollIntoView?.({ block: 'nearest' });
      if (active !== before) options.onActiveChange?.(item.dataset.option ?? '');
    }
  };
  const lists = OPEN_LISTS.get(document) ?? new Map<string, () => void>();
  OPEN_LISTS.set(document, lists);
  const unlisten = (): void => {
    document.removeEventListener('pointerdown', outside, true);
    if (lists.get(id) === unlisten) lists.delete(id);
  };
  function outside(event: Event): void {
    if (!root.isConnected) {
      unlisten();

      return;
    }
    // Read before anything closes: the focus in the list goes back to the button; a click on a
    // field takes it from there. `contains`, not `instanceof Node`: happy-dom has no global `Node`.
    const hadFocus = root.contains(document.activeElement);
    if (!root.contains(event.target as Node | null)) close(hadFocus);
  }
  const show = (focus: boolean): void => {
    root.dataset.open = 'true';
    trigger.setAttribute('aria-expanded', 'true');
    if (!list.isConnected) root.append(list);
    mark(active);
    // The list this one replaces, drawn open before, stops listening now.
    const before = lists.get(id);
    if (before !== undefined && before !== unlisten) before();
    lists.set(id, unlisten);
    document.addEventListener('pointerdown', outside, true);
    if (focus) list.focus();
  };
  const close = (focus: boolean): void => {
    unlisten();
    if (root.dataset.open !== 'true') return;
    root.dataset.open = 'false';
    trigger.setAttribute('aria-expanded', 'false');
    list.remove();
    if (focus) trigger.focus();
    options.onOpenChange?.(false);
  };
  function choose(index: number): void {
    const option = options.options[index];
    close(true);
    if (option !== undefined) options.onSelect?.(option.id);
  }

  trigger.addEventListener('click', () => {
    if (root.dataset.open === 'true') close(true);
    else {
      show(true);
      options.onOpenChange?.(true);
    }
  });
  trigger.addEventListener('keydown', (event) => {
    if (!(event.key in OPENS)) return;
    event.preventDefault();
    show(true);
    options.onOpenChange?.(true);
  });
  list.addEventListener('keydown', (event) => {
    const moves: Record<string, number> = {
      ArrowDown: active + 1,
      ArrowUp: active - 1,
      Home: 0,
      End: items.length - 1,
    };
    const to = moves[event.key];
    const does = LIST_KEYS[event.key];
    if (to !== undefined) {
      event.preventDefault();
      mark(to);
    } else if (does === 'choose') {
      event.preventDefault();
      choose(active);
    } else if (does === 'close') {
      event.preventDefault();
      close(true);
    } else if (does === 'leave') {
      // Back on the button first: the Tab then goes on from it, not from the body of the page.
      close(true);
    }
  });

  root.dataset.open = 'false';
  trigger.setAttribute('aria-expanded', 'false');
  root.append(trigger);
  if (options.open === true) show(false);

  return root;
}

/** The two providers of sign-in the console offers. */
export type SignInProvider = 'google' | 'github';

/**
 * The marks of the providers of sign-in (FRU-525), the paths of the console's `provider-icons.tsx`:
 * - Google: the « G » of Google's sign-in branding guidelines
 *   (developers.google.com/identity/branding-guidelines), in its four colours. The guidelines forbid
 *   a change of these colours, so they stay the same in the dark scheme too. They are attributes of
 *   the paths, as `icons.md` says: no rule of a sheet paints them.
 * - GitHub: the mark of GitHub's logo guidelines (github.com/logos), the `mark-github` of Octicons
 *   (MIT), in one colour: `currentColor`, the colour of the word beside it, in both schemes.
 */
const GOOGLE_MARK: [fill: string, d: string][] = [
  [
    '#EA4335',
    'M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z',
  ],
  [
    '#4285F4',
    'M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z',
  ],
  [
    '#FBBC05',
    'M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z',
  ],
  [
    '#34A853',
    'M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z',
  ],
];

/** The GitHub mark, in a box of 16. */
export const GITHUB_MARK =
  'M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z';

/** The mark of a provider of sign-in, which a screen reader skips: the word beside it names it. */
export function providerMark(document: Document, provider: SignInProvider): SVGSVGElement {
  const drawing = document.createElementNS(SVG, 'svg');
  drawing.setAttribute('viewBox', provider === 'google' ? '0 0 48 48' : '0 0 16 16');
  drawing.setAttribute('aria-hidden', 'true');
  drawing.setAttribute('focusable', 'false');
  drawing.setAttribute('class', 'kit-provider-mark');
  drawing.dataset.provider = provider;
  const paths: [string, string][] = provider === 'google' ? GOOGLE_MARK : [['currentColor', GITHUB_MARK]];
  for (const [fill, d] of paths) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('fill', fill);
    path.setAttribute('d', d);
    drawing.append(path);
  }

  return drawing;
}

/**
 * « Google », « GitHub » (FRU-525): a second action with the mark of its provider before the word.
 * The name of the button is the word alone. The popup and the page of the extension both draw it.
 */
export function providerButton(document: Document, provider: SignInProvider, onClick?: () => void): HTMLButtonElement {
  const node = secondaryButton(document, provider === 'google' ? 'Google' : 'GitHub', onClick);
  node.prepend(providerMark(document, provider));

  return node;
}
