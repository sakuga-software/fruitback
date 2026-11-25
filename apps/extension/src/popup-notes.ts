import { language, msg, t } from './i18n.ts';
import { button, make, stageRing } from './kit.ts';
import { notePaint } from './note-status.ts';
import { PANEL, drawIcon } from './popup-icons.ts';
import type { NotesReading, PanelNote } from './protocol.ts';
import { STAGE_WORD } from './side-panel.ts';

/**
 * « On this page », in screen 3 of the popup (FRU-695): the notes of the tab, one line each, as the
 * mock-up of 2026-11-25 draws them. The popup asks the widget of the tab with `notes`, as the side
 * panel does (FRU-299): one read, the same notes as the pins, no worker and no cache. A click on a line
 * sends `focus-note`, which scrolls to the pin and opens its thread.
 *
 * No `browser` here: `popup-notes.test.ts` reads every state under `node --test`.
 */

/** The most lines the popup shows: the popup stays under the 600 px a browser gives it. */
export const PAGE_NOTES_SHOWN = 6;

/** What the read of the tab answered. `undefined` in `notes`: no answer yet, or `reading` says why. */
export type PageNotesRead = { notes?: PanelNote[]; reading?: NotesReading | 'unreached' };

export type PageNotesOptions = {
  /** Opens the note on the page: the pin, and its thread. */
  onOpen: (id: string) => void;
  /** Opens the side panel, which holds every note. */
  onOpenPanel: () => void;
  now?: number;
};

/** The section, as it is before the widget answers: its head, and « Reading… ». */
export function pageNotes(document: Document, options: Pick<PageNotesOptions, 'onOpenPanel'>): HTMLElement {
  const section = make(document, 'section', 'page-notes');
  const head = make(document, 'div', 'page-notes-head');
  const title = make(document, 'h2', 'page-notes-title', t('On this page'));
  const count = make(document, 'span', 'page-notes-count');
  title.append(count);
  const check = make(document, 'span', 'page-notes-check');
  const panel = button(document, 'page-notes-panel', '', options.onOpenPanel);
  panel.append(drawIcon(document, PANEL), document.createTextNode(t('Open sidebar')));
  head.append(title, check, panel);
  const list = make(document, 'ul', 'page-notes-list');
  list.setAttribute('aria-label', t('Notes on this page'));
  const said = make(document, 'p', 'page-notes-said', t('Reading the notes of this page…'));
  section.append(head, list, said);

  return section;
}

/** The words for a read with no notes: why, or that the page has none. */
const READING_WORDS: Record<NonNullable<PageNotesRead['reading']>, string> = {
  pending: msg('Reading the notes of this page…'),
  failed: msg('The notes of this page could not be read. They are not lost.'),
  'no-widget': msg('Fruitback did not start on this page. Reload it to see its notes.'),
  unreached: msg('Fruitback did not start on this page. Reload it to see its notes.'),
  'signed-out': msg('Your session ended. Sign in again from the Fruitback button, then try again.'),
};

/** Fills the section with what the widget answered. */
export function showPageNotes(section: HTMLElement, read: PageNotesRead, options: PageNotesOptions): void {
  const document = section.ownerDocument;
  const list = section.querySelector('.page-notes-list') as HTMLElement;
  const said = section.querySelector('.page-notes-said') as HTMLElement;
  const count = section.querySelector('.page-notes-count') as HTMLElement;
  const notes = read.notes;
  if (notes === undefined) {
    list.replaceChildren();
    count.textContent = '';
    said.hidden = false;
    said.textContent = t(READING_WORDS[read.reading ?? 'pending']);

    return;
  }
  count.textContent = String(notes.length);
  said.hidden = notes.length > 0;
  said.textContent = notes.length === 0 ? t('No notes on this page yet') : '';
  const now = options.now ?? Date.now();
  const rows = notes.slice(0, PAGE_NOTES_SHOWN).map((note) => {
    const item = make(document, 'li', 'page-notes-item');
    item.append(noteLine(document, note, now, options.onOpen));

    return item;
  });
  const more = notes.length - PAGE_NOTES_SHOWN;
  if (more > 0) {
    const item = make(document, 'li', 'page-notes-item');
    const rest = button(
      document,
      'page-notes-more',
      more === 1 ? t('1 more in the sidebar') : t('{count} more in the sidebar', { count: String(more) }),
      options.onOpenPanel,
    );
    item.append(rest);
    rows.push(item);
  }
  list.replaceChildren(...rows);
}

/** One note on one line: the round of its stage, the note cut with « … », and its age. */
function noteLine(document: Document, note: PanelNote, now: number, onOpen: (id: string) => void): HTMLButtonElement {
  const line = button(document, 'page-note', '', () => onOpen(note.id));
  line.dataset.note = note.id;
  line.title = note.note;
  // The stage is a drawing: a screen reader reads its word before the note.
  const stage = make(document, 'span', 'visually-hidden', `${t(STAGE_WORD[note.stage])}, `);
  const words = make(document, 'span', 'page-note-text', note.note);
  const age = make(document, 'span', 'page-note-age', shortAge(note.createdAt, now));
  line.append(stageRing(document, note.stage, notePaint(note)), stage, words, age);

  return line;
}

/** The units of a short age, largest first: a month or more is a date. */
const SHORT_UNITS: readonly (readonly ['week' | 'day' | 'hour' | 'minute', number])[] = [
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

/**
 * The age of a note as the mock-up writes it: « 40m », « 3h », « 2d », « 1w » (« 40 min », « 3 h »,
 * « 2 j » in French), « now » under a minute, and a date past four weeks. Nothing for a date that
 * does not parse.
 */
export function shortAge(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return t('now');
  if (seconds >= 5 * 604_800) {
    return new Intl.DateTimeFormat(language(), { day: 'numeric', month: 'short' }).format(new Date(then));
  }
  for (const [unit, size] of SHORT_UNITS) {
    if (seconds >= size) {
      return new Intl.NumberFormat(language(), { style: 'unit', unit, unitDisplay: 'narrow' }).format(
        Math.floor(seconds / size),
      );
    }
  }

  return t('now');
}
