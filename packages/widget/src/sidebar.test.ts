import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { seedFixture, seedIssueFixture } from '@fruitback/shared/seed.fixture';
import type { FeedbackEntry } from './export.ts';
import type { SidebarEntry } from './sidebar.ts';
import { keyboardEventCtor, mountPage, setDocumentSize, setRect } from './dom.fixture.ts';
import { deepActiveElement } from './focus.ts';
import { createTranslator } from './messages.ts';
import { type ReadState, type Sidebar, createSidebar } from './sidebar.ts';
import { createCaptureHost } from './host.ts';
import { createOverlay } from './overlay.ts';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const undo of cleanup.splice(0)) undo();
});

function note(id: string, text: string, stage: FeedbackEntry['issue']['stage'] = 'seeded'): FeedbackEntry['issue'] {
  return seedIssueFixture({
    identifier: id.toUpperCase(),
    stage,
    seed: seedFixture({ id, note: text, createdAt: '2026-10-09T10:00:00.000Z', reporter: { name: 'Alice' } }),
  });
}

/** A page with a button that opens the list, as the dock has. */
function mount(entries: SidebarEntry[] = [], more: Partial<Parameters<typeof createSidebar>[0]> = {}) {
  const page = mountPage('<main><button id="opener">open</button><div id="widget"></div></main>');
  const state = { entries };
  const chosen: string[] = [];
  const sidebar: Sidebar = createSidebar({
    document: page.document,
    host: page.query('#widget'),
    entries: () => state.entries,
    onSelect: (id) => chosen.push(id),
    translator: createTranslator({ locale: 'en', now: () => Date.parse('2026-10-09T12:00:00.000Z') }),
    ...more,
  });
  cleanup.push(() => sidebar.destroy());
  const root = page.query('[data-fruitback-sidebar]') as HTMLElement;
  const items = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('[data-fruitback-note]')];
  const opener = page.query('#opener') as HTMLElement;
  const tabs = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('[role="tab"]')];
  const tabNames = (): (string | null)[] => tabs().map((tab) => tab.textContent);

  return { page, state, chosen, sidebar, root, items, opener, tabs, tabNames };
}

/** The words of the three tabs, with their numbers. */
const tabNamesIn = (root: ParentNode): (string | null)[] =>
  [...root.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);

describe('the list of every note of the page (FRU-129)', () => {
  it('lists each note with its state, its first line, who wrote it and when', () => {
    const { sidebar, root, items, tabNames } = mount([
      { issue: note('a', 'The price should say per month.\nSecond line', 'ripening'), placement: 'found', number: 1 },
      { issue: note('b', 'Wrong colour'), placement: 'found', number: 2 },
    ]);
    sidebar.open();

    assert.equal(root.hidden, false);
    assert.deepEqual(tabNames(), ['Open 2', 'Done 0', 'All 2']);
    // The number of its pin, the note on one run of words, then the state, who and when (FRU-259).
    assert.deepEqual(
      items().map((item) => [...item.children].map((child) => child.textContent)),
      [
        ['1', 'The price should say per month. Second line', 'In Progress · Alice · 2 hours ago · further down'],
        ['2', 'Wrong colour', 'In Progress · Alice · 2 hours ago · further down'],
      ],
    );
    // « further down » is in the row for when the page scrolls, and hidden: nothing here says it is below.
    assert.deepEqual(
      items().map((item) => (item.querySelector('[data-fruitback-below]') as HTMLElement).hidden),
      [true, true],
    );
    // The drop is for the eye: the row says its state in words.
    assert.equal(items()[0]?.querySelector('.fruitback-sidebar-pin')?.getAttribute('aria-hidden'), 'true');
  });

  it('says so when a note was found by its position, or not found', () => {
    const { sidebar, root, tabNames, chosen } = mount([
      { issue: note('a', 'Found'), placement: 'found', number: 1 },
      { issue: note('b', 'By position'), placement: 'approximate', number: 2 },
      { issue: note('c', 'Gone'), placement: 'detached', number: 3 },
    ]);
    sidebar.open();

    const rows = [...root.querySelectorAll<HTMLElement>('.fruitback-sidebar-list [data-fruitback-note]')];
    assert.deepEqual(
      rows.map((row) => /Approximate position/.test(row.querySelector('.fruitback-sidebar-meta')?.textContent ?? '')),
      [false, true],
    );
    // The note whose element is gone is apart, in a group with a name, and the tabs do not count it (FRU-259).
    assert.deepEqual(tabNames(), ['Open 2', 'Done 0', 'All 2']);
    const unplaced = root.querySelector('[data-fruitback-unplaced]') as HTMLElement;
    assert.equal(unplaced.hidden, false);
    assert.equal(unplaced.getAttribute('role'), 'group');
    assert.equal(
      root.querySelector(`#${unplaced.getAttribute('aria-labelledby')}`)?.textContent,
      'Could not be placed · 1',
    );
    const lost = unplaced.querySelector('[data-fruitback-note]') as HTMLElement;
    assert.deepEqual(
      [...lost.children].map((child) => child.textContent),
      ['Gone', 'Its element is no longer on this page. The note stays here.'],
    );
    // It still opens its thread, which holds the replies and the way to the store.
    lost.click();
    assert.deepEqual(chosen, ['c']);
  });

  it('has no group of unplaced notes when every note has its element', () => {
    const { sidebar, root } = mount([{ issue: note('a', 'Found'), placement: 'found', number: 1 }]);
    sidebar.open();

    const unplaced = root.querySelector('[data-fruitback-unplaced]') as HTMLElement;
    assert.equal(unplaced.hidden, true);
    assert.equal(unplaced.textContent, '');
  });

  it('shows a note as text, never as markup', () => {
    const { sidebar, root, items } = mount([
      { issue: note('a', '<img src=x onerror=alert(1)> hello'), placement: 'found' },
    ]);
    sidebar.open();

    assert.equal(root.querySelector('img'), null);
    assert.equal(
      items()[0]?.querySelector('.fruitback-sidebar-note')?.textContent,
      '<img src=x onerror=alert(1)> hello',
    );
  });

  it('hands over the note somebody chose, and stays open for the next one', () => {
    const { sidebar, chosen, items } = mount([
      { issue: note('a', 'One'), placement: 'found' },
      { issue: note('b', 'Two'), placement: 'found' },
    ]);
    sidebar.open();

    items()[1]?.click();
    items()[0]?.click();

    assert.deepEqual(chosen, ['b', 'a']);
    assert.equal(sidebar.isOpen, true);
  });

  it('says the page has no feedback, with no empty list', () => {
    const { sidebar, root } = mount([]);
    sidebar.open();

    assert.equal((root.querySelector('.fruitback-sidebar-empty') as HTMLElement).hidden, false);
    assert.equal((root.querySelector('.fruitback-sidebar-list') as HTMLElement).hidden, true);
    assert.equal(root.querySelector('.fruitback-sidebar-empty')?.textContent, 'No note on this page yet.');
    assert.deepEqual(tabNamesIn(root), ['Open 0', 'Done 0', 'All 0']);
  });

  it('draws the notes again when they change, and only while it is open', () => {
    const { sidebar, state, items } = mount([{ issue: note('a', 'One'), placement: 'found' }]);
    // Closed, with a note to draw: a draw here would be work for a list nobody sees.
    sidebar.refresh();
    assert.equal(items().length, 0, 'closed: nothing is drawn');

    sidebar.open();
    assert.equal(items().length, 1);
    state.entries = [...state.entries, { issue: note('b', 'Two'), placement: 'found' }];
    sidebar.refresh();

    assert.equal(items().length, 2);
  });
});

describe('the tabs of the list (FRU-259)', () => {
  const eight = (): SidebarEntry[] =>
    (
      [
        ['a', 'seeded'],
        ['b', 'green'],
        ['c', 'ripening'],
        ['d', 'ripe'],
        ['e', 'seeded'],
        ['f', 'composted'],
        ['g', 'ripening'],
        ['h', 'green'],
      ] as const
    ).map(([id, stage], index) => ({ issue: note(id, `Note ${id}`, stage), placement: 'found', number: index + 1 }));
  const ids = (items: HTMLElement[]) => items.map((item) => item.dataset.fruitbackNote).join('');

  it('counts and shows what is left to do, what is done, and all of it', () => {
    const { page, sidebar, root, items, tabs, tabNames } = mount(eight());
    sidebar.open();

    // New, to do and in progress are open; done and closed are done. Six and two make eight.
    assert.deepEqual(tabNames(), ['Open 6', 'Done 2', 'All 8']);
    assert.equal(ids(items()), 'abcegh');
    const list = root.querySelector('[role="tablist"]');
    assert.equal(list?.getAttribute('aria-label'), 'Which notes');
    assert.deepEqual(
      tabs().map((tab) => [tab.getAttribute('aria-selected'), tab.tabIndex]),
      [
        ['true', 0],
        ['false', -1],
        ['false', -1],
      ],
    );
    const panel = root.querySelector('[role="tabpanel"]') as HTMLElement;
    assert.equal(panel.getAttribute('aria-labelledby'), tabs()[0]?.id);
    assert.equal(tabs()[0]?.getAttribute('aria-controls'), panel.id);

    // From a row the next tab does not show: focus goes to the tab that was chosen, not to the cross.
    items()[0]?.focus();
    tabs()[1]?.click();
    assert.equal(ids(items()), 'df');
    assert.ok(deepActiveElement(page.document) === tabs()[1], 'focus did not go to the chosen tab');
    assert.equal(panel.getAttribute('aria-labelledby'), tabs()[1]?.id);
    assert.deepEqual(
      tabs().map((tab) => tab.getAttribute('aria-selected')),
      ['false', 'true', 'false'],
    );

    tabs()[2]?.click();
    assert.equal(ids(items()), 'abcdefgh');
    // The rows keep the number of their pin, whatever the tab.
    assert.deepEqual(
      items().map((item) => item.querySelector('.fruitback-sidebar-pin')?.textContent),
      ['1', '2', '3', '4', '5', '6', '7', '8'],
    );
  });

  it('goes from one tab to the next with the arrows, Home and End, and focus follows', () => {
    const { page, sidebar, tabs, items } = mount(eight());
    sidebar.open();
    const press = (key: string) => {
      const event = new (keyboardEventCtor(page))('keydown', { key, bubbles: true, cancelable: true });
      (deepActiveElement(page.document) as HTMLElement).dispatchEvent(event);

      return event;
    };
    const selected = () => tabs().findIndex((tab) => tab.getAttribute('aria-selected') === 'true');
    tabs()[0]?.focus();

    // The page must not scroll on the same key, and the capture mode must not hear it.
    assert.equal(press('ArrowRight').defaultPrevented, true);
    assert.equal(selected(), 1);
    assert.ok(deepActiveElement(page.document) === tabs()[1], 'focus did not follow the choice');
    assert.equal(ids(items()), 'df');
    press('ArrowRight');
    assert.equal(selected(), 2);
    // It wraps, in both directions.
    press('ArrowRight');
    assert.equal(selected(), 0);
    press('ArrowLeft');
    assert.equal(selected(), 2);
    press('Home');
    assert.equal(selected(), 0);
    press('End');
    assert.equal(selected(), 2);
    // Another key is the browser's.
    assert.equal(press('ArrowDown').defaultPrevented, false);
    assert.equal(selected(), 2);
  });

  it('swaps the arrows in a right-to-left language', () => {
    const { page, sidebar, tabs } = mount(eight(), {
      translator: createTranslator({ locale: 'he', messages: { he: { 'sidebar.tabOpen': 'פתוחות' } } }),
    });
    sidebar.open();
    tabs()[0]?.focus();

    tabs()[0]?.dispatchEvent(new (keyboardEventCtor(page))('keydown', { key: 'ArrowLeft', bubbles: true }));

    assert.equal(tabs()[1]?.getAttribute('aria-selected'), 'true');
  });

  it('says that a tab holds nothing, which is not that the page has no note', () => {
    const { sidebar, root, tabs } = mount([{ issue: note('a', 'Open one'), placement: 'found', number: 1 }]);
    sidebar.open();
    const empty = root.querySelector('.fruitback-sidebar-empty') as HTMLElement;
    assert.equal(empty.hidden, true);

    tabs()[1]?.click();

    assert.equal(empty.hidden, false);
    assert.equal(empty.textContent, 'No note here.');
  });

  it('marks the note whose thread is open, and says how many replies a note has', () => {
    const withReplies = (id: string, replies: number): SidebarEntry => ({
      issue: {
        ...note(id, `Note ${id}`),
        stateName: '',
        comments: Array.from({ length: replies }, (_, index) => ({
          id: `c${index}`,
          body: 'Seen',
          createdAt: '2026-10-09T11:00:00.000Z',
        })),
      },
      placement: 'found',
      number: 1,
    });
    let open: string | undefined = 'b';
    const { sidebar, items } = mount([withReplies('a', 0), withReplies('b', 1), withReplies('c', 2)], {
      current: () => open,
    });
    sidebar.open();

    assert.deepEqual(
      items().map((item) => item.getAttribute('aria-current')),
      [null, 'true', null],
    );
    // The stage, when the store has no word of its own for the state.
    assert.deepEqual(
      items().map((item) => item.querySelector('.fruitback-sidebar-meta')?.firstChild?.textContent),
      ['New · Alice · 2 hours ago', 'New · Alice · 2 hours ago · 1 reply', 'New · Alice · 2 hours ago · 2 replies'],
    );

    // A thread opens or closes: the rows are marked again, and none is built again, or the thread
    // would have no row to give focus back to.
    const before = items();
    open = 'c';
    sidebar.mark();
    assert.deepEqual(
      items().map((item) => item.getAttribute('aria-current')),
      [null, null, 'true'],
    );
    open = undefined;
    sidebar.mark();
    assert.deepEqual(
      items().map((item) => item.getAttribute('aria-current')),
      [null, null, null],
    );
    assert.ok(
      items().every((item, index) => item === before[index]),
      'marking built the rows again',
    );
  });

  it('says « further down » for a note under the part in sight, and follows the page while it scrolls', async () => {
    const under = new Set(['b']);
    const { page, sidebar, items } = mount(
      [
        { issue: note('a', 'In sight'), placement: 'found', number: 1 },
        { issue: note('b', 'Under the fold'), placement: 'found', number: 2 },
      ],
      { below: (id) => under.has(id) },
    );
    sidebar.open();
    const said = () =>
      items().map((item) => (item.querySelector('[data-fruitback-below]') as HTMLElement).hidden === false);
    assert.deepEqual(said(), [false, true]);
    assert.equal(items()[1]?.querySelector('[data-fruitback-below]')?.textContent, ' · further down');

    // The page scrolled: the second note is in sight now. The rows are not built again.
    const row = items()[1];
    under.clear();
    page.view.dispatchEvent(new (page.view as unknown as { Event: typeof Event }).Event('scroll'));
    await new Promise((resolve) => page.view.requestAnimationFrame(() => resolve(undefined)));
    assert.deepEqual(said(), [false, false]);
    assert.ok(items()[1] === row, 'a scroll built the rows again');

    // Closed, the list listens to nothing.
    sidebar.close();
    under.add('a');
    page.view.dispatchEvent(new (page.view as unknown as { Event: typeof Event }).Event('scroll'));
    await new Promise((resolve) => page.view.requestAnimationFrame(() => resolve(undefined)));
    sidebar.open();
    assert.deepEqual(said(), [true, false]);
  });

  it('holds a button to leave a note, with the label of the host, that closes the list first', () => {
    const order: string[] = [];
    const { sidebar, root } = mount([], {
      leave: { label: 'Feedback, please', onLeave: () => order.push(sidebar.isOpen ? 'open' : 'closed') },
    });
    sidebar.open();
    const leave = root.querySelector('[data-fruitback-leave]') as HTMLElement;
    assert.equal(leave.textContent, 'Feedback, please');
    assert.ok(leave.querySelector('svg.fruitback-icon'), 'the button lost its mark');

    leave.click();

    // The capture needs the page and the keys: the list is gone when it starts.
    assert.deepEqual(order, ['closed']);
  });

  it('has no button to leave a note for a host that gave none', () => {
    const { root } = mount();

    assert.equal(root.querySelector('[data-fruitback-leave]'), null);
  });

  it('says the address of the page under its title', () => {
    const { sidebar, root, page } = mount();
    sidebar.open();

    assert.equal(
      root.querySelector('.fruitback-sidebar-address')?.textContent,
      `${page.view.location.host}${page.view.location.pathname}`,
    );
  });
});

describe('the list and the dock (FRU-259)', () => {
  it('tells the host of the widget that it is open, so the dock stands aside, and takes it back at the close', () => {
    const page = mountPage('<main><button id="opener">open</button></main>');
    const host = createCaptureHost({
      document: page.document,
      engine: {
        elementAt: () => null,
        grabbable: () => true,
        boundsOf: () => ({ left: 0, top: 0, width: 0, height: 0 }),
        sourceOf: async () => undefined,
      },
      onSelect: () => {},
      onList: () => sidebar.toggle(),
    });
    cleanup.push(() => host.destroy());
    const sidebar = createSidebar({ document: page.document, host: host.root, entries: () => [], onSelect: () => {} });
    cleanup.push(() => sidebar.destroy());
    const shell = page.document.querySelector('[data-fruitback-host]') as HTMLElement;
    const button = host.root.querySelector('[data-fruitback-host-list]') as HTMLElement;

    button.focus();
    button.click();
    assert.equal(shell.hasAttribute('data-fruitback-listing'), true);

    // Escape closes, and focus goes back to the button of the dock, which is there again to take it.
    const inside = deepActiveElement(page.document) as HTMLElement;
    inside.dispatchEvent(new (keyboardEventCtor(page))('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(shell.hasAttribute('data-fruitback-listing'), false);
    assert.ok(deepActiveElement(page.document) === button, 'focus did not go back to the button that opened');
  });
});

describe('the list as a dialog (FRU-129)', () => {
  it('is a dialog with a name, that is not modal', () => {
    const { root } = mount();

    assert.equal(root.getAttribute('role'), 'dialog');
    // Named by its title, which the head shows (FRU-259).
    assert.equal(root.querySelector(`#${root.getAttribute('aria-labelledby')}`)?.textContent, 'Notes on this page');
    assert.equal(root.hasAttribute('aria-modal'), false, 'the page stays usable beside it, so it must not say modal');
  });

  it('takes focus on its first note when it opens, and on its close button when there is none', () => {
    const first = mount([{ issue: note('a', 'One'), placement: 'found' }]);
    first.sidebar.open();
    assert.ok(deepActiveElement(first.page.document) === first.items()[0]);

    const empty = mount([]);
    empty.sidebar.open();
    assert.ok(deepActiveElement(empty.page.document) === empty.root.querySelector('.fruitback-sidebar-close'));
  });

  it('closes on Escape, gives focus back to what opened it, and keeps the Escape to itself', () => {
    const { page, sidebar, root, opener } = mount([{ issue: note('a', 'One'), placement: 'found' }]);
    let reached = 0;
    page.document.addEventListener('keydown', () => (reached += 1));
    opener.focus();
    sidebar.open();

    const KeyboardEventCtor = (page.view as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
    root.dispatchEvent(new KeyboardEventCtor('keydown', { key: 'Escape', bubbles: true, composed: true }));

    assert.equal(sidebar.isOpen, false);
    assert.ok(deepActiveElement(page.document) === opener);
    assert.equal(reached, 0, 'the thread closes on an Escape of the document: this one must not reach it');
  });

  it('leaves focus where the reviewer put it when it closes from outside', () => {
    const { page, sidebar, opener } = mount([{ issue: note('a', 'One'), placement: 'found' }]);
    opener.focus();
    sidebar.open();
    const elsewhere = page.document.createElement('button');
    page.document.body.append(elsewhere);
    elsewhere.focus();

    sidebar.close();

    assert.ok(deepActiveElement(page.document) === elsewhere);
  });

  it('keeps focus on the note somebody is on when the list is drawn again', () => {
    const { page, sidebar, state, items } = mount([
      { issue: note('a', 'One'), placement: 'found' },
      { issue: note('b', 'Two'), placement: 'found' },
    ]);
    sidebar.open();
    items()[1]?.focus();

    state.entries = [{ issue: note('c', 'New'), placement: 'found' }, ...state.entries];
    sidebar.refresh();

    assert.equal((deepActiveElement(page.document) as HTMLElement).dataset.fruitbackNote, 'b');
  });

  it('leaves nothing behind when it is destroyed', () => {
    const { page, sidebar } = mount();
    sidebar.destroy();

    assert.equal(page.document.querySelector('[data-fruitback-sidebar]'), null);
    assert.equal(page.document.querySelector('#widget')?.children.length, 0);
  });
});

describe('the way into the list (FRU-129)', () => {
  const engine = {
    elementAt: () => null,
    grabbable: () => true,
    boundsOf: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    sourceOf: async () => undefined,
  };

  it('is a button of the dock, with a name that is not the name of its dialog', () => {
    const page = mountPage('<main></main>');
    let asked = 0;
    const host = createCaptureHost({ document: page.document, engine, onSelect: () => {}, onList: () => (asked += 1) });
    cleanup.push(() => host.destroy());
    const button = host.root.querySelector<HTMLElement>('[data-fruitback-host-list]');

    assert.ok(button !== null);
    assert.equal(button.getAttribute('aria-label'), 'Show every note of this page');
    button.click();
    assert.equal(asked, 1);
  });

  it('is absent when nothing would open, like the gear', () => {
    const page = mountPage('<main></main>');
    const host = createCaptureHost({ document: page.document, engine, onSelect: () => {} });
    cleanup.push(() => host.destroy());

    assert.equal(host.root.querySelector('[data-fruitback-host-list]'), null);
  });

  it('opens the thread of the note that was chosen, and says when the note is not drawn', () => {
    const page = mountPage('<main><button data-testid="cta">Commander</button></main>', {
      width: 1_000,
      height: 1_000,
    });
    setDocumentSize(page.document, 1_000, 1_000);
    setRect(page.query('button'), { left: 100, top: 200, width: 200, height: 40 });
    const host = createCaptureHost({ document: page.document, engine, onSelect: () => {} });
    cleanup.push(() => host.destroy());
    const overlay = createOverlay({ document: page.document, host: host.root });
    cleanup.push(() => overlay.destroy());
    overlay.render([
      seedIssueFixture({
        identifier: 'ID-1',
        seed: seedFixture({
          id: 'sd_one',
          note: 'On the button',
          anchor: {
            selector: '[data-testid="cta"]',
            tag: 'button',
            text: 'Commander',
            bounds: { xPct: 10, yPct: 20, wPct: 20, hPct: 4 },
          },
        }),
      }),
    ]);

    assert.equal(overlay.select('sd_unknown'), false);
    assert.equal(overlay.threadOpen(), false);
    assert.equal(overlay.select('sd_one'), true);
    assert.equal(overlay.threadOpen(), true);
    assert.match(host.root.querySelector('[role="dialog"]')?.textContent ?? '', /On the button/);
  });
});

describe('the list before a read answered (FRU-153)', () => {
  function mountIn(state: { read: ReadState }, entries: FeedbackEntry[] = []) {
    const page = mountPage('<main><div id="widget"></div></main>');
    const retries: number[] = [];
    const sidebar = createSidebar({
      document: page.document,
      host: page.query('#widget'),
      entries: () => entries,
      onSelect: () => {},
      readState: () => state.read,
      onRetry: () => retries.push(1),
      translator: createTranslator({ locale: 'fr' }),
    });
    cleanup.push(() => sidebar.destroy());
    const root = page.query('[data-fruitback-sidebar]') as HTMLElement;
    const shown = (selector: string) => (root.querySelector(selector) as HTMLElement).hidden === false;
    const text = (selector: string) => root.querySelector(selector)?.textContent ?? '';

    return { page, sidebar, root, retries, shown, text };
  }

  it('says it is reading, with no count, while the first read is in flight', () => {
    const { sidebar, shown, text, root } = mountIn({ read: 'pending' });
    sidebar.open();

    // No number while no read answered: zero notes would be a guess.
    assert.deepEqual(tabNamesIn(root), ['Ouvertes', 'Terminées', 'Toutes']);
    assert.equal(text('.fruitback-sidebar-empty'), 'Lecture des notes de cette page…');
    assert.equal(shown('.fruitback-sidebar-failed'), false);
  });

  it('says the read failed, offers to read again, and gives that button focus', () => {
    const state = { read: 'failed' as ReadState };
    const { page, sidebar, retries, shown, text, root } = mountIn(state);
    sidebar.open();

    assert.equal(shown('.fruitback-sidebar-empty'), false);
    assert.deepEqual(tabNamesIn(root), ['Ouvertes', 'Terminées', 'Toutes']);
    assert.match(text('[role="status"]'), /n’ont pas pu être lues/);
    const retry = root.querySelector('.fruitback-sidebar-retry') as HTMLElement;
    assert.equal(retry.textContent, 'Réessayer');
    assert.equal(deepActiveElement(page.document), retry);
    // The button is described by the message, so a reader hears why it is there.
    assert.equal(
      root.querySelector(`#${retry.getAttribute('aria-describedby')}`)?.textContent,
      text('[role="status"]'),
    );

    retry.click();
    assert.deepEqual(retries, [1]);

    // The next draw after a good read hides the message, and focus does not stay on a hidden button.
    state.read = 'read';
    sidebar.refresh();
    assert.equal(shown('.fruitback-sidebar-failed'), false);
    assert.equal(text('.fruitback-sidebar-empty'), 'Aucune note sur cette page pour le moment.');
    assert.equal(deepActiveElement(page.document), root.querySelector('.fruitback-sidebar-close'));
  });

  it('keeps focus on « Réessayer » while the read runs, and after it fails again', () => {
    const state = { read: 'failed' as ReadState };
    const { page, sidebar, retries, shown, text, root } = mountIn(state);
    sidebar.open();
    const retry = root.querySelector('.fruitback-sidebar-retry') as HTMLElement;

    retry.click();
    state.read = 'pending';
    sidebar.refresh();
    assert.equal(shown('.fruitback-sidebar-failed'), true);
    assert.equal(retry.getAttribute('aria-disabled'), 'true');
    assert.equal(text('[role="status"]'), 'Lecture des notes de cette page…');
    assert.equal(deepActiveElement(page.document), retry);
    // Busy: a second press asks for nothing more.
    retry.click();
    assert.deepEqual(retries, [1]);

    state.read = 'failed';
    sidebar.refresh();
    assert.equal(retry.getAttribute('aria-disabled'), 'false');
    assert.match(text('[role="status"]'), /n’ont pas pu être lues/);
    assert.equal(deepActiveElement(page.document), retry);
  });

  it('shows the notes it holds while a read is in flight, rather than a guess', () => {
    const { sidebar, shown, text } = mountIn({ read: 'pending' }, [{ issue: note('a', 'Held'), placement: 'found' }]);
    sidebar.open();

    assert.equal(shown('.fruitback-sidebar-list'), true);
    assert.equal(text('[role="tab"]'), 'Ouvertes 1');
  });
});

describe('the notes kept for later, in the list (FRU-124)', () => {
  it('says how many notes went and why the others stay, when a send did both', async () => {
    const page = mountPage('<main></main>');
    const host = page.document.createElement('div');
    page.document.body.append(host);
    const kept = [{ seed: seedFixture({ id: 'sd_a' }) }, { seed: seedFixture({ id: 'sd_b' }) }];
    let outcome: { sent: number; failure?: 'wait' } = { sent: 1, failure: 'wait' };
    const sidebar = createSidebar({
      document: page.document,
      host,
      entries: () => [],
      drafts: () => kept,
      onSendDrafts: async () => outcome,
      onSelect: () => {},
    });
    sidebar.open();
    const send = host.querySelector('[data-fruitback-send-drafts]') as HTMLButtonElement;
    const said = async () => {
      send.click();
      await new Promise((resolve) => setTimeout(resolve, 0));

      return host.querySelector('[data-fruitback-drafts-sent]')?.textContent;
    };

    assert.equal(send.textContent, 'Send the 2 notes');
    assert.equal(await said(), '1 note sent — Too many notes just now. Your text is kept: send it again in a minute.');
    // Nothing left: the sentence of the failure alone, with no « 0 note sent ».
    outcome = { sent: 0, failure: 'wait' };
    assert.equal(await said(), 'Too many notes just now. Your text is kept: send it again in a minute.');
    outcome = { sent: 2 };
    assert.equal(await said(), '2 notes sent');
    sidebar.destroy();
  });
});

describe('the list while the session of the host has ended (FRU-315)', () => {
  it('says to sign in, its one button signs in, and the way to a new note goes', () => {
    const page = mountPage('<main><div id="widget"></div></main>');
    const state: { read: ReadState } = { read: 'signed-out' };
    const asked: string[] = [];
    const sidebar = createSidebar({
      document: page.document,
      host: page.query('#widget'),
      entries: () => [],
      onSelect: () => {},
      readState: () => state.read,
      onRetry: () => asked.push('retry'),
      onSignIn: () => asked.push('sign-in'),
      leave: { label: 'Leave feedback', onLeave: () => asked.push('leave') },
      translator: createTranslator({ locale: 'en' }),
    });
    cleanup.push(() => sidebar.destroy());
    const root = page.query('[data-fruitback-sidebar]') as HTMLElement;
    sidebar.open();

    assert.equal(
      root.querySelector('.fruitback-sidebar-failed-text')?.textContent,
      'Sign in to see the notes of this page.',
    );
    const button = root.querySelector('.fruitback-sidebar-retry') as HTMLButtonElement;
    assert.equal(button.textContent, 'Sign in');
    assert.equal((root.querySelector('[data-fruitback-leave]') as HTMLElement).hidden, true);
    // Not « No note on this page »: nothing was read.
    assert.equal((root.querySelector('.fruitback-sidebar-empty') as HTMLElement).hidden, true);
    button.click();
    assert.deepEqual(asked, ['sign-in']);

    // Back: « Try again » and the way to a new note return.
    state.read = 'failed';
    sidebar.refresh();
    assert.equal(button.textContent, 'Try again');
    assert.equal((root.querySelector('[data-fruitback-leave]') as HTMLElement).hidden, false);
  });
});
