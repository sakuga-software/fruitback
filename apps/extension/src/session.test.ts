import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  type AccessGrant,
  type Area,
  type SessionResponse,
  type StoredSession,
  REFRESH_MARGIN_MS,
  RETRY_DELAY_MS,
  createSessions,
  nextWakeAt,
  parseIssued,
} from './session.ts';

const ENDPOINT = 'https://worker.test';
const IDENTITY = { subject: 'u_1', name: 'Alex' };
const NOW = 1_700_000_000_000;

/**
 * One storage area, in memory. Two of these is the whole point: they are emptied by different events.
 *
 * `set` is not part of `Area`. It is how a case arranges storage behind the subject's back, which is
 * what the whole-record `write` used to be good for.
 */
function area<T>(entries: Record<string, T> = {}): Area<T> & { set(next: Record<string, T>): void } {
  let state: Record<string, T> = { ...entries };

  return {
    read: async () => ({ ...state }),
    put: async (endpoint, value) => {
      state[endpoint] = value;
    },
    drop: async (endpoint) => {
      delete state[endpoint];
    },
    set: (next) => {
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

  // Deterministic, so a test can assert the stored shape. Production mints a random one.
  let minted = 0;
  const newGeneration = () => {
    minted += 1;

    return `gen.${minted}`;
  };

  return {
    sessions,
    grants,
    remote,
    newGeneration,
    subject: createSessions({
      sessions,
      grants,
      newGeneration,
      post: remote.post,
      now: () => options.now ?? NOW,
    }),
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
    assert.deepEqual(await sessions.read(), {
      [ENDPOINT]: { refreshToken: 'refresh.1', identity: IDENTITY, generation: 'gen.1' },
    });
    assert.deepEqual(await grants.read(), {
      [ENDPOINT]: { accessToken: 'access.1', expiresAt: NOW + 600_000, identity: IDENTITY, generation: 'gen.1' },
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
      answers: [{ status: 200, body: issued({ accessToken: 'access.2', refreshToken: 'refresh.2' }) }],
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

    assert.deepEqual(await sessions.read(), {
      [ENDPOINT]: { refreshToken: 'refresh.2', identity: IDENTITY, generation: 'gen.1' },
    });
  });

  /**
   * The lockout rotation created, and the reason it was invisible: `background.ts` serialises the
   * alarm, and the relay does not go through it. The widget reads and writes at once, so two
   * `ensureAccess` calls on a stale grant are the ordinary case.
   *
   * Both are started before either is awaited. Awaiting the first would pass with or without the
   * lock, which is the shape of test this guard exists to not be.
   */
  it('spends one refresh token when two callers ask at once', async () => {
    const { subject, remote, sessions } = setup({
      sessions: { [ENDPOINT]: { refreshToken: 'refresh.1', identity: IDENTITY } },
      answers: [{ status: 200, body: issued({ refreshToken: 'refresh.2' }) }],
    });

    const [first, second] = await Promise.all([subject.ensureAccess(ENDPOINT), subject.ensureAccess(ENDPOINT)]);

    assert.equal(remote.calls.length, 1, 'the same refresh token was spent twice');
    assert.ok(first.ok);
    assert.ok(second.ok);
    assert.deepEqual(first.grant, second.grant);
    assert.deepEqual(await sessions.read(), {
      [ENDPOINT]: { refreshToken: 'refresh.2', identity: IDENTITY, generation: 'gen.1' },
    });
  });

  /** The lock is per endpoint, not one queue for every worker a reviewer is paired with. */
  it('lets two workers refresh at the same time', async () => {
    const other = 'https://other.test';
    const { subject, remote } = setup({
      sessions: {
        [ENDPOINT]: { refreshToken: 'refresh.1', identity: IDENTITY },
        [other]: { refreshToken: 'other.1', identity: IDENTITY },
      },
      answers: [
        { status: 200, body: issued({ refreshToken: 'refresh.2' }) },
        { status: 200, body: issued({ refreshToken: 'other.2' }) },
      ],
    });

    await Promise.all([subject.ensureAccess(ENDPOINT), subject.ensureAccess(other)]);

    assert.equal(remote.calls.length, 2);
  });

  /**
   * Two endpoints refreshing at once must not write each other's tokens away.
   *
   * **This passes for a structural reason since SKG-602, not for a serialised one.** A write names
   * the endpoint it touches, so a refresh for one worker cannot reach another's entry at all. Before
   * that, one key held every endpoint and a write replaced it whole: a read-modify-write for one
   * worker landed on a snapshot taken before another's write and put a **spent** token back. The
   * next refresh presented a token the worker had already rotated, which is the replay signal — the
   * chain revoked and the reviewer pairing again. A queue in `session.ts` held that inside one
   * context; it did not reach the popup, and it is gone.
   *
   * `refreshOnce` does not cover this and is not meant to: it is per endpoint, and
   * `lets two workers refresh at the same time` asserts that on purpose. That test is what makes
   * this reachable, and rotation is what made it likely — before it, `keep` ran only on the rare
   * answer that carried a new token. Raised in review on SKG-600.
   *
   * The interleaving is not forced with a gate, and the first attempt to do so deadlocked the moment
   * the fix landed — the gate waited for two writes at once, which is exactly what the fix prevents.
   * A test that cannot pass against correct code is not a test. Each write simply yields a few
   * microtasks instead, which is what lets a wrong implementation lose the race.
   */
  it('does not restore a spent token when another endpoint refreshes at the same time', async () => {
    const other = 'https://other.test';
    const backing = area<StoredSession>({
      [ENDPOINT]: { refreshToken: 'refresh.1', identity: IDENTITY },
      [other]: { refreshToken: 'other.1', identity: IDENTITY },
    });
    const sessions: Area<StoredSession> = {
      read: backing.read,
      drop: backing.drop,
      async put(endpoint, value) {
        for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();

        await backing.put(endpoint, value);
      },
    };

    const subject = createSessions({
      sessions,
      grants: area<AccessGrant>(),
      now: () => NOW,
      post: async (url) => ({
        status: 200,
        body: issued({ refreshToken: url.startsWith(other) ? 'other.2' : 'refresh.2' }),
      }),
    });

    await Promise.all([subject.ensureAccess(ENDPOINT), subject.ensureAccess(other)]);

    assert.partialDeepStrictEqual(await backing.read(), {
      [ENDPOINT]: { refreshToken: 'refresh.2', identity: IDENTITY },
      [other]: { refreshToken: 'other.2', identity: IDENTITY },
    });
  });

  /**
   * An access token outlives the session it was minted for, and must not be honoured.
   *
   * The popup and the background hold separate `Sessions` over the same two areas, so a logout can
   * land after a refresh has written the session and before it writes the grant. The grant is then
   * an orphan over cleared storage — and freshness alone accepted it for its remaining ten minutes,
   * which revoking on the worker does not reach. Raised in review.
   *
   * The marker is what closes it: the two writes are not one operation and cannot be. Built here by
   * hand rather than by racing two instances, because the state is what matters and a race that has
   * to be won to fail is a flaky test.
   */
  it('refuses an access token minted for a session that is no longer there', async () => {
    const { subject, sessions, grants, remote } = setup({
      sessions: { [ENDPOINT]: { refreshToken: 'refresh.2', identity: IDENTITY, generation: 'gen.2' } },
      grants: {
        [ENDPOINT]: { accessToken: 'orphan', expiresAt: NOW + 600_000, identity: IDENTITY, generation: 'gen.1' },
      },
      answers: [{ status: 200, body: issued({ accessToken: 'access.2', refreshToken: 'refresh.3' }) }],
    });

    const result = await subject.ensureAccess(ENDPOINT);

    assert.ok(result.ok);
    assert.equal(result.grant.accessToken, 'access.2', 'the orphan token was handed back');
    assert.equal(remote.calls.length, 1, 'a stale grant must send the extension back to the worker');
    assert.deepEqual(await sessions.read(), {
      [ENDPOINT]: { refreshToken: 'refresh.3', identity: IDENTITY, generation: 'gen.1' },
    });
    assert.equal((await grants.read())[ENDPOINT]?.generation, 'gen.1');
  });

  /** An entry stored before the marker existed keeps working: two absent markers compare equal. */
  it('honours a grant stored before sessions carried a generation', async () => {
    const { subject, remote } = setup({
      sessions: { [ENDPOINT]: { refreshToken: 'refresh.1', identity: IDENTITY } },
      grants: { [ENDPOINT]: { accessToken: 'old', expiresAt: NOW + 600_000, identity: IDENTITY } },
    });

    const result = await subject.ensureAccess(ENDPOINT);

    assert.ok(result.ok);
    assert.equal(result.grant.accessToken, 'old');
    assert.equal(remote.calls.length, 0, 'an upgrade signed the reviewer out');
  });

  /** The lock is released, so the next due refresh is not answered from the last one's promise. */
  it('refreshes again after the one in flight has settled', async () => {
    const { subject, remote } = setup({
      sessions: { [ENDPOINT]: { refreshToken: 'refresh.1', identity: IDENTITY } },
      answers: [
        { status: 200, body: issued({ refreshToken: 'refresh.2', expiresIn: 1 }) },
        { status: 200, body: issued({ refreshToken: 'refresh.3', expiresIn: 1 }) },
      ],
    });

    await subject.ensureAccess(ENDPOINT);
    await subject.ensureAccess(ENDPOINT);

    assert.equal(remote.calls.length, 2);
    assert.deepEqual(remote.calls[1]?.body, { refreshToken: 'refresh.2' });
  });

  /**
   * A `200` that carries no successor means the worker spent the stored token and the replacement
   * did not arrive. Taking it would leave a spent token in storage under a working access token,
   * and the session would die when the grace ran out with nothing to explain it.
   */
  it('refuses a refresh that answers without a successor', async () => {
    const { subject, sessions, grants } = setup({
      sessions: { [ENDPOINT]: { refreshToken: 'refresh.1', identity: IDENTITY } },
      answers: [{ status: 200, body: issued() }],
    });

    const result = await subject.ensureAccess(ENDPOINT);

    assert.deepEqual(result, { ok: false, reason: 'unavailable' });
    assert.deepEqual(await sessions.read(), { [ENDPOINT]: { refreshToken: 'refresh.1', identity: IDENTITY } });
    assert.deepEqual(await grants.read(), {}, 'a grant was written over a token the worker has spent');
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

describe('a session that ends while a refresh is in the air', () => {
  /**
   * A refresh that has been sent and not yet answered, so the test can end the session underneath it.
   *
   * Synchronised on the request being **entered**, not merely started: `ensureAccess` reads storage
   * before it posts, and a first version that wrote before that read never reached the guard at all —
   * it took the early `not-paired` and passed for the wrong reason.
   */
  function refreshInFlight(body: Record<string, unknown>) {
    const sessions = area<StoredSession>({ [ENDPOINT]: { refreshToken: 'refresh.1', identity: IDENTITY } });
    const grants = area<AccessGrant>();
    let entered = (): void => {};
    let release = (): void => {};
    const sent = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const answered = new Promise<void>((resolve) => {
      release = resolve;
    });

    const subject = createSessions({
      sessions,
      grants,
      now: () => NOW,
      post: async (url) => {
        if (url.endsWith('/session/refresh')) {
          entered();
          await answered;
        }

        return { status: 200, body };
      },
    });

    return { sessions, grants, sent, release, refreshing: subject.ensureAccess(ENDPOINT) };
  }

  /**
   * The popup and the background are separate contexts with separate `Sessions`, sharing only
   * storage. A reviewer clicking log out while an alarm is already awaiting `/session/refresh` used
   * to get the grant written back afterwards — a working access token in storage under a screen that
   * says signed out, and revoking does not reach a token already minted. Raised in review.
   */
  it('writes nothing back after a logout cleared the session', async () => {
    const { sessions, grants, sent, release, refreshing } = refreshInFlight(issued({ refreshToken: 'refresh.2' }));

    await sent;
    sessions.set({});
    grants.set({});
    release();

    assert.deepEqual(await refreshing, { ok: false, reason: 'not-paired' });
    assert.deepEqual(await grants.read(), {});
    assert.deepEqual(await sessions.read(), {});
  });

  /**
   * Re-pairing while a refresh is in flight is the same shape, and the worse one: the stale answer
   * carries its own rotated token, which would overwrite the credential the new pairing just stored.
   */
  it('writes nothing back after the session was replaced by a new pairing', async () => {
    const { sessions, grants, sent, release, refreshing } = refreshInFlight(
      issued({ refreshToken: 'rotated.by.the.stale.run' }),
    );
    const repaired = { refreshToken: 'refresh.2', identity: IDENTITY };

    await sent;
    sessions.set({ [ENDPOINT]: repaired });
    release();

    assert.deepEqual(await refreshing, { ok: false, reason: 'not-paired' });
    assert.deepEqual(await sessions.read(), { [ENDPOINT]: repaired });
    assert.deepEqual(await grants.read(), {});
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

  /**
   * The alarm never asks for a time that has already passed, and the two ways of getting one are the
   * same failure: a browser restart emptied `chrome.storage.session`, or the last refresh could not
   * reach the worker and left the old token in place. An alarm in the past is an alarm every minute,
   * for as long as the worker stays down. Raised in review; nothing here composed the two functions
   * that produce it.
   */
  it('backs off rather than asking for an alarm that is already due', () => {
    const session = { [ENDPOINT]: { refreshToken: 'r', identity: IDENTITY } };

    assert.equal(nextWakeAt(session, {}, NOW), NOW + RETRY_DELAY_MS);
    assert.equal(
      nextWakeAt(session, { [ENDPOINT]: { accessToken: 'a', expiresAt: NOW - 1, identity: IDENTITY } }, NOW),
      NOW + RETRY_DELAY_MS,
    );
  });

  /**
   * And the first token after a restart does not wait for that: the service worker refreshes once as
   * it starts, which is `background.ts`'s top-level call and not this alarm.
   */
  it('leaves the first refresh of the day to the service worker starting up', async () => {
    const { subject, remote } = setup({
      sessions: { [ENDPOINT]: { refreshToken: 'refresh.1', identity: IDENTITY } },
      answers: [{ status: 200, body: issued() }],
    });

    await subject.refreshDue();

    assert.deepEqual(
      remote.calls.map((call) => call.url),
      [`${ENDPOINT}/session/refresh`],
    );
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

/**
 * Nothing here crosses a plain `http://` connection (SKG-596).
 *
 * A pairing code is spent for a refresh token worth thirty days, and a refresh spends that token
 * again on every renewal — both readable by anyone on the path. The relay's own check was the half
 * a review raised; this is the half nobody did, and it is the larger one. Loopback is excepted
 * because it is the dev loop and is not on a wire.
 *
 * Every case asserts `remote.calls` is empty rather than only reading the refusal: what matters is
 * that the credential was never *sent*, and a refusal returned after the request is no protection.
 */
describe('a session never crosses plain http', () => {
  const INSECURE = 'http://worker.test';
  const HELD = { [INSECURE]: { refreshToken: 'refresh.1', identity: IDENTITY } };

  it('refuses to pair, and asks the worker nothing', async () => {
    const { subject, remote, sessions } = setup({});

    assert.deepEqual(await subject.pair(INSECURE, 'ABCD-EFGH-JKMN'), { ok: false, reason: 'insecure-endpoint' });
    assert.deepEqual(remote.calls, []);
    assert.deepEqual(await sessions.read(), {});
  });

  /** A session stored before this rule existed must not keep spending its token either. */
  it('refuses to refresh a session it somehow already holds', async () => {
    const { subject, remote } = setup({ sessions: HELD });

    assert.deepEqual(await subject.ensureAccess(INSECURE), { ok: false, reason: 'insecure-endpoint' });
    assert.deepEqual(remote.calls, []);
  });

  it('clears on log out without sending the token to be revoked', async () => {
    const { subject, remote, sessions } = setup({ sessions: HELD });

    await subject.logout(INSECURE);

    assert.deepEqual(remote.calls, []);
    assert.deepEqual(await sessions.read(), {});
  });

  it('still pairs against the development loop, which is not on a wire', async () => {
    const loopback = 'http://localhost:8788';
    const { subject, remote } = setup({ answers: [{ status: 200, body: issued({ refreshToken: 'refresh.1' }) }] });

    assert.partialDeepStrictEqual(await subject.pair(loopback, 'ABCD-EFGH-JKMN'), { ok: true });
    assert.equal(remote.calls.length, 1);
  });
});
