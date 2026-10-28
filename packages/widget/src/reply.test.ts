import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { NoteComment, NoteIssue } from '@fruitback/shared';
import { noteFixture, noteIssueFixture } from '@fruitback/shared/note.fixture';
import { type Overlay, type ReplyFailure, type ReplySeam, createOverlay } from './overlay.ts';
import { type MountedPage, keyboardEventCtor, mountPage, setDocumentSize, setRect } from './dom.fixture.ts';

/**
 * The field at the foot of a thread (FRU-257). What a person typed is never lost: not on a failure,
 * not when the thread is built again under it.
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
    note: noteFixture({
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
function answered(allowed = true) {
  const pending: ((answer: NoteComment | ReplyFailure) => void)[] = [];
  const sent: { issue: string; body: string }[] = [];
  const seam: ReplySeam = {
    allowed: () => allowed,
    send: (issue, body) => {
      sent.push({ issue: issue.id, body });

      return new Promise((resolve) => pending.push(resolve));
    },
  };

  return { seam, sent, answer: (value: NoteComment | ReplyFailure) => pending.shift()?.(value) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function open(page: MountedPage, issue: NoteIssue, seam?: ReplySeam, isDraft?: (issue: NoteIssue) => boolean) {
  overlay = createOverlay({
    document: page.document,
    ...(seam === undefined ? {} : { reply: seam }),
    ...(isDraft === undefined ? {} : { isDraft }),
  });
  overlay.render([issue]);
  (page.document.querySelector('.fruitback-pin-badge') as HTMLElement).click();

  return {
    field: () => page.document.querySelector('.fruitback-thread-reply-field') as HTMLTextAreaElement | null,
    status: () => page.document.querySelector('.fruitback-thread-reply-status')?.textContent ?? '',
    submit: () => (page.document.querySelector('.fruitback-thread-reply-form') as HTMLFormElement).requestSubmit(),
    replies: () =>
      [...page.document.querySelectorAll('.fruitback-thread-reply-body')].map((each) => each.textContent ?? ''),
  };
}

function type(field: HTMLTextAreaElement, text: string): void {
  field.value = text;
  field.dispatchEvent(new field.ownerDocument.defaultView!.Event('input', { bubbles: true }));
}

describe('the field to reply to a note (FRU-257)', () => {
  it('is there when the worker lets the reader reply, and names the author of the note', () => {
    const page = mounted();
    const thread = open(page, anIssue(), answered().seam);

    assert.equal(thread.field()?.placeholder, 'Reply to Camille');
    assert.equal(thread.field()?.getAttribute('aria-label'), 'Reply');
    assert.equal(page.document.querySelector('.fruitback-thread-reply-send')?.getAttribute('aria-label'), 'Send reply');
  });

  it('is not there with no seam, when the worker says no, or under a note kept for later', () => {
    for (const [seam, isDraft] of [
      [undefined, undefined],
      [answered(false).seam, undefined],
      [answered().seam, () => true],
    ] as const) {
      const page = mounted();
      const thread = open(page, anIssue(), seam, isDraft);

      assert.ok(thread.field() === null, 'a field is there');
      overlay?.destroy();
    }
  });

  it('keeps the text and says why on each failure, then shows the reply and empties the field', async () => {
    const page = mounted();
    const { seam, sent, answer } = answered();
    const thread = open(page, anIssue(), seam);
    // Read again at each step: the end of a reply builds the thread again.
    const field = () => thread.field() as HTMLTextAreaElement;
    type(field(), 'Same on the phone.');

    for (const [failure, words] of [
      ['wait', /Too many replies/],
      ['signed-out', /session has ended/],
      ['retry', /Did not go through/],
    ] as const) {
      thread.submit();
      assert.equal(thread.status(), 'Sending…');
      assert.equal(field().readOnly, true);
      answer(failure);
      await settle();
      assert.equal(field().value, 'Same on the phone.', failure);
      assert.equal(field().readOnly, false);
      assert.match(thread.status(), words);
    }

    thread.submit();
    answer({
      id: 'c1',
      body: '**Bob** via Fruitback · not verified\n\n> Same on the phone.',
      createdAt: new Date().toISOString(),
    });
    await settle();

    assert.equal(field().value, '');
    assert.equal(thread.status(), 'Sent');
    // As a reply, not as the text of the tracker: the name is the author, and the quote is the text.
    assert.deepEqual(thread.replies(), ['Same on the phone.']);
    assert.match(
      page.document.querySelector('.fruitback-thread-reply-who')?.textContent ?? '',
      /^Bob · not verified · /,
    );
    assert.deepEqual(
      sent.map((each) => each.body),
      Array.from({ length: 4 }, () => 'Same on the phone.'),
    );
  });

  it('sends nothing twice while a reply is in flight, and nothing that is only spaces', async () => {
    const page = mounted();
    const { seam, sent, answer } = answered();
    const thread = open(page, anIssue(), seam);
    const field = thread.field() as HTMLTextAreaElement;

    type(field, '   ');
    thread.submit();
    assert.equal(sent.length, 0);

    type(field, 'Once.');
    thread.submit();
    thread.submit();
    assert.equal(sent.length, 1);
    answer('retry');
    await settle();
  });

  it('sends on Enter, and goes to the next line on Shift+Enter', () => {
    const page = mounted();
    const { seam, sent } = answered();
    const thread = open(page, anIssue(), seam);
    const field = thread.field() as HTMLTextAreaElement;
    type(field, 'Hello');
    const press = (shiftKey: boolean) =>
      field.dispatchEvent(
        new (keyboardEventCtor(page))('keydown', { key: 'Enter', shiftKey, bubbles: true, cancelable: true }),
      );

    assert.equal(press(true), true, 'Shift+Enter is left to the field');
    assert.equal(sent.length, 0);
    assert.equal(press(false), false);
    assert.equal(sent.length, 1);
  });

  it('keeps the text a person typed when the thread is built again under it', () => {
    const page = mounted();
    const issue = anIssue();
    const thread = open(page, issue, answered().seam);
    type(thread.field() as HTMLTextAreaElement, 'Half a sentence');

    // A read draws the notes again, and the thread with them.
    overlay?.render([issue]);
    (page.document.querySelector('.fruitback-pin-badge') as HTMLElement).click();

    assert.equal(thread.field()?.value, 'Half a sentence');
  });

  it('shows a reply from the page with its name and its text, and any other comment as it was written', () => {
    const page = mounted();
    const written = (body: string) => ({
      id: body.length.toString(),
      body,
      createdAt: new Date().toISOString(),
      author: 'Linear user',
    });
    open(
      page,
      anIssue({
        comments: [
          written('**Ana Martin** via Fruitback · member of Acme\n\n> On it.\n>\n> Tomorrow.'),
          // Not the shape the worker writes: shown as it is, under the name the tracker gives.
          written('**Ana Martin** via Fruitback · member of Acme\nNo quote.'),
        ],
      }),
    );

    const who = [...page.document.querySelectorAll('.fruitback-thread-reply-who')].map(
      (each) => each.textContent ?? '',
    );
    const bodies = [...page.document.querySelectorAll('.fruitback-thread-reply-body')].map(
      (each) => each.textContent ?? '',
    );
    assert.match(who[0] ?? '', /^Ana Martin · member of Acme · /);
    assert.equal(bodies[0], 'On it.\n\nTomorrow.');
    assert.match(who[1] ?? '', /^Linear user · /);
    assert.equal(bodies[1], '**Ana Martin** via Fruitback · member of Acme\nNo quote.');
  });

  it('says « Agent » beside the name of the key for a reply of an agent, and never for a member (FRU-465)', () => {
    const page = mounted();
    const at = new Date().toISOString();
    open(
      page,
      anIssue({
        comments: [
          { id: 'c1', body: '**Claude on CI** via Fruitback · agent\n\n> Fixed in #42.', createdAt: at, by: 'agent' },
          { id: 'c2', body: '**Ana Martin** via Fruitback · member of Acme\n\n> Thanks.', createdAt: at },
        ],
      }),
    );

    const who = [...page.document.querySelectorAll('.fruitback-thread-reply-who')].map(
      (each) => each.textContent ?? '',
    );
    assert.match(who[0] ?? '', /^Claude on CI · Agent · /);
    assert.match(who[1] ?? '', /^Ana Martin · member of Acme · /);
    assert.doesNotMatch(who[1] ?? '', /Agent/);
  });

  it('takes no second send while a reply is in flight under a thread built again, and shows it there', async () => {
    const page = mounted();
    const issue = anIssue();
    const { seam, sent, answer } = answered();
    const thread = open(page, issue, seam);
    type(thread.field() as HTMLTextAreaElement, 'Only once.');
    thread.submit();

    // The page changes under the thread while the reply is in flight: the thread is built again.
    overlay?.resolve();
    overlay?.render([issue]);
    (page.document.querySelector('.fruitback-pin-badge') as HTMLElement).click();
    assert.equal(thread.field()?.readOnly, true);
    assert.equal((page.document.querySelector('.fruitback-thread-reply-send') as HTMLButtonElement).disabled, true);
    thread.submit();
    assert.equal(sent.length, 1);

    answer({ id: 'c1', body: 'Only once.', createdAt: new Date().toISOString() });
    await settle();

    assert.deepEqual(thread.replies(), ['Only once.']);
    assert.equal(thread.field()?.value, '');
    assert.equal(thread.status(), 'Sent');
  });

  it('keeps the focus and the caret in the field when the page changes under the thread', () => {
    const page = mounted();
    const thread = open(page, anIssue(), answered().seam);
    const before = thread.field() as HTMLTextAreaElement;
    type(before, 'Half a sentence');
    before.focus();
    before.setSelectionRange(4, 9);

    // What a single page application does at any keystroke: the element is replaced.
    const button = page.query('button');
    button.replaceWith(button.cloneNode(true));
    overlay?.resolve();

    const after = thread.field() as HTMLTextAreaElement;
    assert.ok(after !== before, 'the thread was not built again; this case proves nothing');
    const active = page.document.activeElement?.shadowRoot?.activeElement ?? page.document.activeElement;
    assert.ok(active === after, 'the focus left the field');
    assert.deepEqual([after.selectionStart, after.selectionEnd, after.value], [4, 9, 'Half a sentence']);
  });
});
