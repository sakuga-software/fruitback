import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectSeams, ConnectState, PendingConnect } from './connect.ts';
import { type Timers, claimLoop, startSignIn } from './connect-loop.ts';
import type { ClaimResult, SessionResponse } from './session.ts';

const ENDPOINT = 'https://api.fruitback.test';
const NOW = 1_700_000_000_000;
const STARTED = {
  request: 'req_1',
  claim: 'claim-secret-1',
  word: 'PLUM 47',
  verificationUri: 'https://app.fruitback.test/connect/req_1',
  expiresIn: 900,
  interval: 5,
};

/** The seams of `connect.ts`, with what was asked and what was kept. */
function connectSeams({
  answer = { status: 201, body: STARTED } as SessionResponse | Error,
  claims = [] as (ClaimResult | Error)[],
  kept = undefined as PendingConnect | undefined,
} = {}) {
  const posted: string[] = [];
  const pending = {
    value: kept,
    read: async () => pending.value,
    write: async (next: PendingConnect | undefined) => {
      pending.value = next;
    },
  };
  const connect: ConnectSeams = {
    pending,
    browser: 'Chrome on macOS',
    now: () => NOW,
    wait: async () => undefined,
    post: async (url) => {
      posted.push(url);
      if (answer instanceof Error) throw answer;

      return answer;
    },
    sessions: {
      list: async () => ({}),
      claim: async () => {
        const next = claims.shift() ?? { ok: false, reason: 'waiting' };
        if (next instanceof Error) throw next;

        return next;
      },
    },
  };

  return { connect, posted, pending };
}

/** Timers that run when the test says so, and say what is scheduled. */
function manualTimers(): Timers & { due: { run: () => void; ms: number }[]; tick: () => Promise<void> } {
  const timers = {
    due: [] as { run: () => void; ms: number }[],
    setTimeout: (run: () => void, ms: number) => {
      const entry = { run, ms };
      timers.due.push(entry);

      return entry;
    },
    clearTimeout: (handle: unknown) => {
      timers.due = timers.due.filter((entry) => entry !== handle);
    },
    tick: async () => {
      const next = timers.due.shift();
      next?.run();
      // The claim, its answer and the callback are three turns of the queue.
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    },
  };

  return timers;
}

const noConsole = async () => undefined;

/** A request that waits for the console, as the popup holds it while it shows the word. */
const WAITING: PendingConnect = {
  endpoint: ENDPOINT,
  request: 'req_1',
  claim: 'claim-secret-1',
  word: 'PLUM 47',
  approveAt: 'https://app.fruitback.test/connect/req_1',
  consoleAt: 'https://app.fruitback.test/',
  expiresAt: NOW + 900_000,
  interval: 5,
};

describe('starting a sign-in, from the popup or the welcome page (FRU-511)', () => {
  it('stops at a refused access, and asks the Fruitback nothing', async () => {
    const { connect, posted } = connectSeams();

    for (const granted of [Promise.resolve(false), Promise.reject(new Error('no gesture'))]) {
      const started = await startSignIn(ENDPOINT, granted, false, { connect, rememberConsole: noConsole });
      assert.deepEqual(started, { ok: false, stop: 'blocked' });
    }
    assert.deepEqual(posted, []);
  });

  it('says a Fruitback that did not answer, an insecure one and a console of another site', async () => {
    const down = connectSeams({ answer: new Error('offline') });
    const untrusted = connectSeams({
      answer: { status: 201, body: { ...STARTED, verificationUri: 'https://evil.test/connect/req_1' } },
    });
    const seams = (connect: ConnectSeams) => ({ connect, rememberConsole: noConsole });

    assert.deepEqual(await startSignIn(ENDPOINT, Promise.resolve(true), false, seams(down.connect)), {
      ok: false,
      stop: 'unavailable',
    });
    assert.deepEqual(await startSignIn('http://fruitback.test', Promise.resolve(true), false, seams(down.connect)), {
      ok: false,
      stop: 'unavailable',
    });
    assert.deepEqual(await startSignIn(ENDPOINT, Promise.resolve(true), false, seams(untrusted.connect)), {
      ok: false,
      stop: 'untrusted',
    });
  });

  it('keeps the request and the console, and « Start again » forgets the request that waits', async () => {
    const old: PendingConnect = {
      endpoint: ENDPOINT,
      request: 'req_0',
      claim: 'claim-0',
      word: 'PEAR 12',
      approveAt: 'https://app.fruitback.test/connect/req_0',
      consoleAt: 'https://app.fruitback.test/',
      expiresAt: NOW + 60_000,
      interval: 5,
    };
    const kept: [string, string][] = [];
    const rememberConsole = async (endpoint: string, consoleAt: string) => void kept.push([endpoint, consoleAt]);

    const again = connectSeams({ kept: old });
    const same = await startSignIn(ENDPOINT, Promise.resolve(true), false, { connect: again.connect, rememberConsole });
    assert.ok(same.ok);
    assert.equal(same.pending.word, 'PEAR 12');
    assert.deepEqual(again.posted, []);

    const fresh = connectSeams({ kept: old });
    const started = await startSignIn(ENDPOINT, Promise.resolve(true), true, {
      connect: fresh.connect,
      rememberConsole,
    });
    assert.ok(started.ok);
    assert.equal(started.pending.word, 'PLUM 47');
    assert.equal(fresh.pending.value?.request, 'req_1');
    assert.deepEqual(kept.at(-1), [ENDPOINT, 'https://app.fruitback.test/']);
  });

  it('starts even when the console cannot be kept', async () => {
    const { connect } = connectSeams();
    const started = await startSignIn(ENDPOINT, Promise.resolve(true), false, {
      connect,
      rememberConsole: () => Promise.reject(new Error('storage full')),
    });

    assert.equal(started.ok, true);
  });
});

describe('the claims while the word is on the screen (FRU-511)', () => {
  const waiting = { interval: 5 };

  it('claims at the pace of the worker, and calls back once, when the answer changes', async () => {
    const { connect } = connectSeams({
      claims: [
        { ok: false, reason: 'waiting' },
        { ok: false, reason: 'refused' },
      ],
      kept: WAITING,
    });
    const timers = manualTimers();
    const said: ConnectState[] = [];

    claimLoop(connect, timers).wait(waiting, false, (now) => said.push(now));
    assert.deepEqual(
      timers.due.map((entry) => entry.ms),
      [5000],
    );
    await timers.tick();
    assert.deepEqual(said, [], 'still waiting: the screen stays as it is');
    assert.equal(timers.due.length, 1);
    await timers.tick();
    assert.deepEqual(said, ['refused']);
    assert.equal(timers.due.length, 0, 'the loop stops once it called back');
  });

  it('calls back when a Fruitback that did not answer answers again, and the other way round', async () => {
    const { connect } = connectSeams({
      claims: [new Error('offline'), { ok: false, reason: 'waiting' }],
      kept: WAITING,
    });
    const timers = manualTimers();
    const said: ConnectState[] = [];
    const loop = claimLoop(connect, timers);

    loop.wait(waiting, false, (now) => said.push(now));
    await timers.tick();
    assert.deepEqual(said, ['unavailable']);

    loop.wait(waiting, true, (now) => said.push(now));
    await timers.tick();
    assert.deepEqual(said, ['unavailable', 'waiting']);
  });

  it('runs one loop at a time, and drops the answer of a claim in the air once the screen is gone', async () => {
    let answer: (result: ClaimResult) => void = () => undefined;
    const { connect } = connectSeams({ kept: WAITING });
    connect.sessions.claim = () =>
      new Promise<ClaimResult>((resolve) => {
        answer = resolve;
      });
    const timers = manualTimers();
    const said: ConnectState[] = [];
    const loop = claimLoop(connect, timers);

    loop.wait(waiting, false, (now) => said.push(now));
    loop.wait(waiting, false, (now) => said.push(now));
    assert.equal(timers.due.length, 1, 'the second wait replaced the first');

    await timers.tick();
    loop.stop();
    answer({ ok: false, reason: 'refused' });
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    assert.deepEqual(said, []);
    assert.equal(timers.due.length, 0);
  });
});
