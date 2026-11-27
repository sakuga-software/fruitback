import { afterEach, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Window as HappyDomWindow } from 'happy-dom';
import { compile } from '@tailwindcss/node';
import { setLanguage } from './i18n.ts';
import {
  CLOUD_NOTES_NEED_MEMBER,
  CLOUD_READ_NEEDS_MEMBER,
  MEMBER_TURNS_ON,
  NOT_A_MEMBER,
  type ReadProbe,
} from './read-probe.ts';
import type { PanelNote } from './protocol.ts';
import type { SiteNote } from './site-notes.ts';
import {
  type PanelApis,
  type PanelOptions,
  type PanelState,
  CHECK_PROBLEM,
  REPLY_PROBLEM,
  replyField,
  sentFromHere,
  REPLY_MAX_LENGTH,
  ageOf,
  iconOpensPanel,
  keepPopupOnActionClick,
  setPanelOnClick,
  latestOnly,
  membersOnlyOf,
  notesOf,
  offersPopup,
  openOnRead,
  openPanel,
  openPopupFrom,
  openPanelOrPage,
  panelApis,
  panelPage,
  parsePinsMessage,
  pinsKeeper,
  tabOf,
  toCheck,
  webHost,
  type PanelNotes,
} from './side-panel.ts';

/**
 * The side panel (FRU-296): the gesture that opens it in each browser, the behaviour of the icon,
 * and the frame of its page. The panel opened from a real popup is `e2e/side-panel.spec.ts`'s.
 */

function page(): Document {
  return new HappyDomWindow({ url: 'chrome-extension://fruitback/sidepanel.html' }).document as unknown as Document;
}

afterEach(() => setLanguage('en'));

/** The panel APIs read from `browser` (FRU-560), in place of a cast at each call. */
describe('panelApis', () => {
  it('reads the side panel of Chrome, and calls each method on its own object', async () => {
    const calls: string[] = [];
    const sidePanel = {
      name: 'chrome.sidePanel',
      async open(this: { name: string }, options: unknown) {
        calls.push(`${this.name} open ${JSON.stringify(options)}`);
      },
      async setPanelBehavior(this: { name: string }, behavior: unknown) {
        calls.push(`${this.name} behavior ${JSON.stringify(behavior)}`);
      },
    };
    const apis = panelApis({ runtime: {}, sidePanel });
    assert.equal(apis?.sidePanel, sidePanel);
    assert.equal(apis?.sidebarAction, undefined);

    await openPanel(apis, { tabId: 4 });
    await setPanelOnClick(apis, true, true);
    assert.deepEqual(calls, [
      'chrome.sidePanel open {"tabId":4}',
      'chrome.sidePanel behavior {"openPanelOnActionClick":true}',
    ]);
  });

  it('reads the sidebar of Firefox, which has no side panel', async () => {
    let opened = 0;
    const apis = panelApis({ runtime: {}, sidebarAction: { open: async () => void (opened += 1) } });
    assert.equal(apis?.sidePanel, undefined);

    await openPanel(apis, {});
    assert.equal(opened, 1);
    // Firefox keeps no behaviour of the icon: nothing to set, and nothing throws.
    await setPanelOnClick(apis, true, true);
    await keepPopupOnActionClick(apis);
  });

  it('keeps a Chrome side panel with no setPanelBehavior, bound to its object', async () => {
    const sidePanel = {
      seen: [] as unknown[],
      async open(this: { seen: unknown[] }, options: unknown) {
        this.seen.push(options);
      },
    };
    const apis = panelApis({ sidePanel });
    assert.equal(apis?.sidePanel?.setPanelBehavior, undefined);
    await openPanel(apis, { windowId: 2 });
    assert.deepEqual(sidePanel.seen, [{ windowId: 2 }]);
  });

  it('answers undefined for a browser with neither, and for parts that do not open', async () => {
    for (const browser of [
      undefined,
      null,
      {},
      { sidePanel: {} },
      { sidePanel: { open: 'no' } },
      { sidebarAction: null },
      'chrome',
    ]) {
      assert.equal(panelApis(browser), undefined, JSON.stringify(browser));
    }
    // With no panel: nothing opens, and the page shows the list.
    assert.equal(openPanel(undefined, { tabId: 1 }), undefined);
    assert.equal(await openPanelOrPage(undefined, { tabId: 1 }, async () => true), 'page');
    await setPanelOnClick(undefined, true, true);
  });
});

describe('opening the panel (FRU-296)', () => {
  it('asks Chrome for the panel of the tab, at once, in the click', () => {
    const calls: unknown[] = [];
    const apis: PanelApis = { sidePanel: { open: async (options) => void calls.push(options) } };
    const opened = openPanel(apis, { tabId: 7 });

    // Synchronous: an `await` before the call would drop the gesture.
    assert.deepEqual(calls, [{ tabId: 7 }]);
    assert.ok(opened instanceof Promise);
  });

  it('asks for the panel of the window when the popup knows no tab', () => {
    const calls: unknown[] = [];
    openPanel({ sidePanel: { open: async (options) => void calls.push(options) } }, { windowId: 3 });

    assert.deepEqual(calls, [{ windowId: 3 }]);
  });

  it('opens the sidebar of Firefox', () => {
    let opened = 0;
    openPanel({ sidebarAction: { open: async () => void (opened += 1) } }, { tabId: 7 });

    assert.equal(opened, 1);
  });

  it('answers nothing on a browser with no panel, so the popup shows the list in the page', () => {
    assert.equal(openPanel({}, { tabId: 7 }), undefined);
  });

  it('passes the refusal of the browser on', async () => {
    const apis: PanelApis = {
      sidePanel: { open: () => Promise.reject(new Error('may only be called in response to a user gesture')) },
    };

    await assert.rejects(openPanel(apis, { tabId: 1 }) as Promise<void>, /user gesture/);
  });

  it('shows the list of the page when the browser has no panel, or refuses to open it', async () => {
    const quiet = mock.method(console, 'error', () => {});
    const page = (answer: boolean) => {
      const asked: string[] = [];

      return { asked, inPage: async () => (asked.push('page'), answer) };
    };
    const refusing: PanelApis = { sidePanel: { open: () => Promise.reject(new Error('no gesture')) } };
    const throwing: PanelApis = {
      sidebarAction: {
        open: () => {
          throw new Error('not in a user action');
        },
      },
    };

    const opened = page(true);
    assert.equal(await openPanelOrPage({ sidePanel: { open: async () => {} } }, { tabId: 1 }, opened.inPage), 'panel');
    assert.deepEqual(opened.asked, [], 'the page was asked although the panel opened');
    for (const apis of [{}, refusing, throwing]) {
      const fallback = page(true);
      assert.equal(await openPanelOrPage(apis, { tabId: 1 }, fallback.inPage), 'page');
      assert.deepEqual(fallback.asked, ['page']);
    }
    assert.equal(await openPanelOrPage(refusing, { tabId: 1 }, page(false).inPage), 'nothing');
    quiet.mock.restore();
  });

  it('keeps the popup on the click of the icon, and asks nothing of Firefox', async () => {
    const behaviours: unknown[] = [];
    await keepPopupOnActionClick({
      sidePanel: { open: async () => {}, setPanelBehavior: async (behaviour) => void behaviours.push(behaviour) },
    });
    await keepPopupOnActionClick({ sidebarAction: { open: async () => {} } });

    assert.deepEqual(behaviours, [{ openPanelOnActionClick: false }]);
  });
});

describe('the page of the panel (FRU-296, FRU-299)', () => {
  const NOW = Date.parse('2026-10-20T12:00:00Z');
  const note = (fields: Partial<PanelNote> & Pick<PanelNote, 'id' | 'stage'>): PanelNote => ({
    note: `Note ${fields.id}`,
    createdAt: '2026-10-19T12:00:00Z',
    updatedAt: '2026-10-19T12:00:00Z',
    replies: [],
    canReply: true,
    placement: 'found',
    ...fields,
  });
  const NOTES: PanelNote[] = [
    note({ id: 'b', number: 3, stage: 'todo', note: 'Could the title mention Bordeaux?', mine: true }),
    note({ id: 'a', number: 4, stage: 'new', author: 'Léa', createdAt: '2026-10-20T11:20:00Z' }),
    note({ id: 'c', number: 1, stage: 'done', canReply: false }),
    note({ id: 'd', number: 2, stage: 'progress' }),
  ];
  const handlers = (): Omit<PanelOptions, 'state' | 'tab'> & { calls: string[] } => {
    const calls: string[] = [];

    return {
      calls,
      now: NOW,
      onClose: () => calls.push('close'),
      onLeave: () => calls.push('leave'),
      onTab: (tab) => calls.push(`tab:${tab}`),
      onToggle: (id) => calls.push(`toggle:${id}`),
      onShow: (id) => calls.push(`show:${id}`),
      onReplyOpen: (id) => calls.push(`reply:${id}`),
      onReplyInput: (text) => calls.push(`input:${text}`),
      onReplySend: () => calls.push('send'),
      onReplyCancel: () => calls.push('cancel'),
      onRetry: () => calls.push('retry'),
      onReload: () => calls.push('reload'),
      onSettings: () => calls.push('settings'),
      onVerdict: (id, verdict) => calls.push(`verdict:${id}:${verdict}`),
    };
  };
  const on = (notes: PanelNote[] | 'reading' | 'failed' | 'not-started' | 'signed-out'): PanelState => ({
    kind: 'on',
    host: 'staging.acme.dev',
    where: 'Acme',
    notes,
  });

  it('says to reload a page that still has no widget, with the button that does it (raised in review)', () => {
    const options = handlers();
    const root = panelPage(page(), { ...options, state: on('not-started'), tab: 'open' });
    assert.match(root.textContent ?? '', /did not start on this page/);
    const reload = root.querySelector<HTMLButtonElement>('.panel-failed button');
    assert.equal(reload?.textContent, 'Reload the page');
    reload?.click();
    assert.deepEqual(options.calls, ['reload']);
  });

  it('has « Notes on this page » and « Close the sidebar »', () => {
    const options = handlers();
    const root = panelPage(page(), { ...options, state: { kind: 'not-on' }, tab: 'open' });

    assert.equal(root.querySelector('h2')?.textContent, 'Notes on this page');
    const close = root.querySelector<HTMLButtonElement>('button.panel-close');
    assert.equal(close?.getAttribute('aria-label'), 'Close the sidebar');
    close?.click();
    assert.deepEqual(options.calls, ['close']);
  });

  it('says why it shows nothing on a page Fruitback is not on, and offers nothing', () => {
    const root = panelPage(page(), { ...handlers(), state: { kind: 'not-on' }, tab: 'open' });

    assert.deepEqual(
      [...root.querySelectorAll('p')].map((line) => line.textContent),
      ['Fruitback is not on for this page.', 'Turn it on from the Fruitback button in the toolbar.'],
    );
    assert.equal(root.querySelectorAll('button').length, 1, 'only « Close the sidebar »');
  });

  it('offers « Open Fruitback » in place of the sentence, where the popup can open on the page (FRU-532)', () => {
    const options = handlers();
    const root = panelPage(page(), {
      ...options,
      state: { kind: 'not-on' },
      tab: 'open',
      onOpenPopup: () => options.calls.push('popup'),
    });

    assert.deepEqual(
      [...root.querySelectorAll('p')].map((line) => line.textContent),
      ['Fruitback is not on for this page.'],
    );
    const open = root.querySelector<HTMLButtonElement>('.panel-state button.kit-primary');
    assert.equal(open?.textContent, 'Open Fruitback');
    assert.equal(open?.type, 'button');
    open?.click();
    assert.deepEqual(options.calls, ['popup']);
  });

  it('offers « Open Fruitback » under a session that ended: the popup signs in again (FRU-532)', () => {
    const options = handlers();
    const root = panelPage(page(), {
      ...options,
      state: on('signed-out'),
      tab: 'open',
      onOpenPopup: () => options.calls.push('popup'),
    });

    assert.equal(
      root.querySelector('[role="status"]')?.textContent,
      'Your session ended. Sign in again from the Fruitback button.',
    );
    root.querySelector<HTMLButtonElement>('.panel-notes button.kit-primary')?.click();
    assert.deepEqual(options.calls, ['popup']);
  });

  it('has no « Open Fruitback » on a site that runs its own Fruitback: the action is on the page (FRU-532)', () => {
    const root = panelPage(page(), {
      ...handlers(),
      state: { kind: 'site-widget', host: 'app.acme.dev' },
      tab: 'open',
      onOpenPopup: () => undefined,
    });

    assert.equal(root.querySelector('.panel-open-popup'), null);
  });

  // Raised in review: on a site that embeds its own widget, the panel waited for notes nobody sends.
  it('says that a site in team mode with its own widget keeps its notes in its own list', () => {
    const root = panelPage(page(), {
      ...handlers(),
      state: { kind: 'site-widget', host: 'app.acme.dev' },
      tab: 'open',
    });

    assert.deepEqual(
      [...root.querySelectorAll('p')].map((line) => line.textContent),
      [
        'app.acme.dev runs its own Fruitback.',
        'Its notes are on the page, in its own list. This panel lists the notes of a site where the extension shows Fruitback.',
      ],
    );
    assert.equal(root.querySelector('[role="alert"]'), null, 'said as a failure');
  });

  it('takes no reply longer than the worker does', () => {
    const root = panelPage(page(), {
      ...handlers(),
      state: on(NOTES),
      tab: 'open',
      open: 'b',
      replying: { id: 'b', text: '' },
    });

    assert.equal(root.querySelector<HTMLTextAreaElement>('textarea')?.maxLength, 2000);
  });

  it('offers « Leave a note », and names the site and its workspace at the foot with « Settings »', () => {
    const options = handlers();
    const root = panelPage(page(), { ...options, state: on([]), tab: 'open' });
    const leave = [...root.querySelectorAll('button')].find((each) => each.textContent === 'Leave a note');

    assert.ok(leave?.classList.contains('kit-primary'));
    assert.equal(leave?.dataset.size, 'panel');
    assert.equal(
      root.querySelector('.panel-hint')?.textContent,
      'Then click the part of the page you want to comment on',
    );
    assert.equal(root.querySelector('.panel-where')?.textContent, 'staging.acme.dev · Acme');
    leave?.click();
    [...root.querySelectorAll<HTMLButtonElement>('.panel-foot button')]
      .find((each) => each.textContent === 'Settings')
      ?.click();
    assert.deepEqual(options.calls, ['leave', 'settings']);
  });

  it('counts « To check », « Open » and « Done », and lists each by the number of its pin', () => {
    const root = panelPage(page(), { ...handlers(), state: on(NOTES), tab: 'open' });

    assert.deepEqual(
      [...root.querySelectorAll('[role="tab"]')].map((tab) => [tab.textContent, tab.getAttribute('aria-selected')]),
      [
        ['To check · 0', 'false'],
        ['Open · 3', 'true'],
        ['Done · 1', 'false'],
      ],
    );
    assert.deepEqual(
      [...root.querySelectorAll('li[data-note]')].map((row) => row.querySelector('.kit-drop-number')?.textContent),
      ['2', '3', '4'],
    );
    const third = root.querySelector('li[data-note="b"]');
    assert.equal(third?.querySelector('.panel-row-note')?.textContent, 'Could the title mention Bordeaux?');
    assert.equal(third?.querySelector('.panel-row-meta')?.textContent, 'To do · You · yesterday');
    assert.equal(root.querySelector('li[data-note="a"] .panel-row-meta')?.textContent, 'New · Léa · 40 minutes ago');
    assert.equal(
      root.querySelector('li[data-note="d"] .panel-row-meta')?.textContent,
      'In progress · Anonymous · yesterday',
    );
    assert.equal(third?.querySelector('.kit-drop')?.getAttribute('data-stage'), 'todo');
  });

  it('draws the colour and the name of a status, and the word of the store (FRU-370)', () => {
    const notes = [
      note({
        id: 'p',
        number: 1,
        stage: 'progress',
        status: { stage: 'progress', name: 'Waiting for the client', color: '#fef9c3' },
      }),
      note({ id: 'q', number: 2, stage: 'todo', stateName: 'Backlog', tracker: 'Linear' }),
      note({ id: 'r', number: 3, stage: 'todo', stateName: 'Backlog' }),
    ];
    const root = panelPage(page(), { ...handlers(), state: on(notes), tab: 'open' });
    const painted = root.querySelector<HTMLElement>('li[data-note="p"] .kit-drop');
    const plain = root.querySelector<HTMLElement>('li[data-note="q"] .kit-drop');

    // The stage first, then the status of the team or the word of the tracker (FRU-606). The word of a
    // store the widget did not name is left out: « À faire · To do » would say the stage twice.
    assert.equal(
      root.querySelector('li[data-note="p"] .panel-row-stage')?.textContent,
      'In progress · Waiting for the client',
    );
    assert.equal(root.querySelector('li[data-note="q"] .panel-row-stage')?.textContent, 'To do · Linear: Backlog');
    assert.equal(root.querySelector('li[data-note="r"] .panel-row-stage')?.textContent, 'To do');
    // The round of the stage, half full for « In progress », in the colour of the status.
    const ring = root.querySelector<SVGElement>('li[data-note="p"] .kit-stage-ring');
    assert.equal(ring?.dataset.stage, 'progress');
    assert.equal(ring?.style.color, '#fef9c3');
    assert.equal(painted?.style.background, '#fef9c3');
    assert.equal(painted?.style.getPropertyValue('--drop-on'), '#18181b');
    // The stage stays on the drop, and a note with no colour keeps the class of its stage.
    assert.equal(painted?.dataset.stage, 'progress');
    assert.equal(plain?.style.background, '');
  });

  it('gives each note its whole text in `title`, where the sheet cuts it to one line (FRU-534)', () => {
    const long = 'The price on the dark card is hard to read, and the button under it jumps when the cart opens.';
    const notes = [
      note({ id: 'p', number: 2, stage: 'new', note: long }),
      note({ id: 'r', number: 5, stage: 'done', mine: true, note: `${long} Ready.` }),
      note({ id: 'd', stage: 'todo', placement: 'detached', note: `${long} Detached.` }),
    ];
    const root = panelPage(page(), { ...handlers(), state: on(notes), tab: 'open' });
    const row = root.querySelector('li[data-note="p"] .panel-row-note');
    assert.equal(row?.textContent, long, 'the text is cut by the sheet, never in the DOM');
    assert.equal(row?.getAttribute('title'), long);
    // The name of the button of the row holds the whole note.
    assert.ok(root.querySelector('li[data-note="p"] button.panel-row-head')?.textContent?.includes(long));
    const check = panelPage(page(), { ...handlers(), state: on(notes), tab: 'check' });
    assert.equal(check.querySelector('.ready-item .ready-note')?.getAttribute('title'), `${long} Ready.`);

    const searched = panelPage(page(), {
      ...handlers(),
      state: on(notes),
      tab: 'open',
      search: {
        state: { scope: 'page', q: '', stage: 'all', pinsShown: true },
        handlers: {
          onScope: () => undefined,
          onQuery: () => undefined,
          onStage: () => undefined,
          onSiteNote: () => undefined,
          onSiteRetry: () => undefined,
          onMore: () => undefined,
          onPins: () => undefined,
        },
      },
    });
    assert.equal(searched.querySelector('li[data-note="p"] .panel-row-note')?.getAttribute('title'), long);
    assert.equal(searched.querySelector('.search-detached-note')?.getAttribute('title'), `${long} Detached.`);
  });

  it('lists done and closed notes under « Done »', () => {
    const root = panelPage(page(), { ...handlers(), state: on(NOTES), tab: 'done' });

    assert.deepEqual(
      [...root.querySelectorAll('li[data-note]')].map((row) => row.getAttribute('data-note')),
      ['c'],
    );
  });

  it('opens a row: its replies, « Show on the page », and « Reply » where the reader may reply', () => {
    const options = handlers();
    const withReply = NOTES.map((each) =>
      each.id === 'b'
        ? {
            ...each,
            replies: [{ author: 'Léa', body: 'Planned with the new hero copy.', createdAt: '2026-10-19T16:00:00Z' }],
          }
        : each,
    );
    const root = panelPage(page(), { ...options, state: on(withReply), tab: 'open', open: 'b' });
    const row = root.querySelector('li[data-note="b"]');

    assert.equal(row?.querySelector('.panel-row-head')?.getAttribute('aria-expanded'), 'true');
    assert.equal(root.querySelector('li[data-note="a"] .panel-row-head')?.getAttribute('aria-expanded'), 'false');
    assert.equal(row?.querySelector('.panel-reply-meta')?.textContent, 'Léa · 20 hours ago');
    assert.equal(row?.querySelector('.panel-reply-body')?.textContent, 'Planned with the new hero copy.');
    const links = [...(row?.querySelectorAll<HTMLButtonElement>('.panel-row-links button') ?? [])];
    assert.deepEqual(
      links.map((link) => link.textContent),
      ['Show on the page', 'Reply'],
    );
    for (const link of links) link.click();
    row?.querySelector<HTMLButtonElement>('.panel-row-head')?.click();
    assert.deepEqual(options.calls, ['show:b', 'reply:b', 'toggle:b']);
  });

  it('offers no « Reply » on a note the reader may not reply to', () => {
    const root = panelPage(page(), { ...handlers(), state: on(NOTES), tab: 'done', open: 'c' });

    assert.deepEqual(
      [...root.querySelectorAll('li[data-note="c"] .panel-row-links button')].map((link) => link.textContent),
      ['Show on the page'],
    );
  });

  it('keeps the text of a reply, sends it, and says why it did not go without clearing it', () => {
    const options = handlers();
    const root = panelPage(page(), {
      ...options,
      state: on(NOTES),
      tab: 'open',
      open: 'b',
      replying: { id: 'b', text: 'Merci', problem: REPLY_PROBLEM.retry },
    });
    const field = root.querySelector<HTMLTextAreaElement>('textarea');

    assert.equal(field?.value, 'Merci');
    assert.equal(field?.getAttribute('aria-label'), 'Your reply');
    assert.equal(
      root.querySelector('.panel-reply-problem')?.textContent,
      'The reply was not sent. Your text is still here. Try again.',
    );
    root
      .querySelector('form')
      ?.dispatchEvent(
        new (root.ownerDocument.defaultView as unknown as typeof globalThis).Event('submit', { cancelable: true }),
      );
    assert.deepEqual(options.calls, ['send']);
  });

  it('replies as the thread of the widget does: two lines, Enter sends, Shift+Enter goes to the next line (FRU-606)', () => {
    const options = handlers();
    const root = panelPage(page(), {
      ...options,
      state: on(NOTES),
      tab: 'open',
      open: 'b',
      replying: { id: 'b', text: 'Merci' },
    });
    const field = root.querySelector<HTMLTextAreaElement>('textarea.panel-reply-field');
    const view = root.ownerDocument.defaultView as unknown as typeof globalThis;
    // happy-dom submits a form only when it is in the document.
    root.ownerDocument.body.append(root);
    const press = (init: KeyboardEventInit) =>
      field?.dispatchEvent(
        new view.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }),
      );

    assert.equal(field?.getAttribute('rows'), '2');
    assert.equal(press({ shiftKey: true }), true, 'Shift+Enter is left to the field');
    assert.equal(press({ isComposing: true }), true, 'an Enter that composes a character sends nothing');
    assert.deepEqual(options.calls, []);
    assert.equal(press({}), false);
    assert.deepEqual(options.calls, ['send']);
  });

  it('holds the field of a note whose reply is on its way, opened again from another note (FRU-620)', () => {
    const inFlight = new Set(['b']);
    // The reader opened the reply of « a » during the send of « b », then the one of « b » again.
    const reopened = replyField({ id: 'b', text: 'Merci' }, inFlight);
    const root = panelPage(page(), {
      ...handlers(),
      state: on(NOTES),
      tab: 'open',
      open: 'b',
      ...(reopened === undefined ? {} : { replying: reopened }),
    });

    assert.deepEqual(reopened, { id: 'b', text: 'Merci', sending: true });
    assert.equal(root.querySelector<HTMLButtonElement>('.panel-send')?.disabled, true, 'no second « Send »');
    assert.equal(root.querySelector<HTMLTextAreaElement>('textarea')?.disabled, true);
    assert.equal(root.querySelector<HTMLTextAreaElement>('textarea')?.value, 'Merci');
    // Another note, and a note once its send answered, keep their field as it is.
    assert.deepEqual(replyField({ id: 'a', text: 'Oui' }, inFlight), { id: 'a', text: 'Oui' });
    assert.deepEqual(replyField({ id: 'b', text: 'Merci' }, new Set()), { id: 'b', text: 'Merci' });
    assert.equal(replyField(undefined, inFlight), undefined);
  });

  it('leaves open a reply field that is not the one a send came from (review of #857)', () => {
    const sent = { id: 'b', text: 'Merci' };

    assert.equal(sentFromHere({ id: 'b', text: 'Merci', sending: true } as { id: string; text: string }, sent), true);
    assert.equal(sentFromHere({ id: 'a', text: '' }, sent), false, 'the reply of another note, opened meanwhile');
    assert.equal(sentFromHere({ id: 'b', text: 'Merci, et aussi' }, sent), false, 'a new text typed for this note');
    assert.equal(sentFromHere(undefined, sent), false);
  });

  it('shows « Sending… » and no second send while a reply is on its way', () => {
    const root = panelPage(page(), {
      ...handlers(),
      state: on(NOTES),
      tab: 'open',
      open: 'b',
      replying: { id: 'b', text: 'Merci', sending: true },
    });

    assert.equal(root.querySelector<HTMLButtonElement>('.panel-send')?.textContent, 'Sending…');
    assert.equal(root.querySelector<HTMLButtonElement>('.panel-send')?.disabled, true);
    assert.equal(root.querySelector<HTMLTextAreaElement>('textarea')?.disabled, true);
  });

  it('says it reads, says a failed read with « Try again », and says an empty page', () => {
    const options = handlers();
    const reading = panelPage(page(), { ...options, state: on('reading'), tab: 'open' });
    assert.equal(reading.querySelector('[role="status"]')?.textContent, 'Reading the notes of this page…');

    const failed = panelPage(page(), { ...options, state: on('failed'), tab: 'open' });
    assert.match(failed.querySelector('[role="alert"]')?.textContent ?? '', /could not be read\. They are not lost\./);
    failed.querySelector<HTMLButtonElement>('[role="alert"] button')?.click();
    assert.deepEqual(options.calls, ['retry']);

    const empty = panelPage(page(), { ...options, state: on([]), tab: 'open' });
    assert.equal(empty.querySelector('.panel-empty-title')?.textContent, 'No notes on this page yet');
    assert.equal(empty.querySelector('[role="tablist"]'), null);
  });

  it('leads to the guide, centred, from each state that blocks (FRU-528)', () => {
    const NOT_ANSWERING = 'https://fruitback.com/reviewing.html#when-fruitback-does-not-answer';
    const states: [PanelNotes, string, string][] = [
      ['failed', 'What to check when Fruitback does not answer', NOT_ANSWERING],
      ['reload', 'What to check when Fruitback does not answer', NOT_ANSWERING],
      ['not-started', 'What to check when Fruitback does not answer', NOT_ANSWERING],
      [[], 'How to leave and follow notes', 'https://fruitback.com/reviewing.html#2-switch-a-site-on'],
    ];
    for (const [notes, label, href] of states) {
      const root = panelPage(page(), {
        ...handlers(),
        state: { kind: 'on', host: 'staging.acme.dev', notes },
        tab: 'open',
      });
      const links = [...root.querySelectorAll<HTMLAnchorElement>('.kit-help a')];
      assert.deepEqual(
        links.map((link) => [link.textContent, link.href, link.target]),
        [[label, href, '_blank']],
        String(notes),
      );
    }
    // A list to read, or reading it: nothing blocks, and no button to the guide.
    for (const notes of ['reading', NOTES] as const) {
      const root = panelPage(page(), { ...handlers(), state: on(notes), tab: 'open' });
      assert.equal(root.querySelector('.kit-help'), null);
    }
  });

  it('is in French for a French reader', () => {
    setLanguage('fr');
    const root = panelPage(page(), { ...handlers(), state: on(NOTES), tab: 'open', open: 'b' });

    assert.equal(root.querySelector('h2')?.textContent, 'Notes de cette page');
    assert.equal(root.querySelector('button.panel-close')?.getAttribute('aria-label'), 'Fermer le panneau');
    assert.ok([...root.querySelectorAll('button')].some((each) => each.textContent === 'Laisser une note'));
    assert.deepEqual(
      [...root.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent),
      ['À vérifier · 0', 'Ouvertes · 3', 'Terminées · 1'],
    );
    assert.equal(root.querySelector('li[data-note="b"] .panel-row-meta')?.textContent, 'À faire · Vous · hier');
    assert.deepEqual(
      [...root.querySelectorAll('li[data-note="b"] .panel-row-links button')].map((link) => link.textContent),
      ['Voir sur la page', 'Répondre'],
    );
  });
  describe('a panel of many notes, on a long host (FRU-611)', () => {
    const many = (count: number, stage: PanelNote['stage'], mine: boolean): PanelNote[] =>
      Array.from({ length: count }, (_, index) => ({
        id: `${stage}-${mine}-${index}`,
        stage,
        note: `Note ${index}`,
        createdAt: '2026-10-19T12:00:00Z',
        updatedAt: '2026-10-19T12:00:00Z',
        replies: [],
        canReply: false,
        placement: 'found' as const,
        ...(mine ? { mine: true as const } : {}),
      }));

    it('says « 99+ » above 99 in Open and Done, and the notes to check exactly', () => {
      const root = panelPage(page(), {
        ...handlers(),
        state: on([...many(101, 'done', true), ...many(150, 'new', false), ...many(100, 'closed', false)]),
        tab: 'open',
      });

      assert.deepEqual(
        [...root.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent),
        ['To check · 101', 'Open · 99+', 'Done · 99+'],
      );
    });

    it('names the host in a box cut at its start, the workspace after it, and the whole host in its tooltip', () => {
      const host = 'review-4521-a-very-long-branch-name.preview.staging.acme-corporation.example.com';
      const root = panelPage(page(), { ...handlers(), state: { kind: 'on', host, where: 'Acme', notes: [] } });
      const box = root.querySelector<HTMLElement>('.panel-where .kit-host-tail');

      assert.equal(root.querySelector('.panel-where')?.textContent, `${host} · Acme`);
      assert.equal(box?.title, host);
      assert.equal(box?.querySelector('span')?.getAttribute('dir'), 'ltr');
    });
  });
});

describe('« To check », the first tab (FRU-300, FRU-606)', () => {
  const NOW = Date.parse('2026-10-20T12:00:00Z');
  const base = {
    note: 'The email field is too short on mobile.',
    createdAt: '2026-10-18T12:00:00Z',
    updatedAt: '2026-10-20T10:00:00Z',
    replies: [] as PanelNote['replies'],
    canReply: true,
    placement: 'found' as const,
  };
  const READY: PanelNote = {
    ...base,
    id: 'r1',
    number: 1,
    stage: 'done',
    mine: true,
    replies: [{ author: 'Sakuga team', body: 'Fixed in the last deploy.', createdAt: '2026-10-20T10:00:00Z' }],
  };
  // Raised in review: a reply from a page, under a typed name, does not say who fixed the note.
  const NOBODY: PanelNote = {
    ...base,
    id: 'r2',
    number: 2,
    stage: 'done',
    mine: true,
    note: 'The Add button.',
    replies: [{ author: 'Sakuga team', body: 'Typed on a page.', createdAt: '2026-10-20T11:00:00Z', fromPage: true }],
  };
  const OTHERS: PanelNote = { ...base, id: 'o1', number: 3, stage: 'done', note: 'Somebody else’s.' };
  const CHECKED: PanelNote = {
    ...base,
    id: 'c1',
    number: 4,
    stage: 'done',
    mine: true,
    checked: { by: 'Camille Durand', at: '2026-10-20T11:59:30Z' },
  };
  const OPEN: PanelNote = { ...base, id: 'n1', number: 5, stage: 'new', mine: true, note: 'Reopened one.' };
  const calls: string[] = [];
  const options = (extra: Partial<PanelOptions> = {}): PanelOptions => ({
    state: { kind: 'on', host: 'staging.acme.dev', notes: [READY, NOBODY, OTHERS, CHECKED, OPEN] },
    tab: 'open',
    now: NOW,
    onClose: () => {},
    onLeave: () => {},
    onTab: () => {},
    onToggle: () => {},
    onShow: () => {},
    onReplyOpen: () => {},
    onReplyInput: () => {},
    onReplySend: () => {},
    onReplyCancel: () => {},
    onRetry: () => {},
    onReload: () => {},
    onSettings: () => {},
    onVerdict: (id, verdict) => calls.push(`${id}:${verdict}`),
    ...extra,
  });

  it('holds the done notes of the reader that nobody confirmed, and no other', () => {
    assert.deepEqual([READY, NOBODY, OTHERS, CHECKED, OPEN].map(toCheck), [true, true, false, false, false]);
  });

  it('is the first of three tabs, To check, Open and Done, and takes them out of « Done »', () => {
    const root = panelPage(page(), options({ tab: 'check' }));
    const block = root.querySelector('.ready[role="tabpanel"]');

    assert.deepEqual(
      [...root.querySelectorAll('[role="tab"]')].map((tab) => [tab.textContent, tab.getAttribute('aria-selected')]),
      [
        ['To check · 2', 'true'],
        ['Open · 1', 'false'],
        ['Done · 2', 'false'],
      ],
    );
    assert.equal(root.querySelector('section.ready'), null, 'no block of its own above the tabs any more');
    assert.equal(
      block?.querySelector('.ready-text')?.textContent,
      'The team says these are fixed. Do they look right to you?',
    );
    assert.deepEqual(
      [...(block?.querySelectorAll('.ready-meta') ?? [])].map((line) => line.textContent),
      ['Fixed by Sakuga team · 2 hours ago', 'Marked done · 2 hours ago'],
    );
  });

  it('opens on « To check » while a note waits, and on « Open » when none does, until the reader chooses', () => {
    const { tab: _tab, ...chosenNone } = options();
    const waiting = panelPage(page(), chosenNone);
    assert.equal(waiting.querySelector('[aria-selected="true"]')?.getAttribute('data-tab'), 'check');

    const none = panelPage(page(), {
      ...chosenNone,
      state: { kind: 'on', host: 'staging.acme.dev', notes: [OTHERS, OPEN] },
    });
    assert.equal(none.querySelector('[aria-selected="true"]')?.getAttribute('data-tab'), 'open');

    const chosen: string[] = [];
    const rail = panelPage(page(), { ...chosenNone, onTab: (tab) => chosen.push(tab) });
    for (const tab of rail.querySelectorAll<HTMLButtonElement>('[role="tab"]')) tab.click();
    assert.deepEqual(chosen, ['check', 'open', 'done']);
  });

  it('sends « Looks fixed » and « Still wrong » for their note', () => {
    calls.length = 0;
    const root = panelPage(page(), options({ tab: 'check' }));
    const item = root.querySelector('.ready-item[data-note="r2"]');
    const [fixed, wrong] = [...(item?.querySelectorAll<HTMLButtonElement>('.ready-actions button') ?? [])];

    assert.equal(fixed?.textContent, 'Looks fixed');
    assert.equal(wrong?.textContent, 'Still wrong');
    fixed?.click();
    wrong?.click();
    assert.deepEqual(calls, ['r2:fixed', 'r2:wrong']);
  });

  it('holds both buttons while a verdict is written, and says why one did not go', () => {
    const sending = panelPage(page(), options({ tab: 'check', checking: { id: 'r1', sending: 'fixed' } }));
    const buttons = [...sending.querySelectorAll<HTMLButtonElement>('.ready-item[data-note="r1"] button')];
    assert.deepEqual(
      buttons.map((button) => [button.textContent, button.disabled]),
      [
        ['Sending…', true],
        ['Still wrong', true],
      ],
    );

    const failed = panelPage(page(), options({ tab: 'check', checking: { id: 'r1', problem: CHECK_PROBLEM.retry } }));
    assert.equal(
      failed.querySelector('.ready-item[data-note="r1"] [role="alert"]')?.textContent,
      'Your answer was not sent. Try again.',
    );
    assert.equal(failed.querySelector<HTMLButtonElement>('.ready-item[data-note="r1"] button')?.disabled, false);
  });

  it('says « Checked by you » in Done, and « Reopened by you » in Open', () => {
    const done = panelPage(page(), options({ tab: 'done' }));
    assert.equal(
      done.querySelector('li[data-note="c1"] .panel-row-meta')?.textContent,
      'Done · Checked by you · just now',
    );

    const open = panelPage(page(), options({ reopened: { n1: '2026-10-20T11:59:50Z' } }));
    assert.equal(
      open.querySelector('li[data-note="n1"] .panel-row-meta')?.textContent,
      'New · Reopened by you · just now',
    );
  });

  it('says so when no note is to check', () => {
    const root = panelPage(
      page(),
      options({ tab: 'check', state: { kind: 'on', host: 'staging.acme.dev', notes: [OTHERS, OPEN] } }),
    );
    assert.equal(root.querySelector('.ready-item'), null);
    assert.equal(root.querySelector('.ready-text'), null);
    assert.equal(root.querySelector('.panel-none')?.textContent, 'No note to check.');
  });

  it('is in French for a French reader', () => {
    setLanguage('fr');
    const root = panelPage(page(), options({ tab: 'check' }));
    assert.deepEqual(
      [...root.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent),
      ['À vérifier · 2', 'Ouvertes · 1', 'Terminées · 2'],
    );
    assert.deepEqual(
      [...root.querySelectorAll('.ready-item[data-note="r1"] button')].map((button) => button.textContent),
      ['C’est corrigé', 'Toujours pas'],
    );
    assert.equal(
      root.querySelector('.ready-item[data-note="r1"] .ready-meta')?.textContent,
      'Corrigée par Sakuga team · il y a 2 heures',
    );
  });
});

describe('the tab of a note, and its age', () => {
  it('puts new, to do and in progress under « Open », done and closed under « Done »', () => {
    const of = (stage: PanelNote['stage']) =>
      tabOf({
        id: 'x',
        stage,
        note: '',
        createdAt: '',
        updatedAt: '',
        replies: [],
        canReply: false,
        placement: 'found',
      });
    assert.deepEqual((['new', 'todo', 'progress', 'done', 'closed'] as const).map(of), [
      'open',
      'open',
      'open',
      'done',
      'done',
    ]);
  });

  it('says an age in words, and nothing for a date that does not parse', () => {
    const now = Date.parse('2026-10-20T12:00:00Z');
    assert.equal(ageOf('2026-10-20T11:59:50Z', now), 'just now');
    assert.equal(ageOf('2026-10-20T10:00:00Z', now), '2 hours ago');
    assert.equal(ageOf('not a date', now), '');
  });
});

describe('« Open Fruitback », the popup from the panel (FRU-532)', () => {
  const opens = { action: { openPopup: async () => undefined } };

  it('is offered where the panel reads the address of the tab, which the popup reads the same way', () => {
    assert.equal(offersPopup(opens, 'https://staging.acme.dev/cart', false), true);
    // No address: the popup opened from here would get none either, and say « web pages only ».
    assert.equal(offersPopup(opens, undefined, false), false);
    assert.equal(offersPopup(opens, 'chrome://extensions/', false), false);
  });

  it('is not offered by a browser with no `action.openPopup`, nor after a refusal', () => {
    assert.equal(offersPopup({}, 'https://staging.acme.dev/', false), false);
    assert.equal(offersPopup({ action: {} }, 'https://staging.acme.dev/', false), false);
    assert.equal(offersPopup(opens, 'https://staging.acme.dev/', true), false);
  });

  it('asks for the popup at once, in the click, before any `await`', () => {
    const calls: string[] = [];
    openPopupFrom({ action: { openPopup: async () => void calls.push('open') } }, () => calls.push('refused'));

    assert.deepEqual(calls, ['open']);
  });

  it('says so when the browser refuses, or throws', async () => {
    const said: string[] = [];
    const quiet = mock.method(console, 'error', () => undefined);
    try {
      openPopupFrom({ action: { openPopup: () => Promise.reject(new Error('no gesture')) } }, () => said.push('a'));
      openPopupFrom(
        {
          action: {
            openPopup: () => {
              throw new Error('not here');
            },
          },
        },
        () => said.push('b'),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      quiet.mock.restore();
    }

    assert.deepEqual(said.sort(), ['a', 'b']);
  });
});

describe('a site of the Cloud that its members read, in extension mode (FRU-729)', () => {
  const CLOUD = 'https://api.fruitback.test';
  const rule = { endpoint: CLOUD };
  /** The seams of `membersOnlyOf`, and what each was asked. */
  const seams = (answer: ReadProbe, signedIn = false, member = false) => {
    const asked: string[] = [];

    return {
      asked,
      probe: async () => {
        asked.push('probe');

        return answer;
      },
      signedIn: async () => {
        asked.push('signed-in');

        return signedIn;
      },
      member: async () => {
        asked.push('member');

        return member;
      },
    };
  };

  it('says the line of the popup for a refused read, signed out, with the popup to sign in', async () => {
    assert.deepEqual(await membersOnlyOf(rule, CLOUD, seams('members-only')), {
      members: { sentence: CLOUD_NOTES_NEED_MEMBER, action: 'sign-in' },
      closed: true,
    });
    // Notes open to anyone, reads to members only: « Leave a note » stays.
    assert.deepEqual(await membersOnlyOf(rule, CLOUD, seams('wants-a-session')), {
      members: { sentence: CLOUD_READ_NEEDS_MEMBER, action: 'sign-in' },
      closed: false,
    });
  });

  it('signed in, asks whether the account is a member, as the popup does', async () => {
    const member = seams('members-only', true, true);
    assert.deepEqual(await membersOnlyOf(rule, CLOUD, member), {
      members: { sentence: MEMBER_TURNS_ON, action: 'turn-on' },
      closed: true,
    });
    assert.deepEqual(member.asked, ['probe', 'signed-in', 'member']);
    assert.deepEqual((await membersOnlyOf(rule, CLOUD, seams('members-only', true, false)))?.members, {
      sentence: NOT_A_MEMBER,
    });
    // Signed out, the workspaces are not asked.
    const out = seams('members-only');
    await membersOnlyOf(rule, CLOUD, out);
    assert.deepEqual(out.asked, ['probe', 'signed-in']);
  });

  it('keeps « could not be read » off the Cloud of the build, and for any other answer', async () => {
    const elsewhere = seams('members-only');
    assert.equal(await membersOnlyOf({ endpoint: 'https://feedback.acme.dev' }, CLOUD, elsewhere), undefined);
    assert.equal(await membersOnlyOf(rule, undefined, elsewhere), undefined);
    // Not even asked: a worker run by somebody else keeps the words of before.
    assert.deepEqual(elsewhere.asked, []);
    for (const answer of ['answers', 'not-found', 'unknown'] as const) {
      assert.equal(await membersOnlyOf(rule, CLOUD, seams(answer)), undefined, answer);
    }
    const throwing = { ...seams('members-only'), probe: () => Promise.reject(new Error('down')) };
    assert.equal(await membersOnlyOf(rule, CLOUD, throwing), undefined);
  });

  const options = (notes: PanelNotes, popup: boolean): PanelOptions & { calls: string[] } => {
    const calls: string[] = [];
    const push = (what: string) => () => void calls.push(what);

    return {
      calls,
      state: { kind: 'on', host: 'staging.acme.dev', notes },
      onClose: push('close'),
      onLeave: push('leave'),
      onTab: push('tab'),
      onToggle: push('toggle'),
      onShow: push('show'),
      onReplyOpen: push('reply'),
      onReplyInput: push('input'),
      onReplySend: push('send'),
      onReplyCancel: push('cancel'),
      onRetry: push('retry'),
      onReload: push('reload'),
      onSettings: push('settings'),
      onVerdict: push('verdict'),
      ...(popup ? { onOpenPopup: push('popup') } : {}),
    };
  };

  it('says it in the panel in place of « could not be read », and opens the popup to sign in', () => {
    const shown = options({ members: { sentence: CLOUD_NOTES_NEED_MEMBER, action: 'sign-in' }, closed: true }, true);
    const root = panelPage(page(), shown);

    assert.equal(root.querySelector('.panel-members [role="status"]')?.textContent, CLOUD_NOTES_NEED_MEMBER);
    assert.doesNotMatch(root.textContent ?? '', /could not be read|Try again|does not answer/);
    // The site takes no note from here: no « Leave a note » that leads nowhere.
    assert.equal(
      [...root.querySelectorAll('button')].some((button) => button.textContent?.includes('Leave a note')),
      false,
    );
    const open = root.querySelector<HTMLButtonElement>('.panel-members button.panel-open-popup');
    assert.equal(open?.textContent, 'Open Fruitback');
    open?.click();
    assert.deepEqual(shown.calls, ['popup']);
  });

  it('keeps « Leave a note » where notes are open, and says where the button is with no popup', () => {
    const root = panelPage(
      page(),
      options({ members: { sentence: CLOUD_READ_NEEDS_MEMBER, action: 'sign-in' }, closed: false }, false),
    );
    assert.equal(root.querySelector('.panel-action .kit-note')?.textContent?.includes('Leave a note'), true);
    assert.equal(root.querySelector('.panel-members button'), null);
    assert.match(root.querySelector('.panel-members')?.textContent ?? '', /from the Fruitback button in the toolbar/);
  });

  it('offers no button to an account that is not a member, and says it in French', () => {
    setLanguage('fr');
    const root = panelPage(page(), options({ members: { sentence: NOT_A_MEMBER }, closed: true }, true));
    assert.equal(root.querySelector('.panel-members button'), null);
    assert.match(root.querySelector('.panel-members')?.textContent ?? '', /^Seuls les membres de ce site/);
  });
});

describe('only the latest read of the notes is drawn (Kentō #73e393)', () => {
  /** A read that answers when the test says so. */
  const held = () => {
    const answers: ((value: string) => void)[] = [];
    const read = latestOnly(
      (_name: string) =>
        new Promise<string>((resolve) => {
          answers.push(resolve);
        }),
    );

    return { read, answers };
  };

  it('drops a slow read that succeeded, once a newer one started', async () => {
    const { read, answers } = held();
    const older = read('older');
    const newer = read('newer');
    // The newer read answers first, then the older one, with notes.
    answers[1]?.('notes of now');
    answers[0]?.('notes of before');

    assert.deepEqual(await newer, { value: 'notes of now' });
    assert.equal(await older, undefined);
  });

  it('drops a slow read that failed the same way, and keeps a read nobody overtook', async () => {
    const { read, answers } = held();
    const older = read('older');
    const newer = read('newer');
    answers[0]?.('failed');
    answers[1]?.('notes of now');
    assert.equal(await older, undefined);
    assert.deepEqual(await newer, { value: 'notes of now' });

    const alone = read('alone');
    answers[2]?.('reload');
    assert.deepEqual(await alone, { value: 'reload' });
  });

  it('tells a read that answered `undefined` from one that was overtaken', async () => {
    const read = latestOnly(async () => undefined);
    assert.deepEqual(await read(), { value: undefined });
  });
});

describe('the host the panel shows', () => {
  it('is the host of a web address, and nothing for a page of the browser', () => {
    assert.equal(webHost('https://staging.acme.dev/cart?x=1'), 'staging.acme.dev');
    assert.equal(webHost('http://localhost:5177/'), 'localhost:5177');
    assert.equal(webHost('chrome://extensions/'), undefined);
    assert.equal(webHost('about:blank'), undefined);
    assert.equal(webHost(undefined), undefined);
    assert.equal(webHost('not a url'), undefined);
  });
});

describe('what the panel does with an answer of the widget (raised in review)', () => {
  const NOTE: PanelNote = {
    id: 'n1',
    stage: 'todo',
    note: 'A note',
    createdAt: '2026-10-20T10:00:00Z',
    updatedAt: '2026-10-20T10:00:00Z',
    replies: [],
    canReply: false,
    placement: 'found',
  };

  it('lists the notes, waits for a widget that has not read, says a failed read, and a page with nothing to answer', () => {
    assert.deepEqual(notesOf({ notes: [NOTE] }), [NOTE]);
    assert.equal(notesOf({ reading: 'pending' }), 'reading');
    assert.equal(notesOf({ reading: 'no-widget' }), 'reading');
    assert.equal(notesOf({}), 'reading');
    assert.equal(notesOf({ reading: 'failed' }), 'failed');
    assert.equal(notesOf({ reading: 'signed-out' }), 'signed-out');
    assert.equal(notesOf(undefined), 'reload');
  });

  it('says to reload a page that still has no widget once the wait is over, and only then', () => {
    assert.equal(notesOf({ reading: 'no-widget' }, true), 'not-started');
    assert.equal(notesOf({ reading: 'pending' }, true), 'reading');
    assert.deepEqual(notesOf({ notes: [NOTE] }, true), [NOTE]);
  });

  it('opens the row of a pin once a list that holds it is read, and keeps it waiting until then', () => {
    assert.deepEqual(openOnRead('n1', 'reading'), { waiting: 'n1' });
    assert.deepEqual(openOnRead('n1', 'failed'), { waiting: 'n1' });
    assert.deepEqual(openOnRead('n1', [NOTE]), { open: NOTE });
    assert.deepEqual(openOnRead('gone', [NOTE]), {});
    assert.deepEqual(openOnRead(undefined, [NOTE]), {});
  });

  it('says to reload a page that was open before the site was on, with a button that does it', () => {
    const calls: string[] = [];
    const root = panelPage(new HappyDomWindow().document as unknown as Document, {
      state: { kind: 'on', host: 'staging.acme.dev', notes: 'reload' },
      tab: 'open',
      onClose: () => {},
      onLeave: () => {},
      onTab: () => {},
      onToggle: () => {},
      onShow: () => {},
      onReplyOpen: () => {},
      onReplyInput: () => {},
      onReplySend: () => {},
      onReplyCancel: () => {},
      onRetry: () => {},
      onReload: () => calls.push('reload'),
      onSettings: () => {},
      onVerdict: () => {},
    });
    assert.match(root.textContent ?? '', /Reload it to see its notes\./);
    [...root.querySelectorAll<HTMLButtonElement>('button')]
      .find((each) => each.textContent === 'Reload the page')
      ?.click();
    assert.deepEqual(calls, ['reload']);
  });

  it('takes a reply of the length the worker takes, read in the worker', () => {
    // In `reply-text.ts` since FRU-712: the widget, `/mcp` and the console read it there.
    const worker = readFileSync(fileURLToPath(new URL('../../worker/src/reply-text.ts', import.meta.url)), 'utf8');
    const length = /export const REPLY_LENGTH = (\d+);/.exec(worker)?.[1];

    assert.ok(
      length !== undefined,
      'apps/worker/src/reply-text.ts no longer names REPLY_LENGTH: this check reads nothing',
    );
    assert.equal(REPLY_MAX_LENGTH, Number(length));
  });
});

describe('what the click on the icon opens (FRU-302)', () => {
  it('opens the panel when asked for, on a site that is on, and with its session held', () => {
    assert.equal(iconOpensPanel(true, { enabled: true }, false), true);
    assert.equal(iconOpensPanel(false, { enabled: true }, false), false);
    assert.equal(iconOpensPanel(true, { enabled: false }, false), false);
    assert.equal(iconOpensPanel(true, undefined, false), false);
  });

  it('opens the popup on a site whose session ended, where the person signs in again (review)', () => {
    assert.equal(iconOpensPanel(true, { enabled: true }, true), false);
  });

  it('sets the behaviour of the browser, and nothing on a browser with no such behaviour', async () => {
    const set: boolean[] = [];
    const apis: PanelApis = {
      sidePanel: {
        open: async () => {},
        setPanelBehavior: async ({ openPanelOnActionClick }) => {
          set.push(openPanelOnActionClick);
        },
      },
    };
    await setPanelOnClick(apis, true, true);
    await setPanelOnClick(apis, true, false);
    await setPanelOnClick(apis, false, true);
    assert.deepEqual(set, [true, false, false]);
    await setPanelOnClick({ sidebarAction: { open: async () => {} } }, true, true);
  });
});

describe('the pins a panel hid come back when it goes (FRU-307, review of #419)', () => {
  it('shows again, once the port closes, the tabs still hidden, and only them', () => {
    const shown: number[] = [];
    const keeper = pinsKeeper((tabId) => shown.push(tabId));
    keeper.heard({ hidden: 4 });
    keeper.heard({ hidden: 7 });
    keeper.heard({ shown: 4 });
    keeper.heard({ hidden: 'nine' });
    keeper.heard(null);
    assert.deepEqual(shown, [], 'nothing before the panel goes');

    keeper.closed();

    assert.deepEqual(shown, [7]);
    keeper.closed();
    assert.deepEqual(shown, [7], 'once');
  });

  it('reads a tab id and nothing else', () => {
    assert.deepEqual(parsePinsMessage({ hidden: 3 }), { hidden: 3 });
    assert.deepEqual(parsePinsMessage({ shown: 3 }), { shown: 3 });
    assert.equal(parsePinsMessage({ hidden: 1.5 }), undefined);
    assert.equal(parsePinsMessage('hidden'), undefined);
  });
});

/**
 * The sheet of the panel as Tailwind writes it (FRU-679): its rules are `@apply`, so the guards below
 * read the declarations of the built sheet, which are those the browser takes.
 */
async function builtPanelSheet(): Promise<string> {
  const file = fileURLToPath(new URL('../entrypoints/sidepanel/style.css', import.meta.url));
  const compiler = await compile(readFileSync(file, 'utf8'), {
    base: fileURLToPath(new URL('../entrypoints/sidepanel/', import.meta.url)),
    from: file,
    onDependency: () => {},
  });

  return compiler.build([]);
}

describe('the margins of the panel (FRU-533)', () => {
  let sheet = '';
  before(async () => {
    sheet = await builtPanelSheet();
  });
  /** The declarations of the rule whose selector is `selector`, alone on its line. */
  const rule = (selector: string): string =>
    new RegExp(`\\n${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(sheet)?.[1] ?? '';

  it('takes off the padding of the body of the popup, whose sheet the panel links first', () => {
    // Tailwind writes `p-0` as `padding: 0px`.
    assert.match(rule('body.side-panel-page'), /\bpadding: 0(px)?;/);
  });

  it('declares the gutter once, at 12 px', () => {
    assert.deepEqual(
      [...sheet.matchAll(/--panel-gutter:\s*([^;]+);/g)].map((match) => match[1]),
      ['12px'],
    );
  });

  it('gives every block its side margin from the gutter, not a value of its own', () => {
    for (const selector of [
      '.panel-head',
      '.panel-state',
      '.panel-action',
      '.panel-tabs',
      '.panel-list',
      '.panel-failed',
      '.panel-foot',
      '.ready',
      '.search-options',
      '.site-more',
      '.search-detached',
    ]) {
      const declarations = rule(selector);
      assert.notEqual(declarations, '', `no rule for ${selector}: this guard reads nothing`);
      assert.match(
        declarations,
        /(padding|margin)[a-z-]*:[^;]*var\(--panel-gutter\)/,
        `${selector} has a margin of its own`,
      );
    }
  });

  it('keeps no side margin of 18 or 20 px, the margins of before', () => {
    // The side values of a shorthand: the second, and the fourth when there is one. Tailwind also
    // writes a side as its own property (`padding-inline`, `padding-left`…): each value is a side.
    const sides = [
      ...sheet.matchAll(/\b(?:padding|margin)(-inline-start|-inline-end|-inline|-left|-right)?:\s*([^;]+);/g),
    ].flatMap((match) => {
      const values = (match[2] ?? '').trim().split(/\s+(?![^(]*\))/);
      if (match[1] !== undefined) return values;

      return values.length === 1 ? values : [values[1], values[3] ?? values[1]];
    });
    assert.ok(sides.length > 20, 'this guard reads no margin');
    assert.deepEqual(
      sides.filter((value) => value === '18px' || value === '20px'),
      [],
    );
  });
});

describe('one line for each note (FRU-534)', () => {
  let sheet = '';
  before(async () => {
    sheet = await builtPanelSheet();
  });

  it('cuts the words of a note to one line, with « … », in each list of the panel', () => {
    const rule = /\.panel-row-note,\s*\.ready-note,\s*\.search-detached-note \{([^}]*)\}/.exec(sheet)?.[1] ?? '';
    for (const declaration of ['overflow: hidden', 'white-space: nowrap', 'text-overflow: ellipsis']) {
      assert.ok(rule.includes(declaration), `no « ${declaration} » for the words of a note`);
    }
  });

  it('shows the whole note in an open row', () => {
    const rule = /\.panel-row\[data-open='true'\] \.panel-row-note \{([^}]*)\}/.exec(sheet)?.[1] ?? '';
    assert.ok(rule.includes('white-space: normal'), 'an open row cuts its note');
  });
});

describe('« To check » holds the notes of the other pages of the site (FRU-734)', () => {
  const ELSEWHERE: SiteNote[] = [
    {
      note: 'sd_far_1',
      excerpt: 'The footer link is broken.',
      page: { url: 'https://staging.acme.dev/about', path: '/about' },
      stage: 'done',
      mine: true,
      createdAt: '2026-10-18T12:00:00Z',
    },
    {
      note: 'sd_far_2',
      excerpt: 'The price is wrong.',
      page: { url: 'https://staging.acme.dev/pricing', path: '/pricing' },
      stage: 'done',
      mine: true,
      createdAt: '2026-10-19T12:00:00Z',
    },
  ];
  const HERE: PanelNote = {
    id: 'n1',
    number: 1,
    stage: 'new',
    note: 'A note of this page.',
    createdAt: '2026-10-18T12:00:00Z',
    updatedAt: '2026-10-18T12:00:00Z',
    replies: [],
    canReply: true,
    placement: 'found',
  };
  const options = (notes: PanelNote[], extra: Partial<PanelOptions> = {}) => {
    const calls: string[] = [];
    const built: PanelOptions = {
      state: { kind: 'on', host: 'staging.acme.dev', notes },
      onClose: () => {},
      onLeave: () => {},
      onTab: () => {},
      onToggle: () => {},
      onShow: () => {},
      onReplyOpen: () => {},
      onReplyInput: () => {},
      onReplySend: () => {},
      onReplyCancel: () => {},
      onRetry: () => {},
      onReload: () => {},
      onSettings: () => {},
      onVerdict: () => {},
      elsewhere: {
        notes: ELSEWHERE,
        onVerdict: (note, verdict) => calls.push(`${note.note}:${verdict}`),
        onOpen: (note) => calls.push(`open:${note.note}`),
      },
      ...extra,
    };

    return { built, calls };
  };
  const rows = (root: Element) =>
    [...root.querySelectorAll<HTMLElement>('.ready-elsewhere [data-site-note]')].map((row) => row.dataset.siteNote);

  it('opens on « To check », counts them with the notes of the page, and lists their words and page', () => {
    const { built } = options([HERE]);
    const root = panelPage(page(), built);

    const tabs = [...root.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.trim());
    assert.equal(tabs[0], 'To check · 2');
    assert.equal(root.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim(), 'To check · 2');
    assert.deepEqual(rows(root), ['sd_far_1', 'sd_far_2']);
    assert.equal(root.querySelector('.ready-elsewhere-title')?.textContent, 'On other pages · 2');
    assert.ok(root.querySelector('[data-site-note="sd_far_1"]')?.textContent?.includes('/about'));
    // The tab has notes: it does not say it is empty.
    assert.equal(root.querySelector('.panel-none'), null);
  });

  it('sends a verdict and opens the page of the note from its buttons', () => {
    const { built, calls } = options([HERE]);
    const root = panelPage(page(), built);
    const row = root.querySelector('[data-site-note="sd_far_2"]');
    row?.querySelector<HTMLButtonElement>('.ready-fixed')?.click();
    row?.querySelector<HTMLButtonElement>('.ready-wrong')?.click();
    row?.querySelector<HTMLButtonElement>('.ready-open')?.click();

    assert.deepEqual(calls, ['sd_far_2:fixed', 'sd_far_2:wrong', 'open:sd_far_2']);
  });

  it('shows them on a page with no note of its own, above the empty state', () => {
    const { built } = options([]);
    const root = panelPage(page(), built);

    assert.deepEqual(rows(root), ['sd_far_1', 'sd_far_2']);
    assert.ok(root.querySelector('.panel-empty') !== null);
  });

  it('holds both buttons of the note whose verdict is on its way, and says why one did not go', () => {
    const sending = panelPage(page(), options([HERE], { checking: { id: 'sd_far_1', sending: 'fixed' } }).built);
    const buttons = [
      ...sending.querySelectorAll<HTMLButtonElement>('[data-site-note="sd_far_1"] .ready-actions button'),
    ];
    assert.deepEqual(
      buttons.map((button) => button.disabled),
      [true, true, false],
    );
    const other = [...sending.querySelectorAll<HTMLButtonElement>('[data-site-note="sd_far_2"] .ready-actions button')];
    assert.ok(other.every((button) => !button.disabled));

    const refused = panelPage(
      page(),
      options([HERE], { checking: { id: 'sd_far_1', problem: CHECK_PROBLEM.refused } }).built,
    );
    assert.equal(
      refused.querySelector('[data-site-note="sd_far_1"] [role="alert"]')?.textContent,
      CHECK_PROBLEM.refused,
    );
  });

  it('is the list of before with no note elsewhere: the tab of the page, and its count', () => {
    const { built } = options([HERE], { elsewhere: { notes: [], onVerdict: () => {}, onOpen: () => {} } });
    const root = panelPage(page(), built);

    assert.equal(root.querySelector('[role="tab"]')?.textContent?.trim(), 'To check · 0');
    assert.equal(root.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim(), 'Open · 1');
    assert.equal(root.querySelector('.ready-elsewhere'), null);
  });
});
