import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { NoteIssue } from '@fruitback/shared';
import { noteFixture, noteIssueFixture } from '@fruitback/shared/note.fixture';
import { type EditAnswer, type EditFailure, type EditSeam, type Overlay, createOverlay } from './overlay.ts';
import { type MountedPage, mountPage, setDocumentSize, setRect } from './dom.fixture.ts';

/**
 * The edit of a note by its author, in its thread (FRU-475). What a person typed is never lost: not on
 * a failure, not when the worker refuses, not when the thread is built again under it.
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
    editable: true,
    note: noteFixture({
      text: 'The price is wrong',
      reporter: { name: 'Camille' },
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

/** A seam whose answers a case gives one at a time. */
function answered() {
  const pending: ((answer: EditAnswer | EditFailure) => void)[] = [];
  const sent: { issue: string; text: string }[] = [];
  const seam: EditSeam = {
    send: (issue, text) => {
      sent.push({ issue: issue.id, text });

      return new Promise((resolve) => pending.push(resolve));
    },
  };

  return { seam, sent, answer: (value: EditAnswer | EditFailure) => pending.shift()?.(value) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function open(page: MountedPage, issue: NoteIssue, seam?: EditSeam, isDraft?: (issue: NoteIssue) => boolean) {
  overlay = createOverlay({
    document: page.document,
    ...(seam === undefined ? {} : { edit: seam }),
    ...(isDraft === undefined ? {} : { isDraft }),
  });
  overlay.render([issue]);
  (page.document.querySelector('.fruitback-pin-badge') as HTMLElement).click();
  const q = <T extends Element>(selector: string) => page.document.querySelector(selector) as T | null;

  return {
    edit: () => q<HTMLButtonElement>('.fruitback-thread-edit'),
    field: () => q<HTMLTextAreaElement>('.fruitback-thread-edit-field'),
    save: () => q<HTMLButtonElement>('.fruitback-thread-edit-save'),
    cancel: () => q<HTMLButtonElement>('.fruitback-thread-edit-cancel'),
    status: () => q('.fruitback-thread-edit-status')?.textContent ?? '',
    text: () => q('.fruitback-thread-note')?.textContent ?? null,
    submit: () => q<HTMLFormElement>('.fruitback-thread-edit-form')?.requestSubmit(),
  };
}

function type(field: HTMLTextAreaElement, text: string): void {
  field.value = text;
  field.dispatchEvent(new field.ownerDocument.defaultView!.Event('input', { bubbles: true }));
}

describe('the edit of a note in its thread (FRU-475)', () => {
  it('is offered on a note the read says is editable, and nowhere else', () => {
    for (const [issue, seam, isDraft, offered] of [
      [anIssue(), answered().seam, undefined, true],
      [anIssue({ editable: undefined }), answered().seam, undefined, false],
      [anIssue(), undefined, undefined, false],
      [anIssue(), answered().seam, () => true, false],
    ] as const) {
      const page = mounted();
      const thread = open(page, issue, seam, isDraft);

      assert.equal(thread.edit() !== null, offered);
      if (offered) assert.equal(thread.edit()?.getAttribute('aria-label'), 'Edit your note');
      overlay?.destroy();
    }
  });

  it('opens the text in a field with focus, and « Cancel » gives the note back as it was', () => {
    const page = mounted();
    const thread = open(page, anIssue(), answered().seam);

    thread.edit()?.click();
    assert.equal(thread.field()?.value, 'The price is wrong');
    assert.equal(thread.text(), null);
    assert.equal(page.document.activeElement, thread.field());
    type(thread.field() as HTMLTextAreaElement, 'Something else');

    thread.cancel()?.click();
    assert.equal(thread.field(), null);
    assert.equal(thread.text(), 'The price is wrong');
    // Opened again, the field starts from the note: « Cancel » dropped what was typed.
    thread.edit()?.click();
    assert.equal(thread.field()?.value, 'The price is wrong');
  });

  it('keeps the text and says why on each failure, then shows the note as the store kept it', async () => {
    const page = mounted();
    const issue = anIssue();
    const { seam, sent, answer } = answered();
    const thread = open(page, issue, seam);
    thread.edit()?.click();
    type(thread.field() as HTMLTextAreaElement, 'The price of the Pro plan is wrong');

    for (const [failure, words] of [
      ['wait', /Too many requests/],
      ['signed-out', /session has ended/],
      ['retry', /Not saved/],
      ['refused', /can no longer be edited/],
    ] as const) {
      thread.submit();
      assert.equal(thread.save()?.disabled, true);
      assert.equal(thread.status(), 'Saving…');
      answer(failure);
      await settle();
      assert.equal(thread.field()?.value, 'The price of the Pro plan is wrong', failure);
      assert.match(thread.status(), words);
    }

    thread.submit();
    answer({
      note: { ...issue.note, text: 'The price of the Pro plan is wrong' },
      comment: { id: 'c9', body: 'Edited the note', createdAt: '2026-10-28T10:00:00.000Z' },
    });
    await settle();
    assert.equal(thread.field(), null);
    assert.equal(thread.text(), 'The price of the Pro plan is wrong');
    // The reply that says it was edited is in the thread at once, with no read.
    assert.deepEqual(
      [...page.document.querySelectorAll('.fruitback-thread-reply-body')].map((each) => each.textContent),
      ['Edited the note'],
    );
    assert.equal(thread.status(), 'Saved');
    assert.equal(sent.length, 5);
    assert.ok(sent.every((each) => each.text === 'The price of the Pro plan is wrong'));
  });

  it('sends nothing for an empty text, nor for the text the note has already', async () => {
    const page = mounted();
    const { seam, sent } = answered();
    const thread = open(page, anIssue(), seam);
    thread.edit()?.click();

    type(thread.field() as HTMLTextAreaElement, '   ');
    thread.submit();
    assert.equal(thread.field()?.value, '   ');
    type(thread.field() as HTMLTextAreaElement, 'The price is wrong ');
    thread.submit();
    await settle();

    assert.deepEqual(sent, []);
    assert.equal(thread.text(), 'The price is wrong');
  });

  it('keeps the text typed when the thread is built again under it', () => {
    const page = mounted();
    const issue = anIssue();
    const thread = open(page, issue, answered().seam);
    thread.edit()?.click();
    type(thread.field() as HTMLTextAreaElement, 'Half way');

    // A read draws the notes again, and the thread with them.
    overlay?.render([issue]);
    (page.document.querySelector('.fruitback-pin-badge') as HTMLElement).click();

    assert.equal(thread.field()?.value, 'Half way');
  });
});
