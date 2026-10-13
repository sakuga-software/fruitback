import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Invitation } from './api.ts';
import { INVITED, messageOf } from './invitation-message.ts';

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
