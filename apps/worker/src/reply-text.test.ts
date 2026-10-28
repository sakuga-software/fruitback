import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { REPLY_NAME_LENGTH, checkedOf, editText, markedAgent, replyName, replyText } from './reply-text.ts';

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
