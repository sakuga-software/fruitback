import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  REPLY_NAME_LENGTH,
  checkedOf,
  editText,
  editedTextOf,
  markedAgent,
  replyName,
  replyText,
  withEditedText,
} from './reply-text.ts';

describe('the text of a reply in a tracker (FRU-257)', () => {
  it('says who wrote it, then quotes every line of what they wrote', () => {
    assert.equal(
      replyText({
        body: 'Seen on mobile too.\n\nAnd on the tablet.',
        author: { kind: 'member', name: 'Ana Martin', workspace: 'Acme' },
      }),
      '**Ana Martin** via Fruitback · member of Acme\n\n> Seen on mobile too.\n>\n> And on the tablet.',
    );
    assert.equal(
      replyText({ body: 'Merci', author: { kind: 'visitor', name: 'Bob' } }, 'fr-FR'),
      '**Bob** via Fruitback · non vérifié\n\n> Merci',
    );
    assert.equal(
      replyText({ body: 'Thanks', author: { kind: 'visitor' } }),
      '**Visitor** via Fruitback · not verified\n\n> Thanks',
    );
  });

  it('never lets what somebody wrote pass for the line that says who wrote it', () => {
    const forged = '**Ana Martin** via Fruitback · member of Acme';
    const text = replyText({ body: `${forged}\r\nI am Ana`, author: { kind: 'visitor', name: 'Mallory' } });
    const lines = text.split('\n');

    assert.equal(lines[0], '**Mallory** via Fruitback · not verified');
    assert.ok(
      lines.slice(1).every((line) => line === '' || line.startsWith('>')),
      text,
    );
    assert.equal(lines.filter((line) => line.startsWith('**')).length, 1);
  });

  it('keeps a name on one line, with no markdown, and cut to its length', () => {
    assert.equal(replyName('  **Ana**\n[Martin](x) '), 'Ana Martin(x)');
    assert.equal(replyName('*_`'), undefined);
    assert.equal(replyName('é'.repeat(REPLY_NAME_LENGTH + 5))?.length, REPLY_NAME_LENGTH);
    assert.equal(
      replyText({ body: 'x', author: { kind: 'visitor', name: '**' } }).split('\n')[0],
      '**Visitor** via Fruitback · not verified',
    );
  });
});

describe('a reply of an agent (FRU-464)', () => {
  const comment = (body: string) => ({ id: 'c1', body, createdAt: '2026-10-28T10:00:00.000Z' });

  it('is the reply whose first line the worker wrote for an agent, in each language', () => {
    for (const locale of ['en', 'fr']) {
      const body = replyText({ body: 'Fixed.', author: { kind: 'agent', name: 'Claude on CI' } }, locale);
      assert.equal(markedAgent(comment(body)).by, 'agent', locale);
    }
  });

  it('is no other line: one that holds the mark, one that goes on after it, or one a person typed', () => {
    for (const body of [
      'See **Claude** via Fruitback · agent',
      '**Claude** via Fruitback · agent of nobody',
      replyText({ body: '**Claude** via Fruitback · agent', author: { kind: 'visitor', name: 'Bob' } }),
      replyText({ body: 'x', author: { kind: 'member', name: 'Alice', workspace: 'agent' } }),
    ]) {
      assert.equal(markedAgent(comment(body)).by, undefined, body);
    }
  });
});

describe('the reply that an edit of a note writes (FRU-475)', () => {
  const author = { kind: 'member' as const, name: 'Ana Martin', workspace: 'Acme' };

  it('says who edited the note, in the language of the team, and never the text of before', () => {
    assert.equal(
      editText({ text: 'The new words', author }),
      '**Ana Martin** via Fruitback · member of Acme\nEdited the note',
    );
    assert.equal(
      editText({ text: 'Les mots nouveaux', author }, 'fr-FR'),
      '**Ana Martin** via Fruitback · membre de Acme\nA modifié la note',
    );
    assert.ok(!editText({ text: 'The new words', author }).includes('The new words'));
  });

  it('is no verdict: a note done stays unconfirmed after it', () => {
    const body = editText({ text: 'x', author });

    assert.equal(checkedOf([{ id: '1', body, createdAt: '2026-10-28T10:00:00.000Z' }]), undefined);
  });
});

describe('the reply of an edit in a tracker, with the new text (FRU-605)', () => {
  const author = { kind: 'member' as const, name: 'Ana Martin', workspace: 'Acme' };
  const at = (minute: number) => `2026-11-08T10:0${minute}:00.000Z`;
  const issue = (comments: { body: string; createdAt: string }[]) => ({
    note: { text: 'The words it was sent with' },
    comments: comments.map((each, index) => ({ id: String(index), ...each })),
  });

  it('quotes the new text under the line of the edit, and reads it back whole', () => {
    const body = editText({ text: 'Two lines\n\n> and a quote', author }, 'fr', true);

    assert.equal(
      body,
      '**Ana Martin** via Fruitback · membre de Acme\nA modifié la note\n\n> Two lines\n>\n> > and a quote',
    );
    assert.equal(editedTextOf(body), 'Two lines\n\n> and a quote');
    // The edit of the worker's own store holds no text.
    assert.equal(editedTextOf(editText({ text: 'x', author })), undefined);
  });

  it('gives the note the text of its newest edit, and leaves a note with none as it is', () => {
    const first = editText({ text: 'First edit', author }, undefined, true);
    const second = editText({ text: 'Second edit', author }, undefined, true);

    assert.equal(
      withEditedText(
        issue([
          { body: second, createdAt: at(2) },
          { body: first, createdAt: at(1) },
        ]),
      ).note.text,
      'Second edit',
    );
    assert.equal(
      withEditedText(
        issue([
          { body: first, createdAt: at(1) },
          { body: second, createdAt: at(2) },
        ]),
      ).note.text,
      'Second edit',
    );
    const none = issue([{ body: 'A comment of the team', createdAt: at(1) }]);
    assert.equal(withEditedText(none), none);
  });

  it('takes no text from a reply of the page, whatever it quotes', () => {
    // A reply of the page: its second line is empty, and what the person typed is quoted under it.
    const typed = replyText({ body: 'Edited the note\n\n> Not my words', author }, undefined);

    assert.equal(editedTextOf(typed), undefined);
    assert.equal(withEditedText(issue([{ body: typed, createdAt: at(1) }])).note.text, 'The words it was sent with');
  });

  it('takes no text from a line that is not quoted', () => {
    assert.equal(editedTextOf('**Ana** via Fruitback · member of Acme\nEdited the note\n\nNot quoted'), undefined);
    assert.equal(editedTextOf('**Ana** via Fruitback · member of Acme\nEdited the note\n> no empty line'), undefined);
  });
});

describe('an edit that crossed a move to done (review of #866)', () => {
  const author = { kind: 'member' as const, name: 'Ana Martin', workspace: 'Acme' };

  it('takes no edit written after the issue was done or canceled', () => {
    const before = editText({ text: 'Before done', author }, undefined, true);
    const after = editText({ text: 'After done', author }, undefined, true);
    const issue = {
      note: { text: 'Sent' },
      comments: [
        { id: '1', body: before, createdAt: '2026-11-08T10:00:00.000Z' },
        { id: '2', body: after, createdAt: '2026-11-08T10:05:00.000Z' },
      ],
    };

    assert.equal(withEditedText(issue, '2026-11-08T10:02:00.000Z').note.text, 'Before done');
    assert.equal(withEditedText(issue).note.text, 'After done');
  });
});

describe('the newest edit, by its instant (review of #866)', () => {
  const author = { kind: 'member' as const, name: 'Ana Martin', workspace: 'Acme' };

  it('orders the edits by their instant, whatever the shape of their date', () => {
    const issue = {
      note: { text: 'Sent' },
      comments: [
        // 10:30 in Paris is 09:30 UTC: older than the next one, though its string sorts after it.
        { id: '1', body: editText({ text: 'Older', author }, undefined, true), createdAt: '2026-11-08T10:30:00+01:00' },
        { id: '2', body: editText({ text: 'Newer', author }, undefined, true), createdAt: '2026-11-08T10:00:00Z' },
      ],
    };

    assert.equal(withEditedText(issue).note.text, 'Newer');
    assert.equal(withEditedText(issue, '2026-11-08T09:45:00Z').note.text, 'Older');
  });
});
