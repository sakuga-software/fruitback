import { t } from './i18n.ts';
import { keys, toggle } from './kit.ts';
import { keysOfShortcut } from './popup-view.ts';
import { PAIRING_NEEDS_HTTPS } from './remedy.ts';

/**
 * « Workers and sessions » and « Preferences » of the page of the extension (FRU-302), as the mock-up
 * of 2026-10-20 draws them. No `browser` here: `entrypoints/options/main.ts` reads the rules, the
 * sessions and the preferences, and binds what a click does, so `workers-page.test.ts` reads every
 * part on happy-dom.
 */

function make<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className: string,
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== '') node.className = className;
  if (text !== '') node.textContent = text;

  return node;
}

function button(document: Document, className: string, text: string, onClick: () => void): HTMLButtonElement {
  const node = make(document, 'button', className, text);
  node.type = 'button';
  node.addEventListener('click', onClick);

  return node;
}

/** How a worker takes a pairing: over https, on plain http of this machine, or not at all. */
export type Pairing = 'https' | 'local' | 'insecure';

/** A worker a rule names, or the Cloud of an account, with what this browser holds for it. */
export type WorkerCard = {
  endpoint: string;
  host: string;
  /** The rules that name it. */
  sites: number;
  /** The person of the session this browser holds with it. */
  session?: { name?: string; email?: string };
  /** The session is the account of the Cloud (FRU-238), not a pairing. */
  account?: boolean;
  pairing: Pairing;
  /** A code to fill the field with: a pairing link opened from the popup (FRU-92). */
  code?: string;
};

export type WorkersOptions = {
  cards: WorkerCard[];
  /** Pairs with a code. The page asks for the worker's origin in this click, then pairs. */
  onPair: (endpoint: string, code: string, said: HTMLElement, submit: HTMLButtonElement) => void;
  onLogout: (endpoint: string, out: HTMLButtonElement) => void;
};

/** « 1 site », « 3 sites ». */
export function sitesCount(count: number): string {
  return count === 1 ? t('1 site') : t('{count} sites', { count });
}

/** The section « Workers and sessions »: one card for each worker. */
export function workersSection(document: Document, options: WorkersOptions): HTMLElement {
  const section = make(document, 'section', 'page-section');
  section.classList.add('workers');
  section.id = 'workers';
  const title = make(document, 'h2', '', t('Workers and sessions'));
  title.id = 'workers-title';
  section.setAttribute('aria-labelledby', title.id);
  section.append(
    title,
    make(
      document,
      'p',
      'workers-intro',
      t(
        'You pair with a worker, not with a site: one session covers every site that reports to it. Only team mode needs one.',
      ),
    ),
  );
  if (options.cards.length === 0) {
    section.append(make(document, 'p', 'state', t('No worker yet. A rule names one.')));

    return section;
  }
  const grid = make(document, 'div', 'workers-grid');
  for (const card of options.cards) grid.append(workerCard(document, card, options));
  section.append(grid);

  return section;
}

/**
 * Draws « Workers and sessions » in `container`, unless the cards are those already drawn (raised in
 * review). The tokens of a session turn at each refresh, and each turn is a change of the storage:
 * drawn again for it, a card would lose the code somebody is typing and what its line says. When the
 * cards did change (a session made or ended elsewhere), a code typed in a card that is still unpaired
 * is put back, with the focus. A card whose pairing or log out is in progress is not drawn again
 * (`data-pending` says a draw waits): its caller turns its button back on, then draws. Answers whether
 * it drew.
 */
export function redrawWorkers(document: Document, container: HTMLElement, options: WorkersOptions): boolean {
  const key = JSON.stringify(options.cards);
  if (container.dataset.cards === key) return false;
  // A pairing or a log out in progress has its button off: drawn again, the card would turn it back
  // on, and a second click would spend the same code twice (raised in review). Drawn when it ends.
  if (container.querySelector('button:disabled') !== null) {
    container.dataset.pending = 'true';

    return false;
  }
  delete container.dataset.pending;
  const typed = new Map<string, string>();
  for (const input of container.querySelectorAll<HTMLInputElement>('input.worker-code')) {
    const endpoint = input.closest<HTMLElement>('.worker-card')?.dataset.endpoint;
    if (endpoint !== undefined && input.value !== '') typed.set(endpoint, input.value);
  }
  // No global `HTMLInputElement` here: the page may be another window's (the tests, on happy-dom).
  const active = document.activeElement;
  const hadFocus = active !== null && active.matches('input.worker-code') && container.contains(active);
  const focused = active?.closest<HTMLElement>('.worker-card')?.dataset.endpoint;
  container.replaceChildren(workersSection(document, options));
  container.dataset.cards = key;
  for (const card of container.querySelectorAll<HTMLElement>('.worker-card')) {
    const input = card.querySelector<HTMLInputElement>('input.worker-code');
    const value = card.dataset.endpoint === undefined ? undefined : typed.get(card.dataset.endpoint);
    if (input === null || value === undefined) continue;
    input.value = value;
    if (hadFocus && focused === card.dataset.endpoint) input.focus();
  }

  return true;
}

/** One worker: its host and its sites, then its session, or the way to pair. */
export function workerCard(document: Document, card: WorkerCard, options: WorkersOptions): HTMLElement {
  const root = make(document, 'article', 'worker-card');
  root.dataset.endpoint = card.endpoint;
  const head = make(document, 'div', 'worker-head');
  const dot = make(document, 'span', 'worker-dot');
  dot.dataset.on = String(card.session !== undefined);
  dot.setAttribute('aria-hidden', 'true');
  const host = make(document, 'span', 'worker-host', card.host);
  host.id = `worker-${card.host.replace(/[^a-z0-9]/gi, '-')}`;
  root.setAttribute('aria-labelledby', host.id);
  head.append(dot, host, make(document, 'span', 'worker-sites', sitesCount(card.sites)));
  root.append(head);

  if (card.session !== undefined) {
    root.append(...sessionLines(document, card));
    const out = button(document, 'worker-button', t('Log out'), () => options.onLogout(card.endpoint, out));
    root.append(out);

    return root;
  }

  if (card.pairing === 'insecure') {
    root.append(make(document, 'p', 'worker-text', t(PAIRING_NEEDS_HTTPS)));

    return root;
  }
  root.append(
    make(
      document,
      'p',
      'worker-text',
      t('Not paired. Private-mode sites read without a session; a team site would stay asleep.'),
    ),
  );
  const form = make(document, 'form', 'worker-pair');
  const input = make(document, 'input', 'worker-code');
  input.type = 'text';
  input.placeholder = 'ABCD-EFGH-JKMN';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', t('Pairing code'));
  if (card.code !== undefined) input.value = card.code;
  const submit = make(document, 'button', 'worker-pair-button', t('Pair'));
  submit.type = 'submit';
  const said = make(document, 'p', 'worker-said');
  said.setAttribute('role', 'status');
  form.append(input, submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    options.onPair(card.endpoint, input.value, said, submit);
  });
  root.append(form, said);
  if (card.pairing === 'local') {
    root.append(
      make(
        document,
        'p',
        'worker-hint',
        t('Plain http on localhost. Pairing works here; anywhere else a session must not cross http.'),
      ),
    );
  }

  return root;
}

/**
 * Who the session is (FRU-289): « Paired as Camille Durand ». With no name, « Paired » alone and the
 * e-mail on the line under it, so the identity stays readable.
 */
function sessionLines(document: Document, card: WorkerCard): HTMLElement[] {
  const session = card.session ?? {};
  const name = session.name?.trim();
  const line = make(document, 'p', 'worker-who');
  if (name !== undefined && name !== '') {
    const [before, after] = (card.account === true ? t('Signed in as {name}') : t('Paired as {name}')).split('{name}');
    line.append(before ?? '', make(document, 'strong', '', name), after ?? '');
  } else {
    line.textContent = card.account === true ? t('Signed in') : t('Paired');
  }
  const lines = [line];
  if ((name === undefined || name === '') && session.email !== undefined) {
    lines.push(make(document, 'p', 'worker-hint', session.email));
  }
  lines.push(
    make(
      document,
      'p',
      'worker-hint',
      card.account === true
        ? t('One account for the console and this extension')
        : t('Verified by the worker · renews on its own'),
    ),
  );

  return lines;
}

export type PreferencesOptions = {
  /** `undefined`: the browser has no panel to open from the icon (Firefox), and the row is not drawn. */
  panelOnClick?: boolean;
  onPanelOnClick: (on: boolean) => void;
  name: string;
  onName: (name: string) => void;
  /** The keys of « Leave feedback », as the browser has them: `Alt+Shift+F`. None: not set. */
  shortcut?: string;
  /** Opens the shortcut settings of the browser. None: the row says where to look. */
  onShortcut?: () => void;
  synced: boolean;
  onSynced: (on: boolean) => void;
};

/** The longest name, as the widget keeps it (`REPORTER_NAME_MAX`). */
export const NAME_MAX = 120;

/** One row: its title and its help, then its control. */
function row(document: Document, title: string, help: string, control: HTMLElement): HTMLElement {
  const root = make(document, 'div', 'pref-row');
  const words = make(document, 'div', 'pref-words');
  const label = make(document, 'span', 'pref-title', title);
  label.id = `pref-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  words.append(label, make(document, 'span', 'pref-help', help));
  root.append(words, control);

  return root;
}

/** The keys of a shortcut, as the kit draws them: the same as « Leave feedback » of the popup (FRU-298). */
export const shortcutKeys = keysOfShortcut;

/** The section « Preferences ». */
export function preferencesSection(document: Document, options: PreferencesOptions): HTMLElement {
  const section = make(document, 'section', 'page-section');
  section.classList.add('prefs');
  section.id = 'prefs';
  const title = make(document, 'h2', '', t('Preferences'));
  title.id = 'prefs-title';
  section.setAttribute('aria-labelledby', title.id);
  const card = make(document, 'div', 'pref-card');

  if (options.panelOnClick !== undefined) {
    card.append(
      row(
        document,
        t('Open notes in the sidebar'),
        t('Instead of floating pins only, on every site you review.'),
        toggle(document, {
          checked: options.panelOnClick,
          label: t('Open notes in the sidebar'),
          size: 'preference',
          onChange: options.onPanelOnClick,
        }),
      ),
    );
  }

  const name = make(document, 'input', 'pref-name');
  name.type = 'text';
  name.maxLength = NAME_MAX;
  name.value = options.name;
  name.autocomplete = 'name';
  name.setAttribute('aria-label', t('Name on my notes'));
  name.addEventListener('change', () => options.onName(name.value.trim()));
  card.append(
    row(document, t('Name on my notes'), t('Prefilled in private mode. Team mode signs with your session.'), name),
  );

  const shortcut = make(document, 'div', 'pref-shortcut');
  shortcut.append(
    options.shortcut === undefined
      ? make(document, 'span', 'pref-help', t('Not set'))
      : keys(document, shortcutKeys(options.shortcut)),
  );
  if (options.onShortcut !== undefined) {
    shortcut.append(button(document, 'pref-link', t('Change'), options.onShortcut));
  }
  card.append(
    row(
      document,
      t('Leave feedback shortcut'),
      options.onShortcut === undefined
        ? t('Change it in Add-ons, Manage Extension Shortcuts.')
        : t("Set in your browser's extension shortcuts."),
      shortcut,
    ),
  );

  card.append(
    row(
      document,
      t('Keep my rules in the account of this browser'),
      t(
        'When this is on, your rules (patterns, modes, endpoints, client ids, and the labels and workspace names they hold) are kept by the account of this browser, and reach your other browsers where it is on too. No session and no access travel: on another browser, grant access to each site. Turning it off stops the copy, and removes nothing from the account.',
      ),
      toggle(document, {
        checked: options.synced,
        label: t('Keep my rules in the account of this browser'),
        size: 'preference',
        onChange: options.onSynced,
      }),
    ),
  );
  section.append(title, card);

  return section;
}
