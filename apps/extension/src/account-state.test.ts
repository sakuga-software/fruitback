import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { accountOf, holdsCloudSession, signedInTo } from './account-state.ts';
import type { AccessFailure, AccessGrant, AccessResult, StoredSession } from './session.ts';

const CLOUD = 'https://api.fruitback.test';
const ACCOUNT: StoredSession = { refreshToken: 'r_1', identity: { subject: 'acct_1' }, account: true };
const PAIRING: StoredSession = { refreshToken: 'r_2', identity: { subject: 'u_2' } };
const GRANT: AccessGrant = { accessToken: 'a_1', expiresAt: 0, identity: ACCOUNT.identity };

/**
 * The sessions of this browser, in memory. A refusal forgets the session, as `session.ts` does when
 * Fruitback says it ended. `asked` counts the calls to `ensureAccess`.
 */
function sessionsOf(
  held: Record<string, StoredSession>,
  access: AccessFailure | 'ok' | Error,
  /** A sign-in that lands while the refresh is refused: its session is stored after the refusal. */
  signInMeanwhile?: StoredSession,
) {
  const state = { ...held };
  const calls = { asked: 0 };

  return {
    calls,
    list: async () => ({ ...state }),
    ensureAccess: async (endpoint: string): Promise<AccessResult> => {
      calls.asked += 1;
      if (access instanceof Error) throw access;
      if (access === 'ok') return { ok: true, grant: GRANT };
      if (access === 'session-revoked-or-expired') delete state[endpoint];
      if (signInMeanwhile !== undefined) state[endpoint] = signInMeanwhile;

      return { ok: false, reason: access };
    },
  };
}

describe('accountOf (FRU-560, FRU-735)', () => {
  it('is `none` with no Cloud, no session, or a pairing, and asks nothing', async () => {
    for (const [cloud, held] of [
      [undefined, { [CLOUD]: ACCOUNT }],
      [CLOUD, {}],
      [CLOUD, { [CLOUD]: PAIRING }],
    ] as const) {
      const sessions = sessionsOf(held, 'ok');
      assert.equal(await accountOf(cloud, held, sessions), 'none');
      assert.equal(sessions.calls.asked, 0);
    }
  });

  it('says what Fruitback answered for an account', async () => {
    const held = { [CLOUD]: ACCOUNT };
    assert.equal(await accountOf(CLOUD, held, sessionsOf(held, 'ok')), 'ok');
    assert.equal(await accountOf(CLOUD, held, sessionsOf(held, 'session-revoked-or-expired')), 'ended');
    assert.equal(await accountOf(CLOUD, held, sessionsOf(held, 'unavailable')), 'unreachable');
    assert.equal(await accountOf(CLOUD, held, sessionsOf(held, new Error('storage'))), 'unreachable');
    assert.equal(await accountOf(CLOUD, held, sessionsOf(held, 'not-paired')), 'none');
  });
});

describe('holdsCloudSession (FRU-663, FRU-735)', () => {
  it('counts an account and a pairing, and not an account that ended', () => {
    assert.equal(holdsCloudSession(CLOUD, { [CLOUD]: ACCOUNT }, 'ok'), true);
    assert.equal(holdsCloudSession(CLOUD, { [CLOUD]: ACCOUNT }, 'unreachable'), true);
    assert.equal(holdsCloudSession(CLOUD, { [CLOUD]: PAIRING }, 'none'), true);
    assert.equal(holdsCloudSession(CLOUD, { [CLOUD]: ACCOUNT }, 'ended'), false);
    assert.equal(holdsCloudSession(CLOUD, {}, 'none'), false);
    assert.equal(holdsCloudSession(undefined, { [CLOUD]: ACCOUNT }, 'ok'), false);
  });
});

describe('signedInTo, what the side panel asks (FRU-735)', () => {
  it('is false for a session of the account that Fruitback ended, which storage still held', async () => {
    const sessions = sessionsOf({ [CLOUD]: ACCOUNT }, 'session-revoked-or-expired');
    // The panel only looked at storage before FRU-735, and storage holds the session until it is asked.
    assert.notEqual((await sessions.list())[CLOUD], undefined);
    assert.equal(await signedInTo(CLOUD, sessions), false);
    // Forgotten, as the popup forgets it: the next read says « signed out » with no second refresh.
    assert.equal((await sessions.list())[CLOUD], undefined);
  });

  it('is true when a sign-in stored a new session while the old one was refused (Kentō #07eb72)', async () => {
    const fresh: StoredSession = { refreshToken: 'r_3', identity: { subject: 'acct_1' }, account: true };
    const sessions = sessionsOf({ [CLOUD]: ACCOUNT }, 'session-revoked-or-expired', fresh);
    assert.equal(await signedInTo(CLOUD, sessions), true);
    assert.equal(sessions.calls.asked, 1);
  });

  it('is true for an account that answers, one Fruitback cannot reach, and a pairing', async () => {
    assert.equal(await signedInTo(CLOUD, sessionsOf({ [CLOUD]: ACCOUNT }, 'ok')), true);
    assert.equal(await signedInTo(CLOUD, sessionsOf({ [CLOUD]: ACCOUNT }, 'unavailable')), true);
    assert.equal(await signedInTo(CLOUD, sessionsOf({ [CLOUD]: PAIRING }, 'session-revoked-or-expired')), true);
  });

  it('is false with no session, and with no Cloud in the build', async () => {
    assert.equal(await signedInTo(CLOUD, sessionsOf({}, 'ok')), false);
    assert.equal(await signedInTo(undefined, sessionsOf({ [CLOUD]: ACCOUNT }, 'ok')), false);
  });
});
