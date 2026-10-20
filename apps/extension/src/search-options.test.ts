import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window as HappyDomWindow } from 'happy-dom';
import { setLanguage } from './i18n.ts';
import type { PanelNote } from './protocol.ts';
import { type SearchHandlers, type SearchState, countsOf, matchesPage } from './search-options.ts';
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
  stage: 'seeded',
  note: '29 € for the Mocha, the price list says 27 €.',
  createdAt: '2026-10-19T12:00:00Z',
  updatedAt: '2026-10-19T12:00:00Z',
  replies: [],
  canReply: true,
  placement: 'found',
  ...fields,
});

const NOTES: PanelNote[] = [
  note({ id: 'a', number: 1, stage: 'ripening', note: 'The Add button is almost invisible.' }),
  note({ id: 'b', number: 2, stage: 'green', note: 'Could the title mention the Café de Bordeaux?' }),
  note({ id: 'c', number: 3, stage: 'seeded', author: 'Léa' }),
  note({ id: 'd', number: 4, stage: 'ripening', note: 'The promo code should be AUTUMN10.', placement: 'detached' }),
];

const siteNote = (fields: Partial<SiteNote> & { seed: string }): SiteNote => ({
  excerpt: 'The email field is too short on mobile.',
  page: { url: 'https://staging.acme.dev/subscriptions', path: '/subscriptions' },
  stage: 'ripening',
  createdAt: '2026-10-18T12:00:00Z',
  ...fields,
});

function draw(search: Partial<SearchState> | undefined, notes: PanelState = on(NOTES)) {
  const calls: string[] = [];
  const handlers: SearchHandlers = {
    onScope: (scope) => calls.push(`scope:${scope}`),
    onQuery: (q) => calls.push(`q:${q}`),
    onStage: (stage) => calls.push(`stage:${stage}`),
    onSiteNote: (picked) => calls.push(`site-note:${picked.seed}`),
    onSiteRetry: () => calls.push('site-retry'),
    onMore: () => calls.push('more'),
    onPins: (shown) => calls.push(`pins:${shown}`),
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
    const { root, calls } = draw({ stage: 'ripening', q: 'the' });

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
    assert.deepEqual(calls, ['stage:green']);
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
    siteNote({ seed: 's1', reference: 'FRU-128', referenceUrl: 'https://linear.app/acme/issue/FRU-128' }),
    siteNote({
      seed: 's2',
      stage: 'green',
      excerpt: 'Could the title mention that the coffee is roasted in Bordeaux, and since when the house',
      page: { url: 'https://staging.acme.dev/', path: '/' },
      author: 'Camille',
    }),
    siteNote({ seed: 's3', stage: 'ripe', mine: true, page: { url: 'https://staging.acme.dev/cart', path: '/cart' } }),
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
    const ref = first?.querySelector<HTMLAnchorElement>('a.site-row-ref');
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

  it('opens a note from its row, filters it by a chip, and counts what was read', () => {
    const { root, calls } = draw({ scope: 'site', stage: 'ripe', site: { q: '', notes: SITE, total: 3 } });
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

describe('the helpers of the search (FRU-307)', () => {
  it('counts every note in All, and Closed in no chip of its own', () => {
    assert.deepEqual(countsOf([{ stage: 'composted' }, { stage: 'ripe' }, { stage: 'ripe' }]), {
      all: 3,
      seeded: 0,
      green: 0,
      ripening: 0,
      ripe: 2,
    });
  });

  it('wants every word, in any order', () => {
    const one = note({ id: 'x', note: 'The Add button is almost invisible' });
    assert.equal(matchesPage(one, 'invisible add'), true);
    assert.equal(matchesPage(one, 'invisible remove'), false);
    assert.equal(matchesPage(one, '   '), true);
  });
});
