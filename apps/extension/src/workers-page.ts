import type { DockPosition } from '@fruitback/widget';
import { msg, t } from './i18n.ts';
import { button, keys, make, toggle } from './kit.ts';
import { keysOfShortcut } from './popup-view.ts';
import { parseDockPosition } from './protocol.ts';
import { PAIRING_NEEDS_HTTPS } from './remedy.ts';

/**
 * « Servers and sessions » and « Preferences » of the page of the extension (FRU-302), as the mock-up
 * of 2026-10-20 draws them. No `browser` here: `entrypoints/options/main.ts` reads the rules, the
 * sessions and the preferences, and binds what a click does, so `workers-page.test.ts` reads every
 * part on happy-dom.
 */

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

/** The section « Servers and sessions »: one card for each worker. */
export function workersSection(document: Document, options: WorkersOptions): HTMLElement {
  const section = make(document, 'section', 'page-section');
  section.classList.add('workers');
  section.id = 'workers';
  const title = make(document, 'h2', '', t('Servers and sessions'));
  title.id = 'workers-title';
  section.setAttribute('aria-labelledby', title.id);
  section.append(
    title,
    make(
      document,
      'p',
      'workers-intro',
      t(
        'You connect to a server, not to a site: one session covers every site that reports to it. Only team mode needs one.',
      ),
    ),
  );
  if (options.cards.length === 0) {
    section.append(make(document, 'p', 'state', t('No server yet. A rule names one.')));

    return section;
  }
  const grid = make(document, 'div', 'workers-grid');
  for (const card of options.cards) grid.append(workerCard(document, card, options));
  section.append(grid);

  return section;
}

/**
 * Draws « Servers and sessions » in `container`, unless the cards are those already drawn (raised in
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
    const out = button(document, 'worker-button', t('Sign out'), () => options.onLogout(card.endpoint, out));
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
      t('Not connected. Private-mode sites read without a session; a team site would show nothing.'),
    ),
  );
  const form = make(document, 'form', 'worker-pair');
  const input = make(document, 'input', 'worker-code');
  input.type = 'text';
  input.placeholder = 'ABCD-EFGH-JKMN';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', t('Connection code'));
  if (card.code !== undefined) input.value = card.code;
  const submit = make(document, 'button', 'worker-pair-button', t('Connect'));
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
        t('Plain http on localhost. Connecting works here; anywhere else a session must not cross http.'),
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
    const [before, after] = (card.account === true ? t('Signed in as {name}') : t('Connected as {name}')).split(
      '{name}',
    );
    line.append(before ?? '', make(document, 'strong', '', name), after ?? '');
  } else {
    line.textContent = card.account === true ? t('Signed in') : t('Connected');
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
        : t('Verified by the server · renews on its own'),
    ),
  );

  return lines;
}

export type PreferencesOptions = {
  /** `undefined`: the browser has no panel to open from the icon (Firefox), and the row is not drawn. */
  panelOnClick?: boolean;
  /** Each change is a write: a write that fails puts the control back, and says so (review). */
  onPanelOnClick: (on: boolean) => Promise<void> | void;
  name: string;
  onName: (name: string) => Promise<void> | void;
  /** The keys of « Leave a note », as the browser has them: `Alt+Shift+F`. None: not set. */
  shortcut?: string;
  /** Opens the shortcut settings of the browser. None: the row says where to look. */
  onShortcut?: () => void;
  /**
   * Where to look when there is no `onShortcut`: Firefox's words by default, Safari's on Safari
   * (FRU-380), which has no page of shortcuts an extension may open.
   */
  shortcutPlace?: 'firefox' | 'safari';
  /**
   * « Keep my rules in the account of this browser ». None: the row is not drawn. Safari keeps
   * `storage.sync` on the Mac and syncs nothing (FRU-380), so the row would promise a copy that never
   * reaches another browser.
   */
  synced?: boolean;
  onSynced: (on: boolean) => Promise<void> | void;
  /** « Show CSS selectors » (FRU-349). Off by default. */
  selectors: boolean;
  onSelectors: (on: boolean) => Promise<void> | void;
  /** « Corner of the widget » (FRU-443): the corner of the dock on every site. */
  dockPosition: DockPosition;
  onDockPosition: (position: DockPosition) => Promise<void> | void;
  /** « Allow captures on every site » (FRU-425): whether `<all_urls>` is held now. */
  capturesEverywhere: boolean;
  /**
   * The words of the prompt of this browser, quoted by the row. None: the row quotes nothing
   * (Safari, FRU-380: its prompt was not read, so no words are put in its mouth).
   */
  captureWarning?: string;
  /**
   * Asks for `<all_urls>`, or gives it back. Called in the click, before anything is awaited.
   * Answers whether it is held after: a refused prompt puts the switch back, with no error.
   */
  onCapturesEverywhere: (on: boolean) => Promise<boolean>;
};

/** Where the row of the shortcut says the key is changed. */
function shortcutHelp(options: Pick<PreferencesOptions, 'onShortcut' | 'shortcutPlace'>): string {
  if (options.onShortcut !== undefined) return t("Set in your browser's extension shortcuts.");
  if (options.shortcutPlace === 'safari') return t('Change it in Safari Settings, Extensions.');

  return t('Change it in Add-ons, Manage Extension Shortcuts.');
}

/** What a preference whose write failed says: the control is back where it was. */
export const PREFERENCE_NOT_SAVED = msg('This preference could not be saved. Try again.');

/** The four corners, in the order of the widget, by the words the select shows. */
const CORNER_WORDS: readonly (readonly [DockPosition, string])[] = [
  ['bottom-right', msg('Bottom right')],
  ['bottom-left', msg('Bottom left')],
  ['top-right', msg('Top right')],
  ['top-left', msg('Top left')],
];

/** The corner by default, as the widget has it. */
export const DEFAULT_DOCK_POSITION: DockPosition = 'bottom-right';

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

/** The keys of a shortcut, as the kit draws them: the same as « Leave a note » of the popup (FRU-298). */
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
  const problem = make(document, 'p', 'pref-problem');
  problem.setAttribute('role', 'status');
  /** Writes, and puts the control back when the write fails: the page never shows a value not kept. */
  const save = (write: Promise<void> | void, undo: () => void): void => {
    problem.textContent = '';
    void Promise.resolve(write).catch((error: unknown) => {
      console.error('[fruitback] a preference was not saved', error);
      undo();
      problem.textContent = t(PREFERENCE_NOT_SAVED);
    });
  };
  /** A switch of the kit, flipped back. */
  const flipBack = (control: HTMLElement, on: boolean): void => {
    const knob = control.matches('[role="switch"]') ? control : control.querySelector('[role="switch"]');
    knob?.setAttribute('aria-checked', String(!on));
  };

  if (options.panelOnClick !== undefined) {
    card.append(
      row(
        document,
        t('Open notes in the sidebar'),
        t('Instead of floating pins only, on every site you review.'),
        (() => {
          const control: HTMLElement = toggle(document, {
            checked: options.panelOnClick,
            label: t('Open notes in the sidebar'),
            size: 'preference',
            onChange: (on) => save(options.onPanelOnClick(on), () => flipBack(control, on)),
          });

          return control;
        })(),
      ),
    );
  }

  const name = make(document, 'input', 'pref-name');
  name.type = 'text';
  name.maxLength = NAME_MAX;
  name.value = options.name;
  name.autocomplete = 'name';
  name.setAttribute('aria-label', t('Name on my notes'));
  let keptName = options.name;
  name.addEventListener('change', () => {
    const typed = name.value.trim();
    const before = keptName;
    keptName = typed;
    save(options.onName(typed), () => {
      keptName = before;
      name.value = before;
    });
  });
  card.append(
    row(document, t('Name on my notes'), t('Prefilled in private mode. Team mode signs with your session.'), name),
  );

  card.append(
    row(
      document,
      t('Show CSS selectors'),
      t(
        'In the head of a note you write, and in the note of a pin. The issue in your tracker keeps the selector either way.',
      ),
      (() => {
        const control: HTMLElement = toggle(document, {
          checked: options.selectors,
          label: t('Show CSS selectors'),
          size: 'preference',
          onChange: (on) => save(options.onSelectors(on), () => flipBack(control, on)),
        });

        return control;
      })(),
    ),
  );

  // FRU-443: a select, which a keyboard opens and walks with the arrows, and a screen reader names.
  const corner = make(document, 'select', 'pref-select');
  corner.setAttribute('aria-label', t('Corner of the widget'));
  for (const [value, words] of CORNER_WORDS) {
    const option = make(document, 'option', '', t(words));
    option.value = value;
    corner.append(option);
  }
  corner.value = options.dockPosition;
  let keptCorner = options.dockPosition;
  corner.addEventListener('change', () => {
    const chosen = parseDockPosition(corner.value) ?? DEFAULT_DOCK_POSITION;
    const before = keptCorner;
    keptCorner = chosen;
    save(options.onDockPosition(chosen), () => {
      keptCorner = before;
      corner.value = before;
    });
  });
  card.append(
    row(
      document,
      t('Corner of the widget'),
      t('Where the widget stands on every site you review. It moves at once, and a note being written stays.'),
      corner,
    ),
  );

  card.append(
    row(
      document,
      t('Allow captures on every site'),
      options.captureWarning === undefined
        ? t(
            'Your browser will ask you to allow Fruitback on every website. Fruitback uses it only for the captures you ask for, so you no longer click its icon before each one. Turning it off gives it back to your browser.',
          )
        : t(
            'Your browser will say that Fruitback can “{warning}”. Fruitback uses it only for the captures you ask for, so you no longer click its icon before each one. Turning it off gives it back to your browser.',
            { warning: t(options.captureWarning) },
          ),
      (() => {
        const control: HTMLElement = toggle(document, {
          checked: options.capturesEverywhere,
          label: t('Allow captures on every site'),
          size: 'preference',
          // The request is the first call of the click: an `await` before it loses the gesture.
          onChange: (on) => {
            problem.textContent = '';
            void options.onCapturesEverywhere(on).then(
              (held) => {
                if (held !== on) flipBack(control, on);
              },
              (error: unknown) => {
                console.error('[fruitback] the permission of the captures did not change', error);
                flipBack(control, on);
                problem.textContent = t(PREFERENCE_NOT_SAVED);
              },
            );
          },
        });

        return control;
      })(),
    ),
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
  card.append(row(document, t('Leave a note shortcut'), shortcutHelp(options), shortcut));

  const synced = options.synced;
  if (synced !== undefined) {
    card.append(
      row(
        document,
        t('Keep my rules in the account of this browser'),
        t(
          'When this is on, your rules (patterns, modes, endpoints, client ids, and the labels and workspace names they hold) are kept by the account of this browser, and reach your other browsers where it is on too. No session and no access travel: on another browser, grant access to each site. Turning it off stops the copy, and removes nothing from the account.',
        ),
        (() => {
          const control: HTMLElement = toggle(document, {
            checked: synced,
            label: t('Keep my rules in the account of this browser'),
            size: 'preference',
            onChange: (on) => save(options.onSynced(on), () => flipBack(control, on)),
          });

          return control;
        })(),
      ),
    );
  }
  card.append(problem);
  section.append(title, card);

  return section;
}
