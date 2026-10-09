import { type FeedbackEntry } from './export.ts';
import { deepActiveElement } from './focus.ts';
import { createIcon } from './icons.ts';
import { type Translator, createTranslator, languageOf } from './messages.ts';
import { stageToken } from './theme.ts';

/**
 * Every note of the page, in one list (FRU-129).
 *
 * A pin says where a note is, and a page of thirty pins does not say how many are left to do. The
 * list does: each note with its state, who wrote it and when, and whether its element was found.
 * Choosing a note scrolls to its pin and opens its thread.
 *
 * It is a dialog that is not modal, like the thread. The page stays usable beside it, and a reviewer
 * goes from note to note without opening it again. So it takes focus when it opens, gives it back to
 * what opened it, and closes on Escape. It sets no `aria-modal` and holds no Tab.
 */
export type Sidebar = {
  open(): void;
  close(): void;
  toggle(): void;
  readonly isOpen: boolean;
  /** Draws the list again from `entries`. Called for it when the pins change. */
  refresh(): void;
  destroy(): void;
};

export type SidebarOptions = {
  /** Where to render. The Shadow root, in practice. */
  host: Element | ShadowRoot;
  /** The notes of the page as the overlay holds them now. Read on each draw, so it costs no request. */
  entries: () => readonly FeedbackEntry[];
  /** The reviewer chose this note. */
  onSelect: (id: string) => void;
  document?: Document;
  /** The widget's words (FRU-37). Left out: English, with dates in this document's language. */
  translator?: Translator;
};

/** Enough of the note to know it. The whole note is in its thread. */
const EXCERPT_MAX_LENGTH = 90;

export function createSidebar(options: SidebarOptions): Sidebar {
  const document = options.document ?? options.host.ownerDocument ?? globalThis.document;
  const t = options.translator ?? createTranslator({ language: languageOf(document) });

  const style = document.createElement('style');
  style.textContent = STYLES;

  const root = document.createElement('div');
  root.className = 'fruitback-sidebar';
  root.dataset.fruitbackSidebar = '';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', t.text('sidebar.dialog'));

  // A div, not a header: see `panel.ts` for why the chrome of the widget uses no generic tag.
  const head = document.createElement('div');
  head.className = 'fruitback-sidebar-head';
  const title = document.createElement('span');
  title.className = 'fruitback-sidebar-title';
  title.textContent = t.text('sidebar.title');
  const count = document.createElement('span');
  count.className = 'fruitback-sidebar-count';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'fruitback-sidebar-close';
  close.setAttribute('aria-label', t.text('sidebar.close'));
  close.append(createIcon(document, 'close'));
  head.append(title, count, close);

  const empty = document.createElement('p');
  empty.className = 'fruitback-sidebar-empty';
  empty.textContent = t.text('sidebar.empty');

  const list = document.createElement('ul');
  list.className = 'fruitback-sidebar-list';

  root.append(head, empty, list);
  options.host.append(style, root);

  /** What had focus when the list opened, to give it back. */
  let opener: HTMLElement | null = null;

  function draw(): void {
    const entries = options.entries();
    // The note that has focus keeps it across a draw: the pins change while somebody reads the list.
    const active = deepActiveElement(document);
    const focusedId =
      active !== null && list.contains(active) ? (active as HTMLElement).dataset.fruitbackNote : undefined;

    count.textContent = t.plural('sidebar.count', entries.length);
    empty.hidden = entries.length > 0;
    list.hidden = entries.length === 0;
    list.replaceChildren(...entries.map((entry) => item(entry)));

    if (focusedId !== undefined) {
      const again = [...list.querySelectorAll<HTMLElement>('[data-fruitback-note]')].find(
        (button) => button.dataset.fruitbackNote === focusedId,
      );
      (again ?? close).focus();
    }
  }

  function item({ issue, placement }: FeedbackEntry): HTMLElement {
    const row = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fruitback-sidebar-item';
    button.dataset.fruitbackNote = issue.seed.id;
    button.addEventListener('click', () => options.onSelect(issue.seed.id));

    const state = document.createElement('span');
    state.className = 'fruitback-sidebar-stage';
    const dot = document.createElement('span');
    dot.className = 'fruitback-sidebar-dot';
    dot.style.setProperty('--fruitback-sidebar-stage', stageToken(issue.stage));
    const word = document.createElement('span');
    word.textContent = t.stage(issue.stage);
    state.append(dot, word);

    const note = document.createElement('span');
    note.className = 'fruitback-sidebar-note';
    // Text, never markup: a note is written by anybody who can reach the page.
    note.textContent = excerpt(issue.seed.note) ?? t.text('thread.noNote');

    const meta = document.createElement('span');
    meta.className = 'fruitback-sidebar-meta';
    const who = issue.seed.reporter?.name ?? issue.seed.reporter?.email ?? t.text('thread.anonymous');
    const written = new Date(issue.seed.createdAt);
    const known = !Number.isNaN(written.getTime());
    meta.textContent = `${who} · ${known ? t.relative(written) : issue.seed.createdAt}`;
    if (known) meta.title = t.date(written);

    button.append(state, note, meta);

    if (placement !== 'found') {
      const mark = document.createElement('span');
      mark.className = 'fruitback-sidebar-placement';
      mark.textContent = t.text(placement === 'detached' ? 'sidebar.detached' : 'sidebar.approximate');
      button.append(mark);
    }

    row.append(button);

    return row;
  }

  function open(): void {
    if (!root.hidden) return;
    const active = deepActiveElement(document);
    opener = active !== null && active !== document.body ? (active as HTMLElement) : null;
    root.hidden = false;
    draw();
    (list.querySelector<HTMLElement>('[data-fruitback-note]') ?? close).focus();
  }

  function shut(): void {
    if (root.hidden) return;
    const active = deepActiveElement(document);
    const inside = active !== null && root.contains(active);
    root.hidden = true;
    // Only when focus was in the list: a reviewer who clicked on the page keeps focus where they put it.
    if (inside && opener?.isConnected === true) opener.focus();
    opener = null;
  }

  close.addEventListener('click', shut);
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    // The thread closes on Escape from the document. This Escape is for the list only.
    event.stopPropagation();
    shut();
  });

  return {
    open,
    close: shut,
    toggle: () => (root.hidden ? open() : shut()),
    get isOpen() {
      return !root.hidden;
    },
    refresh() {
      if (!root.hidden) draw();
    },
    destroy() {
      style.remove();
      root.remove();
    },
  };
}

function excerpt(note: string): string | undefined {
  const firstLine = note
    .split('\n')
    .find((line) => line.trim().length > 0)
    ?.trim();
  if (firstLine === undefined) return undefined;

  return firstLine.length > EXCERPT_MAX_LENGTH ? `${firstLine.slice(0, EXCERPT_MAX_LENGTH - 1)}…` : firstLine;
}

/*
  No backtick in this literal: a comment that quotes a symbol closes it. See theme.ts.
  Layout follows the reading direction (inset-inline-end, text-align: start). Nothing here is geometry.
*/
const STYLES = `
.fruitback-sidebar {
  position: fixed;
  inset-block: 0;
  inset-inline-end: 0;
  z-index: 2147483050;
  display: flex;
  flex-direction: column;
  width: 340px;
  max-width: 100vw;
  background: var(--fruitback-color-surface);
  color: var(--fruitback-color-text);
  font: 13px/1.45 var(--fruitback-font-sans);
  box-shadow: var(--fruitback-shadow-lg);
  animation: fruitback-sidebar-in var(--fruitback-duration-fast) ease-out;
}
.fruitback-sidebar[hidden] { display: none; }
@keyframes fruitback-sidebar-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.fruitback-sidebar-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 14px 10px;
}
.fruitback-sidebar-title { font-weight: 600; letter-spacing: -0.006em; }
.fruitback-sidebar-count { flex: 1; color: var(--fruitback-color-text-muted); }
.fruitback-sidebar-close {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: var(--fruitback-radius-sm);
  background: none;
  color: var(--fruitback-color-text-muted);
  font-size: 15px;
  cursor: pointer;
}
.fruitback-sidebar-empty { padding: 4px 14px 14px; color: var(--fruitback-color-text-muted); }
.fruitback-sidebar-empty[hidden] { display: none; }
.fruitback-sidebar-list {
  flex: 1;
  overflow-y: auto;
  margin: 0;
  /* The dock sits over the bottom of the list. The last note must scroll clear of it. */
  padding: 0 8px 64px;
  list-style: none;
}
.fruitback-sidebar-list[hidden] { display: none; }
.fruitback-sidebar-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 9px 8px;
  border: 0;
  border-radius: var(--fruitback-radius-md);
  background: none;
  color: var(--fruitback-color-text);
  text-align: start;
  cursor: pointer;
}
.fruitback-sidebar-item:hover { box-shadow: inset 0 0 0 1px var(--fruitback-color-text-muted); }
.fruitback-sidebar-stage {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 12px;
}
.fruitback-sidebar-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--fruitback-sidebar-stage);
}
.fruitback-sidebar-note { overflow-wrap: anywhere; }
.fruitback-sidebar-meta { color: var(--fruitback-color-text-muted); font-size: 12px; }
.fruitback-sidebar-placement { color: var(--fruitback-color-warning); font-size: 12px; }
@media (prefers-reduced-motion: reduce) {
  .fruitback-sidebar { animation: none; }
}
@media (max-width: 480px) {
  .fruitback-sidebar { inset-block-start: auto; width: 100vw; max-height: 70vh; border-radius: var(--fruitback-radius-lg) var(--fruitback-radius-lg) 0 0; }
}
`;
