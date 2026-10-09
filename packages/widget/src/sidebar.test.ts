import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { seedFixture, seedIssueFixture } from '@fruitback/shared/seed.fixture';
import type { FeedbackEntry } from './export.ts';
import { mountPage, setDocumentSize, setRect } from './dom.fixture.ts';
import { deepActiveElement } from './focus.ts';
import { createTranslator } from './messages.ts';
import { type Sidebar, createSidebar } from './sidebar.ts';
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
function mount(entries: FeedbackEntry[] = []) {
  const page = mountPage('<main><button id="opener">open</button><div id="widget"></div></main>');
  const state = { entries };
  const chosen: string[] = [];
  const sidebar: Sidebar = createSidebar({
    document: page.document,
    host: page.query('#widget'),
    entries: () => state.entries,
    onSelect: (id) => chosen.push(id),
    translator: createTranslator({ locale: 'en', now: () => Date.parse('2026-10-09T12:00:00.000Z') }),
  });
  cleanup.push(() => sidebar.destroy());
  const root = page.query('[data-fruitback-sidebar]') as HTMLElement;
  const items = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('[data-fruitback-note]')];
  const opener = page.query('#opener') as HTMLElement;

  return { page, state, chosen, sidebar, root, items, opener };
}

describe('the list of every note of the page (FRU-129)', () => {
  it('lists each note with its state, its first line, who wrote it and when', () => {
    const { sidebar, root, items } = mount([
      { issue: note('a', 'The price should say per month.\nSecond line', 'ripening'), placement: 'found' },
      { issue: note('b', 'Wrong colour'), placement: 'found' },
    ]);
    sidebar.open();

    assert.equal(root.hidden, false);
    assert.equal(root.querySelector('.fruitback-sidebar-count')?.textContent, '2 notes');
    assert.deepEqual(
      items().map((item) => [...item.children].map((child) => child.textContent)),
      [
        ['In progress', 'The price should say per month.', 'Alice · 2 hours ago'],
        ['New', 'Wrong colour', 'Alice · 2 hours ago'],
      ],
    );
  });

  it('says so when a note was found by its position, or not found', () => {
    const { sidebar, items } = mount([
      { issue: note('a', 'Found'), placement: 'found' },
      { issue: note('b', 'By position'), placement: 'approximate' },
      { issue: note('c', 'Gone'), placement: 'detached' },
    ]);
    sidebar.open();

    assert.deepEqual(
      items().map((item) => item.querySelector('.fruitback-sidebar-placement')?.textContent),
      [undefined, 'Approximate position', 'Element not found on this page'],
    );
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
    assert.equal(root.querySelector('.fruitback-sidebar-count')?.textContent, '0 notes');
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

describe('the list as a dialog (FRU-129)', () => {
  it('is a dialog with a name, that is not modal', () => {
    const { root } = mount();

    assert.equal(root.getAttribute('role'), 'dialog');
    assert.equal(root.getAttribute('aria-label'), 'Every note of this page');
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
