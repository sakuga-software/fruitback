import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Window as HappyDomWindow } from 'happy-dom';
import { setLanguage } from './i18n.ts';
import type { PanelNote } from './protocol.ts';
import {
  type PanelApis,
  type PanelOptions,
  type PanelState,
  CHECK_PROBLEM,
  REPLY_PROBLEM,
  REPLY_MAX_LENGTH,
  ageOf,
  keepPopupOnActionClick,
  notesOf,
  openOnRead,
  openPanel,
  openPanelOrPage,
  panelPage,
  tabOf,
  toCheck,
  webHost,
} from './side-panel.ts';

/**
 * The side panel (FRU-296): the gesture that opens it in each browser, the behaviour of the icon,
 * and the frame of its page. The panel opened from a real popup is `e2e/side-panel.spec.ts`'s.
 */

function page(): Document {
  return new HappyDomWindow({ url: 'chrome-extension://fruitback/sidepanel.html' }).document as unknown as Document;
}

afterEach(() => setLanguage('en'));

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
    note({ id: 'b', number: 3, stage: 'green', note: 'Could the title mention Bordeaux?', mine: true }),
    note({ id: 'a', number: 4, stage: 'seeded', author: 'Léa', createdAt: '2026-10-20T11:20:00Z' }),
    note({ id: 'c', number: 1, stage: 'ripe', canReply: false }),
    note({ id: 'd', number: 2, stage: 'ripening' }),
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
  const on = (notes: PanelNote[] | 'reading' | 'failed'): PanelState => ({
    kind: 'on',
    host: 'staging.acme.dev',
    where: 'Acme',
    notes,
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
        'Its notes are on the page, in its own list. This panel lists the notes of a site Fruitback mounts.',
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

  it('offers « Leave feedback », and names the site and its workspace at the foot with « Settings »', () => {
    const options = handlers();
    const root = panelPage(page(), { ...options, state: on([]), tab: 'open' });
    const leave = [...root.querySelectorAll('button')].find((each) => each.textContent === 'Leave feedback');

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

  it('counts « Open » and « Done », and lists each by the number of its pin', () => {
    const root = panelPage(page(), { ...handlers(), state: on(NOTES), tab: 'open' });

    assert.deepEqual(
      [...root.querySelectorAll('[role="tab"]')].map((tab) => [tab.textContent, tab.getAttribute('aria-selected')]),
      [
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
    assert.equal(third?.querySelector('.kit-drop')?.getAttribute('data-stage'), 'green');
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
      'The reply did not go through. Your text is kept. Try again.',
    );
    root
      .querySelector('form')
      ?.dispatchEvent(
        new (root.ownerDocument.defaultView as unknown as typeof globalThis).Event('submit', { cancelable: true }),
      );
    assert.deepEqual(options.calls, ['send']);
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

  it('is in French for a French reader', () => {
    setLanguage('fr');
    const root = panelPage(page(), { ...handlers(), state: on(NOTES), tab: 'open', open: 'b' });

    assert.equal(root.querySelector('h2')?.textContent, 'Notes de cette page');
    assert.equal(root.querySelector('button.panel-close')?.getAttribute('aria-label'), 'Fermer le panneau');
    assert.ok([...root.querySelectorAll('button')].some((each) => each.textContent === 'Laisser une note'));
    assert.deepEqual(
      [...root.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent),
      ['Ouvertes · 3', 'Terminées · 1'],
    );
    assert.equal(root.querySelector('li[data-note="b"] .panel-row-meta')?.textContent, 'À faire · Vous · hier');
    assert.deepEqual(
      [...root.querySelectorAll('li[data-note="b"] .panel-row-links button')].map((link) => link.textContent),
      ['Voir sur la page', 'Répondre'],
    );
  });
});

describe('« Ready to check » (FRU-300)', () => {
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
    stage: 'ripe',
    mine: true,
    replies: [{ author: 'Sakuga team', body: 'Fixed in the last deploy.', createdAt: '2026-10-20T10:00:00Z' }],
  };
  // Raised in review: a reply from a page, under a typed name, does not say who fixed the note.
  const NOBODY: PanelNote = {
    ...base,
    id: 'r2',
    number: 2,
    stage: 'ripe',
    mine: true,
    note: 'The Add button.',
    replies: [{ author: 'Sakuga team', body: 'Typed on a page.', createdAt: '2026-10-20T11:00:00Z', fromPage: true }],
  };
  const OTHERS: PanelNote = { ...base, id: 'o1', number: 3, stage: 'ripe', note: 'Somebody else’s.' };
  const CHECKED: PanelNote = {
    ...base,
    id: 'c1',
    number: 4,
    stage: 'ripe',
    mine: true,
    checked: { by: 'Camille Durand', at: '2026-10-20T11:59:30Z' },
  };
  const OPEN: PanelNote = { ...base, id: 'n1', number: 5, stage: 'seeded', mine: true, note: 'Reopened one.' };
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
    onSettings: () => {},
    onVerdict: (id, verdict) => calls.push(`${id}:${verdict}`),
    ...extra,
  });

  it('holds the done notes of the reader that nobody confirmed, and no other', () => {
    assert.deepEqual([READY, NOBODY, OTHERS, CHECKED, OPEN].map(toCheck), [true, true, false, false, false]);
  });

  it('shows them between « Leave feedback » and the tabs, with who fixed them, and takes them out of « Done »', () => {
    const root = panelPage(page(), options());
    const block = root.querySelector('section.ready');

    assert.ok(block, 'no block');
    assert.ok(
      (block?.compareDocumentPosition(root.querySelector('[role="tablist"]') as Node) ?? 0) & 4,
      'the block is not before the tabs',
    );
    assert.equal(block?.querySelector('h3')?.textContent, 'Ready to check · 2');
    assert.equal(
      block?.querySelector('.ready-text')?.textContent,
      'The team says these are fixed. Do they look right to you?',
    );
    assert.deepEqual(
      [...(block?.querySelectorAll('.ready-meta') ?? [])].map((line) => line.textContent),
      ['Fixed by Sakuga team · 2 hours ago', 'Marked done · 2 hours ago'],
    );
    assert.deepEqual(
      [...root.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent),
      ['Open · 1', 'Done · 2'],
    );
  });

  it('sends « Looks fixed » and « Still wrong » for their note', () => {
    calls.length = 0;
    const root = panelPage(page(), options());
    const item = root.querySelector('.ready-item[data-note="r2"]');
    const [fixed, wrong] = [...(item?.querySelectorAll<HTMLButtonElement>('.ready-actions button') ?? [])];

    assert.equal(fixed?.textContent, 'Looks fixed');
    assert.equal(wrong?.textContent, 'Still wrong');
    fixed?.click();
    wrong?.click();
    assert.deepEqual(calls, ['r2:fixed', 'r2:wrong']);
  });

  it('holds both buttons while a verdict is written, and says why one did not go', () => {
    const sending = panelPage(page(), options({ checking: { id: 'r1', sending: 'fixed' } }));
    const buttons = [...sending.querySelectorAll<HTMLButtonElement>('.ready-item[data-note="r1"] button')];
    assert.deepEqual(
      buttons.map((button) => [button.textContent, button.disabled]),
      [
        ['Sending…', true],
        ['Still wrong', true],
      ],
    );

    const failed = panelPage(page(), options({ checking: { id: 'r1', problem: CHECK_PROBLEM.retry } }));
    assert.equal(
      failed.querySelector('.ready-item[data-note="r1"] [role="alert"]')?.textContent,
      'Did not go through. Try again.',
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

  it('is not drawn with no note to check', () => {
    const root = panelPage(page(), options({ state: { kind: 'on', host: 'staging.acme.dev', notes: [OTHERS, OPEN] } }));
    assert.equal(root.querySelector('section.ready'), null);
  });

  it('is in French for a French reader', () => {
    setLanguage('fr');
    const root = panelPage(page(), options());
    assert.equal(root.querySelector('section.ready h3')?.textContent, 'À vérifier · 2');
    assert.deepEqual(
      [...root.querySelectorAll('.ready-item[data-note="r1"] button')].map((button) => button.textContent),
      ['C’est corrigé', 'Toujours pas'],
    );
    assert.equal(
      root.querySelector('.ready-item[data-note="r1"] .ready-meta')?.textContent,
      'Corrigé par Sakuga team · il y a 2 heures',
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
    assert.deepEqual((['seeded', 'green', 'ripening', 'ripe', 'composted'] as const).map(of), [
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
    stage: 'green',
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
    });
    assert.match(root.textContent ?? '', /Reload it to see its notes\./);
    [...root.querySelectorAll<HTMLButtonElement>('button')]
      .find((each) => each.textContent === 'Reload the page')
      ?.click();
    assert.deepEqual(calls, ['reload']);
  });

  it('takes a reply of the length the worker takes, read in the worker', () => {
    const worker = readFileSync(fileURLToPath(new URL('../../worker/src/app.ts', import.meta.url)), 'utf8');
    const length = /export const REPLY_LENGTH = (\d+);/.exec(worker)?.[1];

    assert.ok(length !== undefined, 'apps/worker/src/app.ts no longer names REPLY_LENGTH: this check reads nothing');
    assert.equal(REPLY_MAX_LENGTH, Number(length));
  });
});
