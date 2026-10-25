import { browser } from 'wxt/browser';
import { language, setLanguage } from '../../src/i18n.ts';
import { storedLanguage } from '../../src/language.ts';
import type { CheckVerdict } from '../../src/protocol.ts';
import {
  type NotesTab,
  type PanelNotes,
  type PanelOptions,
  type PanelState,
  CHECK_PROBLEM,
  NO_WIDGET_WAIT_MS,
  PANEL_PORT,
  REPLY_PROBLEM,
  notesOf,
  openOnRead,
  panelPage,
  tabOf,
  webHost,
} from '../../src/side-panel.ts';
import type { Scope, SearchHandlers, SearchState, StageFilter } from '../../src/search-options.ts';
import { createBrowserSessions } from '../../src/session-browser.ts';
import { type SiteNote, readSiteNotes } from '../../src/site-notes.ts';
import { readSite } from '../../src/sites.ts';
import {
  type TabCommandAnswer,
  type TabCommandArguments,
  panelEvent,
  parseAnswer,
  tabCommand,
} from '../../src/tab-command.ts';
import type { TabCommand } from '../../src/protocol.ts';

/**
 * The side panel (FRU-296, FRU-299). It follows the active tab of its window, and asks the widget of
 * the tab for the notes it read (`notes`); the widget tells it when they change, through the bridge.
 * « Whole site » of « Search and options » (FRU-307) is the one read of a worker, with the session of
 * this browser (`site-notes.ts`).
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

/**
 * The tab the panel follows: its id and what the panel knows of it. `path`: the address of its page,
 * path and query. `source`: the worker and the site of a rule that a session of this browser reads,
 * for « Whole site » (FRU-307).
 */
let followed:
  | {
      tabId: number;
      host: string;
      path: string;
      where?: string;
      siteWidget?: true;
      source?: { endpoint: string; site: string };
    }
  | undefined;
let notes: PanelNotes = 'reading';
let tab: NotesTab = 'open';
let open: string | undefined;
let replying: PanelOptions['replying'];
/** The verdict on its way, or why the last one did not go (FRU-300). */
let checking: PanelOptions['checking'];
/** The notes reopened from this panel, and when: « Reopened by you ». Gone with the panel. */
const reopened: Record<string, string> = {};
/** Each look at the tab counts one: an older one that answers late does not draw over a newer one. */
let looks = 0;
/** The note a click on a pin asked to open, until a list that holds it is read. */
let pendingOpen: string | undefined;
/** The one more ask of a page that had no widget yet (`NO_WIDGET_WAIT_MS`). */
let noWidgetWait: ReturnType<typeof setTimeout> | undefined;
/** « Search and options » while it is open (FRU-307). Gone with the tab: another page, another search. */
let search: SearchState | undefined;
/** Whether the pins of the tab are shown: « Show pins on the page ». A new page shows them. */
let pinsShown = true;
/** Each read of the whole site counts one: a late answer does not draw over a newer search. */
let siteReads = 0;
let siteTimer: ReturnType<typeof setTimeout> | undefined;
/** The tab opened on the page of a note of the site, and that note: its row opens once read there. */
let awaiting: { tabId: number; note: string } | undefined;
/** The row the panel opens on a page it opened: its thread opens on the page too. */
let focusOnOpen: string | undefined;
const sessions = createBrowserSessions();
/** The background shows again the pins this panel hid, once the panel is gone (review of #419). */
const pinsPort = browser.runtime.connect({ name: PANEL_PORT });

async function ask(command: TabCommand, args: TabCommandArguments = {}): Promise<TabCommandAnswer> {
  return (await askOrNothing(command, args)) ?? { done: false };
}

/** The answer of the widget of the tab, or nothing when nothing on the page answers. */
async function askOrNothing(
  command: TabCommand,
  args: TabCommandArguments = {},
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
  const source = await sourceOf(site);
  if (mine !== looks) return;
  const before = followed?.tabId;
  if (active?.id === undefined || active.url === undefined || host === undefined || site?.enabled !== true) {
    followed = undefined;
  } else {
    const workspace = site.mode === 'team' ? site.mount?.workspace : undefined;
    const address = new URL(active.url);
    followed = {
      tabId: active.id,
      host,
      path: `${address.pathname}${address.search}`,
      ...(workspace === undefined || workspace === '' ? {} : { where: workspace }),
      // Team mode with no mount: the widget is the site's own, and answers the panel nothing.
      ...(site.mode === 'team' && site.mount === undefined ? { siteWidget: true as const } : {}),
      ...(source === undefined ? {} : { source }),
    };
  }
  // Another tab: its own notes, from the start.
  if (followed?.tabId !== before) {
    clearTimeout(noWidgetWait);
    notes = 'reading';
    open = undefined;
    // The tab opened on the page of a note of the site keeps that note to open.
    pendingOpen = awaiting !== undefined && awaiting.tabId === followed?.tabId ? awaiting.note : undefined;
    focusOnOpen = pendingOpen;
    if (pendingOpen !== undefined) awaiting = undefined;
    replying = undefined;
    tab = 'open';
    search = undefined;
    // A read or a search of the tab of before draws nothing here (review of #419).
    clearTimeout(siteTimer);
    siteReads += 1;
    // The tab of before gets its pins back: the switch was about the tab the panel followed.
    if (!pinsShown && before !== undefined) showPinsOf(before);
    pinsShown = true;
  } else if (search !== undefined && followed !== undefined) {
    search = { ...search, path: followed.path };
  }
  draw();
  if (followed !== undefined && followed.siteWidget !== true) await readNotes();
}

/**
 * The notes of the widget of the tab, or why there are none (`notesOf`). Not asked again on a timer:
 * the widget says when it has read, and a page with nothing to answer says so. One exception: a page
 * with no widget yet is asked once more after `NO_WIDGET_WAIT_MS`, then told to reload (review).
 */
async function readNotes(waited = false): Promise<void> {
  clearTimeout(noWidgetWait);
  noWidgetWait = undefined;
  const reading = followed?.tabId;
  const answer = await askOrNothing('notes');
  if (followed?.tabId !== reading) {
    // The tab changed under the read: a row asked for on the tab of before opens nothing (review).
    pendingOpen = undefined;

    return;
  }
  notes = notesOf(answer, waited);
  if (answer?.reading === 'no-widget' && !waited && noWidgetWait === undefined) {
    noWidgetWait = setTimeout(() => {
      if (followed?.tabId === reading) void readNotes(true);
    }, NO_WIDGET_WAIT_MS);
  }
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
    // A note opened from « Whole site »: its thread opens on its page too.
    if (focusOnOpen === asked.open.id) void ask('focus-note', { note: asked.open.id });
    focusOnOpen = undefined;
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
  // FRU-307: the search, its chips, the magnifier and the switch of the pins.
  if (active.classList.contains('search-input')) return 'search';
  if (active.classList.contains('search-chip')) return `chip:${active.dataset.stage ?? ''}`;
  if (active.classList.contains('panel-search')) return 'magnifier';
  if (active.closest('.search-pins') !== null) return 'pins';
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
  else if (key === 'search') target = app.querySelector('.search-input');
  else if (key === 'magnifier') target = app.querySelector('.panel-search');
  else if (key === 'pins') target = app.querySelector('.search-pins [role="switch"]');
  else if (key.startsWith('chip:'))
    target = app.querySelector(`.search-chip[data-stage="${CSS.escape(key.slice(5))}"]`);
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
  if (caret !== undefined && (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement)) {
    target.setSelectionRange(caret[0], caret[1]);
  }
}

function draw(): void {
  if (app === null) return;
  const key = focusKey();
  const active = document.activeElement;
  const field = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement ? active : undefined;
  const caret: [number, number] | undefined =
    field === undefined || field.selectionStart === null || field.selectionEnd === null
      ? undefined
      : [field.selectionStart, field.selectionEnd];
  app.replaceChildren(
    panelPage(document, {
      state: state(),
      tab,
      ...(open === undefined ? {} : { open }),
      ...(replying === undefined ? {} : { replying }),
      ...(checking === undefined ? {} : { checking }),
      reopened,
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
      onVerdict: (id, verdict) => void sendVerdict(id, verdict),
      onSearch: () => toggleSearch(),
      ...(search === undefined ? {} : { search: { state: search, handlers: searchHandlers } }),
    }),
  );
  if (app.firstElementChild instanceof HTMLElement) app.firstElementChild.dataset.state = state().kind;
  refocus(key, caret);
}

/**
 * The worker and the site whose whole list a session of this browser reads (FRU-307): a site of a
 * workspace the extension mounts, with a session held for its worker. A private site has none.
 */
async function sourceOf(
  site: Awaited<ReturnType<typeof readSite>>,
): Promise<{ endpoint: string; site: string } | undefined> {
  if (site?.enabled !== true || site.mode !== 'team' || site.mount === undefined) return undefined;
  const held = await sessions.list().catch(() => ({}) as Record<string, unknown>);

  return held[site.endpoint] === undefined ? undefined : { endpoint: site.endpoint, site: site.mount.clientId };
}

function toggleSearch(): void {
  if (search !== undefined) {
    search = undefined;
    clearTimeout(siteTimer);
    siteReads += 1;
    draw();
    app?.querySelector<HTMLElement>('.panel-search')?.focus();

    return;
  }
  search = {
    scope: 'page',
    q: '',
    stage: 'all',
    pinsShown,
    ...(followed === undefined ? {} : { path: followed.path }),
    ...(followed?.source === undefined ? {} : { site: 'reading' as const }),
  };
  draw();
  app?.querySelector<HTMLElement>('.search-input')?.focus();
  void readWholeSite();
}

/**
 * The notes of the whole site for the search of now (FRU-306), from the worker: one page, or the
 * next one after the last read. Nothing is kept beyond what the panel shows.
 */
async function readWholeSite(more = false): Promise<void> {
  const source = followed?.source;
  if (search === undefined || source === undefined) return;
  siteReads += 1;
  const mine = siteReads;
  const shown = search.site;
  const words = wordsOf(search.q);
  // The next page only of the list of these words: a cursor read with other words names another walk.
  const next = more && typeof shown === 'object' && shown.q === words ? shown : undefined;
  const cursor = next?.next;
  search = { ...search, site: next === undefined ? 'reading' : { ...next, more: 'reading' } };
  draw();
  const read = await readSiteNotes(
    source.endpoint,
    { site: source.site, q: words, ...(cursor === undefined ? {} : { cursor }) },
    {
      ensureAccess: (endpoint) => sessions.ensureAccess(endpoint),
      renewAccess: (endpoint, refused) => sessions.renewAccess(endpoint, refused),
    },
  );
  if (mine !== siteReads || search === undefined || followed?.source !== source) return;
  const now = search.site;
  if (read.ok) {
    const before = next !== undefined && typeof now === 'object' ? now.notes : [];
    search = {
      ...search,
      site: {
        q: words,
        notes: [...before, ...read.page.notes],
        total: read.page.total,
        ...(read.page.next === undefined ? {} : { next: read.page.next }),
      },
    };
  } else if (next !== undefined && typeof now === 'object') {
    search = { ...search, site: { ...now, more: 'failed' } };
  } else {
    search = { ...search, site: read.reason };
  }
  draw();
}

/** A note of the site: its thread on this page, or its page in a new tab, where its row opens. */
async function openSiteNote(note: SiteNote): Promise<void> {
  if (followed === undefined) return;
  if (note.page.path === followed.path) {
    search = undefined;
    open = note.note;
    tab = 'open';
    draw();
    void ask('mark-note', { note: note.note });
    void ask('focus-note', { note: note.note });

    return;
  }
  // A new tab, never the one of the reader: what they type on this page stays where it is.
  const created = await browser.tabs.create({ url: note.page.url }).catch(() => undefined);
  if (created?.id === undefined) return;
  if (followed?.tabId === created.id) {
    // The panel already follows the new tab: the row waits for its list there.
    pendingOpen = note.note;
    focusOnOpen = note.note;
  } else awaiting = { tabId: created.id, note: note.note };
}

const searchHandlers: SearchHandlers = {
  onScope: (scope: Scope) => {
    if (search === undefined) return;
    search = { ...search, scope };
    draw();
  },
  onQuery: (q: string) => {
    if (search === undefined) return;
    // New words: a read still on its way, a « Show more » included, is of the words of before and
    // draws nothing (review of #419). The list of before stays shown, with no « Show more », until
    // the read of the new words answers.
    if (wordsOf(q) !== wordsOf(search.q)) {
      siteReads += 1;
      const shown = search.site;
      if (typeof shown === 'object' && shown.more === 'reading') {
        const { more: _more, ...kept } = shown;
        search = { ...search, site: kept };
      }
    }
    search = { ...search, q };
    draw();
    // The whole site is asked again once the typing stops.
    clearTimeout(siteTimer);
    siteTimer = setTimeout(() => void readWholeSite(), SEARCH_PAUSE_MS);
  },
  onStage: (stage: StageFilter) => {
    if (search === undefined) return;
    search = { ...search, stage };
    draw();
  },
  onSiteNote: (note) => void openSiteNote(note),
  onSiteRetry: () => void readWholeSite(),
  onMore: () => void readWholeSite(true),
  onPins: (shown: boolean) => {
    if (followed === undefined) return;
    pinsShown = shown;
    if (search !== undefined) search = { ...search, pinsShown: shown };
    pinsPort.postMessage(shown ? { shown: followed.tabId } : { hidden: followed.tabId });
    void ask(shown ? 'show-pins' : 'hide-pins');
  },
};

/** `show-pins` to a tab the panel no longer follows. Nothing to do when that tab is gone. */
function showPinsOf(tabId: number): void {
  pinsPort.postMessage({ shown: tabId });
  void browser.tabs.sendMessage(tabId, tabCommand('show-pins')).catch(() => undefined);
}

/** The words a read sends: `readSiteNotes` trims them the same way. */
function wordsOf(q: string): string {
  return q.trim();
}

/** How long the typing pauses before the whole site is asked: one read per search, not per key. */
const SEARCH_PAUSE_MS = 300;

/**
 * « Looks fixed » or « Still wrong » (FRU-300), by the widget of the tab, then a read: the store moved
 * the note, and the list says where it is now. Nothing moves before that answer.
 */
async function sendVerdict(id: string, verdict: CheckVerdict): Promise<void> {
  if (checking?.sending !== undefined) return;
  checking = { id, sending: verdict };
  draw();
  const { outcome } = await ask('check', { note: id, verdict });
  if (outcome === 'sent') {
    checking = undefined;
    if (verdict === 'wrong') reopened[id] = new Date().toISOString();
    open = id;
    // The note is in Done when it looks fixed, back in Open when it is still wrong.
    tab = verdict === 'fixed' ? 'finished' : 'open';
    await readNotes();

    return;
  }
  checking = { id, problem: CHECK_PROBLEM[outcome ?? 'retry'] };
  // A note the worker no longer takes a verdict on: the list of now says why.
  if (outcome === 'refused') await readNotes();
  else draw();
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
    // The field and « Send » are gone: the focus goes back to « Reply » of the same row, not to the
    // body of the page (raised in review).
    const row = app?.querySelector(`li[data-note="${CSS.escape(sending.id)}"]`);
    (
      row?.querySelector<HTMLElement>('[data-action="reply"]') ?? row?.querySelector<HTMLElement>('.panel-row-head')
    )?.focus();

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
