import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SIGN_IN_INTERVAL_MS, SIGN_IN_REQUEST, acceptedSignIn, createSignInGate } from './sign-in-request.ts';
import { wantsSession } from './popup-state.ts';

const ID = 'abcdefghijklmnop';
const TAB = { id: 3, url: 'https://staging.acme.dev/pricing', windowId: 1 };

describe('the ask for the sign-in, from the widget of a tab (FRU-315)', () => {
  it('is taken from a content script of this extension, with the tab it ran in', () => {
    assert.deepEqual(acceptedSignIn(SIGN_IN_REQUEST, { id: ID, tab: TAB }, ID), TAB);
  });

  it('is refused from a page of the extension, from another extension, and in any other shape', () => {
    assert.equal(acceptedSignIn(SIGN_IN_REQUEST, { id: ID }, ID), undefined);
    assert.equal(acceptedSignIn(SIGN_IN_REQUEST, { id: 'another', tab: TAB }, ID), undefined);
    assert.equal(acceptedSignIn({ type: 'fruitback-tab-command' }, { id: ID, tab: TAB }, ID), undefined);
    assert.equal(acceptedSignIn(null, { id: ID, tab: TAB }, ID), undefined);
  });
});

describe('a site that wants a session (FRU-315)', () => {
  const CLOUD = 'https://api.fruitback.test';
  const TEAM = { mode: 'team' as const, endpoint: CLOUD, enabled: true, mount: { clientId: 'site_1' } };

  it('is a site of a workspace of this build, with no session for it', () => {
    assert.equal(wantsSession(TEAM, CLOUD, {}), true);
    assert.equal(wantsSession(TEAM, CLOUD, { [CLOUD]: true }), false);
    // Another worker, a team entry the site mounts itself, private mode, or a build with no Cloud.
    assert.equal(wantsSession({ ...TEAM, endpoint: 'https://self.test' }, CLOUD, {}), false);
    assert.equal(wantsSession({ mode: 'team', endpoint: CLOUD, enabled: true }, CLOUD, {}), false);
    assert.equal(wantsSession({ mode: 'private', endpoint: CLOUD, clientId: 'a', enabled: true }, CLOUD, {}), false);
    assert.equal(wantsSession(TEAM, undefined, {}), false);
  });
});

describe('how often a tab opens the popup (review of #378)', () => {
  it('opens once, then not again in the same few seconds, and another tab is its own', () => {
    let clock = 1_000;
    const allowed = createSignInGate(() => clock);

    assert.equal(allowed(3), true);
    assert.equal(allowed(3), false);
    assert.equal(allowed(4), true);
    clock += SIGN_IN_INTERVAL_MS - 1;
    assert.equal(allowed(3), false);
    clock += 1;
    assert.equal(allowed(3), true);
  });
});
