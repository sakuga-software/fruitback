import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { REPLY_NAME_LENGTH, replyName, replyText } from './reply-text.ts';

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
