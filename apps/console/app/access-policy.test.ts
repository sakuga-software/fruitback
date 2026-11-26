import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Site } from './api.ts';
import {
  type Access,
  LEVEL_ACCESS,
  accessBody,
  accessOf,
  draftAfter,
  levelOf,
  sameAccess,
  visitorReplies,
  withLevel,
} from './access-policy.ts';

const SITE: Site = { id: 's1', origin: 'https://acme.dev', visibility: 'everyone' };
const CONTRIBUTE: Access = {
  ...LEVEL_ACCESS.contribute,
  notifyDone: false,
  visitorNotesPerHour: 10,
  holdVisitorNotes: false,
};

describe('the access of a site, in the tab « Access » (FRU-703)', () => {
  it('reads a worker of before as it behaved: a site everyone read was open to anybody, and a visitor did nothing', () => {
    assert.deepEqual(accessOf(SITE), {
      visibility: 'everyone',
      writers: 'anyone',
      visitorEdit: 'never',
      visitorDelete: 'never',
      notifyDone: false,
      // A worker of before counted nothing (FRU-704).
      visitorNotesPerHour: 0,
      holdVisitorNotes: false,
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
        visitorNotesPerHour: 0,
        holdVisitorNotes: false,
      },
    );
    assert.equal(accessOf({ ...SITE, visitorNotesPerHour: 20 }).visitorNotesPerHour, 20);
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
      visitorNotesPerHour: 10,
      holdVisitorNotes: false,
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
      visitorNotesPerHour: 10,
      holdVisitorNotes: false,
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
    // FRU-704: the notes of a visitor in an hour count where anybody writes, and nowhere else.
    assert.equal(sameAccess(CONTRIBUTE, { ...CONTRIBUTE, visitorNotesPerHour: 0 }), false);
    assert.equal(sameAccess({ ...closed, visitorNotesPerHour: 50 }, closed), true);
    assert.equal(sameAccess(CONTRIBUTE, { ...CONTRIBUTE, holdVisitorNotes: true }), false);
    assert.equal(sameAccess({ ...closed, holdVisitorNotes: true }, closed), true);
    assert.equal(accessOf({ ...SITE, holdVisitorNotes: true }).holdVisitorNotes, true);
  });

  it('lets a visitor reply where everyone reads and anybody writes, as the worker does', () => {
    assert.equal(visitorReplies(CONTRIBUTE), true);
    assert.equal(visitorReplies(withLevel(CONTRIBUTE, 'read-only')), false);
    assert.equal(visitorReplies({ ...CONTRIBUTE, visibility: 'members' }), false);
  });
});

describe('the draft of the tab « Access » when the frame holds another site (FRU-689)', () => {
  const kept: Site = { ...SITE, visibility: 'members', writers: 'members' };

  it('keeps a draft that somebody changed and did not save, when the same site is read again', () => {
    const changed: Access = { ...accessOf(SITE), notifyDone: true };
    assert.notDeepEqual(changed, accessOf(kept));
    assert.deepEqual(draftAfter(changed, SITE, kept), changed);
  });

  it('follows the site when nobody changed the draft, and starts again on another site', () => {
    assert.deepEqual(draftAfter(accessOf(SITE), SITE, kept), accessOf(kept));
    const changed: Access = { ...accessOf(SITE), notifyDone: true };
    const other: Site = { ...kept, id: 's2' };
    assert.deepEqual(draftAfter(changed, SITE, other), accessOf(other));
  });
});
