import { type SendFailure, failureText } from './composer.ts';
import { type Draft } from './drafts.ts';
import { type FeedbackEntry } from './export.ts';
import { deepActiveElement } from './focus.ts';
import { createIcon } from './icons.ts';
import { type Translator, createTranslator, languageOf } from './messages.ts';
import { onStageToken, stageToken } from './theme.ts';

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
 *
 * Since FRU-308 it is the board « Sidebar mode » of the mock-up of 2026-10-20: « This page », a
 * search, a chip for each status, a row for each note with the number its pin carries, the notes
 * whose element is gone at the bottom, and a foot with « Leave feedback » and « Show pins on the
 * page ». **It lies over the page and does not push it** (A19): the board narrows its example site,
 * and a margin put on the page of somebody else breaks a layout nobody here read.
 */
export type Sidebar = {
  open(): void;
  close(): void;
  toggle(): void;
  readonly isOpen: boolean;
  /** Draws the list again from `entries`. Called for it when the pins change. */
  refresh(): void;
  /**
   * Marks the row of the note whose thread is open, and no other (FRU-259). It builds no row: a
   * thread gives focus back to the row that opened it, and a row built again is another element.
   */
  mark(): void;
  destroy(): void;
};

/**
 * What the widget knows of the notes of this page (FRU-153).
 *
 * `pending`: no read has answered yet. `read`: a read answered, and the list is what it said.
 * `failed`: no read answered for this page, and the last one failed. An empty list then says
 * nothing about the notes, so the list must not say that there are none. `signed-out`: the session
 * the host reads with has ended (FRU-315). The list says to sign in, and its one button does it.
 */
export type ReadState = 'pending' | 'read' | 'failed' | 'signed-out';

export type SidebarOptions = {
  /** Where to render. The Shadow root, in practice. */
  host: Element | ShadowRoot;
  /** The notes of the page as the overlay holds them now. Read on each draw, so it costs no request. */
  entries: () => readonly SidebarEntry[];
  /**
   * The reviewer chose this note. Its thread goes in `home`, which takes the place of the rows in the
   * column of the list (FRU-312). `false`: the note has no thread to show, and the rows stay.
   */
  onSelect: (id: string, home: HTMLElement) => boolean | void;
  /** The reviewer went back from a thread to the rows: its thread closes. */
  onBack?: () => void;
  /** Read on each draw. Left out, the list is always `read`. */
  readState?: () => ReadState;
  /** The reviewer asked to read the notes again, after a failed read. */
  onRetry?: () => void;
  /** The reviewer asked to sign in again, while the read state is `signed-out` (FRU-315). */
  onSignIn?: () => void;
  /** Read on each draw: the worker takes no note of this reader here, and « Leave feedback » goes (FRU-330). */
  closed?: () => boolean;
  /**
   * The notes kept for later in this tab, on every page (FRU-124). Read on each draw. They are listed
   * in a group of their own above the notes, with one button that sends them all.
   */
  drafts?: () => readonly Draft[];
  /** Send every draft. Says how many the worker kept, and why the others stay. */
  onSendDrafts?: () => Promise<{ sent: number; failure?: SendFailure }>;
  /** The note whose thread is open now, if any: its row says so. Read on each draw. */
  current?: () => string | undefined;
  /**
   * Whether the element of this note is under the part of the page in sight: its row then says
   * « further down ». Asked on each draw and while the page scrolls under the open list.
   */
  below?: (id: string) => boolean;
  /**
   * The way to a new note from the list, which hides the dock while it is open. `label` is the
   * label of the launch button, so a host that named it reads one name. Left out: no button.
   */
  leave?: { label: string; onLeave: () => void };
  /**
   * The pins of the page, for « Show pins on the page » (FRU-308). The switch hides them while the
   * list is open; the list shows them again when it closes. Left out: no switch.
   */
  pins?: { show(on: boolean): void };
  document?: Document;
  /** The widget's words (FRU-37). Left out: English, with dates in this document's language. */
  translator?: Translator;
};

/** A note of the list: how it was found, and the number its pin carries (FRU-252). */
export type SidebarEntry = FeedbackEntry & { number?: number };

/** Enough of the note to know it. The whole note is in its thread. */
const EXCERPT_MAX_LENGTH = 90;

/**
 * The chips of the board, in its order (FRU-308): « All », then a status each. « Closed » is not on
 * the board: its chip shows only while a note of the page is closed, or while it is the one chosen.
 */
const STAGES = ['new', 'todo', 'progress', 'done', 'closed'] as const;
type Stage = (typeof STAGES)[number];
type Chosen = 'all' | Stage;

/** Whether this note has these words, in its text or in the identifier of its store. */
function matches(entry: SidebarEntry, query: string): boolean {
  if (query === '') return true;
  const words = query.toLocaleLowerCase();

  return (
    entry.issue.seed.note.toLocaleLowerCase().includes(words) ||
    (entry.issue.identifier ?? '').toLocaleLowerCase().includes(words)
  );
}

export function createSidebar(options: SidebarOptions): Sidebar {
  const document = options.document ?? options.host.ownerDocument ?? globalThis.document;
  const t = options.translator ?? createTranslator({ language: languageOf(document) });

  const style = document.createElement('style');
  style.textContent = STYLES;

  const view = document.defaultView;

  const root = document.createElement('div');
  root.className = 'fruitback-sidebar';
  root.dataset.fruitbackSidebar = '';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  // Its name is « Notes on this page », and its head says « Notes »: a name that starts like the one
  // of the thread, « Note 3 », would make one locator find two dialogs.
  root.setAttribute('aria-label', t.text('sidebar.dialog'));

  // A div, not a header: see `panel.ts` for why the chrome of the widget uses no generic tag.
  const head = document.createElement('div');
  head.className = 'fruitback-sidebar-head';
  const heading = document.createElement('div');
  heading.className = 'fruitback-sidebar-heading';
  const title = document.createElement('span');
  title.id = 'fruitback-sidebar-title';
  title.className = 'fruitback-sidebar-title';
  title.textContent = t.text('sidebar.title');
  // Which site: its host, as the address bar writes it.
  const address = document.createElement('span');
  address.className = 'fruitback-sidebar-address';
  heading.append(createIcon(document, 'drop'), title, address);
  const floating = document.createElement('button');
  floating.type = 'button';
  floating.className = 'fruitback-sidebar-icon';
  floating.dataset.fruitbackFloating = '';
  floating.setAttribute('aria-label', t.text('sidebar.floating'));
  floating.title = t.text('sidebar.floating');
  floating.append(createIcon(document, 'list'));
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'fruitback-sidebar-icon fruitback-sidebar-close';
  close.setAttribute('aria-label', t.text('sidebar.close'));
  close.append(createIcon(document, 'close'));
  head.append(heading, floating, close);

  // « This page », the search and the chips of the statuses (FRU-308).
  const actions = document.createElement('div');
  actions.className = 'fruitback-sidebar-actions';
  // The scope of the board, with its one part: the script reads the notes of this page only, and has
  // no route for the whole site. Words, not a tab: a list of one tab chooses nothing.
  const scope = document.createElement('p');
  scope.className = 'fruitback-sidebar-scope';
  const scopeWords = document.createElement('span');
  scope.append(scopeWords);
  const searchBox = document.createElement('label');
  searchBox.className = 'fruitback-sidebar-search';
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'fruitback-sidebar-search-field';
  search.placeholder = t.text('sidebar.search');
  search.setAttribute('aria-label', t.text('sidebar.search'));
  search.autocomplete = 'off';
  search.spellcheck = false;
  searchBox.append(createIcon(document, 'search'), search);
  let query = '';
  search.addEventListener('input', () => {
    query = search.value.trim();
    draw();
  });
  // The page must not take the keys typed here: the capture mode and the shortcuts of a site listen
  // on the document. Escape still reaches the list, which closes on it.
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') event.stopPropagation();
  });

  let chosen: Chosen = 'all';
  const chipGroup = document.createElement('div');
  chipGroup.className = 'fruitback-sidebar-chips';
  chipGroup.setAttribute('role', 'group');
  chipGroup.setAttribute('aria-label', t.text('sidebar.stages'));
  const chips = new Map<Chosen, { button: HTMLButtonElement; word: string; count: HTMLSpanElement }>();
  for (const name of ['all', ...STAGES] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fruitback-sidebar-chip';
    button.dataset.fruitbackChip = name;
    if (name !== 'all') {
      // The drop of the status, for the eye: the chip says it in words.
      const dot = document.createElement('span');
      dot.className = 'fruitback-sidebar-dot';
      dot.setAttribute('aria-hidden', 'true');
      dot.style.setProperty('--fruitback-sidebar-stage', stageToken(name));
      button.append(dot);
    }
    const word = name === 'all' ? t.text('sidebar.all') : t.stage(name);
    const label = document.createElement('span');
    label.textContent = word;
    const count = document.createElement('span');
    count.className = 'fruitback-sidebar-count';
    button.append(label, count);
    button.addEventListener('click', () => {
      chosen = name;
      draw();
    });
    chips.set(name, { button, word, count });
    chipGroup.append(button);
  }
  actions.append(scope, searchBox, chipGroup);

  // The foot of the board: the way to a new note, and the switch of the pins.
  const foot = document.createElement('div');
  foot.className = 'fruitback-sidebar-foot';
  const leave = document.createElement('button');
  leave.type = 'button';
  leave.className = 'fruitback-sidebar-leave';
  leave.dataset.fruitbackLeave = '';
  if (options.leave !== undefined) {
    const label = document.createElement('span');
    label.textContent = options.leave.label;
    leave.append(createIcon(document, 'mark'), label);
    leave.addEventListener('click', () => {
      // The capture needs the page and the keys: the list goes, and gives its focus back first.
      shut();
      options.leave?.onLeave();
    });
    foot.append(leave);
  }
  const pinsRow = document.createElement('label');
  pinsRow.className = 'fruitback-sidebar-pins';
  const pinsWords = document.createElement('span');
  pinsWords.textContent = t.text('sidebar.showPins');
  const pinsSwitch = document.createElement('input');
  pinsSwitch.type = 'checkbox';
  pinsSwitch.setAttribute('role', 'switch');
  pinsSwitch.dataset.fruitbackShowPins = '';
  pinsSwitch.checked = true;
  pinsSwitch.addEventListener('change', () => options.pins?.show(pinsSwitch.checked));
  pinsRow.append(pinsWords, pinsSwitch);
  if (options.pins !== undefined) foot.append(pinsRow);

  // The rows, and everything under the filters. It scrolls.
  const panel = document.createElement('div');
  panel.id = 'fruitback-sidebar-panel';
  panel.className = 'fruitback-sidebar-panel';

  const empty = document.createElement('p');
  empty.className = 'fruitback-sidebar-empty';
  empty.textContent = t.text('sidebar.empty');

  // A failed read says so, and offers to read again (FRU-153). The message is a live region that
  // stays in the tree, because a live region that was hidden announces nothing. It also describes
  // the button, which takes focus.
  const failedText = document.createElement('p');
  failedText.id = 'fruitback-sidebar-failed-text';
  failedText.className = 'fruitback-sidebar-failed-text';
  failedText.setAttribute('role', 'status');
  failedText.setAttribute('aria-live', 'polite');
  const failed = document.createElement('div');
  failed.className = 'fruitback-sidebar-failed';
  failed.hidden = true;
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'fruitback-sidebar-retry';
  retry.textContent = t.text('sidebar.retry');
  retry.setAttribute('aria-describedby', failedText.id);
  // The button stays while the read it asked for runs, so focus stays on it, and a second failure
  // finds it where it was. It is busy, not disabled: a disabled button loses focus.
  let retrying = false;
  retry.addEventListener('click', () => {
    // Signed out, the same place holds « Sign in »: a read again would be refused like the last.
    if ((options.readState?.() ?? 'read') === 'signed-out') {
      options.onSignIn?.();

      return;
    }
    if (retrying) return;
    retrying = true;
    options.onRetry?.();
  });
  failed.append(retry);

  const list = document.createElement('ul');
  list.className = 'fruitback-sidebar-list';

  // The notes kept for later (FRU-124). No board draws this group: it is made of the parts of this
  // list, a title, rows and the button of « Try again ».
  const drafted = document.createElement('div');
  drafted.className = 'fruitback-sidebar-drafts';
  drafted.dataset.fruitbackDrafts = '';
  drafted.hidden = true;
  const draftsTitle = document.createElement('p');
  draftsTitle.className = 'fruitback-sidebar-drafts-title';
  const draftList = document.createElement('ul');
  draftList.className = 'fruitback-sidebar-drafts-list';
  const sendAll = document.createElement('button');
  sendAll.type = 'button';
  sendAll.className = 'fruitback-sidebar-send';
  sendAll.dataset.fruitbackSendDrafts = '';
  // Always in the tree: a live region that was hidden announces nothing. It says what the last send did.
  // `aria-live` without the role: the list has one status, the one of its read (FRU-153).
  const sentText = document.createElement('p');
  sentText.className = 'fruitback-sidebar-sent';
  sentText.dataset.fruitbackDraftsSent = '';
  sentText.setAttribute('aria-live', 'polite');
  let sendingDrafts = false;
  sendAll.addEventListener('click', () => {
    if (sendingDrafts || options.onSendDrafts === undefined) return;
    sendingDrafts = true;
    sentText.textContent = '';
    draw();
    void options
      .onSendDrafts()
      .catch(() => ({ sent: 0, failure: 'retry' as const }))
      .then((outcome) => {
        sendingDrafts = false;
        // Both when some left and some stay: the rows that went are gone from the group, and the
        // sentence of the failure alone would not say where.
        sentText.textContent = [
          outcome.sent > 0 || outcome.failure === undefined ? t.plural('sidebar.draftsSent', outcome.sent) : '',
          outcome.failure === undefined ? '' : failureText(t, outcome.failure),
        ]
          .filter((part) => part !== '')
          .join(' — ');
        draw();
      });
  });
  drafted.append(draftsTitle, draftList, sendAll);

  // The notes whose element is gone (FRU-259): apart from the tabs, which count the notes a pin
  // shows. A group with a name, and no section: the chrome of the widget uses no landmark.
  const unplaced = document.createElement('div');
  unplaced.className = 'fruitback-sidebar-unplaced';
  unplaced.dataset.fruitbackUnplaced = '';
  unplaced.hidden = true;
  unplaced.setAttribute('role', 'group');
  unplaced.setAttribute('aria-labelledby', 'fruitback-sidebar-unplaced-title');
  const unplacedTitle = document.createElement('span');
  unplacedTitle.id = 'fruitback-sidebar-unplaced-title';
  unplacedTitle.className = 'fruitback-sidebar-unplaced-title';
  const unplacedWords = document.createElement('span');
  unplacedTitle.append(createIcon(document, 'markDashed'), unplacedWords);
  const unplacedList = document.createElement('ul');
  unplacedList.className = 'fruitback-sidebar-unplaced-list';
  unplaced.append(unplacedTitle, unplacedList);

  panel.append(drafted, sentText, empty, failedText, failed, list, unplaced);

  // The thread of a note, in the column of the list and in place of its rows (FRU-312). The thread
  // on the page covered the rows and the head of the list; here the head stays, and « All notes »
  // goes back to the row that opened it.
  const detail = document.createElement('div');
  detail.className = 'fruitback-sidebar-detail';
  detail.dataset.fruitbackSidebarDetail = '';
  detail.hidden = true;
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'fruitback-sidebar-back';
  back.dataset.fruitbackSidebarBack = '';
  const arrow = document.createElement('span');
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent = '←';
  const backWords = document.createElement('span');
  backWords.textContent = t.text('sidebar.back');
  back.append(arrow, backWords);
  const home = document.createElement('div');
  home.className = 'fruitback-sidebar-home';
  detail.append(back, home);

  root.append(head, actions, panel, detail, foot);
  options.host.append(style, root);

  /** The shadow host, which the dock reads: it stands aside while the list is open. */
  const shell = 'host' in options.host ? options.host.host : null;

  /** What had focus when the list opened, to give it back. */
  let opener: HTMLElement | null = null;
  /** The note whose thread is shown in place of the rows, if one is (FRU-312). */
  let shown: string | undefined;
  /**
   * Whether the person was in the thread shown in place of the rows: focus went into it, and
   * nothing outside the list took it or was pressed since. When the thread closes, focus goes back
   * to its row only then: its node takes focus with it, and a page that got the click or the key
   * must keep it.
   */
  let inThread = false;
  detail.addEventListener('focusin', () => {
    inThread = true;
  });
  const outside = (event: Event): void => {
    if (!event.composedPath().includes(root)) inThread = false;
  };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('focusin', outside, true);

  /** The thread of this note in place of the rows. The rows come back when it closes. */
  function showNote(id: string): void {
    actions.hidden = true;
    panel.hidden = true;
    detail.hidden = false;
    // Marked after the choice: the thread of before closes during it, and `mark` must not take that
    // close for the close of this one.
    if (options.onSelect(id, home) === false) {
      detail.hidden = true;
      actions.hidden = false;
      panel.hidden = false;
      return;
    }
    shown = id;
  }

  /** The rows again, and focus on the row of the note that was open when focus was in the thread. */
  function showRows(focus: boolean): void {
    if (shown === undefined) return;
    const id = shown;
    shown = undefined;
    inThread = false;
    home.replaceChildren();
    detail.hidden = true;
    actions.hidden = false;
    panel.hidden = false;
    if (!focus) return;
    const row = [...panel.querySelectorAll<HTMLElement>('[data-fruitback-note]')].find(
      (button) => button.dataset.fruitbackNote === id,
    );
    (row ?? close).focus();
  }

  /** Whether focus is in the list, or was in the thread that goes and fell to the page with its node. */
  function focusWasHere(): boolean {
    const active = deepActiveElement(document);
    if (active !== null && root.contains(active)) return true;

    return inThread && (active === null || active === document.body);
  }

  back.addEventListener('click', () => {
    options.onBack?.();
    showRows(true);
  });

  function draw(): void {
    const entries = options.entries();
    const placed = entries.filter((entry) => entry.placement !== 'detached');
    const detached = entries.filter((entry) => entry.placement === 'detached');
    const found = placed.filter((entry) => matches(entry, query));
    const shownHere = (entry: SidebarEntry): boolean =>
      matches(entry, query) && (chosen === 'all' || entry.issue.stage === chosen);
    const rows = placed.filter(shownHere);
    const lostRows = detached.filter(shownHere);
    // The note that has focus keeps it across a draw: the pins change while somebody reads the list.
    const active = deepActiveElement(document);
    const focusedId =
      active !== null && panel.contains(active) ? (active as HTMLElement).dataset.fruitbackNote : undefined;
    const state = options.readState?.() ?? 'read';
    if (state !== 'pending') retrying = false;
    const signedOut = state === 'signed-out';
    const failing = state === 'failed' || signedOut;
    const asking = failing || retrying;
    const known = state === 'read' || entries.length > 0;

    address.textContent = view === null ? '' : `· ${view.location.host}`;
    // No number while no read answered: zero notes would be a guess. The scope counts the notes a pin
    // shows, like the chips: the detached ones have their own count, at the bottom.
    scopeWords.textContent =
      failing || !known ? t.text('sidebar.scope') : t.text('sidebar.scopeCount', { count: placed.length });
    for (const [name, { button, word, count }] of chips) {
      const number = found.filter((entry) => name === 'all' || entry.issue.stage === name).length;
      button.setAttribute('aria-pressed', String(name === chosen));
      // « Closed » is not on the board: shown while a note of the page is closed, or while chosen.
      button.hidden = name === 'closed' && number === 0 && chosen !== 'closed';
      count.textContent = failing || !known ? '' : String(number);
      // « All 4 », with its space: two spans read as one word, « All4 », in an accessible name.
      button.setAttribute('aria-label', count.textContent === '' ? word : `${word} ${number}`);
    }
    // The notes kept for later are what is left to do: at the head of the list, with every status.
    drawDrafts(chosen === 'all');

    let nothing: 'sidebar.noMatch' | 'sidebar.loading' | 'sidebar.empty' = 'sidebar.noMatch';
    if (state === 'pending') nothing = 'sidebar.loading';
    else if (entries.length === 0) nothing = 'sidebar.empty';
    empty.textContent = t.text(nothing);
    empty.hidden = asking || rows.length > 0 || lostRows.length > 0;
    // Set only when it changes, so a draw does not announce the same words again.
    let message = '';
    if (signedOut) message = t.text('sidebar.signedOut');
    else if (failing) message = t.text('sidebar.failed');
    else if (retrying) message = t.text('sidebar.loading');
    if (failedText.textContent !== message) failedText.textContent = message;
    const retryWords = t.text(signedOut ? 'sidebar.signIn' : 'sidebar.retry');
    if (retry.textContent !== retryWords) retry.textContent = retryWords;
    retry.setAttribute('aria-disabled', String(retrying));
    // A new note would be refused: the list's way to one goes while the session is over.
    leave.hidden = signedOut || options.closed?.() === true;
    const leaving = !asking && failed.contains(active);
    failed.hidden = !asking;
    list.hidden = asking || rows.length === 0;
    const current = options.current?.();
    list.replaceChildren(...(asking ? [] : rows.map((entry) => item(entry, current))));
    unplaced.hidden = asking || lostRows.length === 0;
    unplacedWords.textContent = lostRows.length === 0 ? '' : t.plural('sidebar.unplaced', lostRows.length);
    unplacedList.replaceChildren(...(asking ? [] : lostRows.map((entry) => lost(entry, current))));
    // The read answered: focus goes to the first note, or to the close button of an empty list.
    if (leaving) (panel.querySelector<HTMLElement>('[data-fruitback-note]') ?? close).focus();

    if (focusedId !== undefined) {
      const again = [...panel.querySelectorAll<HTMLElement>('[data-fruitback-note]')].find(
        (button) => button.dataset.fruitbackNote === focusedId,
      );
      (again ?? close).focus();
    }
  }

  function drawDrafts(here: boolean): void {
    const kept = here ? (options.drafts?.() ?? []) : [];
    const active = deepActiveElement(document);
    drafted.hidden = kept.length === 0;
    // No words at all with no draft: a hidden « Send the 0 notes » is still text a reader of the DOM finds.
    draftsTitle.textContent = kept.length === 0 ? '' : t.text('sidebar.drafts');
    sendAll.textContent = kept.length === 0 ? '' : t.plural('sidebar.sendDrafts', kept.length);
    // Busy, not disabled, like « Try again »: a disabled button loses focus.
    sendAll.setAttribute('aria-disabled', String(sendingDrafts));
    draftList.replaceChildren(
      ...kept.map((draft) => {
        const row = document.createElement('li');
        row.className = 'fruitback-sidebar-draft';
        const note = document.createElement('span');
        note.className = 'fruitback-sidebar-note';
        note.textContent = excerpt(draft.seed.note) ?? t.text('thread.noNote');
        // The page, because the drafts of a tab come from every page the reviewer read.
        const where = document.createElement('span');
        where.className = 'fruitback-sidebar-meta';
        where.textContent = draft.seed.page.path;
        row.append(note, where);

        return row;
      }),
    );
    // All sent: the group goes, and focus goes to what stays.
    if (kept.length === 0 && active === sendAll) close.focus();
  }

  /** The words of a note as a row shows them. Text, never markup: anybody who reaches the page writes one. */
  function words(note: string, className: string): HTMLElement {
    const text = document.createElement('span');
    text.className = className;
    // On one run of words: the row cuts it at two lines, wherever the note broke its own.
    const flat = note.replace(/\s+/g, ' ').trim();
    text.textContent = flat === '' ? t.text('thread.noNote') : flat;

    return text;
  }

  /** The status in the words of the store, like the thread, and the stage when it has none. */
  function statusOf(issue: SidebarEntry['issue']): string {
    return issue.stateName || t.stage(issue.stage);
  }

  function item({ issue, placement, number }: SidebarEntry, current: string | undefined): HTMLElement {
    const row = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fruitback-sidebar-item';
    button.dataset.fruitbackNote = issue.seed.id;
    if (issue.seed.id === current) button.setAttribute('aria-current', 'true');
    button.addEventListener('click', () => showNote(issue.seed.id));

    // The drop of its pin, with the number the pin carries: the eye goes from the row to the page.
    // For the eye only: the row says its status in words, and a screen reader has no pin to match.
    const pin = document.createElement('span');
    pin.className = 'fruitback-sidebar-pin';
    pin.setAttribute('aria-hidden', 'true');
    pin.style.setProperty('--fruitback-sidebar-stage', stageToken(issue.stage));
    pin.style.setProperty('--fruitback-sidebar-on-stage', onStageToken(issue.stage));
    const digit = document.createElement('span');
    digit.textContent = number === undefined ? '' : String(number);
    pin.append(digit);

    // « In progress · FRU-128 … 2 days ago », as the board writes the top line of a row.
    const top = document.createElement('span');
    top.className = 'fruitback-sidebar-top';
    const status = document.createElement('span');
    status.className = 'fruitback-sidebar-status';
    status.textContent = statusOf(issue);
    top.append(status);
    if (issue.identifier) {
      const id = document.createElement('span');
      id.className = 'fruitback-sidebar-id';
      id.textContent = issue.identifier;
      top.append(id);
    }
    const written = new Date(issue.seed.createdAt);
    const known = !Number.isNaN(written.getTime());
    const age = document.createElement('span');
    age.className = 'fruitback-sidebar-age';
    age.textContent = known ? t.relative(written) : issue.seed.createdAt;
    if (known) age.title = t.date(written);
    top.append(age);

    const meta = document.createElement('span');
    meta.className = 'fruitback-sidebar-meta';
    const who = issue.seed.reporter?.name ?? issue.seed.reporter?.email ?? t.text('thread.anonymous');
    const replies = issue.comments?.length ?? 0;
    meta.textContent = [
      who,
      replies > 0 ? t.plural('sidebar.replies', replies) : t.text('sidebar.noReply'),
      ...(placement === 'approximate' ? [t.text('sidebar.approximate')] : []),
    ].join(' · ');
    // Its own element: the page scrolls under the list, and only these words change then.
    const below = document.createElement('span');
    below.className = 'fruitback-sidebar-below';
    below.dataset.fruitbackBelow = issue.seed.id;
    below.textContent = ` · ${t.text('sidebar.below')}`;
    below.hidden = options.below?.(issue.seed.id) !== true;
    meta.append(below);

    const body = document.createElement('span');
    body.className = 'fruitback-sidebar-body';
    body.append(top, words(issue.seed.note, 'fruitback-sidebar-note'), meta);
    button.append(pin, body);
    row.append(button);

    return row;
  }

  /** A note whose element is gone: its words, and what became of it. It still opens its thread. */
  function lost({ issue }: SidebarEntry, current: string | undefined): HTMLElement {
    const row = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fruitback-sidebar-lost';
    button.dataset.fruitbackNote = issue.seed.id;
    if (issue.seed.id === current) button.setAttribute('aria-current', 'true');
    button.addEventListener('click', () => showNote(issue.seed.id));
    const why = document.createElement('span');
    why.className = 'fruitback-sidebar-meta';
    why.textContent = [
      statusOf(issue),
      ...(issue.identifier ? [issue.identifier] : []),
      t.text('sidebar.unplacedWhy'),
    ].join(' · ');
    button.append(words(issue.seed.note, 'fruitback-sidebar-lost-note'), why);
    row.append(button);

    return row;
  }

  /** « further down » follows the page while it scrolls under the list, one frame at most behind. */
  let frame = 0;
  function follow(): void {
    if (frame !== 0 || view === null) return;
    frame = view.requestAnimationFrame(() => {
      frame = 0;
      for (const mark of list.querySelectorAll<HTMLElement>('[data-fruitback-below]')) {
        mark.hidden = options.below?.(mark.dataset.fruitbackBelow ?? '') !== true;
      }
    });
  }

  function open(): void {
    if (!root.hidden) return;
    const active = deepActiveElement(document);
    opener = active !== null && active !== document.body ? (active as HTMLElement) : null;
    root.hidden = false;
    shell?.setAttribute('data-fruitback-listing', '');
    draw();
    (panel.querySelector<HTMLElement>('[data-fruitback-note]') ?? (failed.hidden ? close : retry)).focus();
    view?.addEventListener('scroll', follow, { passive: true });
    view?.addEventListener('resize', follow);
  }

  function stopFollowing(): void {
    view?.removeEventListener('scroll', follow);
    view?.removeEventListener('resize', follow);
    if (frame !== 0) view?.cancelAnimationFrame(frame);
    frame = 0;
  }

  function shut(): void {
    if (root.hidden) return;
    if (shown !== undefined) {
      options.onBack?.();
      showRows(false);
    }
    const active = deepActiveElement(document);
    const inside = active !== null && root.contains(active);
    root.hidden = true;
    stopFollowing();
    // Back to floating pins: the switch hides them while the list is open, and no longer.
    if (!pinsSwitch.checked) {
      pinsSwitch.checked = true;
      options.pins?.show(true);
    }
    // Before focus goes back: the dock is hidden while the list is open, and a hidden button takes none.
    shell?.removeAttribute('data-fruitback-listing');
    // Only when focus was in the list: a reviewer who clicked on the page keeps focus where they put it.
    if (inside && opener?.isConnected === true) opener.focus();
    opener = null;
  }

  close.addEventListener('click', shut);
  floating.addEventListener('click', shut);
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    // The thread closes on Escape from the document. This Escape is for the list only: from a
    // thread shown in place of the rows, it goes back to the rows (FRU-312).
    event.stopPropagation();
    if (shown === undefined) {
      shut();
      return;
    }
    options.onBack?.();
    showRows(true);
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
    mark() {
      if (root.hidden) return;
      const current = options.current?.();
      // The thread shown in place of the rows closed, by its cross or by a click on the page.
      if (shown !== undefined && current !== shown) showRows(focusWasHere());
      for (const row of panel.querySelectorAll<HTMLElement>('[data-fruitback-note]')) {
        if (row.dataset.fruitbackNote === current) row.setAttribute('aria-current', 'true');
        else row.removeAttribute('aria-current');
      }
    },
    destroy() {
      stopFollowing();
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside, true);
      shell?.removeAttribute('data-fruitback-listing');
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
  width: 392px;
  max-width: 100vw;
  box-sizing: border-box;
  border-inline-start: 1px solid var(--fruitback-color-border);
  background: var(--fruitback-color-surface);
  color: var(--fruitback-color-text);
  font: 14px/1.45 var(--fruitback-font-sans);
  /* The shadow of the board, cast over the page, which is at the start side of the list. */
  box-shadow: -10px 0 30px rgba(0, 0, 0, 0.06);
  animation: fruitback-sidebar-in var(--fruitback-duration-fast) ease-out;
}
.fruitback-sidebar:dir(rtl) { box-shadow: 10px 0 30px rgba(0, 0, 0, 0.06); }
.fruitback-sidebar[hidden] { display: none; }
@keyframes fruitback-sidebar-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.fruitback-sidebar-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding-block: 16px 12px;
  padding-inline: 18px 12px;
}
.fruitback-sidebar-heading { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; }
.fruitback-sidebar-heading .fruitback-icon { flex: none; width: 16px; height: 16px; color: var(--fruitback-color-accent); }
.fruitback-sidebar-title { flex: none; font-weight: 650; font-size: 15px; letter-spacing: -0.01em; }
/* anywhere: a host has no space to wrap at. */
.fruitback-sidebar-address { min-width: 0; font-size: 12px; color: var(--fruitback-color-text-muted); overflow-wrap: anywhere; }
.fruitback-sidebar-icon {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: var(--fruitback-radius-md);
  background: transparent;
  color: var(--fruitback-color-text-muted);
  cursor: pointer;
}
.fruitback-sidebar-icon .fruitback-icon { width: 17px; height: 17px; }
.fruitback-sidebar-close .fruitback-icon { width: 14px; height: 14px; }
.fruitback-sidebar-icon:hover { background: var(--fruitback-color-surface-sunken); color: var(--fruitback-color-text); }
.fruitback-sidebar button:focus-visible, .fruitback-sidebar input:focus-visible {
  outline: 2px solid var(--fruitback-color-accent);
  outline-offset: 2px;
}
.fruitback-sidebar-actions {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 0 18px 12px;
  border-bottom: 1px solid var(--fruitback-color-border);
}
/* The rail of the scope, with its one part drawn as the chosen tab of the board. */
.fruitback-sidebar-scope {
  margin: 0;
  padding: 3px;
  border-radius: var(--fruitback-radius-md);
  background: var(--fruitback-color-surface-sunken);
}
.fruitback-sidebar-scope > span {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 30px;
  border-radius: var(--fruitback-radius-field);
  background: var(--fruitback-color-surface);
  box-shadow: var(--fruitback-shadow-xs);
  font-size: 12px;
  font-weight: 600;
}
.fruitback-sidebar-search { position: relative; display: block; }
.fruitback-sidebar-search .fruitback-icon {
  position: absolute;
  inset-inline-start: 10px;
  top: 9px;
  width: 15px;
  height: 15px;
  color: var(--fruitback-color-text-muted);
  pointer-events: none;
}
.fruitback-sidebar-search-field {
  width: 100%;
  height: 34px;
  box-sizing: border-box;
  margin: 0;
  padding-block: 0;
  padding-inline: 32px 10px;
  border: 1px solid var(--fruitback-color-border-strong);
  border-radius: var(--fruitback-radius-sm);
  background: var(--fruitback-color-surface);
  color: var(--fruitback-color-text);
  font: 13px/1.45 var(--fruitback-font-sans);
}
.fruitback-sidebar-search-field::placeholder { color: var(--fruitback-color-text-muted); opacity: 1; }
.fruitback-sidebar-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.fruitback-sidebar-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--fruitback-color-border);
  border-radius: var(--fruitback-radius-pill);
  background: var(--fruitback-color-surface);
  color: var(--fruitback-color-text);
  font: 600 12px/1 var(--fruitback-font-sans);
  cursor: pointer;
}
.fruitback-sidebar-chip[hidden] { display: none; }
.fruitback-sidebar-chip[aria-pressed='true'] {
  border-color: var(--fruitback-color-text);
  background: var(--fruitback-color-surface-sunken);
}
.fruitback-sidebar-count { color: var(--fruitback-color-text-muted); font-weight: 500; }
.fruitback-sidebar-count:empty { display: none; }
/* The drop of a status, 9 px, the point down. */
.fruitback-sidebar-dot {
  width: 9px;
  height: 9px;
  border-radius: 50% 50% 50% 0;
  transform: rotate(-45deg);
  background: var(--fruitback-sidebar-stage);
  box-shadow: 0 0 0 1px var(--fruitback-color-stage-edge);
}
.fruitback-sidebar-panel {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px 12px;
}
.fruitback-sidebar-panel[hidden] { display: none; }
.fruitback-sidebar-empty { margin: 0; padding: 12px 10px; color: var(--fruitback-color-text-muted); }
.fruitback-sidebar-drafts { margin: 0 2px 6px; padding: 10px; border-radius: var(--fruitback-radius-md); box-shadow: inset 0 0 0 1px var(--fruitback-color-border); font-size: 13px; }
.fruitback-sidebar-drafts[hidden] { display: none; }
.fruitback-sidebar-drafts-title { margin: 0 0 6px; font-weight: 600; font-size: 12px; }
.fruitback-sidebar-drafts-list { margin: 0 0 10px; padding: 0; list-style: none; }
.fruitback-sidebar-draft { display: flex; flex-direction: column; gap: 2px; padding: 4px 0; list-style: none; }
.fruitback-sidebar-draft + .fruitback-sidebar-draft { border-top: 1px solid var(--fruitback-color-border); }
.fruitback-sidebar-empty[hidden] { display: none; }
.fruitback-sidebar-failed-text { margin: 0; padding: 12px 10px 8px; }
.fruitback-sidebar-failed-text:empty { padding: 0; }
.fruitback-sidebar-failed { padding: 0 10px; }
.fruitback-sidebar-failed[hidden] { display: none; }
.fruitback-sidebar-retry[aria-disabled='true'], .fruitback-sidebar-send[aria-disabled='true'] { opacity: 0.6; cursor: progress; }
.fruitback-sidebar-sent { margin: 0; padding: 0 10px 8px; font-size: 13px; }
.fruitback-sidebar-sent:empty { padding: 0; }
.fruitback-sidebar-retry, .fruitback-sidebar-send {
  padding: 6px 12px;
  border: 1px solid var(--fruitback-color-text-muted);
  border-radius: var(--fruitback-radius-sm);
  background: none;
  color: var(--fruitback-color-text);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.fruitback-sidebar-list { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.fruitback-sidebar-list[hidden] { display: none; }
.fruitback-sidebar-list > li, .fruitback-sidebar-unplaced-list > li { list-style: none; }
.fruitback-sidebar-item {
  display: flex;
  gap: 12px;
  width: 100%;
  box-sizing: border-box;
  padding: 12px;
  border: 0;
  border-radius: var(--fruitback-radius-md);
  background: none;
  color: var(--fruitback-color-text);
  font: inherit;
  text-align: start;
  /* A button that holds a note: its words wrap, against the rule of the labels (FRU-350). */
  white-space: normal;
  cursor: pointer;
}
.fruitback-sidebar-item:hover { background: var(--fruitback-color-surface-raised); }
/* The note whose thread is open: the card of the board. After the pointer, so it holds under it too. */
.fruitback-sidebar-item[aria-current='true'], .fruitback-sidebar-lost[aria-current='true'] {
  background: var(--fruitback-color-surface-warm);
  box-shadow: inset 0 0 0 1px var(--fruitback-color-border);
}
/* The drop of the pin, 24 px, the point down, with a white edge as on the page. */
.fruitback-sidebar-pin {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  box-sizing: border-box;
  margin-top: 2px;
  border: 2px solid #fff;
  border-radius: 50% 50% 50% 0;
  transform: rotate(-45deg);
  background: var(--fruitback-sidebar-stage);
  box-shadow: 0 0 0 1px var(--fruitback-color-stage-edge), 0 2px 6px rgba(24, 24, 27, 0.2);
}
.fruitback-sidebar-pin > span {
  transform: rotate(45deg);
  color: var(--fruitback-sidebar-on-stage);
  font: 700 11px/1 var(--fruitback-font-sans);
}
.fruitback-sidebar-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.fruitback-sidebar-top { display: flex; align-items: center; gap: 8px; font-size: 12px; line-height: 1.5; }
.fruitback-sidebar-status { font-weight: 600; letter-spacing: -0.006em; }
/* An identifier is a label: DEV-002 never breaks at its dash (FRU-350). */
.fruitback-sidebar-id { color: var(--fruitback-color-text-muted); white-space: nowrap; }
.fruitback-sidebar-age { margin-inline-start: auto; color: var(--fruitback-color-text-muted); white-space: nowrap; }
/* Two lines at most: the whole note is in its thread. */
.fruitback-sidebar-note {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.fruitback-sidebar-draft .fruitback-sidebar-note { display: block; }
.fruitback-sidebar-meta { color: var(--fruitback-color-text-muted); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.fruitback-sidebar-below[hidden] { display: none; }
.fruitback-sidebar-unplaced {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
  padding: 10px 8px 4px;
  border-top: 1px solid var(--fruitback-color-border);
}
.fruitback-sidebar-unplaced[hidden] { display: none; }
/* The title of the board, in capitals. Its words in the muted text, and its drop in the grey of a note with no place. */
.fruitback-sidebar-unplaced-title {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--fruitback-color-text-muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.fruitback-sidebar-unplaced-title .fruitback-icon { width: 12px; height: 15px; color: var(--fruitback-color-unplaced); }
.fruitback-sidebar-unplaced-list { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
/* A dashed card, as the board draws it: it still opens the thread of its note. */
.fruitback-sidebar-lost {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  box-sizing: border-box;
  padding: 10px 12px;
  border: 1px dashed var(--fruitback-color-unplaced);
  border-radius: var(--fruitback-radius-md);
  background: var(--fruitback-color-surface-warm);
  color: var(--fruitback-color-text);
  font: inherit;
  text-align: start;
  white-space: normal;
  cursor: pointer;
}
.fruitback-sidebar-lost:hover { background: var(--fruitback-color-surface-raised); }
.fruitback-sidebar-lost-note { overflow-wrap: anywhere; }
.fruitback-sidebar-actions[hidden], .fruitback-sidebar-detail[hidden] { display: none; }
/* The thread of a note in place of the rows (FRU-312): the way back, then the thread, which scrolls. */
.fruitback-sidebar-detail { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; }
.fruitback-sidebar-back {
  align-self: flex-start;
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 44px;
  margin: 6px 8px 0;
  padding: 0 10px;
  border: 0;
  border-radius: var(--fruitback-radius-md);
  background: none;
  color: var(--fruitback-color-text-subtle);
  font: 600 13px/1.45 var(--fruitback-font-sans);
  cursor: pointer;
}
.fruitback-sidebar-back:hover { background: var(--fruitback-color-surface-raised); color: var(--fruitback-color-text); }
.fruitback-sidebar-foot {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 18px 18px;
  border-top: 1px solid var(--fruitback-color-border);
}
.fruitback-sidebar-foot:empty { display: none; }
.fruitback-sidebar-leave {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 44px;
  border: 0;
  border-radius: var(--fruitback-radius-pill);
  background: var(--fruitback-color-accent);
  color: var(--fruitback-color-on-accent);
  font: 600 13px/1.45 var(--fruitback-font-sans);
  letter-spacing: -0.006em;
  cursor: pointer;
}
.fruitback-sidebar-leave[hidden] { display: none; }
/* The drop of the mark, taller than wide, as on the launch button. */
.fruitback-sidebar-leave .fruitback-icon { width: 12px; height: 15px; }
.fruitback-sidebar-leave:hover { background: var(--fruitback-color-accent-strong); }
/* A row of words and its switch, 32 × 18 as the board draws it: the whole row toggles it. */
.fruitback-sidebar-pins {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--fruitback-color-text-muted);
  font-size: 12px;
  cursor: pointer;
}
/* Off, the edge of a field and not the light grey of the kit: 3.42:1 on the surface shows where it is. */
.fruitback-sidebar-pins input {
  appearance: none;
  -webkit-appearance: none;
  flex: none;
  position: relative;
  width: 32px;
  height: 18px;
  margin: 0;
  border-radius: var(--fruitback-radius-pill);
  background: var(--fruitback-color-border-strong);
  cursor: pointer;
  transition: background var(--fruitback-duration-fast) var(--fruitback-ease-out);
}
.fruitback-sidebar-pins input::before {
  content: '';
  position: absolute;
  top: 2px;
  inset-inline-start: 2px;
  width: 14px;
  height: 14px;
  border-radius: var(--fruitback-radius-pill);
  background: var(--fruitback-color-surface);
  transition: transform var(--fruitback-duration-fast) var(--fruitback-ease-out);
}
.fruitback-sidebar-pins input:checked { background: var(--fruitback-color-text); }
.fruitback-sidebar-pins input:checked::before { transform: translateX(14px); }
.fruitback-sidebar-pins input:checked:dir(rtl)::before { transform: translateX(-14px); }
@media (forced-colors: active) {
  .fruitback-sidebar-pins input { border: 1px solid ButtonText; }
  .fruitback-sidebar-pins input::before { background: ButtonText; }
  .fruitback-sidebar-pins input:checked { background: Highlight; }
  .fruitback-sidebar-chip[aria-pressed='true'] { outline: 2px solid Highlight; }
}
@media (prefers-reduced-motion: reduce) {
  .fruitback-sidebar { animation: none; }
  .fruitback-sidebar-pins input, .fruitback-sidebar-pins input::before { transition: none; }
}
/* A sheet at the bottom of a phone, as before: the board draws no phone. */
@media (max-width: 480px) {
  .fruitback-sidebar {
    inset-block-start: auto;
    width: 100vw;
    max-height: 70vh;
    border-inline-start: 0;
    border-radius: var(--fruitback-radius-lg) var(--fruitback-radius-lg) 0 0;
  }
  .fruitback-sidebar-foot { padding-bottom: calc(18px + env(safe-area-inset-bottom)); }
}
/* A thumb, not a pointer (FRU-157): the buttons of the head, the chips and the field are 44 px. */
@media (pointer: coarse) {
  .fruitback-sidebar-icon { width: 44px; height: 44px; margin-block: -6px; }
  .fruitback-sidebar-close { margin-inline-end: -6px; }
  .fruitback-sidebar-chip, .fruitback-sidebar-search-field { min-height: 44px; }
  .fruitback-sidebar-search .fruitback-icon { top: 14px; }
  .fruitback-sidebar-pins { min-height: 44px; }
  .fruitback-sidebar-retry, .fruitback-sidebar-send { min-height: 44px; }
}
`;
