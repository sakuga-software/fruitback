import { browser } from 'wxt/browser';
import { language, setLanguage } from '../../src/i18n.ts';
import { storedLanguage } from '../../src/language.ts';
import {
  type NotesTab,
  type PanelNotes,
  type PanelOptions,
  type PanelState,
  REPLY_PROBLEM,
  notesOf,
  openOnRead,
  panelPage,
  tabOf,
  webHost,
} from '../../src/side-panel.ts';
import { readSite } from '../../src/sites.ts';
import { type TabCommandAnswer, panelEvent, parseAnswer, tabCommand } from '../../src/tab-command.ts';
import type { TabCommand } from '../../src/protocol.ts';

/**
 * The side panel (FRU-296, FRU-299). It follows the active tab of its window, and reads nothing from
 * a worker: it asks the widget of the tab for the notes it read (`notes`), and the widget tells it
 * when they change, through the bridge.
 *
 * The address of a tab is given to the extension only for a site it has access to, or after the
 * click on the toolbar icon (`activeTab`). A site that is on has that access: any other tab reads as
 * « not on », which is what it is.
 *
 * **What somebody types in a reply stays**: the page is drawn again at each change, and the text,
 * the place of the caret and the focus are put back.
 */

setLanguage((await storedLanguage(browser.storage.local)) ?? navigator.language);
document.documentElement.lang = language();

const app = document.querySelector('#app');

/** The tab the panel follows: its id and what the panel knows of it. */
let followed: { tabId: number; host: string; where?: string; siteWidget?: true } | undefined;
let notes: PanelNotes = 'reading';
let tab: NotesTab = 'open';
let open: string | undefined;
let replying: PanelOptions['replying'];
/** Each look at the tab counts one: an older one that answers late does not draw over a newer one. */
let looks = 0;
/** The note a click on a pin asked to open, until a list that holds it is read. */
let pendingOpen: string | undefined;

async function ask(command: TabCommand, args: { note?: string; body?: string } = {}): Promise<TabCommandAnswer> {
  return (await askOrNothing(command, args)) ?? { done: false };
}

/** The answer of the widget of the tab, or nothing when nothing on the page answers. */
async function askOrNothing(
  command: TabCommand,
  args: { note?: string; body?: string } = {},
): Promise<TabCommandAnswer | undefined> {
  if (followed === undefined) return undefined;
  const raw: unknown = await browser.tabs.sendMessage(followed.tabId, tabCommand(command, args)).catch(() => undefined);

  return raw === undefined ? undefined : parseAnswer(raw);
}

/** Which tab the panel follows now, and whether Fruitback is on there. */
async function look(): Promise<void> {
  looks += 1;
  const mine = looks;
  const [active] = await browser.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const host = webHost(active?.url);
  const site =
    active?.url === undefined || host === undefined
      ? undefined
      : await readSite(new URL(active.url).origin).catch(() => undefined);
  if (mine !== looks) return;
  const before = followed?.tabId;
  if (active?.id === undefined || host === undefined || site?.enabled !== true) {
    followed = undefined;
  } else {
    const workspace = site.mode === 'team' ? site.mount?.workspace : undefined;
    followed = {
      tabId: active.id,
      host,
      ...(workspace === undefined || workspace === '' ? {} : { where: workspace }),
      // Team mode with no mount: the widget is the site's own, and answers the panel nothing.
      ...(site.mode === 'team' && site.mount === undefined ? { siteWidget: true as const } : {}),
    };
  }
  // Another tab: its own notes, from the start.
  if (followed?.tabId !== before) {
    notes = 'reading';
    open = undefined;
    pendingOpen = undefined;
    replying = undefined;
    tab = 'open';
  }
  draw();
  if (followed !== undefined && followed.siteWidget !== true) await readNotes();
}

/**
 * The notes of the widget of the tab, or why there are none (`notesOf`). Never asked again on a
 * timer: the widget says when it has read, and a page with nothing to answer says so.
 */
async function readNotes(): Promise<void> {
  const reading = followed?.tabId;
  const answer = await askOrNothing('notes');
  if (followed?.tabId !== reading) {
    // The tab changed under the read: a row asked for on the tab of before opens nothing (review).
    pendingOpen = undefined;

    return;
  }
  notes = notesOf(answer);
  // The open row of a note that is gone closes.
  if (Array.isArray(notes) && open !== undefined && !notes.some((note) => note.id === open)) open = undefined;
  // A row a pin asked for, once a list that holds its note is read.
  const asked = openOnRead(pendingOpen, notes);
  pendingOpen = asked.waiting;
  if (asked.open !== undefined) {
    open = asked.open.id;
    tab = tabOf(asked.open);
  }
  draw();
  if (asked.open !== undefined) {
    void ask('mark-note', { note: asked.open.id });
    // The row of the pin that was clicked comes into sight.
    app
      ?.querySelector<HTMLElement>(`li[data-note="${CSS.escape(asked.open.id)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }
}

function state(): PanelState {
  if (followed === undefined) return { kind: 'not-on' };
  if (followed.siteWidget === true) return { kind: 'site-widget', host: followed.host };

  return { kind: 'on', host: followed.host, ...(followed.where === undefined ? {} : { where: followed.where }), notes };
}

/** What has the focus, said so that the same control can take it back after a draw. */
function focusKey(): string | undefined {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || app === null || !app.contains(active)) return undefined;
  if (active.classList.contains('panel-reply-field')) return 'reply';
  const row = active.closest<HTMLElement>('li[data-note]')?.dataset.note;
  if (active.classList.contains('panel-row-head') && row !== undefined) return `row:${row}`;
  if (active.getAttribute('role') === 'tab') return `tab:${active.dataset.tab ?? ''}`;
  if (row !== undefined) return `in:${row}:${active.textContent ?? ''}`;

  return undefined;
}

function refocus(key: string | undefined, caret: [number, number] | undefined): void {
  if (key === undefined || app === null) return;
  let target: HTMLElement | null = null;
  if (key === 'reply') target = app.querySelector('.panel-reply-field');
  else if (key.startsWith('row:')) {
    target = app.querySelector(`li[data-note="${CSS.escape(key.slice(4))}"] .panel-row-head`);
  } else if (key.startsWith('tab:')) target = app.querySelector(`[role="tab"][data-tab="${CSS.escape(key.slice(4))}"]`);
  else if (key.startsWith('in:')) {
    const [, id, text] = key.split(':');
    target =
      [...app.querySelectorAll<HTMLElement>(`li[data-note="${CSS.escape(id ?? '')}"] button`)].find(
        (each) => each.textContent === text,
      ) ?? null;
  }
  target?.focus();
  if (caret !== undefined && target instanceof HTMLTextAreaElement) target.setSelectionRange(caret[0], caret[1]);
}

function draw(): void {
  if (app === null) return;
  const key = focusKey();
  const field = document.activeElement instanceof HTMLTextAreaElement ? document.activeElement : undefined;
  const caret: [number, number] | undefined =
    field === undefined ? undefined : [field.selectionStart, field.selectionEnd];
  app.replaceChildren(
    panelPage(document, {
      state: state(),
      tab,
      ...(open === undefined ? {} : { open }),
      ...(replying === undefined ? {} : { replying }),
      onClose: () => window.close(),
      onLeave: () => void ask('leave-feedback'),
      onTab: (chosen) => {
        tab = chosen;
        draw();
      },
      onToggle: (id) => {
        open = open === id ? undefined : id;
        draw();
        // The pin of the open row stands out on the page.
        void ask('mark-note', open === undefined ? {} : { note: open });
      },
      onShow: (id) => void ask('focus-note', { note: id }),
      onReplyOpen: (id) => {
        replying = { id, text: '' };
        draw();
        app.querySelector<HTMLElement>('.panel-reply-field')?.focus();
      },
      onReplyInput: (text) => {
        if (replying !== undefined) replying = { ...replying, text };
      },
      onReplyCancel: () => {
        replying = undefined;
        draw();
      },
      onReplySend: () => void sendReply(),
      // The widget reads the page again, and says when it has (`notes-changed`).
      onRetry: () => {
        notes = 'reading';
        draw();
        void ask('reread');
      },
      onReload: () => {
        if (followed !== undefined) void browser.tabs.reload(followed.tabId);
      },
      onSettings: () => void browser.runtime.openOptionsPage(),
    }),
  );
  if (app.firstElementChild instanceof HTMLElement) app.firstElementChild.dataset.state = state().kind;
  refocus(key, caret);
}

async function sendReply(): Promise<void> {
  const sending = replying;
  if (sending === undefined || sending.text.trim() === '') return;
  replying = { id: sending.id, text: sending.text, sending: true };
  draw();
  const { outcome } = await ask('reply', { note: sending.id, body: sending.text });
  if (outcome === 'sent') {
    replying = undefined;
    await readNotes();

    return;
  }
  // Not sent: the text stays in the field, with why.
  replying = { id: sending.id, text: sending.text, problem: REPLY_PROBLEM[outcome ?? 'retry'] };
  draw();
  document.querySelector<HTMLElement>('.panel-reply-field')?.focus();
}

void look();
// The panel follows the tab: another tab of the window, a new address in this one, or a rule
// switched from the popup.
browser.tabs.onActivated.addListener(() => void look());
browser.tabs.onUpdated.addListener((_id, change, updated) => {
  if (updated.active && (change.url !== undefined || change.status === 'complete')) void look();
});
browser.windows.onFocusChanged.addListener(() => void look());
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.sites !== undefined) void look();
});
// The widget of the tab read its notes again, or a note was opened on the page (a click on its pin).
browser.runtime.onMessage.addListener((message: unknown, sender) => {
  const event = panelEvent(message);
  if (event === undefined || followed === undefined || sender.tab?.id !== followed.tabId) return undefined;
  if (event.open !== undefined) pendingOpen = event.open;
  void readNotes();

  return undefined;
});
