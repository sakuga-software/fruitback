import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  type AccessGrant,
  type Area,
  type SessionResponse,
  type StoredSession,
  REFRESH_MARGIN_MS,
  createSessions,
  nextWakeAt,
  parseIssued,
} from './session.ts';

const ENDPOINT = 'https://worker.test';
const IDENTITY = { subject: 'u_1', name: 'Alex' };
const NOW = 1_700_000_000_000;

/** One storage area, in memory. Two of these is the whole point: they are emptied by different events. */
function area<T>(entries: Record<string, T> = {}): Area<T> {
  let state: Record<string, T> = { ...entries };

  return {
    read: async () => ({ ...state }),
    write: async (next) => {
      state = { ...next };
    },
  };
}

/** A worker that answers whatever the case needs, and records what it was asked. */
function worker(answers: (SessionResponse | Error)[]) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];

  return {
    calls,
    post: async (url: string, body: Record<string, unknown>): Promise<SessionResponse> => {
      calls.push({ url, body });
      const answer = answers.shift();
      assert.ok(answer !== undefined, `the worker was asked ${url} with no answer left to give`);
      if (answer instanceof Error) throw answer;

      return answer;
    },
  };
}

function issued(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { accessToken: 'access.1', expiresIn: 600, identity: IDENTITY, ...overrides };
}

function setup(options: {
  sessions?: Record<string, StoredSession>;
  grants?: Record<string, AccessGrant>;
  answers?: (SessionResponse | Error)[];
  now?: number;
}) {
  const sessions = area<StoredSession>({ ...options.sessions });
  const grants = area<AccessGrant>({ ...options.grants });
  const remote = worker(options.answers ?? []);

  return {
    sessions,
    grants,
    remote,
    subject: createSessions({ sessions, grants, post: remote.post, now: () => options.now ?? NOW }),
  };
}

describe('pairing', () => {
  /**
   * The claim the whole ticket rests on, from the storage side: the two credentials are not kept
   * together. The refresh token has to outlive the browser closing and the access token must not.
   */
  it('puts the refresh token and the access token in different areas', async () => {
    const { subject, sessions, grants } = setup({
      answers: [{ status: 200, body: issued({ refreshToken: 'refresh.1' }) }],
    });

    const result = await subject.pair(ENDPOINT, 'ABCD-EFGH-JKMN');

    assert.deepEqual(result, { ok: true, identity: IDENTITY });
    assert.deepEqual(await sessions.read(), { [ENDPOINT]: { refreshToken: 'refresh.1', identity: IDENTITY } });
    assert.deepEqual(await grants.read(), {
      [ENDPOINT]: { accessToken: 'access.1', expiresAt: NOW + 600_000, identity: IDENTITY },
    });
  });

  it('stores nothing for a code the worker refused', async () => {
    const { subject, sessions, grants } = setup({
      answers: [{ status: 401, body: { error: 'code-spent-or-expired' } }],
    });

    assert.deepEqual(await subject.pair(ENDPOINT, 'ABCD'), { ok: false, reason: 'code-spent-or-expired' });
    assert.deepEqual(await sessions.read(), {});
    assert.deepEqual(await grants.read(), {});
  });

  /**
   * A busy or broken worker is not a bad code, and saying it is sends the reviewer to an operator
   * for a replacement they do not need — while the one in their hand is still good.
   */
  it('does not blame the code when the worker is the problem', async () => {
    for (const answer of [
      { status: 502, body: { error: 'store-unavailable' } },
      { status: 429, body: {} },
    ]) {
      const { subject } = setup({ answers: [answer] });

      assert.deepEqual(await subject.pair(ENDPOINT, 'ABCD'), { ok: false, reason: 'unavailable' });
    }

    const unreachable = setup({ answers: [new Error('offline')] });
    assert.deepEqual(await unreachable.subject.pair(ENDPOINT, 'ABCD'), { ok: false, reason: 'unavailable' });
  });

  /** A `200` whose body is not what it claims is not a session. */
  it('refuses an answer that carries no refresh token', async () => {
    const { subject, sessions } = setup({ answers: [{ status: 200, body: issued() }] });

    assert.deepEqual(await subject.pair(ENDPOINT, 'ABCD'), { ok: false, reason: 'unavailable' });
    assert.deepEqual(await sessions.read(), {});
  });
});

describe('keeping an access token fresh', () => {
  it('hands back a token that is still good without asking the worker', async () => {
    const grant = { accessToken: 'access.1', expiresAt: NOW + 9 * 60_000, identity: IDENTITY };
    const { subject, remote } = setup({
      sessions: { [ENDPOINT]: { refreshToken: 'refresh.1', identity: IDENTITY } },
      grants: { [ENDPOINT]: grant },
    });

    assert.deepEqual(await subject.ensureAccess(ENDPOINT), { ok: true, grant });
    assert.deepEqual(remote.calls, []);
  });

  /** Replaced before it expires rather than after a `401`, which is the whole reason for the margin. */
  it('replaces a token that is inside the margin but not yet expired', async () => {
    const { subject, remote, grants } = setup({
      sessions: { [ENDPOINT]: { refreshToken: 'refresh.1', identity: IDENTITY } },
      grants: {
        [ENDPOINT]: { accessToken: 'old', expiresAt: NOW + REFRESH_MARGIN_MS - 1_000, identity: IDENTITY },
      },
      answers: [{ status: 200, body: issued({ accessToken: 'access.2' }) }],
    });

    const result = await subject.ensureAccess(ENDPOINT);

    assert.ok(result.ok);
    assert.equal(result.grant.accessToken, 'access.2');
    assert.equal(remote.calls[0]?.url, `${ENDPOINT}/session/refresh`);
    assert.equal((await grants.read())[ENDPOINT]?.accessToken, 'access.2');
  });

  it('says so rather than guessing when this worker was never paired with', async () => {
    const { subject, remote } = setup({});

    assert.deepEqual(await subject.ensureAccess(ENDPOINT), { ok: false, reason: 'not-paired' });
    assert.deepEqual(remote.calls, []);
  });

  /**
   * The guard that costs the most to get wrong in both directions.
   *
   * A refusal means the session is over and holding the token would leave a reviewer stuck behind a
   * credential the worker has already forgotten. An outage means nothing of the sort, and throwing
   * the token away there logs them out of a session that is still open — recoverable only with a new
   * pairing code from an operator.
   */
  it('forgets the session the worker refused, and keeps the one it could not reach', async () => {
    const refused = setup({
      sessions: { [ENDPOINT]: { refreshToken: 'refresh.1', identity: IDENTITY } },
      grants: { [ENDPOINT]: { accessToken: 'old', expiresAt: NOW, identity: IDENTITY } },
      answers: [{ status: 401, body: { error: 'session-revoked-or-expired' } }],
    });

    assert.deepEqual(await refused.subject.ensureAccess(ENDPOINT), {
      ok: false,
      reason: 'session-revoked-or-expired',
    });
    assert.deepEqual(await refused.sessions.read(), {});
    assert.deepEqual(await refused.grants.read(), {});

    for (const answer of [new Error('offline'), { status: 502, body: { error: 'store-unavailable' } }]) {
      const kept = setup({
        sessions: { [ENDPOINT]: { refreshToken: 'refresh.1', identity: IDENTITY } },
        answers: [answer],
      });

      assert.deepEqual(await kept.subject.ensureAccess(ENDPOINT), { ok: false, reason: 'unavailable' });
      assert.deepEqual(await kept.sessions.read(), {
        [ENDPOINT]: { refreshToken: 'refresh.1', identity: IDENTITY },
      });
    }
  });

  /**
   * The worker does not rotate today. This is the half that has to already work on the day it does,
   * because a client that ignored the new token would keep sending a retired one.
   */
  it('stores a rotated refresh token when the worker sends one', async () => {
    const { subject, sessions } = setup({
      sessions: { [ENDPOINT]: { refreshToken: 'refresh.1', identity: IDENTITY } },
      answers: [{ status: 200, body: issued({ refreshToken: 'refresh.2' }) }],
    });

    await subject.ensureAccess(ENDPOINT);

    assert.deepEqual(await sessions.read(), { [ENDPOINT]: { refreshToken: 'refresh.2', identity: IDENTITY } });
  });

  it('refreshes only what is due, across several workers', async () => {
    const other = 'https://other.test';
    const { subject, remote } = setup({
      sessions: {
        [ENDPOINT]: { refreshToken: 'refresh.1', identity: IDENTITY },
        [other]: { refreshToken: 'refresh.2', identity: IDENTITY },
      },
      grants: { [other]: { accessToken: 'fresh', expiresAt: NOW + 9 * 60_000, identity: IDENTITY } },
      answers: [{ status: 200, body: issued() }],
    });

    await subject.refreshDue();

    assert.deepEqual(
      remote.calls.map((call) => call.url),
      [`${ENDPOINT}/session/refresh`],
    );
  });
});

describe('logging out', () => {
  /**
   * Revoke first, clear second. The other order cannot work: the token the call needs is the one the
   * clear has just thrown away, and what is left behind is a live credential on the worker that
   * nobody can revoke any more.
   */
  it('revokes on the worker before it clears anything here', async () => {
    const { subject, remote, sessions, grants } = setup({
      sessions: { [ENDPOINT]: { refreshToken: 'refresh.1', identity: IDENTITY } },
      grants: { [ENDPOINT]: { accessToken: 'access.1', expiresAt: NOW + 600_000, identity: IDENTITY } },
      answers: [{ status: 204, body: undefined }],
    });

    await subject.logout(ENDPOINT);

    assert.deepEqual(remote.calls, [{ url: `${ENDPOINT}/session/revoke`, body: { refreshToken: 'refresh.1' } }]);
    assert.deepEqual(await sessions.read(), {});
    assert.deepEqual(await grants.read(), {});
  });

  /** A screen that says signed out while this extension still holds a working credential is worse. */
  it('clears here even when the worker never answered', async () => {
    const { subject, sessions, grants } = setup({
      sessions: { [ENDPOINT]: { refreshToken: 'refresh.1', identity: IDENTITY } },
      grants: { [ENDPOINT]: { accessToken: 'access.1', expiresAt: NOW + 600_000, identity: IDENTITY } },
      answers: [new Error('offline')],
    });

    await subject.logout(ENDPOINT);

    assert.deepEqual(await sessions.read(), {});
    assert.deepEqual(await grants.read(), {});
  });

  it('leaves the other workers alone', async () => {
    const other = 'https://other.test';
    const { subject, sessions } = setup({
      sessions: {
        [ENDPOINT]: { refreshToken: 'refresh.1', identity: IDENTITY },
        [other]: { refreshToken: 'refresh.2', identity: IDENTITY },
      },
      answers: [{ status: 204, body: undefined }],
    });

    await subject.logout(ENDPOINT);

    assert.deepEqual(await sessions.read(), { [other]: { refreshToken: 'refresh.2', identity: IDENTITY } });
  });
});

describe('nextWakeAt', () => {
  it('asks for no alarm at all when nothing is paired', () => {
    assert.equal(nextWakeAt({}, {}, NOW), undefined);
    assert.equal(
      nextWakeAt({}, { [ENDPOINT]: { accessToken: 'a', expiresAt: NOW, identity: IDENTITY } }, NOW),
      undefined,
    );
  });

  /** `chrome.storage.session` is empty after a restart, so a session with no token is due now. */
  it('is due now for a session whose access token did not survive the browser closing', () => {
    assert.equal(nextWakeAt({ [ENDPOINT]: { refreshToken: 'r', identity: IDENTITY } }, {}, NOW), NOW);
  });

  it('is the earliest deadline across every worker', () => {
    const other = 'https://other.test';
    const due = nextWakeAt(
      {
        [ENDPOINT]: { refreshToken: 'r1', identity: IDENTITY },
        [other]: { refreshToken: 'r2', identity: IDENTITY },
      },
      {
        [ENDPOINT]: { accessToken: 'a1', expiresAt: NOW + 600_000, identity: IDENTITY },
        [other]: { accessToken: 'a2', expiresAt: NOW + 300_000, identity: IDENTITY },
      },
      NOW,
    );

    assert.equal(due, NOW + 300_000 - REFRESH_MARGIN_MS);
  });
});

describe('parseIssued', () => {
  it('accepts what the worker sends', () => {
    assert.deepEqual(parseIssued(issued({ refreshToken: 'r' })), {
      accessToken: 'access.1',
      expiresIn: 600,
      identity: IDENTITY,
      refreshToken: 'r',
    });
  });

  /** A lifetime that is not a positive number would be turned into an `expiresAt` in the past. */
  it('refuses a body that is not the shape it claims', () => {
    assert.equal(parseIssued(undefined), undefined);
    assert.equal(parseIssued(issued({ accessToken: '' })), undefined);
    assert.equal(parseIssued(issued({ expiresIn: '600' })), undefined);
    assert.equal(parseIssued(issued({ expiresIn: 0 })), undefined);
    assert.equal(parseIssued(issued({ identity: { name: 'Alex' } })), undefined);
  });

  /** An identity carries one required field; the rest are what an operator happened to type. */
  it('keeps an identity that has only a subject', () => {
    assert.partialDeepStrictEqual(parseIssued(issued({ identity: { subject: 'u_2' } })), {
      identity: { subject: 'u_2' },
    });
  });
});
