import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CLOUD,
  POPUP_KINDS,
  type PopupFacts,
  SCREEN_OF,
  cloudEndpoint,
  decide,
  screenOf,
  unmapped,
} from './popup-state.ts';

/** A site with no rule, in a browser that holds nothing: the first popup anybody opens. */
const FRESH: PopupFacts = {
  origin: 'https://staging.acme.dev',
  pairLink: false,
  editing: false,
  canSignIn: true,
  connect: 'none',
  rule: false,
  offer: false,
  account: 'none',
  sessions: 0,
};

const on = (facts: Partial<PopupFacts>) => decide({ ...FRESH, ...facts });

describe('the screen of the popup (FRU-251)', () => {
  it('asks a browser that holds nothing to sign in (05)', () => {
    assert.deepEqual(on({}), { kind: 'signed-out', canSignIn: true, ended: false });
  });

  it('has no sign-in in a build that names no Fruitback', () => {
    assert.deepEqual(on({ canSignIn: false }), { kind: 'signed-out', canSignIn: false, ended: false });
  });

  it('says a page that is not http or https is none Fruitback runs on, for a browser signed in or paired', () => {
    assert.deepEqual(on({ origin: undefined, account: 'ok', sessions: 1, rule: true }), { kind: 'not-web' });
    assert.deepEqual(on({ origin: undefined, sessions: 1 }), { kind: 'not-web' });
    assert.deepEqual(on({ origin: undefined, canSignIn: false }), { kind: 'not-web' });
  });

  it('offers the sign-in on a page that is not http or https, as the welcome page sends there (FRU-482)', () => {
    assert.deepEqual(on({ origin: undefined }), { kind: 'signed-out', canSignIn: true, ended: false });
    assert.deepEqual(on({ origin: undefined, account: 'ended' }), { kind: 'signed-out', canSignIn: true, ended: true });
    assert.deepEqual(on({ origin: undefined, connect: 'waiting', rule: true }), {
      kind: 'connecting',
      unanswered: false,
    });
    assert.deepEqual(on({ origin: undefined, connect: 'unavailable' }), { kind: 'connecting', unanswered: true });
    assert.deepEqual(on({ origin: undefined, connect: 'refused' }), { kind: 'sign-in-problem', problem: 'refused' });
  });

  it('shows the screen of a pairing link, until the person says the page is a site', () => {
    assert.deepEqual(on({ pairLink: true, connect: 'waiting' }), { kind: 'pair-link' });
    assert.deepEqual(on({ pairLink: true, editing: true }), { kind: 'form' });
  });

  it('shows the word while the console has not answered, and says when Fruitback did not', () => {
    assert.deepEqual(on({ connect: 'waiting' }), { kind: 'connecting', unanswered: false });
    assert.deepEqual(on({ connect: 'unavailable' }), { kind: 'connecting', unanswered: true });
    // Before the rule of the page: the person came back for the sign-in.
    assert.deepEqual(on({ connect: 'waiting', rule: true }), { kind: 'connecting', unanswered: false });
  });

  it('says why a sign-in did not finish', () => {
    assert.deepEqual(on({ connect: 'refused' }), { kind: 'sign-in-problem', problem: 'refused' });
    assert.deepEqual(on({ connect: 'expired', sessions: 2 }), { kind: 'sign-in-problem', problem: 'expired' });
  });

  it('goes on to the page once the sign-in is done', () => {
    assert.deepEqual(on({ connect: 'signed-in', account: 'ok', sessions: 1, offer: true }), { kind: 'offer' });
    assert.deepEqual(on({ connect: 'signed-in', account: 'ok', sessions: 1 }), { kind: 'new-site' });
  });

  it('asks to sign in on a site of the workspace whose session is gone, and the rule waits (FRU-238)', () => {
    assert.deepEqual(on({ rule: true, ruleWantsSession: true }), { kind: 'signed-out', canSignIn: true, ended: false });
    assert.deepEqual(on({ rule: true, ruleWantsSession: true, account: 'ended' }), {
      kind: 'signed-out',
      canSignIn: true,
      ended: true,
    });
    // The control: with the session there, the rule is the screen.
    assert.deepEqual(on({ rule: true, ruleWantsSession: false, account: 'ok', sessions: 1 }), { kind: 'rule' });
  });

  it('puts the rule of this browser before anything about an account', () => {
    assert.deepEqual(on({ rule: true }), { kind: 'rule' });
    assert.deepEqual(on({ rule: true, account: 'ended' }), { kind: 'rule' });
    assert.deepEqual(on({ rule: true, offer: true }), { kind: 'rule' });
  });

  it('offers the site of a workspace', () => {
    assert.deepEqual(on({ offer: true, account: 'ok', sessions: 1 }), { kind: 'offer' });
  });

  it('asks to sign in again when the session of the account ended', () => {
    assert.deepEqual(on({ account: 'ended' }), { kind: 'signed-out', canSignIn: true, ended: true });
    // Ended while a pairing lives on: the account is still what is missing.
    assert.deepEqual(on({ account: 'ended', sessions: 1 }), { kind: 'signed-out', canSignIn: true, ended: true });
  });

  it('says Fruitback did not answer, rather than asking to sign in again', () => {
    assert.deepEqual(on({ account: 'unreachable', sessions: 1 }), { kind: 'unreachable' });
  });

  it('offers to add a site of no workspace to somebody signed in (08, FRU-255)', () => {
    assert.deepEqual(on({ account: 'ok', sessions: 1 }), { kind: 'new-site' });
    assert.deepEqual(on({ account: 'ok', sessions: 2, rule: true }), { kind: 'rule' });
    assert.deepEqual(on({ account: 'ok', sessions: 1, offer: true }), { kind: 'offer' });
    assert.deepEqual(on({ account: 'ok', sessions: 1, editing: true }), { kind: 'form' });
  });

  it('gives the fields to somebody paired by hand, or who asked for them', () => {
    assert.deepEqual(on({ sessions: 1 }), { kind: 'form' });
    assert.deepEqual(on({ editing: true }), { kind: 'form' });
  });
});

describe('the Fruitback of the build', () => {
  it('is the one of Sakuga Software unless the build names another', () => {
    assert.equal(cloudEndpoint(undefined), DEFAULT_CLOUD);
    assert.equal(cloudEndpoint('http://localhost:8789/'), 'http://localhost:8789');
    assert.equal(cloudEndpoint(' https://fruitback.client.fr/api '), 'https://fruitback.client.fr/api');
  });

  it('is none for an empty value, and for one a credential must not travel to', () => {
    for (const raw of ['', '  ', 'http://fruitback.client.fr', 'javascript:alert(1)', 'not an address']) {
      assert.equal(cloudEndpoint(raw), undefined, raw);
    }
  });
});

describe('the ten states of before, in the four screens of the mock-up of 2026-10-20 (FRU-297)', () => {
  it('puts each kind in its screen, as the table of the ticket says', () => {
    assert.deepEqual(Object.fromEntries(POPUP_KINDS.map((kind) => [kind, SCREEN_OF[kind]])), {
      'not-web': 4,
      'pair-link': 'page',
      connecting: 1,
      'sign-in-problem': 1,
      form: 'page',
      rule: 3,
      'no-access': 4,
      offer: 2,
      unreachable: 4,
      'new-site': 2,
      'signed-out': 1,
    });
    assert.equal(screenOf(on({})), 1);
    assert.equal(screenOf(on({ rule: true })), 3);
  });

  it('finds a kind that has no screen', () => {
    // The planted violation: the table without « unreachable ».
    const { unreachable: _left, ...table } = SCREEN_OF;
    assert.deepEqual(unmapped(table), ['unreachable']);
    assert.deepEqual(unmapped(SCREEN_OF), []);
  });

  it('says a rule of a site whose Fruitback does not answer is the screen of a problem (4) (FRU-319)', () => {
    assert.deepEqual(on({ rule: true, ruleUnreachable: true, account: 'unreachable', sessions: 1 }), {
      kind: 'unreachable',
    });
    // The control: the same rule, with its Fruitback answering, is the site that is on.
    assert.deepEqual(on({ rule: true, ruleUnreachable: false, account: 'ok', sessions: 1 }), { kind: 'rule' });
    // A removed access is fixed in this browser, so it is said first.
    assert.deepEqual(on({ rule: true, ruleUnreachable: true, accessRemoved: true }), { kind: 'no-access' });
  });

  it('says a rule whose access the browser removed is the screen of a problem (4)', () => {
    assert.deepEqual(on({ rule: true, accessRemoved: true }), { kind: 'no-access' });
    assert.deepEqual(on({ rule: true, accessRemoved: false }), { kind: 'rule' });
    // A sign-in in progress still comes first.
    assert.deepEqual(on({ rule: true, accessRemoved: true, connect: 'waiting' }), {
      kind: 'connecting',
      unanswered: false,
    });
  });
});
