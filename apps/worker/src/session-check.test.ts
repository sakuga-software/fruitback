import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'vitest';
import type { Role } from './accounts.ts';
import { mutatedModule } from './conformance.fixture.ts';
import { signIdentityToken } from './identity.ts';
import type { Database } from './postgres.ts';
import { createPgliteDatabase } from './postgres.fixture.ts';
import type { SessionCheck } from './session-check.ts';
import { createPostgresConnectStore, createPostgresSessionStore } from './session-postgres.ts';
import {
  type SessionStore,
  createPairing,
  createRefreshToken,
  digest,
  mintAccessToken,
  redeemPairing,
  refreshSession,
  revokeSession,
} from './session.ts';

/**
 * `sessionStillValid` (FRU-238): what a route that writes for an extension asks before it writes.
 * Each check has a scenario, and each scenario fails on the file with that check taken out.
 */

const SECRET = 'a-worker-secret-of-exactly-enough';
type Check = (token: string, check: SessionCheck) => Promise<unknown>;

const opened: Database[] = [];
afterEach(async () => {
  for (const database of opened.splice(0)) await database.close();
});

/** A world of one store: a member of `ws_acme`, and an account `acc_alice` that is there. */
async function world() {
  const database = await createPgliteDatabase();
  opened.push(database);
  const sessions = createPostgresSessionStore(database);
  const connect = createPostgresConnectStore(database);
  const roles = new Map<string, Role>([['ws_acme alice', 'member']]);
  const accounts = new Set(['acc_alice']);
  const check = (now = Date.now()): SessionCheck => ({
    sessions,
    secret: SECRET,
    roleIn: async (workspace, account) => roles.get(`${workspace} ${account}`),
    accountActive: async (account) => accounts.has(account),
    now,
  });

  /** A session paired for `ws_acme`. */
  const paired = async () => {
    const { code } = await createPairing(sessions, { subject: 'alice', workspace: 'ws_acme' });
    const redeemed = await redeemPairing(sessions, code, SECRET);
    assert.ok(redeemed.ok);

    return redeemed.session;
  };
  /** A session of the account `acc_alice`, approved and claimed. */
  const ofAccount = async () => {
    const now = Date.now();
    await connect.createRequest({
      requestHash: 'request',
      claimHash: 'claim',
      word: 'PLUM 47',
      browser: 'A browser',
      now,
      expiresAt: now + 60_000,
      maxLive: 10,
    });
    const refreshToken = createRefreshToken();
    const tokenHash = await digest(refreshToken);
    await connect.answer({ requestHash: 'request', account: 'acc_alice', outcome: 'approved', now });
    const claimed = await connect.claim({
      claimHash: 'claim',
      now,
      tokenHash,
      connectionId: 'connection-of-alice',
      expiresAt: now + 60_000,
      open: async () => ({}),
    });
    assert.equal(claimed.state, 'claimed');
    const identity = { subject: 'acc_alice', account: true as const };

    return { refreshToken, accessToken: await mintAccessToken(identity, SECRET, now, tokenHash) };
  };

  return { sessions, connect, roles, accounts, check, paired, ofAccount };
}

type World = Awaited<ReturnType<typeof world>>;
/** The person as the token says it: what a check that reads no store would take. */
const TOKEN_IDENTITY =
  '{ subject: verified.reporter.id as string, ...(verified.workspace === undefined ? {} : { workspace: verified.workspace }), ...(verified.account === true ? { account: true as const } : {}) }';

type Scenario = { holds: string; change: { from: string; to: string }; run(valid: Check, world: World): Promise<void> };

const SCENARIOS: Scenario[] = [
  {
    holds: 'a token that names no chain writes nothing',
    change: {
      // Trusts a token that names no chain, as the routes of reading do.
      from: 'if (!verified.ok || verified.chain === undefined) return undefined;\n\n  const identity = await check.sessions.liveIdentity(verified.chain, now);',
      to: 'if (!verified.ok) return undefined;\n\n  const identity = verified.chain === undefined ? TRUSTED : await check.sessions.liveIdentity(verified.chain, now);'.replace(
        'TRUSTED',
        '(' + TOKEN_IDENTITY + ')',
      ),
    },
    async run(valid, { check, paired }) {
      await paired();
      const now = Math.floor(Date.now() / 1000);
      // Signed with the worker key, of a live person, with no `sid`: a token of before.
      const token = await signIdentityToken({ sub: 'alice', ws: 'ws_acme', iat: now, exp: now + 600 }, SECRET);
      assert.equal(await valid(token, check()), undefined);
    },
  },
  {
    holds: 'a session that was logged out writes nothing, with a token that still verifies',
    change: {
      // Reads the person from the token, and not from the store.
      from: 'const identity = await check.sessions.liveIdentity(verified.chain, now);',
      to: 'const identity = ' + TOKEN_IDENTITY + ';',
    },
    async run(valid, { sessions, check, paired }) {
      const session = await paired();
      assert.deepEqual(await valid(session.accessToken, check()), { subject: 'alice', workspace: 'ws_acme' });
      await revokeSession(sessions, session.refreshToken);
      assert.equal(await valid(session.accessToken, check()), undefined);
    },
  },
  {
    holds: 'a token of one chain does not stand for a session of another person',
    change: { from: 'identity.subject !== verified.reporter.id ||', to: '' },
    async run(valid, { check, paired }) {
      const session = await paired();
      const chain = JSON.parse(Buffer.from(session.accessToken.split('.')[1] as string, 'base64url').toString()) as {
        sid: string;
      };
      const now = Math.floor(Date.now() / 1000);
      // A token the worker would never mint: the chain of Alice, for Mallory. Signed here, as a key would.
      const forged = await signIdentityToken(
        { sub: 'mallory', ws: 'ws_acme', sid: chain.sid, iat: now, exp: now + 600 },
        SECRET,
      );
      assert.equal(await valid(forged, check()), undefined);
    },
  },
  {
    holds: 'a person removed from the workspace writes nothing there',
    change: {
      from: 'return (await check.roleIn(identity.workspace, identity.subject)) === undefined ? undefined : identity;',
      to: 'return identity;',
    },
    async run(valid, { roles, check, paired }) {
      const session = await paired();
      roles.delete('ws_acme alice');
      assert.equal(await valid(session.accessToken, check()), undefined);
    },
  },
  {
    holds: 'a session of an account that is gone writes nothing',
    change: {
      from: 'return check.accountActive !== undefined && (await check.accountActive(identity.subject)) ? identity : undefined;',
      to: 'return identity;',
    },
    async run(valid, { accounts, check, ofAccount }) {
      const session = await ofAccount();
      assert.deepEqual(await valid(session.accessToken, check()), { subject: 'acc_alice', account: true });
      accounts.delete('acc_alice');
      assert.equal(await valid(session.accessToken, check()), undefined);
    },
  },
  {
    holds: 'a session ended in My account writes nothing',
    change: {
      // Reads the person from the token, and not from the store.
      from: 'const identity = await check.sessions.liveIdentity(verified.chain, now);',
      to: 'const identity = ' + TOKEN_IDENTITY + ';',
    },
    async run(valid, { connect, check, ofAccount }) {
      const session = await ofAccount();
      assert.equal(await connect.endBrowser('acc_alice', 'connection-of-alice', Date.now()), true);
      assert.equal(await valid(session.accessToken, check()), undefined);
    },
  },
];

describe('whether the session of an extension still writes (FRU-238)', () => {
  it('writes with the token of each refresh, which names the same chain', async () => {
    const { sessions, check, paired } = await world();
    const { sessionStillValid } = await import('./session-check.ts');
    const session = await paired();
    const refreshed = await refreshSession(sessions as SessionStore, session.refreshToken, SECRET);
    assert.ok(refreshed.ok);
    assert.deepEqual(await sessionStillValid(refreshed.accessToken, check()), {
      subject: 'alice',
      workspace: 'ws_acme',
    });
  });

  for (const scenario of SCENARIOS) {
    it(`holds that ${scenario.holds}`, async () => {
      const { sessionStillValid } = await import('./session-check.ts');
      await scenario.run(sessionStillValid, await world());
    });

    it(`fails « ${scenario.holds} » with the check taken out`, async () => {
      const mutant = await mutatedModule('session-check.ts', scenario.change);
      try {
        const valid = mutant.module.sessionStillValid as Check;
        const failure = await scenario.run(valid, await world()).then(
          () => undefined,
          (error: unknown) => error,
        );
        assert.ok(
          failure instanceof assert.AssertionError,
          `the scenario did not fail on an assertion: ${String(failure)}`,
        );
      } finally {
        mutant.remove();
      }
    });
  }
});
