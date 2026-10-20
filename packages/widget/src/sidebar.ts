import { type SendFailure, failureText } from './composer.ts';
import { type Draft } from './drafts.ts';
import { type FeedbackEntry } from './export.ts';
import { deepActiveElement } from './focus.ts';
import { createIcon } from './icons.ts';
import { type MessageKey, type Translator, createTranslator, languageOf } from './messages.ts';
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
 * Since FRU-259 it is the list of the mock-up of 2026-10-13: three tabs, « Open », « Done » and
 * « All », a row for each note with the number its pin carries, and a section of its own for the
 * notes whose element is gone. **It lies over the page and does not push it**: the mock-up narrows
 * its example site, and a margin put on the page of somebody else breaks a layout nobody here read.
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
  document?: Document;
  /** The widget's words (FRU-37). Left out: English, with dates in this document's language. */
  translator?: Translator;
};

/** A note of the list: how it was found, and the number its pin carries (FRU-252). */
export type SidebarEntry = FeedbackEntry & { number?: number };

/** Enough of the note to know it. The whole note is in its thread. */
const EXCERPT_MAX_LENGTH = 90;

/**
 * Which notes a tab shows. « Open » is what is left to do: new, to do, in progress. « Done » is the
 * rest: done, and closed. A note is in one or the other, so « All » counts the two.
 */
const TABS = ['open', 'done', 'all'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL = {
  open: 'sidebar.tabOpen',
  done: 'sidebar.tabDone',
  all: 'sidebar.tabAll',
} as const satisfies Record<Tab, MessageKey>;
const DONE_STAGES: readonly string[] = ['ripe', 'composted'];

function inTab(tab: Tab, entry: SidebarEntry): boolean {
  if (tab === 'all') return true;

  return DONE_STAGES.includes(entry.issue.stage) === (tab === 'done');
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
  root.setAttribute('aria-labelledby', 'fruitback-sidebar-title');

  // A div, not a header: see `panel.ts` for why the chrome of the widget uses no generic tag.
  const head = document.createElement('div');
  head.className = 'fruitback-sidebar-head';
  const heading = document.createElement('div');
  heading.className = 'fruitback-sidebar-heading';
  const title = document.createElement('span');
  title.id = 'fruitback-sidebar-title';
  title.className = 'fruitback-sidebar-title';
  title.textContent = t.text('sidebar.dialog');
  // Which page: the host and the path, as the address bar writes them.
  const address = document.createElement('span');
  address.className = 'fruitback-sidebar-address';
  heading.append(title, address);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'fruitback-sidebar-close';
  close.setAttribute('aria-label', t.text('sidebar.close'));
  close.append(createIcon(document, 'close'));
  head.append(heading, close);

  const actions = document.createElement('div');
  actions.className = 'fruitback-sidebar-actions';
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
    actions.append(leave);
  }

  let tab: Tab = 'open';
  const tablist = document.createElement('div');
  tablist.className = 'fruitback-sidebar-tabs';
  tablist.setAttribute('role', 'tablist');
  tablist.setAttribute('aria-label', t.text('sidebar.tabs'));
  const tabs = new Map<Tab, HTMLButtonElement>();
  for (const name of TABS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = `fruitback-sidebar-tab-${name}`;
    button.className = 'fruitback-sidebar-tab';
    button.dataset.fruitbackTab = name;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', 'fruitback-sidebar-panel');
    // Focus too: a click gives a button no focus in every browser, and the row that had it may be
    // one the chosen tab does not show.
    button.addEventListener('click', () => choose(name, true));
    tabs.set(name, button);
    tablist.append(button);
  }
  actions.append(tablist);

  // What the chosen tab shows. It scrolls, and everything under the tabs is in it.
  const panel = document.createElement('div');
  panel.id = 'fruitback-sidebar-panel';
  panel.className = 'fruitback-sidebar-panel';
  panel.setAttribute('role', 'tabpanel');

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

  root.append(head, actions, panel, detail);
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
    const inThisTab = placed.filter((entry) => inTab(tab, entry));
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

    address.textContent = view === null ? '' : `${view.location.host}${view.location.pathname}`;
    for (const name of TABS) {
      const button = tabs.get(name) as HTMLButtonElement;
      const selected = name === tab;
      button.setAttribute('aria-selected', String(selected));
      // One stop for the three: the arrows go from one tab to the next.
      button.tabIndex = selected ? 0 : -1;
      // « Open 6 », one text, so the name of the tab reads with its space. No number while no read
      // answered: zero notes would be a guess.
      const word = t.text(TAB_LABEL[name]);
      const label = failing || !known ? word : `${word} ${placed.filter((entry) => inTab(name, entry)).length}`;
      if (button.textContent !== label) button.textContent = label;
    }
    panel.setAttribute('aria-labelledby', `fruitback-sidebar-tab-${tab}`);
    // The notes kept for later are what is left to do: at the head of « Open », and nowhere else.
    drawDrafts(tab === 'open');

    let nothing: 'sidebar.emptyTab' | 'sidebar.loading' | 'sidebar.empty' = 'sidebar.emptyTab';
    if (state === 'pending') nothing = 'sidebar.loading';
    else if (entries.length === 0) nothing = 'sidebar.empty';
    empty.textContent = t.text(nothing);
    empty.hidden = asking || inThisTab.length > 0;
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
    leave.hidden = signedOut;
    const leaving = !asking && failed.contains(active);
    failed.hidden = !asking;
    list.hidden = asking || inThisTab.length === 0;
    const current = options.current?.();
    list.replaceChildren(...(asking ? [] : inThisTab.map((entry) => item(entry, current))));
    unplaced.hidden = asking || detached.length === 0;
    unplacedWords.textContent = detached.length === 0 ? '' : t.text('sidebar.unplaced', { count: detached.length });
    unplacedList.replaceChildren(...(asking ? [] : detached.map((entry) => lost(entry, current))));
    // The read answered: focus goes to the first note, or to the close button of an empty list.
    if (leaving) (panel.querySelector<HTMLElement>('[data-fruitback-note]') ?? close).focus();

    if (focusedId !== undefined) {
      const again = [...panel.querySelectorAll<HTMLElement>('[data-fruitback-note]')].find(
        (button) => button.dataset.fruitbackNote === focusedId,
      );
      (again ?? close).focus();
    }
  }

  /** Another tab. Focus follows the choice: that is what the arrows are for, and a click says the same. */
  function choose(next: Tab, focus: boolean): void {
    tab = next;
    draw();
    if (focus) tabs.get(next)?.focus();
  }

  tablist.addEventListener('keydown', (event) => {
    const [back, forth] = t.direction === 'rtl' ? ['ArrowRight', 'ArrowLeft'] : ['ArrowLeft', 'ArrowRight'];
    const at = TABS.indexOf(tab);
    let to: number | undefined;
    if (event.key === forth) to = (at + 1) % TABS.length;
    else if (event.key === back) to = (at + TABS.length - 1) % TABS.length;
    else if (event.key === 'Home') to = 0;
    else if (event.key === 'End') to = TABS.length - 1;
    if (to === undefined) return;

    // The page must not scroll, and the capture mode must not move its cursor, on the same key.
    event.preventDefault();
    event.stopPropagation();
    choose(TABS[to] as Tab, true);
  });

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

    const meta = document.createElement('span');
    meta.className = 'fruitback-sidebar-meta';
    const who = issue.seed.reporter?.name ?? issue.seed.reporter?.email ?? t.text('thread.anonymous');
    const written = new Date(issue.seed.createdAt);
    const known = !Number.isNaN(written.getTime());
    const replies = issue.comments?.length ?? 0;
    meta.textContent = [
      // The store's own word for the state, like the thread, and the stage when it has none.
      issue.stateName || t.stage(issue.stage),
      who,
      known ? t.relative(written) : issue.seed.createdAt,
      ...(replies > 0 ? [t.plural('sidebar.replies', replies)] : []),
      ...(placement === 'approximate' ? [t.text('sidebar.approximate')] : []),
    ].join(' · ');
    if (known) meta.title = t.date(written);
    // Its own element: the page scrolls under the list, and only these words change then.
    const below = document.createElement('span');
    below.className = 'fruitback-sidebar-below';
    below.dataset.fruitbackBelow = issue.seed.id;
    below.textContent = ` · ${t.text('sidebar.below')}`;
    below.hidden = options.below?.(issue.seed.id) !== true;
    meta.append(below);

    button.append(pin, words(issue.seed.note, 'fruitback-sidebar-note'), meta);
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
    why.textContent = t.text('sidebar.unplacedWhy');
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
    // Before focus goes back: the dock is hidden while the list is open, and a hidden button takes none.
    shell?.removeAttribute('data-fruitback-listing');
    // Only when focus was in the list: a reviewer who clicked on the page keeps focus where they put it.
    if (inside && opener?.isConnected === true) opener.focus();
    opener = null;
  }

  close.addEventListener('click', shut);
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
  width: 380px;
  max-width: 100vw;
  border-inline-start: 1px solid var(--fruitback-color-border);
  background: var(--fruitback-color-surface);
  color: var(--fruitback-color-text);
  font: 14px/1.45 var(--fruitback-font-sans);
  box-shadow: var(--fruitback-shadow-lg);
  animation: fruitback-sidebar-in var(--fruitback-duration-fast) ease-out;
}
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
  padding-block: 12px;
  padding-inline: 18px 10px;
  border-bottom: 1px solid var(--fruitback-color-border);
}
.fruitback-sidebar-heading { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.fruitback-sidebar-title { font-weight: 600; font-size: 15px; }
/* anywhere: an address has no space to wrap at. */
.fruitback-sidebar-address { font-size: 12px; color: var(--fruitback-color-text-muted); overflow-wrap: anywhere; }
.fruitback-sidebar-close {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: 0;
  border-radius: var(--fruitback-radius-field);
  background: var(--fruitback-color-surface);
  color: var(--fruitback-color-text-muted);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}
.fruitback-sidebar-close:hover { background: var(--fruitback-color-surface-sunken); }
.fruitback-sidebar-actions { flex: none; display: flex; flex-direction: column; gap: 14px; padding: 14px 18px 0; }
.fruitback-sidebar-leave {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 40px;
  border: 0;
  border-radius: var(--fruitback-radius-pill);
  background: var(--fruitback-color-accent);
  color: var(--fruitback-color-on-accent);
  font: 600 13px/1.45 var(--fruitback-font-sans);
  letter-spacing: -0.006em;
  cursor: pointer;
}
/* The drop of the mark, taller than wide, as on the launch button. */
.fruitback-sidebar-leave[hidden] { display: none; }
.fruitback-sidebar-leave .fruitback-icon { width: 12px; height: 15px; }
.fruitback-sidebar-leave:hover { background: var(--fruitback-color-accent-strong); }
.fruitback-sidebar-tabs {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: var(--fruitback-radius-md);
  background: var(--fruitback-color-surface-sunken);
}
.fruitback-sidebar-tab {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  min-width: 0;
  border: 0;
  border-radius: var(--fruitback-radius-field);
  background: transparent;
  color: var(--fruitback-color-text-subtle);
  font: 600 13px/1.45 var(--fruitback-font-sans);
  cursor: pointer;
}
.fruitback-sidebar-tab[aria-selected='true'] {
  background: var(--fruitback-color-surface);
  color: var(--fruitback-color-text);
  box-shadow: var(--fruitback-shadow-xs);
}
.fruitback-sidebar-panel { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 10px 8px 16px; }
.fruitback-sidebar-empty { margin: 0; padding: 12px 10px; color: var(--fruitback-color-text-muted); }
.fruitback-sidebar-drafts { margin: 0 2px 10px; padding: 10px; border-radius: var(--fruitback-radius-md); box-shadow: inset 0 0 0 1px var(--fruitback-color-border); font-size: 13px; }
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
.fruitback-sidebar-list { margin: 0; padding: 0; list-style: none; }
.fruitback-sidebar-list[hidden] { display: none; }
.fruitback-sidebar-list > li, .fruitback-sidebar-unplaced-list > li { list-style: none; }
.fruitback-sidebar-list > li + li { margin-top: 2px; }
.fruitback-sidebar-item {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr);
  gap: 2px 10px;
  width: 100%;
  padding: 12px 10px;
  border: 0;
  border-radius: var(--fruitback-radius-md);
  background: none;
  color: var(--fruitback-color-text);
  text-align: start;
  cursor: pointer;
}
.fruitback-sidebar-item:hover, .fruitback-sidebar-lost:hover { background: var(--fruitback-color-surface-raised); }
/* The note whose thread is open. After the pointer, so it holds under it too. */
.fruitback-sidebar-item[aria-current='true'], .fruitback-sidebar-lost[aria-current='true'] {
  background: var(--fruitback-color-surface-sunken);
}
/* The silhouette of the pin, which is not in the scale and is not settable (see theme.ts). */
.fruitback-sidebar-pin {
  grid-row: span 2;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  margin-block-start: 2px;
  margin-inline-start: 2px;
  border-radius: 50% 50% 50% 0;
  transform: rotate(-90deg);
  background: var(--fruitback-sidebar-stage);
}
.fruitback-sidebar-pin > span {
  transform: rotate(90deg);
  color: var(--fruitback-sidebar-on-stage);
  font: 600 12px/1 var(--fruitback-font-sans);
}
/* Two lines at most, as the mock-up cuts it: the whole note is in its thread. */
.fruitback-sidebar-note {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.fruitback-sidebar-draft .fruitback-sidebar-note { display: block; }
.fruitback-sidebar-meta { color: var(--fruitback-color-text-muted); font-size: 12px; overflow-wrap: anywhere; }
.fruitback-sidebar-below[hidden] { display: none; }
.fruitback-sidebar-unplaced {
  margin: 18px 10px 0;
  padding-top: 14px;
  border-top: 1px solid var(--fruitback-color-border);
}
.fruitback-sidebar-unplaced[hidden] { display: none; }
.fruitback-sidebar-unplaced-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-weight: 600;
  font-size: 13px;
}
/* The dashed drop of a note with no place, in the amber the mock-up gives it. */
.fruitback-sidebar-unplaced-title .fruitback-icon { width: 12px; height: 15px; color: var(--fruitback-color-unplaced); }
.fruitback-sidebar-unplaced-list { margin: 0; padding: 0; list-style: none; }
.fruitback-sidebar-unplaced-list > li + li { margin-top: 10px; }
/* A button that reads as its text: the note and what became of it. The fill of a row, 8 px around
   the words, without moving them off the edge of the title. */
.fruitback-sidebar-lost {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: calc(100% + 16px);
  margin: -8px;
  padding: 8px;
  border: 0;
  border-radius: var(--fruitback-radius-md);
  background: none;
  color: var(--fruitback-color-text);
  text-align: start;
  cursor: pointer;
}
.fruitback-sidebar-lost-note { overflow-wrap: anywhere; }
.fruitback-sidebar-actions[hidden], .fruitback-sidebar-panel[hidden], .fruitback-sidebar-detail[hidden] { display: none; }
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
@media (prefers-reduced-motion: reduce) {
  .fruitback-sidebar { animation: none; }
}
/* A sheet at the bottom of a phone, as before: the mock-up draws no phone. */
@media (max-width: 480px) {
  .fruitback-sidebar {
    inset-block-start: auto;
    width: 100vw;
    max-height: 70vh;
    border-inline-start: 0;
    border-radius: var(--fruitback-radius-lg) var(--fruitback-radius-lg) 0 0;
  }
  .fruitback-sidebar-panel { padding-bottom: calc(16px + env(safe-area-inset-bottom)); }
}
/* A thumb, not a pointer (FRU-157): the close button and the tabs are 44 px, and the head keeps its height. */
@media (pointer: coarse) {
  .fruitback-sidebar-close { width: 44px; height: 44px; margin-block: -4px; margin-inline-end: -4px; }
  .fruitback-sidebar-leave, .fruitback-sidebar-tab { height: 44px; }
  .fruitback-sidebar-retry, .fruitback-sidebar-send { min-height: 44px; }
}
`;
