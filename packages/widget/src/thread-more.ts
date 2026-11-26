import type { NoteComment, NoteIssue, NoteStage, TrackerName } from '@fruitback/shared';
import { createIcon } from './icons.ts';
import { deepActiveElement } from './focus.ts';
import type { Translator } from './messages.ts';

/**
 * The menu « ⋯ » of the author in the head of a thread (FRU-605, board P3b): « Edit the note » and
 * « Copy link to the note ».
 *
 * Only the author sees it, and only while the note is open: `new`, `todo` or `progress`. A note at
 * `done` waits for the verdict of its author (FRU-603), and a `closed` note says nothing more. The
 * worker decides again for each action: `mine` and `editable` only say where to offer them.
 */
const OPEN_STAGES: ReadonlySet<NoteStage> = new Set(['new', 'todo', 'progress']);

/** Whether the reader sees the menu of the author on this note. */
export function authorMenuOffered(issue: NoteIssue): boolean {
  return issue.mine === true && OPEN_STAGES.has(issue.stage);
}

/**
 * The address that opens a note on its page (FRU-253): `#fruitback-note=<id>`, after the fragment of
 * the site when it has one, as `linkedNote` reads it.
 */
export function noteLink(url: string, id: string): string {
  const part = `fruitback-note=${encodeURIComponent(id)}`;
  const at = url.indexOf('#');
  if (at === -1) return `${url}#${part}`;

  return at === url.length - 1 ? `${url}${part}` : `${url}&${part}`;
}

/** The words of each `MoreSaid`. */
const SAID = {
  copied: 'more.copied',
  manual: 'more.copyManually',
  moved: 'move.done',
  moveFailed: 'move.failed',
  moveBusy: 'move.failedBusy',
} as const;

/** What the last action of the menu said, by note: the link copied, or the link to copy by hand. */
export type MoreSaid = 'copied' | 'manual' | 'moved' | 'moveFailed' | 'moveBusy';

/** What the menus of the threads share, by note: a menu is built again with its thread. */
export type MoreFooter = {
  said: Map<string, MoreSaid>;
  /** Opens the field of the edit (FRU-475). Left out: the worker does not offer an edit now. */
  edit?: () => void;
  /** The edit reads « Edit the text », for a visitor known by their browser (FRU-701). */
  editText?: true;
  /** The withdrawal reads « Delete the note », in red, for a visitor known by their browser (FRU-702). */
  deleteText?: true;
  /** Asks « Withdraw this note? » in the thread. Left out: the worker does not offer it now. */
  withdraw?: () => void;
  /** Starts the choice of a new element for the note (FRU-605). Left out: not offered now. */
  move?: () => void;
  /** Draws the thread again, with the focus on « ⋯ », or on the link to copy by hand. */
  settled: () => void;
};

/** « ⋯ » and its menu, with the keys of `wireMenu`. */
export function moreMenu(document: Document, issue: NoteIssue, t: Translator, more: MoreFooter): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'fruitback-thread-more-wrap';
  const id = `fruitback-thread-more-${issue.note.id}`;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'fruitback-thread-more';
  trigger.setAttribute('aria-label', t.text('more.open'));
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', id);
  trigger.append(createIcon(document, 'more'));

  const menu = document.createElement('ul');
  menu.className = 'fruitback-thread-more-menu';
  menu.id = id;
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', t.text('more.open'));
  menu.hidden = true;
  // Set by `wireMenu`, below: an item closes the menu before it runs.
  let close: (refocus: boolean) => void = () => undefined;

  const item = (
    key: `more.${'edit' | 'editText' | 'copyLink' | 'move' | 'withdraw' | 'delete'}`,
    run: () => void,
  ): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fruitback-thread-more-item';
    button.setAttribute('role', 'menuitem');
    button.tabIndex = -1;
    button.textContent = t.text(key);
    button.addEventListener('click', () => {
      // The focus goes back to « ⋯ » at once: the item it was on is hidden now, and the action may
      // take a while (a clipboard answers later).
      close(true);
      run();
    });
    const li = document.createElement('li');
    li.setAttribute('role', 'none');
    li.append(button);
    menu.append(li);

    return button;
  };

  /** « Withdraw the note », or for a visitor « Delete the note », in red (FRU-702). */
  const withdrawItem = (run: () => void): HTMLButtonElement => {
    if (more.deleteText !== true) return item('more.withdraw', run);
    const button = item('more.delete', run);
    button.dataset.fruitbackDanger = '';

    return button;
  };
  const { edit } = more;
  const items = [
    ...(edit === undefined ? [] : [item(more.editText === true ? 'more.editText' : 'more.edit', edit)]),
    item('more.copyLink', () => {
      const link = noteLink(issue.note.page.url, issue.note.id);
      void clipboardOf(document)
        .then((board) => board.writeText(link))
        .then((): MoreSaid => 'copied')
        .catch((): MoreSaid => 'manual')
        .then((said) => {
          more.said.set(issue.note.id, said);
          more.settled();
        });
    }),
    ...(more.move === undefined ? [] : [item('more.move', more.move)]),
    ...(more.withdraw === undefined ? [] : [withdrawItem(more.withdraw)]),
  ];

  close = wireMenu(document, { wrap, trigger, menu, items });
  wrap.append(trigger, menu);

  return wrap;
}

/** The parts of a menu of a thread: the button that opens it, the list, and its items in order. */
export type MenuParts = { wrap: HTMLElement; trigger: HTMLButtonElement; menu: HTMLElement; items: HTMLElement[] };

/**
 * The keys and the clicks of a menu of a thread (FRU-605), « ⋯ » and the status (FRU-718). The arrows
 * go from one item to the next, Home and End to the ends, Enter or Space takes one, Escape closes the
 * menu and gives the focus back to its button, Tab closes it and goes on. Escape stops there: the
 * thread stays open. `first`: the item the menu opens on, by the arrow down or a click. Answers what
 * closes the menu, with the focus back on its button or not.
 */
export function wireMenu(
  document: Document,
  { wrap, trigger, menu, items }: MenuParts,
  first = 0,
): (refocus: boolean) => void {
  function open(focus: 'first' | 'last'): void {
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    (focus === 'first' ? items[first] : items[items.length - 1])?.focus();
  }

  function close(refocus: boolean): void {
    if (menu.hidden) return;
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (refocus) trigger.focus();
  }

  trigger.addEventListener('click', () => {
    if (menu.hidden) open('first');
    else close(true);
  });
  trigger.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    open(event.key === 'ArrowDown' ? 'first' : 'last');
  });
  // On the whole of the menu and its button: while the menu is open, Escape closes the menu only. The
  // thread closes on an Escape that reaches the document.
  wrap.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || menu.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  });
  menu.addEventListener('keydown', (event) => {
    const { key } = event;
    if (key === 'Tab') {
      close(false);

      return;
    }
    const at = items.indexOf(deepActiveElement(document) as HTMLElement);
    const next: Record<string, number> = {
      ArrowDown: (at + 1) % items.length,
      ArrowUp: (at - 1 + items.length) % items.length,
      Home: 0,
      End: items.length - 1,
    };
    if (next[key] === undefined) return;
    event.preventDefault();
    items[next[key]]?.focus();
  });
  // The focus leaves the menu and its button: the menu closes, as a click out of it does.
  wrap.addEventListener('focusout', (event) => {
    const to = (event as FocusEvent).relatedTarget;
    if (to !== null && wrap.contains(to as Node)) return;
    close(false);
  });

  return close;
}

async function clipboardOf(document: Document): Promise<Clipboard> {
  const clipboard = document.defaultView?.navigator?.clipboard;
  if (clipboard === undefined) throw new Error('no clipboard');

  return clipboard;
}

/**
 * What « Copy link to the note » said, under the text of the note. A clipboard can refuse: no
 * permission, no secure context, or a browser that has none. The link then shows in a field, selected,
 * to copy by hand. A copy that fails with nothing to see reads as a copy that worked.
 */
export function moreSaid(
  document: Document,
  issue: NoteIssue,
  t: Translator,
  more: MoreFooter | undefined,
): HTMLElement[] {
  const said = more?.said.get(issue.note.id);
  if (said === undefined) return [];
  const line = document.createElement('p');
  line.className = 'fruitback-thread-more-said';
  line.setAttribute('role', 'status');
  line.textContent = t.text(SAID[said]);
  if (said !== 'manual') return [line];

  const field = document.createElement('input');
  field.className = 'fruitback-thread-more-link';
  field.readOnly = true;
  field.value = noteLink(issue.note.page.url, issue.note.id);
  field.setAttribute('aria-label', t.text('more.linkLabel'));
  field.addEventListener('focus', () => field.select());

  return [line, field];
}

/** Why a withdrawal did not go (FRU-605). `refused`: the worker takes none of this note any more. */
export type WithdrawFailure = 'retry' | 'wait' | 'signed-out' | 'refused';

/** What the store kept of a withdrawal: the stage of the note now, and the reply that says so. */
export type WithdrawAnswer = { stage: NoteStage; comment?: NoteComment };

/** A seam like the edit's (FRU-605): the overlay does not know the worker. */
export type WithdrawSeam = { send(issue: NoteIssue): Promise<WithdrawAnswer | WithdrawFailure> };

/** What the withdrawals of the notes share, by note: a block is built again with its thread. */
export type WithdrawFooter = {
  seam: WithdrawSeam;
  /** The notes whose question « Withdraw this note? » is open. */
  asking: Set<string>;
  inFlight: Set<string>;
  said: Map<string, string>;
  /** Draws the thread again; with `kept`, the pins too, with this thread kept open. */
  settled: (issue: NoteIssue, focus: 'confirm' | 'said' | 'more', kept?: WithdrawAnswer) => void;
  /**
   * The reader is a visitor known by their browser (FRU-702): the question is « Delete your note? »,
   * and says that the pin goes, and what the tracker of the note does with it, when it has one.
   */
  deletes?: { tracker?: TrackerName };
};

const WITHDRAW_FAILURES = {
  retry: 'withdraw.failed',
  wait: 'withdraw.failedWait',
  'signed-out': 'withdraw.failedSignedOut',
  refused: 'withdraw.refused',
} as const;

/** The words of a deletion by a visitor (FRU-702). A `401` is a key the worker does not know: try again. */
const DELETE_FAILURES = {
  retry: 'delete.failed',
  wait: 'withdraw.failedWait',
  'signed-out': 'delete.failed',
  refused: 'delete.refused',
} as const;

/**
 * « Withdraw this note? », with « Withdraw » and « Keep it », under the text of the note (FRU-605).
 * A withdrawal closes the note for the team, so it is asked first. After it, one line says it was
 * done, in the thread it was done in.
 */
export function withdrawBlock(
  document: Document,
  issue: NoteIssue,
  t: Translator,
  withdraw: WithdrawFooter | undefined,
): HTMLElement[] {
  if (withdraw === undefined) return [];
  const id = issue.note.id;
  const said = withdraw.said.get(id);
  if (!withdraw.asking.has(id)) {
    if (said === undefined) return [];
    const line = document.createElement('p');
    line.className = 'fruitback-thread-withdraw-said';
    line.setAttribute('role', 'status');
    line.tabIndex = -1;
    line.textContent = said;

    return [line];
  }

  const block = document.createElement('div');
  block.className = 'fruitback-thread-withdraw';
  const askId = `fruitback-withdraw-${id}`;
  const ask = document.createElement('p');
  ask.className = 'fruitback-thread-withdraw-ask';
  ask.id = askId;
  const { deletes } = withdraw;
  ask.textContent = t.text(deletes === undefined ? 'withdraw.ask' : 'delete.ask');
  const detail: HTMLElement[] = [];
  if (deletes !== undefined) {
    const said = document.createElement('p');
    said.className = 'fruitback-thread-withdraw-detail';
    said.textContent =
      deletes.tracker === undefined
        ? t.text('delete.detailOwn')
        : t.text('delete.detail', { tracker: deletes.tracker });
    detail.push(said);
  }
  const sending = withdraw.inFlight.has(id);
  const sendingWords = t.text(deletes === undefined ? 'withdraw.sending' : 'delete.sending');
  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = 'fruitback-thread-withdraw-confirm';
  confirm.textContent = sending ? sendingWords : t.text(deletes === undefined ? 'withdraw.confirm' : 'delete.confirm');
  confirm.disabled = sending;
  const keep = document.createElement('button');
  keep.type = 'button';
  keep.className = 'fruitback-thread-withdraw-keep';
  keep.textContent = t.text('withdraw.keep');
  keep.disabled = sending;
  const actions = document.createElement('div');
  actions.className = 'fruitback-thread-withdraw-actions';
  actions.setAttribute('role', 'group');
  actions.setAttribute('aria-labelledby', askId);
  actions.append(confirm, keep);
  const status = document.createElement('span');
  status.className = 'fruitback-thread-withdraw-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent = sending ? sendingWords : (said ?? '');

  keep.addEventListener('click', () => {
    withdraw.asking.delete(id);
    withdraw.said.delete(id);
    withdraw.settled(issue, 'more');
  });
  confirm.addEventListener('click', () => {
    if (withdraw.inFlight.has(id)) return;
    withdraw.inFlight.add(id);
    withdraw.said.delete(id);
    withdraw.settled(issue, 'confirm');
    void withdraw.seam
      .send(issue)
      .catch((): WithdrawFailure => 'retry')
      .then((answer) => {
        withdraw.inFlight.delete(id);
        if (typeof answer === 'string') {
          withdraw.said.set(id, t.text((deletes === undefined ? WITHDRAW_FAILURES : DELETE_FAILURES)[answer]));
          withdraw.settled(issue, 'confirm');

          return;
        }
        withdraw.asking.delete(id);
        withdraw.said.set(id, t.text(deletes === undefined ? 'withdraw.done' : 'delete.done'));
        withdraw.settled(issue, 'said', answer);
      });
  });
  block.append(ask, ...detail, actions, status);

  return [block];
}

/** The stage the store answers, and the reply of the withdrawal once, on the issue on screen. */
export function applyWithdraw(issue: NoteIssue, answer: WithdrawAnswer): void {
  const { comment } = answer;
  if (comment !== undefined && issue.comments !== undefined && !issue.comments.some((each) => each.id === comment.id)) {
    issue.comments = [...issue.comments, comment];
  }
  if (answer.stage !== issue.stage) {
    issue.stage = answer.stage;
    // The store's word was for the stage of before: the stage says it until the next read.
    issue.stateName = '';
  }
  delete issue.editable;
  delete issue.withdrawable;
}
