import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { noteFixture, noteIssueFixture } from '@fruitback/shared/note.fixture';
import type { FeedbackEntry } from './export.ts';
import type { SidebarEntry } from './sidebar.ts';
import { keyboardEventCtor, mountPage, setDocumentSize, setRect, stylesIn } from './dom.fixture.ts';
import { deepActiveElement } from './focus.ts';
import { createTranslator } from './messages.ts';
import { type ReadState, type Sidebar, createSidebar } from './sidebar.ts';
import { createCaptureHost } from './host.ts';
import { createOverlay } from './overlay.ts';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const undo of cleanup.splice(0)) undo();
});

function note(id: string, text: string, stage: FeedbackEntry['issue']['stage'] = 'new'): FeedbackEntry['issue'] {
  return noteIssueFixture({
    identifier: id.toUpperCase(),
    stage,
    note: noteFixture({ id, text: text, createdAt: '2026-10-09T10:00:00.000Z', reporter: { name: 'Alice' } }),
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
    onSelect: (id) => {
      chosen.push(id);
    },
    translator: createTranslator({ locale: 'en', now: () => Date.parse('2026-10-09T12:00:00.000Z') }),
    ...more,
  });
  cleanup.push(() => sidebar.destroy());
  const root = page.query('[data-fruitback-sidebar]') as HTMLElement;
  const items = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('[data-fruitback-note]')];
  const opener = page.query('#opener') as HTMLElement;
  const chips = (): HTMLElement[] =>
    [...root.querySelectorAll<HTMLElement>('[data-fruitback-chip]')].filter((chip) => !chip.hidden);
  const chipNames = (): (string | null)[] => chipNamesIn(root);
  const chip = (stage: string): HTMLElement => root.querySelector(`[data-fruitback-chip="${stage}"]`) as HTMLElement;
  const search = root.querySelector('input[type="search"]') as HTMLInputElement;
  const type = (words: string) => {
    search.value = words;
    search.dispatchEvent(new (page.view as unknown as { Event: typeof Event }).Event('input', { bubbles: true }));
  };

  return { page, state, chosen, sidebar, root, items, opener, chips, chipNames, chip, search, type };
}

/** The names of the chips that show, with their numbers: « All 8 », « New 2 »… */
const chipNamesIn = (root: ParentNode): (string | null)[] =>
  [...root.querySelectorAll<HTMLElement>('[data-fruitback-chip]')]
    .filter((chip) => !chip.hidden)
    .map((chip) => chip.getAttribute('aria-label'));

/** A row as it reads: the number of its pin, its top line in parts, its note, and its last line. */
const rowOf = (item: HTMLElement) => [
  item.querySelector('.fruitback-sidebar-pin')?.textContent,
  [...(item.querySelector('.fruitback-sidebar-top')?.children ?? [])].map((part) => part.textContent),
  item.querySelector('.fruitback-sidebar-note')?.textContent,
  item.querySelector('.fruitback-sidebar-meta')?.textContent,
];

describe('the list of every note of the page (FRU-129, FRU-308)', () => {
  it('lists each note with its status, its identifier, when, its note, who wrote it and its replies', () => {
    const { sidebar, root, items, chipNames } = mount([
      { issue: note('a', 'The price should say per month.\nSecond line', 'progress'), placement: 'found', number: 1 },
      { issue: note('b', 'Wrong colour'), placement: 'found', number: 2 },
    ]);
    sidebar.open();

    assert.equal(root.hidden, false);
    assert.equal(root.querySelector('.fruitback-sidebar-scope')?.textContent, 'This page · 2');
    assert.deepEqual(chipNames(), ['All 2', 'New 1', 'To do 0', 'In progress 1', 'Done 0']);
    // The board: « In progress · A … 2 hours ago », the note on one run of words, then who and the replies.
    assert.deepEqual(items().map(rowOf), [
      [
        '1',
        ['In Progress', 'A', '2 hours ago'],
        'The price should say per month. Second line',
        'Alice · no reply · further down',
      ],
      ['2', ['In Progress', 'B', '2 hours ago'], 'Wrong colour', 'Alice · no reply · further down'],
    ]);
    // « further down » is in the row for when the page scrolls, and hidden: nothing here says it is below.
    assert.deepEqual(
      items().map((item) => (item.querySelector('[data-fruitback-below]') as HTMLElement).hidden),
      [true, true],
    );
    // The drop is for the eye: the row says its state in words.
    assert.equal(items()[0]?.querySelector('.fruitback-sidebar-pin')?.getAttribute('aria-hidden'), 'true');
  });

  it('says so when a note was found by its position, and puts a note not found at the bottom', () => {
    const { sidebar, root, chipNames, chosen } = mount([
      { issue: note('a', 'Found'), placement: 'found', number: 1 },
      { issue: note('b', 'By position'), placement: 'approximate', number: 2 },
      { issue: note('c', 'Gone', 'progress'), placement: 'detached', number: 3 },
    ]);
    sidebar.open();

    const rows = [...root.querySelectorAll<HTMLElement>('.fruitback-sidebar-list [data-fruitback-note]')];
    assert.deepEqual(
      rows.map((row) => /Approximate position/.test(row.querySelector('.fruitback-sidebar-meta')?.textContent ?? '')),
      [false, true],
    );
    // The note whose element is gone is apart, in a group with a name, and the counts leave it out (FRU-259).
    assert.equal(root.querySelector('.fruitback-sidebar-scope')?.textContent, 'This page · 2');
    assert.deepEqual(chipNames(), ['All 2', 'New 2', 'To do 0', 'In progress 0', 'Done 0']);
    const unplaced = root.querySelector('[data-fruitback-unplaced]') as HTMLElement;
    assert.equal(unplaced.hidden, false);
    assert.equal(unplaced.getAttribute('role'), 'group');
    assert.equal(root.querySelector(`#${unplaced.getAttribute('aria-labelledby')}`)?.textContent, '1 detached note');
    const lost = unplaced.querySelector('[data-fruitback-note]') as HTMLElement;
    assert.deepEqual(
      [...lost.children].map((child) => child.textContent),
      ['Gone', 'In Progress · C · the element it pointed at is gone'],
    );
    // It still opens its thread, which holds the replies and the way to the store.
    lost.click();
    assert.deepEqual(chosen, ['c']);
  });

  it('has no group of detached notes when every note has its element', () => {
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

  it('says the page has no note, with no empty list', () => {
    const { sidebar, root } = mount([]);
    sidebar.open();

    assert.equal((root.querySelector('.fruitback-sidebar-empty') as HTMLElement).hidden, false);
    assert.equal((root.querySelector('.fruitback-sidebar-list') as HTMLElement).hidden, true);
    assert.equal(root.querySelector('.fruitback-sidebar-empty')?.textContent, 'No note on this page yet.');
    assert.deepEqual(chipNamesIn(root), ['All 0', 'New 0', 'To do 0', 'In progress 0', 'Done 0']);
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

describe('the search and the chips of the list (FRU-308)', () => {
  const eight = (): SidebarEntry[] =>
    (
      [
        ['a', 'new', 'The mug is too small'],
        ['b', 'todo', 'Wrong colour on the button'],
        ['c', 'progress', 'The price should say per month'],
        ['d', 'done', 'Typo in the footer'],
        ['e', 'new', 'The MUG photo is blurred'],
        ['f', 'closed', 'Not a bug'],
        ['g', 'progress', 'Logo too big'],
        ['h', 'todo', 'Add a mug size'],
      ] as const
    ).map(([id, stage, text], index) => ({ issue: note(id, text, stage), placement: 'found', number: index + 1 }));
  const ids = (items: HTMLElement[]) => items.map((item) => item.dataset.fruitbackNote).join('');

  it('counts each status, and a chip shows its notes only', () => {
    const { sidebar, root, items, chips, chipNames, chip } = mount(eight());
    sidebar.open();

    assert.equal(root.querySelector('[role="tablist"]'), null, 'the tabs of FRU-259 are gone');
    const group = root.querySelector('.fruitback-sidebar-chips');
    assert.equal(group?.getAttribute('role'), 'group');
    assert.equal(group?.getAttribute('aria-label'), 'Status');
    // « Closed » is not on the board: it shows because a note of the page is closed.
    assert.deepEqual(chipNames(), ['All 8', 'New 2', 'To do 2', 'In progress 2', 'Done 1', 'Closed 1']);
    assert.deepEqual(
      chips().map((one) => one.getAttribute('aria-pressed')),
      ['true', 'false', 'false', 'false', 'false', 'false'],
    );
    assert.equal(ids(items()), 'abcdefgh');

    chip('progress').click();
    assert.equal(ids(items()), 'cg');
    assert.equal(chip('progress').getAttribute('aria-pressed'), 'true');
    assert.equal(chip('all').getAttribute('aria-pressed'), 'false');
    // The rows keep the number of their pin, whatever the chip.
    assert.deepEqual(
      items().map((item) => item.querySelector('.fruitback-sidebar-pin')?.textContent),
      ['3', '7'],
    );

    chip('all').click();
    assert.equal(ids(items()), 'abcdefgh');
  });

  it('has no chip « Closed » while no note of the page is closed', () => {
    const { sidebar, chipNames, chip } = mount(eight().filter((entry) => entry.issue.stage !== 'closed'));
    sidebar.open();

    assert.deepEqual(chipNames(), ['All 7', 'New 2', 'To do 2', 'In progress 2', 'Done 1']);
    assert.equal(chip('closed').hidden, true);
  });

  it('searches the whole text of the notes and their identifier, whatever the case, and the chips count what it found', () => {
    const notes = eight();
    (notes[3] as SidebarEntry).issue.identifier = 'FRU-128';
    const { sidebar, root, items, chipNames, chip, search, type } = mount(notes);
    sidebar.open();
    assert.equal(search.getAttribute('aria-label'), 'Search notes');
    assert.equal(search.placeholder, 'Search notes');

    type('mug');
    assert.equal(ids(items()), 'aeh');
    assert.deepEqual(chipNames(), ['All 3', 'New 2', 'To do 1', 'In progress 0', 'Done 0']);
    // The scope counts the page, not the search.
    assert.equal(root.querySelector('.fruitback-sidebar-scope')?.textContent, 'This page · 8');

    // A search and a chip together.
    chip('todo').click();
    assert.equal(ids(items()), 'h');
    // The identifier of the store.
    chip('all').click();
    type('  fru-128 ');
    assert.equal(ids(items()), 'd');

    type('');
    assert.equal(ids(items()), 'abcdefgh');
  });

  it('says that nothing matches, which is not that the page has no note', () => {
    const { sidebar, root, type } = mount(eight());
    sidebar.open();
    const empty = root.querySelector('.fruitback-sidebar-empty') as HTMLElement;
    assert.equal(empty.hidden, true);

    type('nothing like this');

    assert.equal(empty.hidden, false);
    assert.equal(empty.textContent, 'No note matches.');
    assert.equal((root.querySelector('.fruitback-sidebar-list') as HTMLElement).hidden, true);
  });

  it('keeps the keys typed in the search from the page, and lets Escape close the list', () => {
    const { page, sidebar, search } = mount(eight());
    let reached = 0;
    page.document.addEventListener('keydown', () => (reached += 1));
    sidebar.open();
    search.focus();

    search.dispatchEvent(new (keyboardEventCtor(page))('keydown', { key: 'm', bubbles: true, composed: true }));
    assert.equal(reached, 0, 'a site that listens to the keys heard the search');

    search.dispatchEvent(new (keyboardEventCtor(page))('keydown', { key: 'Escape', bubbles: true, composed: true }));
    assert.equal(sidebar.isOpen, false);
  });

  it('filters the detached notes too', () => {
    const { sidebar, root, chip, type } = mount([
      { issue: note('a', 'Found'), placement: 'found', number: 1 },
      { issue: note('c', 'Gone banner', 'progress'), placement: 'detached' },
    ]);
    sidebar.open();
    const unplaced = root.querySelector('[data-fruitback-unplaced]') as HTMLElement;
    assert.equal(unplaced.hidden, false);

    chip('new').click();
    assert.equal(unplaced.hidden, true);
    chip('progress').click();
    assert.equal(unplaced.hidden, false);
    type('found');
    assert.equal(unplaced.hidden, true);
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
      items().map((item) => item.querySelector('.fruitback-sidebar-status')?.textContent),
      ['New', 'New', 'New'],
    );
    assert.deepEqual(
      items().map((item) => item.querySelector('.fruitback-sidebar-meta')?.firstChild?.textContent),
      ['Alice · no reply', 'Alice · 1 reply', 'Alice · 2 replies'],
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
});

describe('the head and the foot of the list (FRU-308)', () => {
  it('holds a button to leave a note, with the label of the host, that closes the list first', () => {
    const order: string[] = [];
    const { sidebar, root } = mount([], {
      leave: { label: 'Feedback, please', onLeave: () => order.push(sidebar.isOpen ? 'open' : 'closed') },
    });
    sidebar.open();
    const leave = root.querySelector('[data-fruitback-leave]') as HTMLElement;
    assert.equal(leave.textContent, 'Feedback, please');
    assert.ok(leave.querySelector('svg.fruitback-icon'), 'the button lost its mark');
    assert.ok(leave.closest('.fruitback-sidebar-foot'), 'the button is not in the foot');

    leave.click();

    // The capture needs the page and the keys: the list is gone when it starts.
    assert.deepEqual(order, ['closed']);
  });

  it('has no button to leave a note for a host that gave none', () => {
    const { root } = mount();

    assert.equal(root.querySelector('[data-fruitback-leave]'), null);
  });

  it('says « Notes » and the host of the page in its head', () => {
    const { sidebar, root, page } = mount();
    sidebar.open();

    assert.equal(root.querySelector('.fruitback-sidebar-title')?.textContent, 'Notes');
    assert.equal(root.querySelector('.fruitback-sidebar-address')?.textContent, `· ${page.view.location.host}`);
  });

  it('closes on « Back to floating pins » and on its cross', () => {
    const { sidebar, root, opener } = mount([{ issue: note('a', 'One'), placement: 'found' }]);
    const floating = root.querySelector('[data-fruitback-floating]') as HTMLElement;
    assert.equal(floating.getAttribute('aria-label'), 'Back to floating pins');
    const close = root.querySelector('.fruitback-sidebar-close') as HTMLElement;
    assert.equal(close.getAttribute('aria-label'), 'Close the sidebar');

    opener.focus();
    sidebar.open();
    floating.click();
    assert.equal(sidebar.isOpen, false);

    sidebar.open();
    close.click();
    assert.equal(sidebar.isOpen, false);
  });

  it('hides the pins while the list is open, and shows them again when it closes', () => {
    const asked: boolean[] = [];
    const { sidebar, root } = mount([{ issue: note('a', 'One'), placement: 'found' }], {
      pins: { show: (on) => asked.push(on) },
    });
    sidebar.open();
    const toggle = root.querySelector('[data-fruitback-show-pins]') as HTMLInputElement;
    assert.equal(toggle.getAttribute('role'), 'switch');
    assert.equal(toggle.checked, true);
    assert.equal(toggle.closest('label')?.textContent, 'Show pins on the page');

    toggle.click();
    assert.deepEqual(asked, [false]);
    toggle.click();
    toggle.click();
    assert.deepEqual(asked, [false, true, false]);

    // Back to floating pins: they come back, and the switch is on when the list opens again.
    sidebar.close();
    assert.deepEqual(asked, [false, true, false, true]);
    sidebar.open();
    assert.equal(toggle.checked, true);
    // Closed with the pins shown: nothing to ask.
    sidebar.close();
    assert.deepEqual(asked, [false, true, false, true]);
  });

  it('has no switch of the pins for a host that gave no pins', () => {
    const { root } = mount();

    assert.equal(root.querySelector('[data-fruitback-show-pins]'), null);
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
    // Its name is not the « Notes » of its head: it must not start like « Note 3 », the thread (FRU-308).
    assert.equal(root.getAttribute('aria-label'), 'Notes on this page');
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

/** No engine at all: these tests never point at the page. */
const engine = {
  elementAt: () => null,
  grabbable: () => true,
  boundsOf: () => ({ left: 0, top: 0, width: 0, height: 0 }),
  sourceOf: async () => undefined,
};

describe('the way into the list (FRU-129)', () => {
  it('is a button of the dock, with a name that is not the name of its dialog', () => {
    const page = mountPage('<main></main>');
    let asked = 0;
    const host = createCaptureHost({ document: page.document, engine, onSelect: () => {}, onList: () => (asked += 1) });
    cleanup.push(() => host.destroy());
    const button = host.root.querySelector<HTMLElement>('[data-fruitback-host-list]');

    assert.ok(button !== null);
    assert.equal(button.getAttribute('aria-label'), 'Show every note in a sidebar');
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
      noteIssueFixture({
        identifier: 'ID-1',
        note: noteFixture({
          id: 'sd_one',
          text: 'On the button',
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

describe('the thread of a note in place of the rows (FRU-312)', () => {
  /** The list and the pins, wired as `embed.ts` wires them. */
  function wired() {
    const page = mountPage('<main><button data-testid="cta">Commander</button></main>', {
      width: 1_440,
      height: 900,
    });
    setDocumentSize(page.document, 1_440, 900);
    setRect(page.query('button'), { left: 100, top: 200, width: 200, height: 40 });
    const host = createCaptureHost({ document: page.document, engine, onSelect: () => {} });
    cleanup.push(() => host.destroy());
    const issues = ['sd_one', 'sd_two'].map((id, index) =>
      noteIssueFixture({
        id: `issue_${id}`,
        identifier: `ID-${index + 1}`,
        note: noteFixture({
          id,
          text: `Note ${index + 1}`,
          anchor: {
            selector: '[data-testid="cta"]',
            tag: 'button',
            text: 'Commander',
            bounds: { xPct: 10, yPct: 20, wPct: 20, hPct: 4 },
          },
        }),
      }),
    );
    let sidebar: Sidebar | undefined;
    const overlay = createOverlay({ document: page.document, host: host.root, onThread: () => sidebar?.mark() });
    cleanup.push(() => overlay.destroy());
    overlay.render(issues);
    sidebar = createSidebar({
      document: page.document,
      host: host.root,
      entries: () => issues.map((issue, index) => ({ issue, placement: 'found' as const, number: index + 1 })),
      onSelect: (id, home) => overlay.select(id, home),
      onBack: () => overlay.closeThread(),
      current: () => overlay.openId(),
    });
    const list = sidebar;
    cleanup.push(() => list.destroy());
    const root = host.root.querySelector('[data-fruitback-sidebar]') as HTMLElement;
    const rows = () => [...root.querySelectorAll<HTMLElement>('.fruitback-sidebar-list [data-fruitback-note]')];
    const detail = root.querySelector('[data-fruitback-sidebar-detail]') as HTMLElement;
    const panel = root.querySelector('.fruitback-sidebar-panel') as HTMLElement;
    const escape = () =>
      deepActiveElement(page.document)?.dispatchEvent(
        new (keyboardEventCtor(page))('keydown', { key: 'Escape', bubbles: true, composed: true }),
      );

    return { page, host, overlay, sidebar: list, root, rows, detail, panel, escape, issues };
  }

  it('shows the thread in the column of the list, under its head, and not on the page', () => {
    const { page, host, sidebar, root, rows, detail, panel } = wired();
    sidebar.open();
    rows()[1]?.click();

    assert.equal(detail.hidden, false);
    assert.equal(panel.hidden, true);
    // The head of the list stays: its title and its cross.
    assert.equal((root.querySelector('.fruitback-sidebar-head') as HTMLElement).hidden, false);
    const thread = detail.querySelector('[data-fruitback-thread]') as HTMLElement;
    assert.equal(thread.dataset.fruitbackThread, 'sd_two');
    assert.ok(thread.hasAttribute('data-fruitback-home'));
    // Not on the page: the overlay holds no thread of its own.
    assert.equal(host.root.querySelectorAll('[data-fruitback-thread]').length, 1);
    assert.equal(detail.querySelector('[data-fruitback-sidebar-back]')?.textContent, '←All notes');
    // Focus in the thread, on its cross.
    assert.ok(deepActiveElement(page.document)?.classList.contains('fruitback-thread-close'));
  });

  it('goes back to the rows on « All notes », on Escape and on the cross, with focus on the row', () => {
    const { page, overlay, sidebar, rows, detail, panel, escape } = wired();
    sidebar.open();
    const focusedRow = () => (deepActiveElement(page.document) as HTMLElement | null)?.dataset.fruitbackNote;

    rows()[1]?.click();
    (detail.querySelector('[data-fruitback-sidebar-back]') as HTMLElement).click();
    assert.equal(detail.hidden, true);
    assert.equal(panel.hidden, false);
    assert.equal(overlay.threadOpen(), false);
    assert.equal(focusedRow(), 'sd_two');

    rows()[0]?.click();
    escape();
    assert.equal(detail.hidden, true);
    assert.equal(overlay.threadOpen(), false);
    // Escape went back to the rows, and did not close the list.
    assert.equal(sidebar.isOpen, true);
    assert.equal(focusedRow(), 'sd_one');

    rows()[0]?.click();
    (detail.querySelector('.fruitback-thread-close') as HTMLElement).click();
    assert.equal(detail.hidden, true);
    assert.equal(focusedRow(), 'sd_one');
  });

  it('keeps the thread in the list across a read that draws the pins again, and goes back when its note goes', () => {
    const { page, overlay, sidebar, rows, detail, panel, issues } = wired();
    sidebar.open();
    rows()[1]?.click();

    // A read answers while the thread is read: the pins are drawn again, the thread stays in the list.
    overlay.render([...issues]);
    assert.equal(detail.hidden, false);
    assert.equal(panel.hidden, true);
    assert.equal(overlay.threadOpen(), true);
    assert.equal(
      (detail.querySelector('[data-fruitback-thread]') as HTMLElement | null)?.dataset.fruitbackThread,
      'sd_two',
    );
    assert.ok(deepActiveElement(page.document)?.classList.contains('fruitback-thread-close'));

    // A read where the note is gone: the thread closes, and the list shows its rows again.
    overlay.render([issues[0]!]);
    assert.equal(overlay.threadOpen(), false);
    assert.equal(detail.hidden, true);
    assert.equal(panel.hidden, false);
  });

  it('leaves focus on the page when a click there closes the thread, and gives it to the row from the thread', () => {
    const { page, sidebar, rows, detail } = wired();
    const view = page.view as unknown as typeof globalThis;
    sidebar.open();

    rows()[0]?.click();
    // A press on the page, outside the list: focus goes to the page, and the click closes the thread.
    const main = page.query('main') as HTMLElement;
    main.dispatchEvent(new view.Event('pointerdown', { bubbles: true, composed: true }));
    (deepActiveElement(page.document) as HTMLElement | null)?.blur();
    main.click();
    assert.equal(detail.hidden, true);
    assert.equal(deepActiveElement(page.document), page.document.body);

    // From the thread, its cross gives focus to the row of its note.
    rows()[1]?.click();
    (detail.querySelector('.fruitback-thread-close') as HTMLElement).click();
    assert.equal(detail.hidden, true);
    assert.equal((deepActiveElement(page.document) as HTMLElement | null)?.dataset.fruitbackNote, 'sd_two');
  });

  it('closes the thread with the list, and shows the rows when the list opens again', () => {
    const { overlay, sidebar, rows, detail, panel } = wired();
    sidebar.open();
    rows()[0]?.click();
    sidebar.close();
    assert.equal(overlay.threadOpen(), false);
    sidebar.open();
    assert.equal(detail.hidden, true);
    assert.equal(panel.hidden, false);
  });

  it('keeps the rows when the chosen note has no thread to show', () => {
    const page = mountPage('<main><div id="widget"></div></main>');
    const sidebar = createSidebar({
      document: page.document,
      host: page.query('#widget'),
      entries: () => [{ issue: note('a', 'One'), placement: 'found' }],
      onSelect: () => false,
    });
    cleanup.push(() => sidebar.destroy());
    sidebar.open();
    (page.document.querySelector('[data-fruitback-note]') as HTMLElement).click();
    assert.equal((page.document.querySelector('[data-fruitback-sidebar-detail]') as HTMLElement).hidden, true);
    assert.equal((page.document.querySelector('.fruitback-sidebar-panel') as HTMLElement).hidden, false);
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
    assert.deepEqual(chipNamesIn(root), ['Toutes', 'Nouveau', 'À faire', 'En cours', 'Terminé']);
    assert.equal(text('.fruitback-sidebar-scope'), 'Cette page');
    assert.equal(text('.fruitback-sidebar-empty'), 'Lecture des notes de cette page…');
    assert.equal(shown('.fruitback-sidebar-failed'), false);
  });

  it('says the read failed, offers to read again, and gives that button focus', () => {
    const state = { read: 'failed' as ReadState };
    const { page, sidebar, retries, shown, text, root } = mountIn(state);
    sidebar.open();

    assert.equal(shown('.fruitback-sidebar-empty'), false);
    assert.deepEqual(chipNamesIn(root), ['Toutes', 'Nouveau', 'À faire', 'En cours', 'Terminé']);
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
    assert.equal(text('.fruitback-sidebar-scope'), 'Cette page · 1');
  });
});

describe('the notes kept for later, in the list (FRU-124)', () => {
  it('says how many notes went and why the others stay, when a send did both', async () => {
    const page = mountPage('<main></main>');
    const host = page.document.createElement('div');
    page.document.body.append(host);
    const kept = [{ note: noteFixture({ id: 'sd_a' }) }, { note: noteFixture({ id: 'sd_b' }) }];
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
    assert.equal(
      await said(),
      '1 note sent — Too many notes just now. Your text is still here. Send it again in a minute.',
    );
    // Nothing left: the sentence of the failure alone, with no « 0 note sent ».
    outcome = { sent: 0, failure: 'wait' };
    assert.equal(await said(), 'Too many notes just now. Your text is still here. Send it again in a minute.');
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
      leave: { label: 'Leave a note', onLeave: () => asked.push('leave') },
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

describe('« All pages », when the host reads the site (FRU-470)', () => {
  const siteNote = (id: string, path: string, stage: 'new' | 'done' = 'new') => ({
    note: id,
    excerpt: `Note ${id}`,
    page: { url: `https://preview.acme.test${path}`, path },
    stage,
    author: 'Bob',
    createdAt: '2026-10-09T10:00:00.000Z',
  });

  /** A host whose answers the test gives, one read at a time. */
  function siteHost() {
    const asked: { q?: string; cursor?: string }[] = [];
    let answer: (read: import('./site-notes.ts').SiteRead) => void = () => {};
    const read = (query: { q?: string; cursor?: string }) => {
      asked.push(query);

      return new Promise<import('./site-notes.ts').SiteRead>((resolve) => {
        answer = resolve;
      });
    };

    return { asked, read, answer: (value: import('./site-notes.ts').SiteRead) => answer(value) };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const siteRows = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[data-fruitback-site-note]')];
  const scope = (root: HTMLElement, which: 'page' | 'site') =>
    root.querySelector(`[data-fruitback-scope="${which}"]`) as HTMLButtonElement;

  it('is not offered when the host reads one page only: « This page » stays words', () => {
    const { sidebar, root } = mount([{ issue: note('a', 'Here'), placement: 'found', number: 1 }]);
    sidebar.open();

    assert.equal(root.querySelector('[data-fruitback-scope]'), null);
    assert.equal(root.querySelector('p.fruitback-sidebar-scope')?.textContent, 'This page · 1');
  });

  it('reads the site when chosen, lists its notes with their page, and says how many', async () => {
    const host = siteHost();
    const { sidebar, root, items, chips } = mount([{ issue: note('a', 'Here'), placement: 'found', number: 1 }], {
      site: { read: host.read, here: (url) => url === 'https://preview.acme.test/pricing' },
    });
    sidebar.open();
    assert.equal(scope(root, 'page').getAttribute('aria-pressed'), 'true');
    assert.equal(scope(root, 'page').textContent, 'This page · 1');
    assert.equal(scope(root, 'site').textContent, 'All pages');

    scope(root, 'site').click();
    assert.deepEqual(host.asked, [{}]);
    assert.equal(scope(root, 'site').getAttribute('aria-pressed'), 'true');
    assert.equal(
      (root.querySelector('.fruitback-sidebar-empty') as HTMLElement).textContent,
      'Reading the notes of every page…',
    );
    assert.equal(items().length, 0, 'the rows of this page stay in « All pages »');
    assert.equal(chips().length > 0 && chips()[0]!.closest('[hidden]') !== null, true, 'the chips of the page stay');
    // happy-dom does no layout: the rule that makes `hidden` win over the `display` of the class.
    assert.match(stylesIn(root), /\.fruitback-sidebar-chips\[hidden\] \{ display: none; \}/);

    host.answer({ ok: true, notes: [siteNote('s1', '/about'), siteNote('a', '/pricing', 'done')], total: 2 });
    await settle();
    assert.equal(scope(root, 'site').textContent, 'All pages · 2');
    assert.deepEqual(
      siteRows(root).map((row) => [
        row.querySelector('.fruitback-sidebar-status')?.textContent,
        row.querySelector('.fruitback-sidebar-note')?.textContent,
        row.querySelector('.fruitback-sidebar-meta')?.textContent,
      ]),
      [
        ['New', 'Note s1', '/about · Bob'],
        ['Done', 'Note a', 'this page · Bob'],
      ],
    );
  });

  it('opens a note of this page in the list, and refuses an address of another origin', async () => {
    const host = siteHost();
    const { sidebar, root, chosen } = mount([{ issue: note('a', 'Here'), placement: 'found', number: 1 }], {
      site: { read: host.read, here: (url) => url === 'https://preview.acme.test/pricing' },
    });
    sidebar.open();
    scope(root, 'site').click();
    const away = { ...siteNote('x', '/elsewhere'), page: { url: 'javascript:alert(1)', path: '/elsewhere' } };
    host.answer({ ok: true, notes: [siteNote('a', '/pricing'), away], total: 2 });
    await settle();

    const [mine, other] = siteRows(root);
    assert.equal(other?.getAttribute('aria-disabled'), 'true');
    mine?.click();
    assert.deepEqual(chosen, ['a']);
    assert.equal(scope(root, 'page').getAttribute('aria-pressed'), 'true');
  });

  it('searches through the host once the typing stops, and drops an older answer', async () => {
    const host = siteHost();
    const { sidebar, root, type } = mount([], { site: { read: host.read, here: () => false } });
    sidebar.open();
    scope(root, 'site').click();
    type('price');
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.deepEqual(host.asked, [{}, { q: 'price' }]);
    host.answer({ ok: true, notes: [siteNote('p', '/pricing')], total: 1 });
    await settle();
    assert.deepEqual(
      siteRows(root).map((row) => row.dataset.fruitbackSiteNote),
      ['p'],
    );
  });

  it('shows more with the cursor of the host, and gives focus to the first note it brought', async () => {
    const host = siteHost();
    const { sidebar, root, page } = mount([], { site: { read: host.read, here: () => false } });
    sidebar.open();
    scope(root, 'site').click();
    host.answer({ ok: true, notes: [siteNote('1', '/a')], total: 2, next: 'c2' });
    await settle();
    const more = root.querySelector('.fruitback-sidebar-more') as HTMLButtonElement;
    assert.equal(more.hidden, false);
    more.focus();
    more.click();
    assert.deepEqual(host.asked.at(-1), { cursor: 'c2' });
    host.answer({ ok: true, notes: [siteNote('2', '/b')], total: 2 });
    await settle();
    assert.deepEqual(
      siteRows(root).map((row) => row.dataset.fruitbackSiteNote),
      ['1', '2'],
    );
    assert.equal(more.hidden, true);
    assert.equal(deepActiveElement(page.document)?.getAttribute('data-fruitback-site-note'), '2');
  });

  it('says a failed read, reads again on « Try again », and offers no retry where the host cannot read', async () => {
    const host = siteHost();
    const { sidebar, root } = mount([], { site: { read: host.read, here: () => false } });
    sidebar.open();
    scope(root, 'site').click();
    host.answer({ ok: false, reason: 'failed' });
    await settle();
    const retry = root.querySelector('.fruitback-sidebar-failed .fruitback-sidebar-retry') as HTMLButtonElement;
    assert.equal(
      root.querySelector('.fruitback-sidebar-failed-text')?.textContent,
      'The notes of the other pages could not be read.',
    );
    retry.click();
    assert.equal(host.asked.length, 2);
    host.answer({ ok: false, reason: 'unavailable' });
    await settle();
    assert.equal(
      root.querySelector('.fruitback-sidebar-failed-text')?.textContent,
      'The notes of the other pages cannot be read here.',
    );
    assert.equal(retry.hidden, true);
  });

  it('drops the answer of a read made before the list closed, when a new one runs (review of #639)', async () => {
    const answers: ((read: import('./site-notes.ts').SiteRead) => void)[] = [];
    const read = () =>
      new Promise<import('./site-notes.ts').SiteRead>((resolve) => {
        answers.push(resolve);
      });
    const { sidebar, root } = mount([], { site: { read, here: () => false } });
    sidebar.open();
    scope(root, 'site').click();
    sidebar.close();
    sidebar.open();
    scope(root, 'site').click();
    // The first read answers last: it is dropped, and the list waits for its own.
    answers[0]?.({ ok: true, notes: [siteNote('old', '/old')], total: 1 });
    await settle();
    assert.equal(siteRows(root).length, 0);
    assert.equal(scope(root, 'site').textContent, 'All pages');
    answers[1]?.({ ok: true, notes: [siteNote('new', '/new')], total: 1 });
    await settle();
    assert.deepEqual(
      siteRows(root).map((row) => row.dataset.fruitbackSiteNote),
      ['new'],
    );
  });

  it('gives focus back to the row of a note of this page, opened from « All pages » (review of #639)', async () => {
    const host = siteHost();
    const { sidebar, root, page } = mount([{ issue: note('a', 'Here'), placement: 'found', number: 1 }], {
      site: { read: host.read, here: (url) => url.endsWith('/pricing') },
    });
    sidebar.open();
    scope(root, 'site').click();
    host.answer({ ok: true, notes: [siteNote('a', '/pricing')], total: 1 });
    await settle();
    siteRows(root)[0]?.click();
    (root.querySelector('[data-fruitback-sidebar-back]') as HTMLButtonElement).focus();
    (root.querySelector('[data-fruitback-sidebar-back]') as HTMLButtonElement).click();

    assert.equal(deepActiveElement(page.document)?.getAttribute('data-fruitback-note'), 'a');
  });

  it('opens again on « This page », and asks the host again', async () => {
    const host = siteHost();
    const { sidebar, root } = mount([], { site: { read: host.read, here: () => false } });
    sidebar.open();
    scope(root, 'site').click();
    host.answer({ ok: true, notes: [siteNote('1', '/a')], total: 1 });
    await settle();
    sidebar.close();
    sidebar.open();
    assert.equal(scope(root, 'page').getAttribute('aria-pressed'), 'true');
    assert.equal(siteRows(root).length, 0);
    scope(root, 'site').click();
    assert.equal(host.asked.length, 2);
  });
});
