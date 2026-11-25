import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Invitation } from './api.ts';
import { INVITED, INVITED_SEVERAL, invitedSentences, messageOf } from './invitation-message.ts';

const invitation = (mailed?: boolean): Invitation => ({
  id: 'inv_1',
  email: 'paul@client.dev',
  role: 'member',
  organizationId: 'ws_1',
  status: 'pending',
  expiresAt: '2026-10-19T00:00:00.000Z',
  ...(mailed === undefined ? {} : { mailed }),
});

describe('what the console says of the message of an invitation (FRU-209)', () => {
  it('says that no message went when the worker answers mailed: false, and gives the link', () => {
    assert.equal(messageOf(invitation(false), true), 'held');
    assert.match(INVITED.held, /no message was sent/);
    assert.match(INVITED.held, /Send them this link:$/);
  });

  it('says sent for mailed: true, and for a worker that does not say: the control', () => {
    assert.equal(messageOf(invitation(true), true), 'sent');
    assert.equal(messageOf(invitation(), true), 'sent');
    assert.match(INVITED.sent, /^Invitation sent to/);
  });

  it('says kept, and not held, on a worker with no mailer, whatever mailed says', () => {
    for (const mailed of [undefined, false, true]) assert.equal(messageOf(invitation(mailed), false), 'no-mailer');
  });
});

describe('the block of several addresses invited at once (FRU-691)', () => {
  it('says one sentence a kind of message, with its addresses, in the order they were sent', () => {
    assert.deepEqual(
      invitedSentences([
        { email: 'zoe@client.fr', message: 'sent' },
        { email: 'lou@client.fr', message: 'held' },
        { email: 'paul@client.fr', message: 'sent' },
      ]),
      [
        { message: 'sent', emails: ['zoe@client.fr', 'paul@client.fr'] },
        { message: 'held', emails: ['lou@client.fr'] },
      ],
    );
    // The control: one address is one sentence.
    assert.deepEqual(invitedSentences([{ email: 'zoe@client.fr', message: 'sent' }]), [
      { message: 'sent', emails: ['zoe@client.fr'] },
    ]);
  });

  it('has a sentence of several addresses for each kind of message, which ends with the link', () => {
    for (const message of ['sent', 'no-mailer', 'held'] as const) {
      assert.match(INVITED_SEVERAL[message], /\{emails\}/);
      assert.match(INVITED_SEVERAL[message], /this link:$/);
    }
  });
});
