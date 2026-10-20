import { msg, t } from './i18n.ts';
import { segmentedTabs, statusDrop, toggle } from './kit.ts';
import type { PanelNote } from './protocol.ts';
import type { SiteNote, SiteStage } from './site-notes.ts';

/**
 * « Search and options » of the side panel (FRU-307): the scope (« This page », « Whole site »), the
 * search, the chips of the statuses, the notes that lost their element, and « Show pins on the page ».
 * The controls are the ones of the board « Sidebar mode » of the mock-up of 2026-10-20, behind the
 * magnifier of `ExtSidebar`.
 *
 * « This page » filters the notes the widget of the tab read: their whole text. « Whole site » shows
 * what `GET /session/notes` answers (FRU-306): the first words of each note, as the index keeps them.
 * A row of another page opens that page; the widget there reads the note and its thread.
 *
 * Plain functions of a state: `side-panel.ts` draws them, `entrypoints/sidepanel/main.ts` holds it.
 */

export type Scope = 'page' | 'site';

/** The chips: every note, or one status. « Closed » has no chip; « All » counts it. */
export const STAGE_FILTERS = ['all', 'seeded', 'green', 'ripening', 'ripe'] as const;
export type StageFilter = (typeof STAGE_FILTERS)[number];

/** The notes of the whole site, or where their read is. */
export type SiteList =
  | 'reading'
  /** The session of the site ended: the popup signs in again. */
  | 'signed-out'
  /** No session may read the whole site here, or a worker of before FRU-306. */
  | 'unavailable'
  | 'failed'
  | { notes: SiteNote[]; total: number; next?: string; more?: 'reading' | 'failed' };

export type SearchState = {
  scope: Scope;
  q: string;
  stage: StageFilter;
  /** Absent: this site has no list of its own here (a private site, a site with no session). */
  site?: SiteList;
  pinsShown: boolean;
  /** The address of the tab, `path` and query: the rows of the site on it say « This page ». */
  path?: string;
};

export type SearchHandlers = {
  onScope: (scope: Scope) => void;
  onQuery: (q: string) => void;
  onStage: (stage: StageFilter) => void;
  onSiteNote: (note: SiteNote) => void;
  onSiteRetry: () => void;
  onMore: () => void;
  onPins: (shown: boolean) => void;
};

/** The word of each status, as the rows say it. */
export const STAGE_WORD: Record<SiteStage, string> = {
  seeded: msg('New'),
  green: msg('To do'),
  ripening: msg('In progress'),
  ripe: msg('Done'),
  composted: msg('Closed'),
};

const FILTER_WORD: Record<StageFilter, string> = {
  all: msg('All'),
  seeded: msg('New'),
  green: msg('To do'),
  ripening: msg('In progress'),
  ripe: msg('Done'),
};

/** The words of a search: lower case, no accent, so « cafe » finds « Café ». */
function folded(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Whether every word of `q` is in the text of this note, or in the name of who wrote it. */
export function matchesPage(note: PanelNote, q: string): boolean {
  const words = folded(q).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = folded(`${note.note} ${note.author ?? ''}`);

  return words.every((word) => text.includes(word));
}

/** How many notes of each chip: `all` counts every one. */
export function countsOf(notes: readonly { stage: SiteStage }[]): Record<StageFilter, number> {
  const counts = { all: notes.length, seeded: 0, green: 0, ripening: 0, ripe: 0 };
  for (const note of notes) if (note.stage !== 'composted') counts[note.stage] += 1;

  return counts;
}

export function passes(stage: SiteStage, filter: StageFilter): boolean {
  return filter === 'all' || stage === filter;
}

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

const SVG = 'http://www.w3.org/2000/svg';

/** The magnifier: 18 px in the head, 15 px in the field. */
export function magnifier(document: Document, className: string): SVGSVGElement {
  const drawing = document.createElementNS(SVG, 'svg');
  drawing.setAttribute('viewBox', '0 0 16 16');
  drawing.setAttribute('aria-hidden', 'true');
  drawing.setAttribute('class', className);
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', 'M7 2.5 A4.5 4.5 0 1 0 7 11.5 A4.5 4.5 0 1 0 7 2.5 Z M10.3 10.3 L13.5 13.5');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.6');
  path.setAttribute('stroke-linecap', 'round');
  drawing.append(path);

  return drawing;
}

/**
 * The controls under the head: the scope, the search, the chips. `pageNotes` is `undefined` while
 * the widget has not answered: its tab then shows no count.
 */
export function searchControls(
  document: Document,
  state: SearchState,
  handlers: SearchHandlers,
  pageNotes: readonly PanelNote[] | undefined,
): HTMLElement {
  const root = make(document, 'section', 'search-options');
  root.id = 'search-options';
  root.setAttribute('aria-label', t('Search and options'));

  if (state.site !== undefined) {
    const siteTotal = typeof state.site === 'object' ? state.site.total : undefined;
    const tabs = segmentedTabs(document, {
      label: t('Scope'),
      size: 'page',
      tabs: [
        {
          id: 'page',
          label: pageNotes === undefined ? t('This page') : t('This page · {count}', { count: pageNotes.length }),
        },
        {
          id: 'site',
          label: siteTotal === undefined ? t('Whole site') : t('Whole site · {count}', { count: siteTotal }),
        },
      ],
      selected: state.scope,
      onSelect: (id) => handlers.onScope(id === 'site' ? 'site' : 'page'),
    });
    tabs.classList.add('search-scope');
    root.append(tabs);
  }

  const field = make(document, 'div', 'search-field');
  const input = make(document, 'input', 'search-input');
  input.type = 'search';
  input.value = state.q;
  input.placeholder = t('Search notes');
  input.setAttribute('aria-label', t('Search notes'));
  input.maxLength = 200;
  input.addEventListener('input', () => handlers.onQuery(input.value));
  field.append(magnifier(document, 'search-glass'), input);
  root.append(field);
  if (state.scope === 'site') {
    const hint = make(document, 'p', 'search-hint', t('Searches the first words of each note'));
    hint.id = 'search-hint';
    input.setAttribute('aria-describedby', hint.id);
    root.append(hint);
  }

  const counts = countsOf(chipNotes(state, pageNotes));
  const chips = make(document, 'div', 'search-chips');
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', t('Status'));
  for (const filter of STAGE_FILTERS) {
    const chip = make(document, 'button', 'search-chip');
    chip.type = 'button';
    chip.dataset.stage = filter;
    chip.setAttribute('aria-pressed', String(state.stage === filter));
    if (filter !== 'all') chip.append(statusDrop(document, { stage: filter }));
    chip.append(
      make(document, 'span', 'search-chip-word', t(FILTER_WORD[filter])),
      make(document, 'span', 'search-chip-count', String(counts[filter])),
    );
    chip.addEventListener('click', () => handlers.onStage(filter));
    chips.append(chip);
  }
  root.append(chips);

  return root;
}

/** The notes the chips count: the page's that match the search, or the site's that were read. */
function chipNotes(state: SearchState, pageNotes: readonly PanelNote[] | undefined): readonly { stage: SiteStage }[] {
  if (state.scope === 'site') return typeof state.site === 'object' ? state.site.notes : [];

  return (pageNotes ?? []).filter((note) => matchesPage(note, state.q));
}

/** « Show pins on the page », at the foot of the panel. */
export function pinsSwitch(document: Document, state: SearchState, handlers: SearchHandlers): HTMLElement {
  const row = make(document, 'div', 'search-pins');
  const label = make(document, 'span', 'search-pins-word', t('Show pins on the page'));
  label.setAttribute('aria-hidden', 'true');
  row.append(
    label,
    toggle(document, {
      checked: state.pinsShown,
      label: t('Show pins on the page'),
      size: 'table',
      onChange: handlers.onPins,
    }),
  );

  return row;
}

/**
 * The notes that lost their element (`placement: 'detached'`), at the end of the list: their pin is
 * not on the page, so the list is where they are read.
 */
export function detachedPart(document: Document, notes: readonly PanelNote[]): HTMLElement | undefined {
  if (notes.length === 0) return undefined;
  const part = make(document, 'section', 'search-detached');
  const title = make(
    document,
    'h3',
    'search-detached-title',
    notes.length === 1 ? t('1 detached note') : t('{count} detached notes', { count: notes.length }),
  );
  title.id = 'search-detached-title';
  part.setAttribute('aria-labelledby', title.id);
  const mark = make(document, 'span', 'search-detached-drop');
  mark.setAttribute('aria-hidden', 'true');
  title.prepend(mark);
  const list = make(document, 'ul', 'search-detached-list');
  for (const note of notes) {
    const card = make(document, 'li', 'search-detached-card');
    card.dataset.note = note.id;
    card.append(
      make(document, 'p', 'search-detached-note', note.note),
      make(
        document,
        'p',
        'search-detached-meta',
        t('{stage} · the element it pointed at is gone', { stage: t(STAGE_WORD[note.stage]) }),
      ),
    );
    list.append(card);
  }
  part.append(title, list);

  return part;
}

/** The list of the whole site, or where its read is. */
export function siteList(
  document: Document,
  state: SearchState,
  handlers: SearchHandlers,
  now: number,
  age: (iso: string, now: number) => string,
): Node[] {
  const site = state.site;
  if (site === undefined || site === 'unavailable') {
    return [make(document, 'p', 'panel-none', t('The notes of the whole site cannot be read from this browser.'))];
  }
  if (site === 'reading') {
    const line = make(document, 'p', 'panel-reading', t('Reading the notes of the whole site…'));
    line.setAttribute('role', 'status');

    return [line];
  }
  if (site === 'signed-out') {
    const line = make(
      document,
      'p',
      'panel-reading',
      t('Your session ended. Sign in again from the Fruitback button.'),
    );
    line.setAttribute('role', 'status');

    return [line];
  }
  if (site === 'failed') return [failed(document, handlers.onSiteRetry)];

  const shown = site.notes.filter((note) => passes(note.stage, state.stage));
  const parts: Node[] = [];
  if (shown.length === 0) {
    parts.push(make(document, 'p', 'panel-none', t('No note matches.')));
  } else {
    const list = make(document, 'ul', 'panel-list');
    list.classList.add('site-list');
    list.setAttribute('aria-label', t('Notes of the whole site'));
    for (const note of shown) list.append(siteRow(document, note, state.path, handlers, now, age));
    parts.push(list);
  }
  if (site.next !== undefined || site.more !== undefined) {
    const more = make(document, 'div', 'site-more');
    more.append(
      make(
        document,
        'p',
        'site-more-count',
        t('Showing {shown} of {total}', { shown: site.notes.length, total: site.total }),
      ),
    );
    if (site.more === 'reading') {
      const line = make(document, 'p', 'site-more-count', t('Reading…'));
      line.setAttribute('role', 'status');
      more.append(line);
    } else {
      if (site.more === 'failed') {
        const problem = make(document, 'p', 'panel-reply-problem', t('The next notes could not be read.'));
        problem.setAttribute('role', 'alert');
        more.append(problem);
      }
      more.append(linkButton(document, t('Show more'), handlers.onMore));
    }
    parts.push(more);
  }

  return parts;
}

function failed(document: Document, onRetry: () => void): HTMLElement {
  const box = make(document, 'div', 'panel-failed');
  box.setAttribute('role', 'alert');
  box.append(
    make(document, 'p', '', t('The notes of the whole site could not be read. They are not lost.')),
    linkButton(document, t('Try again'), onRetry),
  );

  return box;
}

function linkButton(document: Document, label: string, onClick: () => void): HTMLButtonElement {
  const node = make(document, 'button', 'panel-link', label);
  node.type = 'button';
  node.addEventListener('click', onClick);

  return node;
}

/** The index keeps 64 characters: a note that long was cut, and says so. */
const EXCERPT = 64;

/**
 * A note of the site: its drop (hollow for a note of another page), its first words, its status,
 * who wrote it and where. A click opens its page, or its thread on the page of the tab.
 */
function siteRow(
  document: Document,
  note: SiteNote,
  path: string | undefined,
  handlers: SearchHandlers,
  now: number,
  age: (iso: string, now: number) => string,
): HTMLLIElement {
  const here = path !== undefined && note.page.path === path;
  const row = make(document, 'li', 'panel-row');
  row.classList.add('site-row');
  row.dataset.note = note.seed;
  const head = make(document, 'button', 'panel-row-head');
  head.type = 'button';
  head.addEventListener('click', () => handlers.onSiteNote(note));
  const drop = statusDrop(document, { stage: note.stage });
  drop.dataset.size = 'site';
  if (!here) drop.dataset.hollow = 'true';
  const words = make(document, 'span', 'panel-row-words');
  const who = note.mine === true ? t('You') : (note.author ?? t('Anonymous'));
  const meta = make(document, 'span', 'panel-row-meta');
  meta.append(
    make(document, 'strong', 'panel-row-stage', t(STAGE_WORD[note.stage])),
    ` · ${who} · ${here ? t('This page') : note.page.path} · ${age(note.createdAt, now)}`,
  );
  const excerpt = note.excerpt.length >= EXCERPT ? `${note.excerpt}…` : note.excerpt;
  words.append(make(document, 'span', 'panel-row-note', excerpt), meta);
  head.append(drop, words);
  // Said to a screen reader: what the click does.
  head.setAttribute(
    'aria-description',
    here ? t('Shows the note on this page') : t('Opens {path} in a new tab', { path: note.page.path }),
  );
  row.append(head);
  if (note.reference !== undefined && note.referenceUrl !== undefined) {
    const links = make(document, 'div', 'site-row-links');
    const open = make(document, 'a', 'site-row-ref', t('Open {reference} →', { reference: note.reference }));
    open.href = note.referenceUrl;
    open.target = '_blank';
    // `noreferrer` holds `noopener`: the tracker gets no handle on the panel.
    open.rel = 'noreferrer';
    links.append(open);
    row.append(links);
  }

  return row;
}
