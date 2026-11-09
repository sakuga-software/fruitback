import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { NoteIssue } from '@fruitback/shared';
import { noteFixture, noteIssueFixture } from '@fruitback/shared/note.fixture';
import { type EditSeam, type Overlay, createOverlay } from './overlay.ts';
import { linkedNote } from './page.ts';
import { type WithdrawAnswer, type WithdrawFailure, type WithdrawSeam, noteLink } from './thread-more.ts';
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

function open(
  page: MountedPage,
  issue: NoteIssue,
  withdraw?: WithdrawSeam,
  move?: (issue: NoteIssue) => Promise<boolean | undefined>,
) {
  overlay = createOverlay({
    document: page.document,
    edit: neverSent,
    ...(withdraw === undefined ? {} : { withdraw }),
    ...(move === undefined ? {} : { move }),
  });
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

  it('closes the menu, not the thread, on Escape with the focus on « ⋯ » (review of #863)', () => {
    const page = mounted();
    const thread = open(page, anIssue());
    const keyOf = (key: string) =>
      new (page.view as unknown as typeof globalThis).KeyboardEvent('keydown', { key, bubbles: true, composed: true });
    thread.more()?.click();
    thread.more()?.focus();
    assert.equal(thread.menu()?.hidden, false);
    thread.more()?.dispatchEvent(keyOf('Escape'));
    assert.equal(thread.menu()?.hidden, true);
    assert.notEqual(thread.thread(), null);
    // The menu closed, the next Escape is the thread's.
    thread.more()?.dispatchEvent(keyOf('Escape'));
    assert.equal(thread.thread(), null);
  });

  it('gives the focus back to « ⋯ » at once, while the clipboard has not answered (review of #863)', async () => {
    const page = mounted();
    let answer: () => void = () => {};
    withClipboard(page, () => new Promise<void>((resolve) => (answer = resolve)));
    const thread = open(page, anIssue());
    thread.more()?.click();
    thread.item('Copy link to the note')?.click();
    assert.equal(thread.menu()?.hidden, true);
    assert.equal(page.document.activeElement, thread.more());
    await settle();
    // Still asked: the thread says nothing yet, and the focus stays on « ⋯ ».
    assert.equal(thread.said(), null);
    assert.equal(page.document.activeElement, thread.more());
    answer();
    await settle();
    assert.equal(thread.said(), 'Link copied.');
    assert.equal(page.document.activeElement, thread.more());
  });
});

describe('the withdrawal of a note by its author, from « ⋯ » (FRU-605)', () => {
  /** A seam whose answers a case gives one at a time. */
  function answered() {
    const pending: ((answer: WithdrawAnswer | WithdrawFailure) => void)[] = [];
    const sent: string[] = [];
    const seam: WithdrawSeam = {
      send: (issue) => {
        sent.push(issue.id);

        return new Promise((resolve) => pending.push(resolve));
      },
    };

    return { seam, sent, answer: (value: WithdrawAnswer | WithdrawFailure) => pending.shift()?.(value) };
  }
  const q = (page: MountedPage, selector: string) => page.document.querySelector<HTMLElement>(selector);

  it('is offered where the read says `withdrawable`, and asks before it goes', () => {
    const page = mounted();
    const { seam, sent } = answered();
    let thread = open(page, anIssue({ withdrawable: true }), seam);
    thread.more()?.click();
    assert.deepEqual(thread.items(), ['Copy link to the note', 'Withdraw the note']);
    overlay?.destroy();

    thread = open(page, anIssue(), seam);
    thread.more()?.click();
    assert.deepEqual(thread.items(), ['Copy link to the note']);
    overlay?.destroy();

    thread = open(page, anIssue({ withdrawable: true }), seam);
    thread.more()?.click();
    thread.item('Withdraw the note')?.click();
    assert.equal(
      q(page, '.fruitback-thread-withdraw-ask')?.textContent,
      'Withdraw this note? The team will see it closed. Nothing is deleted.',
    );
    assert.equal(page.document.activeElement, q(page, '.fruitback-thread-withdraw-confirm'));
    assert.deepEqual(sent, []);
    // « Keep it »: nothing goes, and the focus goes back to « ⋯ ».
    q(page, '.fruitback-thread-withdraw-keep')?.click();
    assert.equal(q(page, '.fruitback-thread-withdraw'), null);
    assert.equal(page.document.activeElement, thread.more());
    assert.deepEqual(sent, []);
  });

  it('closes the note once the store kept it, keeps the thread open, and says so', async () => {
    const page = mounted();
    const { seam, sent, answer } = answered();
    const issue = anIssue({ withdrawable: true, editable: true });
    const thread = open(page, issue, seam);
    thread.more()?.click();
    thread.item('Withdraw the note')?.click();
    q(page, '.fruitback-thread-withdraw-confirm')?.click();
    assert.deepEqual(sent, [issue.id]);
    assert.equal(q(page, '.fruitback-thread-withdraw-confirm')?.textContent, 'Withdrawing…');
    assert.equal((q(page, '.fruitback-thread-withdraw-confirm') as HTMLButtonElement | null)?.disabled, true);

    answer({
      stage: 'closed',
      comment: {
        id: 'c9',
        body: '**Bob** via Fruitback · member of Acme\nWithdrew the note',
        createdAt: '2026-11-08T10:00:00.000Z',
      },
    });
    await settle();

    assert.notEqual(thread.thread(), null);
    assert.equal(q(page, '.fruitback-thread-withdraw-said')?.textContent, 'Withdrawn. The note is closed.');
    assert.equal(page.document.activeElement, q(page, '.fruitback-thread-withdraw-said'));
    // Closed: the author has no menu any more, and the reply reads in the words of the reader.
    assert.equal(thread.more(), null);
    assert.ok((thread.thread()?.textContent ?? '').includes('Withdrew the note'));
    assert.ok(!(thread.thread()?.textContent ?? '').includes('**Bob**'));
    assert.equal(page.document.querySelector('[data-fruitback-pin]')?.getAttribute('data-fruitback-stage'), 'closed');
  });

  it('says why when it did not go, and asks again', async () => {
    const page = mounted();
    const { seam, answer } = answered();
    const thread = open(page, anIssue({ withdrawable: true }), seam);
    thread.more()?.click();
    thread.item('Withdraw the note')?.click();
    for (const [failure, words] of [
      ['retry', 'Not withdrawn. Try again.'],
      ['wait', 'Too many requests just now. Try again in a minute.'],
      ['signed-out', 'Your session has ended. Sign in again, then try again.'],
      ['refused', 'This note can no longer be withdrawn: the team marked it done or closed it.'],
    ] as const) {
      q(page, '.fruitback-thread-withdraw-confirm')?.click();
      answer(failure);
      await settle();
      assert.equal(q(page, '.fruitback-thread-withdraw-status')?.textContent, words, failure);
      assert.notEqual(q(page, '.fruitback-thread-withdraw-confirm'), null);
    }
  });
});

describe('the move of a note by its author, from « ⋯ » (FRU-605)', () => {
  it('is offered where the read says `editable`, closes the thread for the choice, and opens it again', async () => {
    const page = mounted();
    let answer: (moved: boolean | undefined) => void = () => {};
    const asked: string[] = [];
    const move = (issue: NoteIssue) => {
      asked.push(issue.id);

      return new Promise<boolean | undefined>((resolve) => (answer = resolve));
    };
    let thread = open(page, anIssue(), undefined, move);
    thread.more()?.click();
    assert.deepEqual(thread.items(), ['Copy link to the note']);
    overlay?.destroy();

    const issue = anIssue({ editable: true });
    thread = open(page, issue, undefined, move);
    thread.more()?.click();
    assert.deepEqual(thread.items(), ['Edit the note', 'Copy link to the note', 'Move the note']);
    thread.item('Move the note')?.click();
    assert.deepEqual(asked, [issue.id]);
    assert.equal(thread.thread(), null);

    answer(true);
    await settle();
    assert.notEqual(thread.thread(), null);
    assert.equal(thread.said(), 'Moved.');
  });

  it('says it did not move, and says nothing when the choice was given up', async () => {
    const page = mounted();
    const answers: ((moved: boolean | undefined) => void)[] = [];
    const move = () => new Promise<boolean | undefined>((resolve) => answers.push(resolve));
    const thread = open(page, anIssue({ editable: true }), undefined, move);
    thread.more()?.click();
    thread.item('Move the note')?.click();
    answers.shift()?.(false);
    await settle();
    assert.equal(thread.said(), 'Not moved. Try again.');

    thread.more()?.click();
    thread.item('Move the note')?.click();
    answers.shift()?.(undefined);
    await settle();
    assert.equal(thread.thread(), null);
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
