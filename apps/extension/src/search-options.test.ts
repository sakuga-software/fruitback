import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window as HappyDomWindow } from 'happy-dom';
import { setLanguage } from './i18n.ts';
import type { PanelNote } from './protocol.ts';
import {
  type SearchHandlers,
  type SearchState,
  MAX_CHIPS,
  countsOf,
  matchesPage,
  noteLink,
  statusFilter,
  statusesOf,
} from './search-options.ts';
import { type PanelOptions, type PanelState, panelPage } from './side-panel.ts';
import type { SiteNote } from './site-notes.ts';

/**
 * « Search and options » of the side panel (FRU-307): the magnifier, the scope, the search, the
 * chips, the notes that lost their element, the list of the whole site and « Show pins on the page ».
 * The panel opened in a real browser, on a real worker, is `e2e/side-panel-search.spec.ts`'s.
 */

function page(): Document {
  return new HappyDomWindow({ url: 'chrome-extension://fruitback/sidepanel.html' }).document as unknown as Document;
}

afterEach(() => setLanguage('en'));

const NOW = Date.parse('2026-10-20T12:00:00Z');

const note = (fields: Partial<PanelNote> & { id: string }): PanelNote => ({
  stage: 'new',
  note: '29 € for the Mocha, the price list says 27 €.',
  createdAt: '2026-10-19T12:00:00Z',
  updatedAt: '2026-10-19T12:00:00Z',
  replies: [],
  canReply: true,
  placement: 'found',
  ...fields,
});

const NOTES: PanelNote[] = [
  note({ id: 'a', number: 1, stage: 'progress', note: 'The Add button is almost invisible.' }),
  note({ id: 'b', number: 2, stage: 'todo', note: 'Could the title mention the Café de Bordeaux?' }),
  note({ id: 'c', number: 3, stage: 'new', author: 'Léa' }),
  note({ id: 'd', number: 4, stage: 'progress', note: 'The promo code should be AUTUMN10.', placement: 'detached' }),
];

const siteNote = (fields: Partial<SiteNote> & { note: string }): SiteNote => ({
  excerpt: 'The email field is too short on mobile.',
  page: { url: 'https://staging.acme.dev/subscriptions', path: '/subscriptions' },
  stage: 'progress',
  createdAt: '2026-10-18T12:00:00Z',
  ...fields,
});

function draw(search: Partial<SearchState> | undefined, notes: PanelState = on(NOTES)) {
  const calls: string[] = [];
  const handlers: SearchHandlers = {
    onScope: (scope) => calls.push(`scope:${scope}`),
    onQuery: (q) => calls.push(`q:${q}`),
    onStage: (stage) => calls.push(`stage:${stage}`),
    onSiteNote: (picked) => calls.push(`site-note:${picked.note}`),
    onSiteRetry: () => calls.push('site-retry'),
    onMore: () => calls.push('more'),
    onPins: (shown) => calls.push(`pins:${shown}`),
    onStatus: (status) => calls.push(`status:${status ?? 'all'}`),
    onStatusOpen: (open) => calls.push(`status-open:${open}`),
    onStatusActive: (id) => calls.push(`status-active:${id}`),
  };
  const options: PanelOptions = {
    state: notes,
    tab: 'open',
    now: NOW,
    onClose: () => calls.push('close'),
    onLeave: () => calls.push('leave'),
    onTab: (tab) => calls.push(`tab:${tab}`),
    onToggle: (id) => calls.push(`toggle:${id}`),
    onShow: () => {},
    onReplyOpen: () => {},
    onReplyInput: () => {},
    onReplySend: () => {},
    onReplyCancel: () => {},
    onRetry: () => {},
    onReload: () => {},
    onSettings: () => {},
    onVerdict: () => {},
    onSearch: () => calls.push('search'),
    ...(search === undefined
      ? {}
      : { search: { state: { scope: 'page', q: '', stage: 'all', pinsShown: true, ...search }, handlers } }),
  };

  return { root: panelPage(page(), options), calls };
}

function on(notes: PanelNote[] | 'reading'): PanelState {
  return { kind: 'on', host: 'staging.acme.dev', notes };
}

const rows = (root: HTMLElement): string[] =>
  [...root.querySelectorAll<HTMLElement>('.panel-notes .panel-list > li')].map((row) => row.dataset.note ?? '');

describe('the magnifier « Search and options » (FRU-307)', () => {
  it('opens and closes the options, and says which', () => {
    const closed = draw(undefined);
    const button = closed.root.querySelector<HTMLButtonElement>('button.panel-search');
    assert.equal(button?.getAttribute('aria-label'), 'Search and options');
    assert.equal(button?.getAttribute('aria-expanded'), 'false');
    assert.equal(closed.root.querySelector('#search-options'), null);
    button?.click();
    assert.deepEqual(closed.calls, ['search']);

    const opened = draw({});
    assert.equal(opened.root.querySelector('button.panel-search')?.getAttribute('aria-expanded'), 'true');
    assert.equal(opened.root.querySelector('button.panel-search')?.getAttribute('aria-controls'), 'search-options');
    assert.ok(opened.root.querySelector('#search-options'));
  });

  it('is not in the head of a page Fruitback is not on', () => {
    assert.equal(draw(undefined, { kind: 'not-on' }).root.querySelector('button.panel-search'), null);
  });
});

describe('« This page » (FRU-307)', () => {
  it('lists every note in one list, the detached ones at the end, without the tabs', () => {
    const { root } = draw({});

    assert.equal(root.querySelector('.panel-tabs'), null, 'the chips stand in for Open and Done');
    assert.deepEqual(rows(root), ['a', 'b', 'c']);
    const detached = root.querySelector('.search-detached');
    assert.equal(detached?.querySelector('h3')?.textContent, '1 detached note');
    assert.match(detached?.textContent ?? '', /AUTUMN10/);
    assert.match(detached?.textContent ?? '', /In progress · the element it pointed at is gone/);
  });

  it('finds the words of a note in its whole text, with or without accents, and its author', () => {
    assert.deepEqual(rows(draw({ q: 'cafe bordeaux' }).root), ['b']);
    assert.deepEqual(rows(draw({ q: 'lea' }).root), ['c']);
    const none = draw({ q: 'nothing like it' }).root;
    assert.deepEqual(rows(none), []);
    assert.match(none.textContent ?? '', /No note matches\./);
  });

  it('filters by a chip, and counts what the search found', () => {
    const { root, calls } = draw({ stage: 'progress', q: 'the' });

    assert.deepEqual(rows(root), ['a']);
    assert.equal(root.querySelector('.search-detached-card')?.getAttribute('data-note'), 'd');
    const chips = [...root.querySelectorAll<HTMLButtonElement>('button.search-chip')];
    assert.deepEqual(
      chips.map(
        (chip) =>
          `${chip.querySelector('.search-chip-word')?.textContent} ${chip.querySelector('.search-chip-count')?.textContent} ${chip.getAttribute('aria-pressed')}`,
      ),
      ['All 4 false', 'New 1 false', 'To do 1 false', 'In progress 2 true', 'Done 0 false'],
    );
    chips[2]?.click();
    assert.deepEqual(calls, ['stage:todo']);
  });

  it('sends what is typed in the search', () => {
    const { root, calls } = draw({});
    const input = root.querySelector<HTMLInputElement>('input.search-input');
    assert.equal(input?.getAttribute('aria-label'), 'Search notes');
    if (input === null) return;
    input.value = 'mocha';
    input.dispatchEvent(new (input.ownerDocument.defaultView as unknown as typeof globalThis).Event('input'));
    assert.deepEqual(calls, ['q:mocha']);
  });

  it('has no scope for a site that no session of this browser reads whole', () => {
    assert.equal(draw({}).root.querySelector('.search-scope'), null);
  });

  it('switches the pins of the page off and on at the foot', () => {
    const { root, calls } = draw({ pinsShown: true });
    const toggle = root.querySelector<HTMLButtonElement>('.panel-foot [role="switch"]');
    assert.equal(toggle?.getAttribute('aria-label'), 'Show pins on the page');
    assert.equal(toggle?.getAttribute('aria-checked'), 'true');
    toggle?.click();
    assert.deepEqual(calls, ['pins:false']);
    assert.equal(draw(undefined).root.querySelector('.panel-foot [role="switch"]'), null, 'only with the options');
  });
});

describe('« Whole site » (FRU-307)', () => {
  const SITE: SiteNote[] = [
    siteNote({ note: 's1', reference: 'FRU-128', referenceUrl: 'https://linear.app/acme/issue/FRU-128' }),
    siteNote({
      note: 's2',
      stage: 'todo',
      excerpt: 'Could the title mention that the coffee is roasted in Bordeaux, and since when the house',
      page: { url: 'https://staging.acme.dev/', path: '/' },
      author: 'Camille',
    }),
    siteNote({ note: 's3', stage: 'done', mine: true, page: { url: 'https://staging.acme.dev/cart', path: '/cart' } }),
  ];

  it('names the two scopes with their counts', () => {
    const { root, calls } = draw({ site: { q: '', notes: SITE, total: 7 } });
    const tabs = [...root.querySelectorAll<HTMLButtonElement>('.search-scope [role="tab"]')];
    assert.equal(root.querySelector('.search-scope')?.getAttribute('aria-label'), 'Scope');
    assert.deepEqual(
      tabs.map((tab) => tab.textContent),
      ['This page · 4', 'Whole site · 7'],
    );
    tabs[1]?.click();
    assert.deepEqual(calls, ['scope:site']);
  });

  it('lists the notes of every page, hollow for another page, with the link to the tracker', () => {
    const { root } = draw({ scope: 'site', path: '/', site: { q: '', notes: SITE, total: 3 } });

    assert.deepEqual(rows(root), ['s1', 's2', 's3']);
    const [first, second, third] = [...root.querySelectorAll<HTMLElement>('.site-row')];
    assert.equal(first?.querySelector('.kit-drop')?.getAttribute('data-hollow'), 'true');
    assert.match(first?.textContent ?? '', /In progress · Anonymous · \/subscriptions/);
    const ref = [...(first?.querySelectorAll<HTMLAnchorElement>('a.site-row-ref') ?? [])].find((link) =>
      link.textContent?.startsWith('Open '),
    );
    assert.equal(ref?.textContent, 'Open FRU-128 →');
    assert.equal(ref?.target, '_blank');
    assert.equal(ref?.rel, 'noreferrer');
    // The page of the tab: a filled drop, « This page ».
    assert.equal(second?.querySelector('.kit-drop')?.getAttribute('data-hollow'), null);
    assert.match(second?.textContent ?? '', /To do · Camille · This page/);
    assert.match(second?.textContent ?? '', /since when the house…/, 'an excerpt of 64 says it was cut');
    assert.match(third?.textContent ?? '', /Done · You · \/cart/);
    assert.equal(root.querySelector('.search-hint')?.textContent, 'Searches the first words of each note');
    assert.equal(root.querySelector('.search-detached'), null, 'the index knows no placement');
  });

  // FRU-434: « Show on the page » on each row, as the table of the notes of the console has it.
  it('links each note to its page: another page in a new tab on the note, the page of the tab by a scroll', () => {
    const { root, calls } = draw({ scope: 'site', path: '/', site: { q: '', notes: SITE, total: 3 } });
    const [first, second, third] = [...root.querySelectorAll<HTMLElement>('.site-row')];
    const show = (row: HTMLElement | undefined) =>
      [...(row?.querySelectorAll<HTMLElement>('.site-row-ref') ?? [])].find(
        (link) => link.textContent === 'Show on the page',
      );

    const elsewhere = show(first) as HTMLAnchorElement | undefined;
    assert.equal(elsewhere?.tagName, 'A');
    assert.equal(elsewhere?.getAttribute('href'), 'https://staging.acme.dev/subscriptions#fruitback-note=s1');
    assert.equal(elsewhere?.target, '_blank');
    assert.equal(elsewhere?.rel, 'noreferrer');
    assert.equal(elsewhere?.getAttribute('aria-description'), 'Opens /subscriptions in a new tab');
    assert.equal(show(third)?.getAttribute('href'), 'https://staging.acme.dev/cart#fruitback-note=s3');

    // The page of the tab: a button, which scrolls to the note there, as a click on the row does.
    const here = show(second);
    assert.equal(here?.tagName, 'BUTTON');
    here?.click();
    assert.deepEqual(calls, ['site-note:s2']);

    setLanguage('fr');
    const french = draw({ scope: 'site', path: '/', site: { q: '', notes: SITE, total: 3 } }).root;
    assert.equal(
      [...french.querySelectorAll('.site-row')][0]?.querySelector('.site-row-ref')?.textContent,
      'Voir sur la page',
    );
  });

  it('opens a note from its row, filters it by a chip, and counts what was read', () => {
    const { root, calls } = draw({ scope: 'site', stage: 'done', site: { q: '', notes: SITE, total: 3 } });
    assert.deepEqual(rows(root), ['s3']);
    const counts = [...root.querySelectorAll('.search-chip-count')].map((count) => count.textContent);
    assert.deepEqual(counts, ['3', '0', '1', '1', '1']);
    root.querySelector<HTMLButtonElement>('.site-row .panel-row-head')?.click();
    assert.deepEqual(calls, ['site-note:s3']);
  });

  it('says how many it shows of the total, and reads the next ones', () => {
    const { root, calls } = draw({ scope: 'site', site: { q: '', notes: SITE, total: 60, next: 'abc' } });
    assert.match(root.querySelector('.site-more')?.textContent ?? '', /Showing 3 of 60/);
    [...root.querySelectorAll<HTMLButtonElement>('.site-more button')]
      .find((b) => b.textContent === 'Show more')
      ?.click();
    assert.deepEqual(calls, ['more']);
    assert.match(
      draw({ scope: 'site', site: { q: '', notes: SITE, total: 60, more: 'failed', next: 'abc' } }).root.textContent ??
        '',
      /The next notes could not be read\./,
    );
  });

  it('offers no « Show more » for a list of other words than the field (review of #419)', () => {
    const { root } = draw({ scope: 'site', q: 'mocha', site: { q: '', notes: SITE, total: 60, next: 'abc' } });
    assert.equal(root.querySelector('.site-more'), null, 'its cursor is of a walk of other words');
    const current = draw({ scope: 'site', q: ' mocha ', site: { q: 'mocha', notes: SITE, total: 60, next: 'abc' } });
    assert.ok(current.root.querySelector('.site-more'), 'the control: the same words walk on');
  });

  it('says where the read is: reading, failed, session ended, not readable here', () => {
    assert.match(
      draw({ scope: 'site', site: 'reading' }).root.textContent ?? '',
      /Reading the notes of the whole site…/,
    );
    const failed = draw({ scope: 'site', site: 'failed' });
    failed.root.querySelector<HTMLButtonElement>('.panel-failed button')?.click();
    assert.deepEqual(failed.calls, ['site-retry']);
    assert.match(draw({ scope: 'site', site: 'signed-out' }).root.textContent ?? '', /Your session ended/);
    assert.match(
      draw({ scope: 'site', site: 'unavailable' }).root.textContent ?? '',
      /cannot be read from this browser/,
    );
  });

  it('speaks French', () => {
    setLanguage('fr');
    const { root } = draw({ scope: 'site', site: { q: '', notes: SITE, total: 3 } });
    assert.deepEqual(
      [...root.querySelectorAll('.search-scope [role="tab"]')].map((tab) => tab.textContent),
      ['Cette page · 4', 'Tout le site · 3'],
    );
    assert.equal(root.querySelector('.search-input')?.getAttribute('placeholder'), 'Chercher dans les notes');
    assert.equal(root.querySelector('button.panel-search')?.getAttribute('aria-label'), 'Recherche et options');
  });
});

describe('more than five statuses: a list in place of the chips (FRU-535)', () => {
  /** Seven statuses of a tracker, Linear's: one note each, « In Review » twice. */
  const TEAM: [PanelNote['stage'], string, string][] = [
    ['new', 'Triage', '#e0f2fe'],
    ['todo', 'Backlog', '#e4e4e7'],
    ['todo', 'Ready', '#fde68a'],
    ['progress', 'In Progress', '#f97316'],
    ['progress', 'In Review', '#7c3aed'],
    ['done', 'Done', '#16a34a'],
    ['closed', 'Canceled', '#a1a1aa'],
  ];
  const statused: PanelNote[] = [
    ...TEAM.map(([stage, name, color], index) =>
      note({ id: `s${index}`, number: index + 1, stage, status: { name, stage, color }, note: `Note ${name}` }),
    ),
    note({ id: 'twice', number: 9, stage: 'progress', stateName: 'In Review', note: 'Note In Review again' }),
  ];

  it('keeps the chips up to five statuses', () => {
    assert.equal(MAX_CHIPS, 5);
    const { root } = draw({}, on(statused.slice(0, 5)));

    assert.equal(root.querySelectorAll('button.search-chip').length, 5);
    assert.equal(root.querySelector('.search-status'), null);
  });

  it('draws « Status · All · {count} » and no chip beyond five', () => {
    const { root, calls } = draw({}, on(statused));

    assert.equal(root.querySelectorAll('button.search-chip').length, 0);
    const trigger = root.querySelector<HTMLButtonElement>('.search-status button.kit-select-trigger');
    assert.equal(trigger?.textContent?.includes('Status · All · 8'), true);
    trigger?.click();
    const options = [...root.querySelectorAll('.search-status [role="option"]')];
    // Each status of the team, in the order of the stages, with its colour and its number of notes.
    assert.deepEqual(
      options.map((option) => option.textContent),
      ['All8', 'Triage1', 'Backlog1', 'Ready1', 'In Progress1', 'In Review2', 'Done1', 'Canceled1'],
    );
    assert.equal(options[5]?.querySelector<HTMLElement>('.kit-drop')?.style.background, '#7c3aed');
    (options[5] as HTMLElement | undefined)?.click();
    assert.deepEqual(calls, ['status-open:true', 'status-open:false', 'status:name:In Review']);
  });

  it('lists the notes of the status chosen, and says it on its button', () => {
    const { root } = draw({ status: 'name:In Review' }, on(statused));

    assert.deepEqual(rows(root), ['s4', 'twice']);
    assert.equal(
      root.querySelector('.search-status .kit-select-trigger')?.textContent?.includes('Status · In Review · 2'),
      true,
    );
  });

  it('keeps the list, and the status chosen, when the search finds five statuses or fewer (review of #730)', () => {
    // « In » finds three statuses: the list stays, with every status of the page, and still filters.
    const { root } = draw({ status: 'name:In Review', q: 'In' }, on(statused));

    assert.equal(root.querySelectorAll('button.search-chip').length, 0);
    assert.deepEqual(rows(root), ['s4', 'twice']);
    assert.equal(
      root.querySelector('.search-status .kit-select-trigger')?.textContent?.includes('Status · In Review · 2'),
      true,
    );
    root.querySelector<HTMLButtonElement>('.search-status .kit-select-trigger')?.click();
    assert.deepEqual(
      [...root.querySelectorAll('.search-status [role="option"]')].map((option) => option.textContent),
      ['All3', 'Triage0', 'Backlog0', 'Ready0', 'In Progress1', 'In Review2', 'Done0', 'Canceled0'],
    );
  });

  it('keeps the option the keyboard is on when the panel draws again between two arrows (review of #730)', () => {
    // The panel as `main.ts` holds it: its state, and a draw that builds the page again from it.
    let state: SearchState = { scope: 'page', q: '', stage: 'all', pinsShown: true };
    const chosen: (string | undefined)[] = [];
    const document = page();
    const handlers: SearchHandlers = {
      onScope: () => undefined,
      onQuery: () => undefined,
      onStage: () => undefined,
      onSiteNote: () => undefined,
      onSiteRetry: () => undefined,
      onMore: () => undefined,
      onPins: () => undefined,
      onStatus: (status) => void chosen.push(status),
      onStatusOpen: (open) => {
        const { statusActive: _active, ...rest } = state;
        state = { ...rest, statusOpen: open };
      },
      onStatusActive: (id) => {
        state = { ...state, statusActive: id };
      },
    };
    const draw = (): void => {
      const root = panelPage(document, {
        state: on(statused),
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
        onVerdict: () => {},
        onSearch: () => {},
        search: { state, handlers },
      });
      document.body.replaceChildren(root);
    };
    const key = (name: string): void => {
      document
        .querySelector('.search-status [role="listbox"]')
        ?.dispatchEvent(
          new document.defaultView!.KeyboardEvent('keydown', { key: name, bubbles: true }) as unknown as Event,
        );
    };
    draw();
    document.querySelector<HTMLButtonElement>('.search-status .kit-select-trigger')?.click();
    key('ArrowDown');
    // The widget read the page again: the panel draws, the list stays open.
    draw();
    key('ArrowDown');
    key('Enter');

    // All → Triage → Backlog: the second arrow goes on from Triage, not from All.
    assert.deepEqual(chosen, ['name:Backlog']);
  });

  it('is drawn open over the notes when the panel kept it open', () => {
    const { root } = draw({ statusOpen: true }, on(statused));

    assert.notEqual(root.querySelector('.search-status [role="listbox"]'), null);
    // The list is in the options, before the notes: the sheet lays it over them (`kit.css`).
    assert.equal(root.querySelector('.panel-notes [role="listbox"]'), null);
  });

  it('counts a status by its name, and a note with none by its stage', () => {
    assert.deepEqual(
      statusesOf([
        { stage: 'progress', stateName: 'In Review' },
        { stage: 'progress', status: { name: 'In Review', stage: 'progress' } },
        { stage: 'progress' },
      ]).map((status) => `${status.key} ${status.word} ${status.count}`),
      ['stage:progress In progress 1', 'name:In Review In Review 2'],
    );
  });

  it('keeps every note for a status no note wears any more, as its button says « All »', () => {
    const keeps = statusFilter({ scope: 'page', q: '', stage: 'all', pinsShown: true, status: 'name:Gone' }, statused);

    assert.equal(statused.filter(keeps).length, statused.length);
  });

  it('keeps the chips for the whole site, whose notes say their stage only', () => {
    const notes = TEAM.map(([stage], index) => siteNote({ note: `n${index}`, stage }));
    const keeps = statusFilter({ scope: 'site', q: '', stage: 'progress', pinsShown: true }, notes);

    assert.ok(statusesOf(notes).length <= MAX_CHIPS);
    assert.deepEqual(
      notes.filter(keeps).map((each) => each.note),
      ['n3', 'n4'],
    );
  });
});

describe('noteLink (FRU-434)', () => {
  it('writes the link of FRU-253 after the fragment of the site, and encodes the id', () => {
    assert.equal(noteLink('https://acme.dev/a', 'sd_1'), 'https://acme.dev/a#fruitback-note=sd_1');
    assert.equal(noteLink('https://acme.dev/a?x=1', 'FB 12'), 'https://acme.dev/a?x=1#fruitback-note=FB%2012');
    assert.equal(noteLink('https://acme.dev/a#pricing', 'sd_1'), 'https://acme.dev/a#pricing&fruitback-note=sd_1');
    assert.equal(noteLink('https://acme.dev/a#', 'sd_1'), 'https://acme.dev/a#fruitback-note=sd_1');
  });
});

describe('the helpers of the search (FRU-307)', () => {
  it('counts every note in All, and Closed in no chip of its own', () => {
    assert.deepEqual(countsOf([{ stage: 'closed' }, { stage: 'done' }, { stage: 'done' }]), {
      all: 3,
      new: 0,
      todo: 0,
      progress: 0,
      done: 2,
    });
  });

  it('wants every word, in any order', () => {
    const one = note({ id: 'x', note: 'The Add button is almost invisible' });
    assert.equal(matchesPage(one, 'invisible add'), true);
    assert.equal(matchesPage(one, 'invisible remove'), false);
    assert.equal(matchesPage(one, '   '), true);
  });
});
