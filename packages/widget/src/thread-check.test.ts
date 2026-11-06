import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { NoteComment, NoteIssue } from '@fruitback/shared';
import { noteFixture, noteIssueFixture } from '@fruitback/shared/note.fixture';
import {
  type CheckAnswer,
  type CheckFailure,
  type CheckSeam,
  type Overlay,
  type ReplySeam,
  applyCheck,
  checkOffered,
  createOverlay,
  doneByOf,
  verdictFromPage,
} from './overlay.ts';
import { createTranslator } from './messages.ts';
import { type MountedPage, mountPage, setDocumentSize, setRect } from './dom.fixture.ts';

/**
 * The verdict of the author in the thread of a note the team marked done (FRU-603): « Marc Petit
 * marked it done », the replies of the team, then « Does it look right to you? » with « Looks fixed »
 * and « Still wrong ». The worker decides who may (FRU-294): the thread asks the reader the read calls
 * the author (`mine`), and nobody else.
 */

const t = createTranslator({ locale: 'en' });
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

const TEAM_REPLY: NoteComment = {
  id: 'c1',
  body: 'Fixed in the last deploy: the price comes from the catalog now.',
  createdAt: '2026-11-05T10:00:00.000Z',
  author: 'Marc Petit',
};

function aDoneNote(overrides: Partial<NoteIssue> = {}): NoteIssue {
  return noteIssueFixture({
    stage: 'done',
    stateName: 'Done',
    comments: [TEAM_REPLY],
    mine: true,
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

/** The reply the worker writes for a verdict (`checkText` of the worker), then the stage it answers. */
function kept(verdict: 'fixed' | 'wrong', typed?: string): CheckAnswer {
  const words = verdict === 'fixed' ? 'Checked: looks fixed' : 'Reopened: still wrong';
  const quoted =
    typed === undefined
      ? ''
      : `\n\n${typed
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n')}`;

  return {
    comment: {
      id: `verdict-${verdict}`,
      body: `**Camille** via Fruitback · member of Acme\n${words}${quoted}`,
      createdAt: '2026-11-06T09:00:00.000Z',
      author: 'Camille',
    },
    stage: verdict === 'fixed' ? 'done' : 'new',
  };
}

/** A seam whose answers a case gives one at a time. */
function answered() {
  const pending: ((answer: CheckAnswer | CheckFailure) => void)[] = [];
  const sent: { issue: string; verdict: string; body: string | undefined }[] = [];
  const seam: CheckSeam = {
    send: (issue, verdict, body) => {
      sent.push({ issue: issue.id, verdict, body });

      return new Promise((resolve) => pending.push(resolve));
    },
  };

  return { seam, sent, answer: (value: CheckAnswer | CheckFailure) => pending.shift()?.(value) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Types in a field as a person does: the value, then the event its page sends. */
function type(field: HTMLTextAreaElement | null, text: string): void {
  if (field === null) throw new Error('no field');
  field.value = text;
  field.dispatchEvent(new field.ownerDocument.defaultView!.Event('input', { bubbles: true }));
}

function press(field: HTMLTextAreaElement, init: { key: string; shiftKey?: boolean }): void {
  field.dispatchEvent(new field.ownerDocument.defaultView!.KeyboardEvent('keydown', { ...init, bubbles: true }));
}

const REPLY: ReplySeam = { allowed: () => true, send: async () => 'retry' };

function open(page: MountedPage, issue: NoteIssue, seam?: CheckSeam, isDraft?: (issue: NoteIssue) => boolean) {
  overlay = createOverlay({
    document: page.document,
    reply: REPLY,
    ...(seam === undefined ? {} : { check: seam }),
    ...(isDraft === undefined ? {} : { isDraft }),
  });
  overlay.render([issue]);
  (page.document.querySelector('.fruitback-pin-badge') as HTMLElement).click();
  const q = <T extends Element>(selector: string) => page.document.querySelector(selector) as T | null;

  return {
    done: () => q('.fruitback-thread-done')?.textContent ?? null,
    block: () => q('.fruitback-thread-check'),
    ask: () => q('.fruitback-thread-check-ask')?.textContent ?? null,
    fixed: () => q<HTMLButtonElement>('.fruitback-thread-check-fixed'),
    wrong: () => q<HTMLButtonElement>('.fruitback-thread-check-wrong'),
    field: () => q<HTMLTextAreaElement>('.fruitback-thread-check-field'),
    send: () => q<HTMLButtonElement>('.fruitback-thread-check-send'),
    cancel: () => q<HTMLButtonElement>('.fruitback-thread-check-cancel'),
    status: () => q('.fruitback-thread-check-status')?.textContent ?? '',
    said: () => q('.fruitback-thread-check-said')?.textContent ?? null,
    replyForm: () => q('.fruitback-thread-reply-form'),
    replies: () => [...page.document.querySelectorAll('.fruitback-thread-reply-body')].map((each) => each.textContent),
    thread: () => q('.fruitback-thread'),
    pinStage: () => q<HTMLElement>('[data-fruitback-pin]')?.dataset.fruitbackStage,
    active: () => page.document.activeElement,
  };
}

describe('who is asked for a verdict (FRU-603)', () => {
  it('asks the author of a note done and not confirmed yet', () => {
    assert.equal(checkOffered(aDoneNote()), true);
  });

  it('asks nobody else: not mine, not done, or confirmed already', () => {
    const { mine: _mine, ...notMine } = aDoneNote();
    assert.equal(checkOffered(noteIssueFixture(notMine)), false);
    assert.equal(checkOffered(aDoneNote({ stage: 'closed' })), false);
    assert.equal(checkOffered(aDoneNote({ stage: 'progress' })), false);
    assert.equal(checkOffered(aDoneNote({ checked: { by: 'Camille', at: '2026-11-06T09:00:00.000Z' } })), false);
  });

  it('draws the question and its two buttons for the author, under the replies, in place of the field to reply', () => {
    const view = open(mounted(), aDoneNote(), answered().seam);

    assert.equal(view.done(), 'Marc Petit marked it done');
    assert.equal(view.ask(), 'Does it look right to you?');
    assert.equal(view.fixed()?.textContent, 'Looks fixed');
    assert.equal(view.wrong()?.textContent, 'Still wrong');
    assert.equal(view.wrong()?.getAttribute('aria-expanded'), 'false');
    // The two buttons are named by the question, for a screen reader.
    const group = view.fixed()?.parentElement;
    assert.equal(group?.getAttribute('role'), 'group');
    assert.equal(group?.getAttribute('aria-labelledby'), view.block()?.querySelector('p')?.id);
    // In the order of the ticket: the line of who marked it done, the replies, then the question.
    const order = [...(view.thread()?.children ?? [])].map((child) => child.className);
    assert.deepEqual(order.slice(-3), ['fruitback-thread-done', 'fruitback-thread-answers', 'fruitback-thread-check']);
    assert.equal(view.replyForm(), null);
  });

  it('shows a reader who is not the author that it is done, and asks them nothing', () => {
    const { mine: _mine, ...notMine } = aDoneNote();
    const view = open(mounted(), noteIssueFixture(notMine), answered().seam);

    assert.equal(view.done(), 'Marc Petit marked it done');
    assert.equal(view.block(), null);
    // The control: the field to reply is there, as for any note.
    assert.notEqual(view.replyForm(), null);
  });

  it('asks nothing when the host gives no way to send a verdict, or under a note kept for later', () => {
    assert.equal(open(mounted(), aDoneNote()).block(), null);
    overlay?.destroy();
    assert.equal(open(mounted(), aDoneNote(), answered().seam, () => true).block(), null);
  });

  it('says « Marked done » when no reply of the team names who did it', () => {
    const fromPage: NoteComment = {
      id: 'c2',
      body: '**Camille** via Fruitback · not verified\n\n> Any news?',
      createdAt: '2026-11-05T11:00:00.000Z',
      author: 'Fruitback',
    };
    assert.equal(doneByOf(aDoneNote({ comments: [fromPage] }), t), undefined);
    assert.equal(open(mounted(), aDoneNote({ comments: [] }), answered().seam).done(), 'Marked done');
    // The newest reply of the team wins over an older one and over one from the page.
    const older: NoteComment = { ...TEAM_REPLY, id: 'c0', author: 'Léa', createdAt: '2026-11-01T10:00:00.000Z' };
    assert.equal(doneByOf(aDoneNote({ comments: [older, TEAM_REPLY, fromPage] }), t), 'Marc Petit');
  });
});

describe('« Looks fixed » (FRU-603)', () => {
  it('sends the verdict alone, waits, then says it and confirms the note', async () => {
    const issue = aDoneNote();
    const { seam, sent, answer } = answered();
    const view = open(mounted(), issue, seam);

    view.fixed()?.click();
    assert.deepEqual(sent, [{ issue: issue.id, verdict: 'fixed', body: undefined }]);
    // While it is on its way: both buttons wait, and the one pressed says so.
    assert.equal(view.fixed()?.textContent, 'Sending…');
    assert.equal(view.fixed()?.disabled, true);
    assert.equal(view.wrong()?.disabled, true);
    view.fixed()?.click();
    assert.equal(sent.length, 1, 'a second press sends nothing');

    answer(kept('fixed'));
    await settle();
    assert.equal(view.block(), null);
    assert.equal(view.said(), 'Thank you. The team knows it looks fixed.');
    assert.equal(view.thread()?.querySelector('.fruitback-thread-check-said')?.getAttribute('role'), 'status');
    assert.deepEqual(issue.checked, { by: 'Camille', at: '2026-11-06T09:00:00.000Z' });
    // The reply of the verdict, in the words of the reader, and no line « marked it done » any more.
    assert.deepEqual(view.replies().at(-1), 'Checked: looks fixed');
    assert.equal(view.done(), null);
    // The field to reply is back: the note is confirmed, a reply is a reply again.
    assert.notEqual(view.replyForm(), null);
  });

  it('keeps the question and says why when the verdict did not go', async () => {
    const { seam, answer } = answered();
    const view = open(mounted(), aDoneNote(), seam);

    view.fixed()?.click();
    answer('retry');
    await settle();
    assert.equal(view.status(), 'Not sent. Your text is still here. Try again.');
    assert.equal(view.fixed()?.disabled, false);

    view.fixed()?.click();
    answer('refused');
    await settle();
    assert.equal(
      view.status(),
      'Fruitback did not take this answer: the note may have moved. Reload the page to see where it is.',
    );
  });
});

describe('« Still wrong » (FRU-603)', () => {
  it('opens the field that says what is missing, and sends it with the verdict', async () => {
    const issue = aDoneNote();
    const { seam, sent, answer } = answered();
    const view = open(mounted(), issue, seam);

    view.wrong()?.click();
    assert.equal(view.wrong()?.getAttribute('aria-expanded'), 'true');
    assert.equal(view.active(), view.field());
    assert.equal(view.field()?.getAttribute('aria-label'), 'What is still wrong?');
    assert.equal(view.send()?.getAttribute('aria-label'), 'Send: still wrong');

    type(view.field(), 'The price is still 12 € on the card.');
    view.send()?.click();
    assert.deepEqual(sent, [{ issue: issue.id, verdict: 'wrong', body: 'The price is still 12 € on the card.' }]);
    assert.equal(view.field()?.readOnly, true);
    assert.equal(view.status(), 'Sending…');

    answer(kept('wrong', 'The price is still 12 € on the card.'));
    await settle();
    // The note is open again: its pin takes its stage, and its thread stays open with the answer.
    assert.equal(issue.stage, 'new');
    assert.equal(view.pinStage(), 'new');
    assert.notEqual(view.thread(), null);
    assert.equal(view.block(), null);
    assert.equal(view.said(), 'Sent. The note is open again.');
    assert.equal(view.replies().at(-1), 'Reopened: still wrong\nThe price is still 12 € on the card.');
  });

  it('sends no text when none was typed', () => {
    const { seam, sent } = answered();
    const view = open(mounted(), aDoneNote(), seam);
    view.wrong()?.click();
    view.send()?.click();

    assert.deepEqual(
      sent.map((each) => each.body),
      [undefined],
    );
  });

  it('keeps what was typed through a failure, a thread built again, and « Cancel »', async () => {
    const issue = aDoneNote();
    const { seam, answer } = answered();
    const page = mounted();
    const view = open(page, issue, seam);

    view.wrong()?.click();
    const typed = 'Still 12 €';
    type(view.field(), typed);
    view.send()?.click();
    answer('signed-out');
    await settle();
    assert.equal(view.field()?.value, typed);
    assert.equal(view.status(), 'Your session has ended. Your text is still here. Sign in again, then send it.');

    // « Cancel » closes the field and gives the focus back to « Still wrong »; pressed again, the text is there.
    view.cancel()?.click();
    assert.equal(view.field(), null);
    assert.equal(view.active(), view.wrong());
    view.wrong()?.click();
    assert.equal(view.field()?.value, typed);

    // A render draws the thread again: the text stays.
    overlay?.render([issue]);
    (page.document.querySelector('.fruitback-pin-badge') as HTMLElement).click();
    assert.equal(view.field()?.value, typed);
  });

  it('sends on Enter, and goes to the next line with Shift and Enter', () => {
    const { seam, sent } = answered();
    const view = open(mounted(), aDoneNote(), seam);
    view.wrong()?.click();
    const field = view.field() as HTMLTextAreaElement;

    press(field, { key: 'Enter', shiftKey: true });
    assert.equal(sent.length, 0);
    press(field, { key: 'Enter' });
    assert.equal(sent.length, 1);
  });
});

describe('the replies of a verdict, and what a verdict changes on the issue (FRU-603)', () => {
  it('reads the reply of a verdict in the words of the reader, in either language of the team', () => {
    assert.deepEqual(verdictFromPage(kept('fixed').comment.body, t), {
      name: 'Camille',
      who: 'member of Acme',
      text: 'Checked: looks fixed',
      verdict: 'fixed',
    });
    assert.equal(
      verdictFromPage('**Camille** via Fruitback · membre de Acme\nRouvert : toujours faux\n\n> Toujours 12 €', t)
        ?.text,
      'Reopened: still wrong\nToujours 12 €',
    );
    assert.equal(verdictFromPage('**Camille** via Fruitback · not verified\n\n> Any news?', t), undefined);
    assert.equal(verdictFromPage('Checked: looks fixed', t), undefined);
  });

  it('puts the reply under the note, the stage the store answered, and the word of the stage until a read', () => {
    const issue = aDoneNote();
    applyCheck(issue, 'wrong', kept('wrong'));
    assert.equal(issue.stage, 'new');
    assert.equal(issue.stateName, '');
    assert.equal(issue.checked, undefined);
    assert.deepEqual(
      issue.comments?.map((each) => each.id),
      ['c1', 'verdict-wrong'],
    );
    // Applied twice (a read drew the note again meanwhile), the reply is there once.
    applyCheck(issue, 'wrong', kept('wrong'));
    assert.equal(issue.comments?.length, 2);
  });

  it('adds no reply to a reader whose read holds none', () => {
    const { comments: _comments, ...withoutReplies } = aDoneNote();
    const issue = noteIssueFixture(withoutReplies);
    applyCheck(issue, 'fixed', kept('fixed'));
    assert.equal(issue.comments, undefined);
    assert.equal(issue.checked?.by, 'Camille');
  });
});
