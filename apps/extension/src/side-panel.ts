import { language, msg, t } from './i18n.ts';
import { dropMark, primaryButton, segmentedTabs, statusDrop } from './kit.ts';
import type { CheckVerdict, NotesReading, PanelNote, ReplyOutcome } from './protocol.ts';

/**
 * The side panel of the browser (FRU-296, FRU-299): its place in the manifest, the gesture that
 * opens it, and « Notes on this page », as `ExtSidebar` of the mock-up of 2026-10-20 draws it.
 *
 * **The panel reads no worker.** The widget of the tab holds the notes it read for its pins; the
 * panel asks it for them (`notes`), and is told when they change. One read, the same numbers as the
 * pins, no second model and no cache.
 *
 * No `browser` here: the APIs come in as arguments, so `side-panel.test.ts` reads every part under
 * `node --test`. `entrypoints/sidepanel/main.ts` holds the state and binds them.
 */

/**
 * The two shapes of the API, as each browser names it. Chrome: `chrome.sidePanel` (`sidePanel`
 * permission, `side_panel.default_path`). Firefox: `browser.sidebarAction` (`sidebar_action`).
 */
export type PanelApis = {
  sidePanel?: {
    open(options: { tabId?: number; windowId?: number }): Promise<void>;
    setPanelBehavior?(behavior: { openPanelOnActionClick: boolean }): Promise<void>;
  };
  sidebarAction?: { open(): Promise<void> };
};

/**
 * Opens the panel of the browser, from the click that called it.
 *
 * **Call it before any `await` of the click.** Both browsers open the panel only inside the
 * handler of a gesture of the person, and an `await` before the call drops the gesture: Chrome then
 * rejects with « may only be called in response to a user gesture ».
 *
 * Answers `undefined` when the browser has no panel to open, and the promise of the browser
 * otherwise, so that a refusal is reported.
 */
export function openPanel(apis: PanelApis, where: { tabId?: number; windowId?: number }): Promise<void> | undefined {
  if (apis.sidePanel !== undefined) {
    // Chrome opens the panel of the whole window when it has no panel for this tab alone, which is
    // the case here: the manifest declares one global panel, and it follows the active tab.
    return where.tabId !== undefined
      ? apis.sidePanel.open({ tabId: where.tabId })
      : apis.sidePanel.open({ windowId: where.windowId ?? -2 });
  }
  if (apis.sidebarAction !== undefined) return apis.sidebarAction.open();

  return undefined;
}

/**
 * The panel, or the list of the page when the browser has no panel or refuses to open it (a Firefox
 * that does not take the gesture, a Chrome that throws): what was asked is shown either way.
 * `openPanel` is called first, in the click. Answers what was shown, or `nothing` when the page did
 * not answer either.
 */
export async function openPanelOrPage(
  apis: PanelApis,
  where: { tabId?: number; windowId?: number },
  inPage: () => Promise<boolean>,
): Promise<'panel' | 'page' | 'nothing'> {
  let opened: Promise<void> | undefined;
  try {
    opened = openPanel(apis, where);
  } catch (error) {
    opened = Promise.reject(error);
  }
  if (opened !== undefined) {
    try {
      await opened;

      return 'panel';
    } catch (error) {
      console.error('[fruitback] the side panel did not open', error);
    }
  }

  return (await inPage()) ? 'page' : 'nothing';
}

/** The storage key of the preference « Open notes in the sidebar » (FRU-302). */
export const PANEL_ON_CLICK_KEY = 'openNotesInSidebar';

/**
 * What the click on the icon opens (FRU-302): the panel when the person asked for it and the tab is
 * a site that is on; the popup everywhere else, which is where a site is turned on. Chrome keeps
 * one behaviour for the whole browser, so the background sets it again when the tab changes.
 */
/**
 * Whether the click on the icon opens the panel (FRU-302): asked for, on a site that is on, and whose
 * session is held. A site of the workspace whose session ended opens the popup, which is where the
 * person signs in again: the panel would only say so, and the icon would never reach the popup
 * (raised in review).
 */
export function iconOpensPanel(
  wanted: boolean,
  site: { enabled: boolean } | undefined,
  sessionWanted: boolean,
): boolean {
  return wanted && site?.enabled === true && !sessionWanted;
}

export async function setPanelOnClick(apis: PanelApis, wanted: boolean, siteOn: boolean): Promise<void> {
  await apis.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: wanted && siteOn });
}

/**
 * The click on the toolbar icon keeps the popup. The panel opens from the popup, and later from the
 * preference « Open notes in the sidebar » (FRU-302). Chrome's default is the same; it is written
 * here so that the choice is in the code, not in a default that can change.
 */
export async function keepPopupOnActionClick(apis: PanelApis): Promise<void> {
  await apis.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false });
}

/** What the panel shows: why it shows nothing, or the notes of the site of the tab. */
export type PanelState =
  /** A page of the browser, a site with no rule, a rule that is off, a site with no access. */
  | { kind: 'not-on' }
  /**
   * A site in team mode that embeds its own widget (FRU-57): the widget is the site's, and answers
   * the extension nothing. Its notes are in its own list, on the page (raised in review).
   */
  | { kind: 'site-widget'; host: string }
  | {
      kind: 'on';
      host: string;
      /** What the foot says after the host: the workspace of the rule, when it has one. */
      where?: string;
      /** The notes, or where their read is (`notesOf`). */
      notes: PanelNotes;
    };

export type NotesTab = 'open' | 'done';

/**
 * The notes, or where their read is. `reading`: the widget has not read yet, or is not mounted yet;
 * it says when it has. `failed`: its read failed. `signed-out`: the session of the site ended (FRU-315). `reload`: nothing on the page answers, a page open
 * before the site was turned on. `not-started`: the page answers, but still has no widget after
 * `NO_WIDGET_WAIT_MS` (a mount that threw, a widget taken down): reloading the page mounts it again.
 */
export type PanelNotes = PanelNote[] | 'reading' | 'failed' | 'reload' | 'signed-out' | 'not-started';

/**
 * How long the panel waits for a widget the page does not have yet (raised in review). A widget
 * that mounts says so (`notes-changed`) well before; one that does not would leave the panel on
 * « Reading… » for ever. After it, the panel asks once more, and says to reload the page.
 */
export const NO_WIDGET_WAIT_MS = 4000;

/**
 * What an answer to `notes` says (raised in review): the notes, or why there are none. No answer at
 * all is a page with no bridge. The panel does not ask again on a timer: the widget says when it has
 * read (`notes-changed`).
 */
export function notesOf(
  answer: { notes?: PanelNote[]; reading?: NotesReading } | undefined,
  waited = false,
): PanelNotes {
  if (answer === undefined) return 'reload';
  if (answer.notes !== undefined) return answer.notes;

  if (answer.reading === 'failed' || answer.reading === 'signed-out') return answer.reading;
  // Still no widget once `NO_WIDGET_WAIT_MS` has passed: it will not come by itself.
  if (answer.reading === 'no-widget' && waited) return 'not-started';

  return 'reading';
}

/**
 * The row a click on a pin asked for, once a list is read (raised in review). The id waits for a
 * list that holds its note: `open` is the row to open, `waiting` what still waits.
 */
export function openOnRead(asked: string | undefined, notes: PanelNotes): { open?: PanelNote; waiting?: string } {
  if (asked === undefined) return {};
  if (!Array.isArray(notes)) return { waiting: asked };
  const note = notes.find((each) => each.id === asked);

  return note === undefined ? {} : { open: note };
}

export type PanelOptions = {
  state: PanelState;
  /** The tab of the list. */
  tab: NotesTab;
  /** The note whose row is open. */
  open?: string;
  /** The note whose reply field is open, and what is written in it. */
  replying?: { id: string; text: string; sending?: boolean; problem?: string };
  /** The note whose verdict is on its way, or why the last one did not go (FRU-300). */
  checking?: { id: string; sending?: CheckVerdict; problem?: string };
  /** The notes the reader reopened from this panel, and when: their rows say so (FRU-300). */
  reopened?: Record<string, string>;
  /** Now, for the ages: a test sets it. */
  now?: number;
  onClose: () => void;
  onLeave: () => void;
  onTab: (tab: NotesTab) => void;
  onToggle: (id: string) => void;
  onShow: (id: string) => void;
  onReplyOpen: (id: string) => void;
  onReplyInput: (text: string) => void;
  onReplySend: () => void;
  onReplyCancel: () => void;
  onRetry: () => void;
  onReload: () => void;
  onSettings: () => void;
  onVerdict: (id: string, verdict: CheckVerdict) => void;
};

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

function linkButton(document: Document, label: string, onClick: () => void): HTMLButtonElement {
  const node = make(document, 'button', 'panel-link', label);
  node.type = 'button';
  node.addEventListener('click', onClick);

  return node;
}

const SVG = 'http://www.w3.org/2000/svg';

/** The cross of « Close the sidebar », 15 px, in the colour of its button. */
function cross(document: Document): SVGSVGElement {
  const drawing = document.createElementNS(SVG, 'svg');
  drawing.setAttribute('viewBox', '0 0 16 16');
  drawing.setAttribute('aria-hidden', 'true');
  drawing.setAttribute('class', 'panel-cross');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', 'M3.5 3.5 L12.5 12.5 M12.5 3.5 L3.5 12.5');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.8');
  path.setAttribute('stroke-linecap', 'round');
  drawing.append(path);

  return drawing;
}

/** The word of each stage: the widget's words, as the popup says them. */
const STAGE_WORD: Record<PanelNote['stage'], string> = {
  seeded: msg('New'),
  green: msg('To do'),
  ripening: msg('In progress'),
  ripe: msg('Done'),
  composted: msg('Closed'),
};

/** « Open » is what is left to do: new, to do, in progress. « Done » is done and closed. */
export function tabOf(note: PanelNote): NotesTab {
  return note.stage === 'ripe' || note.stage === 'composted' ? 'done' : 'open';
}

/**
 * A note the reader left that the team marked done, and that nobody confirmed (FRU-300): it waits in
 * « Ready to check », and not in « Done ». `mine` and `checked` are the worker's word (FRU-294).
 */
export function toCheck(note: PanelNote): boolean {
  return note.stage === 'ripe' && note.mine === true && note.checked === undefined;
}

/** The order of the pins: by their number, the notes with no number last. */
function byNumber(a: PanelNote, b: PanelNote): number {
  return (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER);
}

const UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

/** « just now », « 1 day ago », in the language of the reader. Nothing for a date that does not parse. */
export function ageOf(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const seconds = Math.round((then - now) / 1000);
  if (Math.abs(seconds) < 60) return t('just now');
  const format = new Intl.RelativeTimeFormat(language(), { numeric: 'auto', style: 'long' });
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }

  return format.format(0, 'second');
}

/** Who wrote a note: « You », the name they gave, or « Anonymous ». */
function authorOf(note: PanelNote): string {
  if (note.mine === true) return t('You');
  const name = note.author?.trim();

  return name === undefined || name === '' ? t('Anonymous') : name;
}

/** What a row says after its stage: who checked or reopened it, or who wrote it when. */
function saidOf(note: PanelNote, now: number, reopenedAt: string | undefined): string {
  if (note.checked !== undefined && note.stage === 'ripe') {
    return note.mine === true
      ? t('Checked by you · {age}', { age: ageOf(note.checked.at, now) })
      : t('Checked by {name} · {age}', { name: note.checked.by, age: ageOf(note.checked.at, now) });
  }
  if (reopenedAt !== undefined && tabOf(note) === 'open') {
    return t('Reopened by you · {age}', { age: ageOf(reopenedAt, now) });
  }

  return `${authorOf(note)} · ${ageOf(note.createdAt, now)}`;
}

/** The page of the panel. */
export function panelPage(document: Document, options: PanelOptions): HTMLElement {
  const root = make(document, 'div', 'side-panel');
  const top = make(document, 'header', 'panel-head');
  const title = make(document, 'h2', 'panel-title', t('Notes on this page'));
  title.id = 'panel-title';
  const close = make(document, 'button', 'panel-close');
  close.type = 'button';
  close.setAttribute('aria-label', t('Close the sidebar'));
  close.append(cross(document));
  close.addEventListener('click', options.onClose);
  top.append(title, close);
  root.append(top);

  const { state } = options;
  if (state.kind === 'not-on' || state.kind === 'site-widget') {
    const body = make(document, 'section', 'panel-state');
    body.setAttribute('aria-labelledby', title.id);
    body.append(
      ...(state.kind === 'not-on'
        ? [
            make(document, 'p', 'panel-state-title', t('Fruitback is not on for this page.')),
            make(document, 'p', 'panel-state-text', t('Turn it on from the Fruitback button in the toolbar.')),
          ]
        : [
            make(document, 'p', 'panel-state-title', t('{host} runs its own Fruitback.', { host: state.host })),
            make(
              document,
              'p',
              'panel-state-text',
              t('Its notes are on the page, in its own list. This panel lists the notes of a site Fruitback mounts.'),
            ),
          ]),
    );
    root.append(body);

    return root;
  }

  // « Leave feedback », and what to do next.
  const action = make(document, 'div', 'panel-action');
  const leave = primaryButton(document, t('Leave feedback'), options.onLeave, { size: 'panel' });
  leave.prepend(dropMark(document));
  action.append(leave, make(document, 'p', 'panel-hint', t('Then click the part of the page you want to comment on')));
  root.append(action);

  const main = make(document, 'section', 'panel-notes');
  main.setAttribute('aria-labelledby', title.id);
  main.append(...notesPart(document, options, state.notes));
  root.append(main);

  const foot = make(document, 'footer', 'panel-foot');
  foot.append(
    make(document, 'span', 'panel-where', state.where === undefined ? state.host : `${state.host} · ${state.where}`),
    linkButton(document, t('Settings'), options.onSettings),
  );
  root.append(foot);

  return root;
}

/** The list part: reading, failed, empty, or the tabs and the rows. */
function notesPart(document: Document, options: PanelOptions, notes: PanelNotes): Node[] {
  if (notes === 'reading') {
    const line = make(document, 'p', 'panel-reading', t('Reading the notes of this page…'));
    line.setAttribute('role', 'status');

    return [line];
  }
  if (notes === 'signed-out') {
    const line = make(
      document,
      'p',
      'panel-reading',
      t('Your session ended. Sign in again from the Fruitback button.'),
    );
    line.setAttribute('role', 'status');

    return [line];
  }
  if (notes === 'reload') {
    const box = make(document, 'div', 'panel-failed');
    box.append(
      make(document, 'p', '', t('This page was open before Fruitback was on. Reload it to see its notes.')),
      linkButton(document, t('Reload the page'), options.onReload),
    );

    return [box];
  }
  if (notes === 'not-started') {
    const box = make(document, 'div', 'panel-failed');
    box.append(
      make(document, 'p', '', t('Fruitback did not start on this page. Reload it to see its notes.')),
      linkButton(document, t('Reload the page'), options.onReload),
    );

    return [box];
  }
  if (notes === 'failed') {
    const box = make(document, 'div', 'panel-failed');
    box.setAttribute('role', 'alert');
    box.append(
      make(document, 'p', '', t('The notes of this page could not be read. They are not lost.')),
      linkButton(document, t('Try again'), options.onRetry),
    );

    return [box];
  }
  if (notes.length === 0) {
    const empty = make(document, 'div', 'panel-empty');
    const drop = make(document, 'span', 'panel-empty-drop');
    drop.setAttribute('aria-hidden', 'true');
    empty.append(
      drop,
      make(document, 'p', 'panel-empty-title', t('No notes on this page yet')),
      make(
        document,
        'p',
        'panel-empty-text',
        t(
          'Press Leave feedback, click anything that looks wrong and write what you expected. The team gets it right away.',
        ),
      ),
    );

    return [empty];
  }

  const ready = notes.filter(toCheck).sort(byNumber);
  const open = notes.filter((note) => tabOf(note) === 'open').sort(byNumber);
  // A note to check waits in its block, not in « Done ».
  const done = notes.filter((note) => tabOf(note) === 'done' && !toCheck(note)).sort(byNumber);
  const tabs = segmentedTabs(document, {
    label: t('Notes on this page'),
    size: 'panel',
    tabs: [
      { id: 'open', label: t('Open · {count}', { count: open.length }) },
      { id: 'done', label: t('Done · {count}', { count: done.length }) },
    ],
    selected: options.tab,
    onSelect: (id) => options.onTab(id === 'done' ? 'done' : 'open'),
  });
  tabs.classList.add('panel-tabs');
  const shown = options.tab === 'done' ? done : open;
  const list = make(document, 'ul', 'panel-list');
  list.setAttribute('role', 'tabpanel');
  list.setAttribute('aria-label', options.tab === 'done' ? t('Done notes') : t('Open notes'));
  for (const note of shown) list.append(noteRow(document, options, note));
  const parts: Node[] = ready.length > 0 ? [readyBlock(document, options, ready), tabs, list] : [tabs, list];
  if (shown.length === 0) {
    parts.push(
      make(document, 'p', 'panel-none', options.tab === 'done' ? t('No note is done yet.') : t('No note is open.')),
    );
  }

  return parts;
}

/** A row: the drop with the number of the pin, the note, and who wrote it when. Open: the rest. */
function noteRow(document: Document, options: PanelOptions, note: PanelNote): HTMLLIElement {
  const now = options.now ?? Date.now();
  const opened = options.open === note.id;
  const row = make(document, 'li', 'panel-row');
  row.dataset.note = note.id;
  if (opened) row.dataset.open = 'true';

  const head = make(document, 'button', 'panel-row-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', String(opened));
  head.addEventListener('click', () => options.onToggle(note.id));
  const drop = statusDrop(document, {
    stage: note.stage,
    ...(note.number === undefined ? {} : { number: note.number }),
  });
  if (note.number === undefined) drop.dataset.size = 'list';
  const words = make(document, 'span', 'panel-row-words');
  const meta = make(document, 'span', 'panel-row-meta');
  const reopenedAt = options.reopened?.[note.id];
  // FRU-300: a verdict says itself on its row: the store moved the note, the panel names who did.
  meta.append(
    make(document, 'strong', 'panel-row-stage', t(STAGE_WORD[note.stage])),
    ` · ${saidOf(note, now, reopenedAt)}`,
  );
  words.append(make(document, 'span', 'panel-row-note', note.note), meta);
  head.append(drop, words);
  row.append(head);
  if (!opened) return row;

  const more = make(document, 'div', 'panel-row-more');
  if (note.replies.length > 0) {
    const replies = make(document, 'ul', 'panel-replies');
    replies.setAttribute('aria-label', t('Replies'));
    for (const reply of note.replies) {
      const item = make(document, 'li', 'panel-reply');
      const who = make(document, 'span', 'panel-reply-meta');
      const name = reply.author?.trim();
      who.append(
        make(document, 'strong', '', name === undefined || name === '' ? t('Anonymous') : name),
        ` · ${ageOf(reply.createdAt, now)}`,
      );
      item.append(who, make(document, 'span', 'panel-reply-body', reply.body));
      replies.append(item);
    }
    more.append(replies);
  }
  const links = make(document, 'div', 'panel-row-links');
  links.append(linkButton(document, t('Show on the page'), () => options.onShow(note.id)));
  const replying = options.replying?.id === note.id ? options.replying : undefined;
  if (note.canReply && replying === undefined) {
    const reply = linkButton(document, t('Reply'), () => options.onReplyOpen(note.id));
    // The panel gives the focus back here once a reply is sent.
    reply.dataset.action = 'reply';
    links.append(reply);
  }
  more.append(links);
  if (note.canReply && replying !== undefined) more.append(replyForm(document, options, replying));
  row.append(more);

  return row;
}

const SVG_CHECK = 'M3.5 8.5 L6.5 11.5 L12.5 4.5';

/** The tick of « Looks fixed », 15 px. */
function tick(document: Document): SVGSVGElement {
  const drawing = document.createElementNS(SVG, 'svg');
  drawing.setAttribute('viewBox', '0 0 16 16');
  drawing.setAttribute('aria-hidden', 'true');
  drawing.setAttribute('class', 'ready-tick');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', SVG_CHECK);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.8');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  drawing.append(path);

  return drawing;
}

/**
 * Who marked a note done, as its replies say: the author of the newest reply of the tracker, never one
 * written from a page, or nobody known.
 */
function fixedLine(note: PanelNote, now: number): string {
  // A reply written from a page carries a name the page typed: it says nobody fixed anything (review).
  const last = [...note.replies]
    .reverse()
    .find((reply) => reply.fromPage !== true && (reply.author ?? '').trim() !== '');
  if (last?.author !== undefined) {
    return t('Fixed by {name} · {age}', { name: last.author.trim(), age: ageOf(last.createdAt, now) });
  }

  return t('Marked done · {age}', { age: ageOf(note.updatedAt, now) });
}

/**
 * « Ready to check » (FRU-300): the notes of the reader that the team says are fixed, each with
 * « Looks fixed » and « Still wrong ». After a verdict the panel reads the page again: the store
 * moved the note, and the list says where it is now. Nothing moves before that.
 */
function readyBlock(document: Document, options: PanelOptions, ready: PanelNote[]): HTMLElement {
  const now = options.now ?? Date.now();
  const block = make(document, 'section', 'ready');
  const title = make(document, 'h3', 'ready-title', t('Ready to check · {count}', { count: ready.length }));
  title.id = 'ready-title';
  block.setAttribute('aria-labelledby', title.id);
  block.append(
    title,
    make(document, 'p', 'ready-text', t('The team says these are fixed. Do they look right to you?')),
  );
  const list = make(document, 'ul', 'ready-list');
  for (const note of ready) {
    const item = make(document, 'li', 'ready-item');
    item.dataset.note = note.id;
    const head = make(document, 'div', 'ready-head');
    const words = make(document, 'div', 'ready-words');
    words.append(
      make(document, 'span', 'ready-note', note.note),
      make(document, 'span', 'ready-meta', fixedLine(note, now)),
    );
    head.append(
      statusDrop(document, { stage: 'ripe', ...(note.number === undefined ? {} : { number: note.number }) }),
      words,
    );
    const checking = options.checking?.id === note.id ? options.checking : undefined;
    const sending = checking?.sending !== undefined;
    const actions = make(document, 'div', 'ready-actions');
    const fixed = make(document, 'button', 'ready-fixed');
    fixed.type = 'button';
    fixed.append(tick(document), checking?.sending === 'fixed' ? t('Sending…') : t('Looks fixed'));
    const wrong = make(
      document,
      'button',
      'ready-wrong',
      checking?.sending === 'wrong' ? t('Sending…') : t('Still wrong'),
    );
    wrong.type = 'button';
    for (const [button, verdict] of [
      [fixed, 'fixed'],
      [wrong, 'wrong'],
    ] as const) {
      // Both wait while one verdict is written: a second would be refused, and say nothing true.
      button.disabled = sending;
      button.addEventListener('click', () => options.onVerdict(note.id, verdict));
    }
    actions.append(fixed, wrong);
    item.append(head, actions);
    if (checking?.problem !== undefined) {
      const problem = make(document, 'p', 'ready-problem', t(checking.problem));
      problem.setAttribute('role', 'alert');
      item.append(problem);
    }
    list.append(item);
  }
  block.append(list);

  return block;
}

/** What a verdict that did not go says (FRU-300). Nothing moved. */
export const CHECK_PROBLEM: Record<Exclude<ReplyOutcome, 'sent'>, string> = {
  retry: msg('Did not go through. Try again.'),
  wait: msg('Too many requests just now. Try again in a minute.'),
  'signed-out': msg('Your session ended. Sign in again from the Fruitback button, then try again.'),
  refused: msg('This note can no longer be checked here. The list is read again.'),
};

/** The field of a reply, under its note, as the thread of the widget has it. */
function replyForm(
  document: Document,
  options: PanelOptions,
  replying: NonNullable<PanelOptions['replying']>,
): HTMLFormElement {
  const form = make(document, 'form', 'panel-reply-form');
  const field = make(document, 'textarea', 'panel-reply-field');
  // The length the worker takes for a reply: nothing longer can be typed, so nothing is cut or refused.
  field.maxLength = REPLY_MAX_LENGTH;
  field.setAttribute('aria-label', t('Your reply'));
  field.rows = 3;
  field.value = replying.text;
  field.disabled = replying.sending === true;
  field.addEventListener('input', () => options.onReplyInput(field.value));
  const actions = make(document, 'div', 'panel-reply-actions');
  const cancel = make(document, 'button', 'panel-link', t('Cancel'));
  cancel.type = 'button';
  cancel.addEventListener('click', options.onReplyCancel);
  const send = make(document, 'button', 'panel-send', replying.sending === true ? t('Sending…') : t('Send'));
  send.type = 'submit';
  send.disabled = replying.sending === true;
  actions.append(cancel, send);
  form.append(field, actions);
  if (replying.problem !== undefined) {
    const problem = make(document, 'p', 'panel-reply-problem', t(replying.problem));
    problem.setAttribute('role', 'alert');
    form.append(problem);
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (field.value.trim() !== '') options.onReplySend();
  });

  return form;
}

/** The longest reply the worker takes (`REPLY_LENGTH` of `apps/worker/src/app.ts`, FRU-257). */
export const REPLY_MAX_LENGTH = 2000;

/** What a reply that did not go says. The text stays in the field. */
export const REPLY_PROBLEM: Record<Exclude<ReplyOutcome, 'sent'>, string> = {
  retry: msg('The reply did not go through. Your text is kept. Try again.'),
  wait: msg('Too many replies just now. Your text is kept. Try again in a minute.'),
  'signed-out': msg('Your session ended. Sign in again from the Fruitback button, then send.'),
  refused: msg('You cannot reply to this note any more.'),
};

/** The host of an address the panel may show: `http` and `https` only. */
export function webHost(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);

    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.host : undefined;
  } catch {
    return undefined;
  }
}
