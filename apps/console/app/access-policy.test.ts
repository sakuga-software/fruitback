import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Site } from './api.ts';
import {
  type Access,
  LEVEL_ACCESS,
  accessBody,
  accessOf,
  levelOf,
  sameAccess,
  visitorReplies,
  withLevel,
} from './access-policy.ts';

const SITE: Site = { id: 's1', origin: 'https://acme.dev', visibility: 'everyone' };
const CONTRIBUTE: Access = { ...LEVEL_ACCESS.contribute, notifyDone: false };

describe('the access of a site, in the tab « Access » (FRU-703)', () => {
  it('reads a worker of before as it behaved: a site everyone read was open to anybody, and a visitor did nothing', () => {
    assert.deepEqual(accessOf(SITE), {
      visibility: 'everyone',
      writers: 'anyone',
      visitorEdit: 'never',
      visitorDelete: 'never',
      notifyDone: false,
    });
    assert.equal(accessOf({ ...SITE, visibility: 'members' }).writers, 'members');
    assert.deepEqual(
      accessOf({ ...SITE, writers: 'members', visitorEdit: 'while-open', visitorDelete: 'never', notifyDone: true }),
      {
        visibility: 'everyone',
        writers: 'members',
        visitorEdit: 'while-open',
        visitorDelete: 'never',
        notifyDone: true,
      },
    );
  });

  it('names the level of each row of the table, and « custom » for a cell that differs', () => {
    assert.equal(levelOf(withLevel(CONTRIBUTE, 'closed')), 'closed');
    assert.equal(levelOf(withLevel(CONTRIBUTE, 'read-only')), 'read-only');
    assert.equal(levelOf(CONTRIBUTE), 'contribute');
    assert.equal(levelOf({ ...CONTRIBUTE, visitorEdit: 'never' }), 'custom');
    assert.equal(levelOf({ ...CONTRIBUTE, visitorDelete: 'never' }), 'custom');
    // A site its members read, where anybody writes: what FRU-330 called « Anyone on the page ».
    assert.equal(levelOf({ ...CONTRIBUTE, visibility: 'members' }), 'custom');
    // Where only members write, a visitor has no note: their rights are not read.
    assert.equal(levelOf({ ...withLevel(CONTRIBUTE, 'closed'), visitorEdit: 'while-open' }), 'closed');
  });

  it('fills the table when a level is chosen, and keeps the e-mail switch', () => {
    const chosen = withLevel({ ...CONTRIBUTE, notifyDone: true }, 'read-only');
    assert.deepEqual(chosen, {
      visibility: 'everyone',
      writers: 'members',
      visitorEdit: 'never',
      visitorDelete: 'never',
      notifyDone: true,
    });
  });

  it('sends what the table shows: the rights of a visitor always, the e-mail where anybody writes', () => {
    assert.deepEqual(accessBody('https://acme.dev', { ...CONTRIBUTE, visitorEdit: 'never' }), {
      url: 'https://acme.dev',
      visibility: 'everyone',
      writers: 'anyone',
      visitorEdit: 'never',
      visitorDelete: 'while-open',
      notifyDone: false,
    });
    // Where only members write, the table says « Never », and that is what is stored (#ca9e30): a
    // site opened again later brings back no right that nobody saw.
    assert.deepEqual(accessBody('https://acme.dev', { ...CONTRIBUTE, writers: 'members' }), {
      url: 'https://acme.dev',
      visibility: 'everyone',
      writers: 'members',
      visitorEdit: 'never',
      visitorDelete: 'never',
    });
  });

  it('counts a change only where it would be stored differently', () => {
    const closed = withLevel(CONTRIBUTE, 'closed');
    // The e-mail does nothing where only members write.
    assert.equal(sameAccess({ ...closed, notifyDone: true }, closed), true);
    // Rights kept from before, which the table shows as « Never »: the save stores « Never ».
    assert.equal(sameAccess({ ...CONTRIBUTE, writers: 'members' }, { ...CONTRIBUTE, writers: 'members' }), false);
    assert.equal(sameAccess(CONTRIBUTE, { ...CONTRIBUTE, notifyDone: true }), false);
    assert.equal(sameAccess(CONTRIBUTE, { ...CONTRIBUTE, visitorDelete: 'never' }), false);
    assert.equal(sameAccess(CONTRIBUTE, closed), false);
    assert.equal(sameAccess(CONTRIBUTE, CONTRIBUTE), true);
  });

  it('lets a visitor reply where everyone reads and anybody writes, as the worker does', () => {
    assert.equal(visitorReplies(CONTRIBUTE), true);
    assert.equal(visitorReplies(withLevel(CONTRIBUTE, 'read-only')), false);
    assert.equal(visitorReplies({ ...CONTRIBUTE, visibility: 'members' }), false);
  });
});
