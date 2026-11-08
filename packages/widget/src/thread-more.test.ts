import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { NoteIssue } from '@fruitback/shared';
import { noteFixture, noteIssueFixture } from '@fruitback/shared/note.fixture';
import { type EditSeam, type Overlay, createOverlay } from './overlay.ts';
import { linkedNote } from './page.ts';
import { noteLink } from './thread-more.ts';
import { type MountedPage, mountPage, setDocumentSize, setRect } from './dom.fixture.ts';

/**
 * The menu « ⋯ » of the author in the head of a thread (FRU-605): « Edit the note » and « Copy link to
 * the note », for the author of an open note only.
 */

let overlay: Overlay | null = null;

afterEach(() => {
  overlay?.destroy();
  overlay = null;
});

function mounted(): MountedPage {
  const page = mountPage('<main><button data-testid="cta">Commander</button></main>', { width: 1_000, height: 1_000 });
  setDocumentSize(page.document, 1_000, 1_000);
  setRect(page.query('button'), { left: 100, top: 200, width: 200, height: 40 });

  return page;
}

function anIssue(overrides: Parameters<typeof noteIssueFixture>[0] = {}): NoteIssue {
  return noteIssueFixture({
    comments: [],
    mine: true,
    stage: 'todo',
    note: noteFixture({
      text: 'The price is wrong',
      anchor: {
        selector: '[data-testid="cta"]',
        tag: 'button',
        text: 'Commander',
        bounds: { xPct: 10, yPct: 20, wPct: 20, hPct: 4 },
      },
    }),
    ...overrides,
  });
}

const neverSent: EditSeam = { send: () => new Promise(() => {}) };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function open(page: MountedPage, issue: NoteIssue) {
  overlay = createOverlay({ document: page.document, edit: neverSent });
  overlay.render([issue]);
  (page.document.querySelector('.fruitback-pin-badge') as HTMLElement).click();
  const q = <T extends Element>(selector: string) => page.document.querySelector(selector) as T | null;
  const items = () =>
    [...page.document.querySelectorAll<HTMLButtonElement>('.fruitback-thread-more-item')].map(
      (each) => each.textContent,
    );

  return {
    more: () => q<HTMLButtonElement>('.fruitback-thread-more'),
    menu: () => q<HTMLElement>('.fruitback-thread-more-menu'),
    items,
    item: (text: string) =>
      [...page.document.querySelectorAll<HTMLButtonElement>('.fruitback-thread-more-item')].find(
        (each) => each.textContent === text,
      ),
    said: () => q('.fruitback-thread-more-said')?.textContent ?? null,
    linkField: () => q<HTMLInputElement>('.fruitback-thread-more-link'),
    thread: () => q('.fruitback-thread'),
  };
}

function withClipboard(page: MountedPage, writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(page.document.defaultView?.navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
}

describe('the menu of the author in a thread (FRU-605)', () => {
  for (const stage of ['new', 'todo', 'progress'] as const) {
    it(`is offered to the author of a note at ${stage}`, () => {
      const thread = open(mounted(), anIssue({ stage }));
      assert.notEqual(thread.more(), null);
      assert.equal(thread.more()?.getAttribute('aria-label'), 'More actions on your note');
      assert.equal(thread.menu()?.hidden, true);
    });
  }

  for (const stage of ['done', 'closed'] as const) {
    it(`is not offered on a note at ${stage}: the note is fixed`, () => {
      const thread = open(mounted(), anIssue({ stage }));
      assert.equal(thread.more(), null);
      assert.notEqual(closeOf(thread), null);
    });
  }

  it('is not offered to a reader who did not leave the note', () => {
    const thread = open(mounted(), anIssue({ mine: undefined }));
    assert.equal(thread.more(), null);
  });

  it('offers « Edit the note » only where the worker offers the edit', () => {
    const page = mounted();
    let thread = open(page, anIssue({ stage: 'new', editable: true }));
    thread.more()?.click();
    assert.deepEqual(thread.items(), ['Edit the note', 'Copy link to the note']);
    overlay?.destroy();

    thread = open(page, anIssue({ stage: 'todo' }));
    thread.more()?.click();
    assert.deepEqual(thread.items(), ['Copy link to the note']);
  });

  it('opens the field of the edit from « Edit the note »', () => {
    const page = mounted();
    const thread = open(page, anIssue({ stage: 'new', editable: true }));
    thread.more()?.click();
    assert.equal(thread.menu()?.hidden, false);
    assert.equal(thread.more()?.getAttribute('aria-expanded'), 'true');
    thread.item('Edit the note')?.click();
    const field = page.document.querySelector<HTMLTextAreaElement>('.fruitback-thread-edit-field');
    assert.equal(field?.value, 'The price is wrong');
    assert.equal(page.document.activeElement, field);
  });

  it('copies the link that opens the note on its page, and says so', async () => {
    const page = mounted();
    const copied: string[] = [];
    withClipboard(page, async (text) => {
      copied.push(text);
    });
    const issue = anIssue();
    const thread = open(page, issue);
    thread.more()?.click();
    thread.item('Copy link to the note')?.click();
    await settle();
    assert.equal(copied.length, 1);
    assert.equal(copied[0], noteLink(issue.note.page.url, issue.note.id));
    assert.equal(linkedNote(new URL(copied[0] ?? '').hash), issue.note.id);
    assert.equal(thread.said(), 'Link copied.');
    assert.equal(thread.linkField(), null);
    // The thread stays open, the focus back on « ⋯ ».
    assert.notEqual(thread.thread(), null);
    assert.equal(thread.more()?.getAttribute('aria-expanded'), 'false');
  });

  it('shows the link to copy by hand when the clipboard refuses', async () => {
    const page = mounted();
    withClipboard(page, () => Promise.reject(new Error('denied')));
    const issue = anIssue();
    const thread = open(page, issue);
    thread.more()?.click();
    thread.item('Copy link to the note')?.click();
    await settle();
    assert.equal(thread.said(), 'The link could not be copied. Select it, then copy it.');
    assert.equal(thread.linkField()?.value, noteLink(issue.note.page.url, issue.note.id));
    assert.equal(thread.linkField()?.readOnly, true);
  });

  it('closes the menu on Escape and keeps the thread open', () => {
    const page = mounted();
    const thread = open(page, anIssue({ stage: 'new', editable: true }));
    thread.more()?.click();
    const first = thread.item('Edit the note');
    assert.equal(page.document.activeElement, first);
    first?.dispatchEvent(
      new (page.view as unknown as typeof globalThis).KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
    assert.equal(page.document.activeElement, thread.item('Copy link to the note'));
    first?.dispatchEvent(
      new (page.view as unknown as typeof globalThis).KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    assert.equal(thread.menu()?.hidden, true);
    assert.notEqual(thread.thread(), null);
    assert.equal(page.document.activeElement, thread.more());
  });
});

describe('noteLink (FRU-605)', () => {
  it('puts the id after the fragment of the site, as linkedNote reads it', () => {
    assert.equal(noteLink('https://a.test/p', 'sd_1'), 'https://a.test/p#fruitback-note=sd_1');
    assert.equal(noteLink('https://a.test/p#', 'sd_1'), 'https://a.test/p#fruitback-note=sd_1');
    assert.equal(noteLink('https://a.test/p#top', 'sd 1'), 'https://a.test/p#top&fruitback-note=sd%201');
    assert.equal(linkedNote('#top&fruitback-note=sd%201'), 'sd 1');
  });
});

function closeOf(thread: ReturnType<typeof open>): Element | null {
  return thread.thread()?.querySelector('.fruitback-thread-close') ?? null;
}
