import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  type ConnectSeams,
  type EndedConnect,
  type PendingArea,
  type PendingConnect,
  approvalPage,
  forgetConnect,
  browserLabel,
  parseEnded,
  parsePending,
  parseStarted,
  pollConnect,
  startConnect,
} from './connect.ts';
import type { ClaimResult, SessionResponse, StoredSession } from './session.ts';

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

function pendingArea(initial?: PendingConnect): PendingArea & { value: PendingConnect | undefined } {
  const area = {
    value: initial,
    read: async () => area.value,
    write: async (next: PendingConnect | undefined) => {
      area.value = next;
    },
  };

  return area;
}

function seams({
  answer = { status: 201, body: STARTED },
  claims = [] as (ClaimResult | Error)[],
  held = {} as Record<string, StoredSession>,
  pending = pendingArea(),
  now = NOW,
}: {
  answer?: SessionResponse | Error;
  claims?: (ClaimResult | Error)[];
  held?: Record<string, StoredSession>;
  pending?: ReturnType<typeof pendingArea>;
  now?: number;
} = {}) {
  const posted: { url: string; body: Record<string, unknown> }[] = [];
  const claimed: { endpoint: string; claim: string }[] = [];
  const waited: number[] = [];
  const state: { held: Record<string, StoredSession>; now: number; onWait?: () => void } = { held, now };
  const ended: { value: EndedConnect | undefined } & NonNullable<ConnectSeams['ended']> = {
    value: undefined,
    read: async () => ended.value,
    write: async (next) => {
      ended.value = next;
    },
  };
  const connect: ConnectSeams = {
    pending,
    ended,
    browser: 'Chrome on macOS',
    now: () => state.now,
    wait: async (ms) => {
      waited.push(ms);
      state.onWait?.();
    },
    post: async (url, body) => {
      posted.push({ url, body });
      if (answer instanceof Error) throw answer;

      return answer;
    },
    sessions: {
      list: async () => state.held,
      claim: async (endpoint, claim) => {
        claimed.push({ endpoint, claim });
        const next = claims.shift() ?? { ok: false, reason: 'waiting' };
        if (next instanceof Error) throw next;

        return next;
      },
    },
  };

  return { connect, posted, claimed, pending, state, waited, ended };
}

const session = (epoch: string): StoredSession => ({
  refreshToken: `refresh-${epoch}`,
  identity: { subject: 'u_1' },
  epoch,
});

describe('starting a sign-in (FRU-251)', () => {
  it('asks the Fruitback for a request, keeps it, and opens the console of its site', async () => {
    const { connect, posted, pending } = seams();

    const started = await startConnect(ENDPOINT, connect);

    assert.equal(started.ok, true);
    assert.deepEqual(posted, [{ url: `${ENDPOINT}/session/connect`, body: { browser: 'Chrome on macOS' } }]);
    assert.deepEqual(pending.value, {
      endpoint: ENDPOINT,
      request: 'req_1',
      claim: 'claim-secret-1',
      word: 'PLUM 47',
      approveAt: 'https://app.fruitback.test/connect/req_1',
      consoleAt: 'https://app.fruitback.test/',
      expiresAt: NOW + 900_000,
      interval: 5,
    });
  });

  it('never puts the claim in the address of the console', async () => {
    const { connect } = seams();

    const started = await startConnect(ENDPOINT, connect);

    assert.ok(started.ok);
    assert.equal(started.pending.approveAt.includes('claim-secret-1'), false);
  });

  it('gives back the request that waits rather than making a second one', async () => {
    const kept = await (async () => {
      const first = seams();
      const started = await startConnect(ENDPOINT, first.connect);
      assert.ok(started.ok);

      return first.pending;
    })();
    const again = seams({
      pending: kept,
      answer: {
        status: 201,
        body: {
          ...STARTED,
          request: 'req_2',
          word: 'FIG 12',
          verificationUri: 'https://app.fruitback.test/connect/req_2',
        },
      },
    });

    const started = await startConnect(ENDPOINT, again.connect);

    assert.ok(started.ok);
    assert.equal(started.pending.request, 'req_1');
    assert.deepEqual(again.posted, [], 'a second request was made');
  });

  it('makes a new request once the one kept has expired', async () => {
    const kept = pendingArea({
      endpoint: ENDPOINT,
      request: 'req_old',
      claim: 'old',
      word: 'OLD 01',
      approveAt: 'https://app.fruitback.test/connect/req_old',
      consoleAt: 'https://app.fruitback.test/',
      interval: 5,
      expiresAt: NOW - 1,
    });
    const { connect, posted } = seams({ pending: kept });

    const started = await startConnect(ENDPOINT, connect);

    assert.ok(started.ok);
    assert.equal(started.pending.request, 'req_1');
    assert.equal(posted.length, 1);
  });

  it('says Fruitback did not answer, and keeps nothing', async () => {
    for (const answer of [
      new TypeError('Failed to fetch'),
      { status: 503, body: {} },
      { status: 201, body: { request: 'r' } },
    ]) {
      const { connect, pending } = seams({ answer });

      assert.deepEqual(await startConnect(ENDPOINT, connect), { ok: false, reason: 'unavailable' });
      assert.equal(pending.value, undefined);
    }
  });

  it('refuses a console that is not of the site of the worker, and opens nothing', async () => {
    for (const verificationUri of [
      'https://evil.example/connect/req_1',
      'https://fruitback.test.evil.example/connect/req_1',
      'http://app.fruitback.test/connect/req_1',
      'https://user:pass@app.fruitback.test/connect/req_1',
      'https://app.fruitback.test/connect/req_2',
      'https://app.fruitback.test/elsewhere',
      'https://app.fruitback.test/connect/req_1?next=https://evil.example',
      'https://app.fruitback.test/connect/req_1#x',
      'javascript:alert(1)',
      'not an address',
    ]) {
      const { connect, pending } = seams({ answer: { status: 201, body: { ...STARTED, verificationUri } } });

      assert.deepEqual(
        await startConnect(ENDPOINT, connect),
        { ok: false, reason: 'untrusted-console' },
        verificationUri,
      );
      assert.equal(pending.value, undefined);
    }
  });

  it('refuses a Fruitback over plain http, loopback excepted', async () => {
    const { connect, posted } = seams();

    assert.deepEqual(await startConnect('http://api.fruitback.test', connect), {
      ok: false,
      reason: 'insecure-endpoint',
    });
    assert.deepEqual(posted, []);
  });

  it('believes a lifetime of thirty minutes at most', async () => {
    const { connect } = seams({ answer: { status: 201, body: { ...STARTED, expiresIn: 86_400 } } });

    const started = await startConnect(ENDPOINT, connect);

    assert.ok(started.ok);
    assert.equal(started.pending.expiresAt, NOW + 30 * 60 * 1000);
  });
});

describe('the page of the console that approves a request', () => {
  const page = (endpoint: string, uri: string, request = 'r') => approvalPage(endpoint, uri, request)?.approveAt;

  it('is the host of the worker, or a host under the domain the worker is under', () => {
    assert.deepEqual(approvalPage('https://api.fruitback.com', 'https://app.fruitback.com/connect/r_1', 'r_1'), {
      approveAt: 'https://app.fruitback.com/connect/r_1',
      consoleAt: 'https://app.fruitback.com/',
    });
    assert.deepEqual(approvalPage('https://api.acme.dev', 'https://acme.dev/fruitback/connect/r', 'r'), {
      approveAt: 'https://acme.dev/fruitback/connect/r',
      consoleAt: 'https://acme.dev/fruitback',
    });
    assert.equal(
      page('https://api.client.co.uk', 'https://console.client.co.uk/connect/r'),
      'https://console.client.co.uk/connect/r',
    );
    assert.equal(
      page('https://fruitback.com', 'https://app.fruitback.com/connect/r'),
      'https://app.fruitback.com/connect/r',
    );
    assert.equal(page('http://localhost:8788', 'http://localhost:5178/connect/r'), 'http://localhost:5178/connect/r');
  });

  it('is not another site, a domain of one label, or a loopback for a worker that is not one', () => {
    assert.equal(page('https://fruitback.com', 'https://evil.com/connect/r'), undefined);
    assert.equal(page('https://api.co.uk', 'https://other.co.uk/connect/r'), undefined);
    assert.equal(page('https://api.fruitback.com', 'http://localhost:5178/connect/r'), undefined);
    assert.equal(page('http://localhost:8788', 'https://evil.com/connect/r'), undefined);
    // A shared suffix of two labels: a host under it is somebody else's site.
    assert.equal(page('https://fruitback.workers.dev', 'https://evil.workers.dev/connect/r'), undefined);
    assert.equal(
      page('https://fruitback.workers.dev', 'https://app.fruitback.workers.dev/connect/r'),
      'https://app.fruitback.workers.dev/connect/r',
    );
  });

  it('is the page of this request, and only it', () => {
    assert.equal(page('https://api.fruitback.com', 'https://app.fruitback.com/connect/other', 'r'), undefined);
    assert.equal(page('https://api.fruitback.com', 'https://app.fruitback.com/connect/r?x=1', 'r'), undefined);
    assert.equal(page('https://api.fruitback.com', 'https://app.fruitback.com/connect/r?', 'r'), undefined);
    assert.equal(page('https://api.fruitback.com', 'https://app.fruitback.com/connect/r#', 'r'), undefined);
    assert.equal(page('https://api.fruitback.com', 'https://app.fruitback.com/connect/r%201', 'r 1'), undefined);
  });
});

describe('the answer of a request', () => {
  it('needs every field, and refuses control characters in what is shown or put in an address', () => {
    assert.ok(parseStarted(STARTED));
    for (const field of ['request', 'claim', 'word', 'verificationUri', 'expiresIn'] as const) {
      const body: Record<string, unknown> = { ...STARTED };
      delete body[field];
      assert.equal(parseStarted(body), undefined, field);
    }
    assert.equal(parseStarted({ ...STARTED, word: 'PLUM\n47' }), undefined);
    assert.equal(parseStarted({ ...STARTED, expiresIn: -1 }), undefined);
    assert.equal(parseStarted({ ...STARTED, request: 'r/../x' }), undefined);
    // The pace is the worker's to give, and a request without it still works.
    const { interval: _pace, ...noPace } = STARTED;
    assert.deepEqual(parseStarted(noPace), noPace);
  });
});

describe('claiming a request', () => {
  const waiting = (): PendingConnect => ({
    endpoint: ENDPOINT,
    request: 'req_1',
    claim: 'claim-secret-1',
    word: 'PLUM 47',
    approveAt: 'https://app.fruitback.test/connect/req_1',
    consoleAt: 'https://app.fruitback.test/',
    expiresAt: NOW + 60_000,
    interval: 5,
  });

  it('is nothing when nobody asked', async () => {
    const { connect, claimed } = seams();

    assert.equal(await pollConnect(connect), 'none');
    assert.deepEqual(claimed, []);
  });

  it('waits while nobody approved it, and keeps the request', async () => {
    const { connect, pending, claimed } = seams({ pending: pendingArea(waiting()) });

    assert.equal(await pollConnect(connect), 'waiting');
    assert.deepEqual(claimed, [{ endpoint: ENDPOINT, claim: 'claim-secret-1' }]);
    assert.ok(pending.value);
  });

  it('signs in once approved, and forgets the request', async () => {
    const { connect, pending } = seams({
      pending: pendingArea(waiting()),
      claims: [{ ok: true, identity: { subject: 'u_1' } }],
    });

    assert.equal(await pollConnect(connect), 'signed-in');
    assert.equal(pending.value, undefined);
  });

  it('says refused, and expired, and forgets the request', async () => {
    for (const reason of ['refused', 'expired'] as const) {
      const { connect, pending } = seams({ pending: pendingArea(waiting()), claims: [{ ok: false, reason }] });

      assert.equal(await pollConnect(connect), reason);
      assert.equal(pending.value, undefined);
    }
  });

  it('says expired once its time is over, without asking', async () => {
    const { connect, claimed, pending } = seams({ pending: pendingArea({ ...waiting(), expiresAt: NOW }) });

    assert.equal(await pollConnect(connect), 'expired');
    assert.deepEqual(claimed, []);
    assert.equal(pending.value, undefined);
  });

  it('keeps the request when Fruitback did not answer: the next claim may work', async () => {
    for (const claim of [new Error('offline'), { ok: false, reason: 'unavailable' } as const]) {
      const { connect, pending } = seams({ pending: pendingArea(waiting()), claims: [claim] });

      assert.equal(await pollConnect(connect), 'unavailable');
      assert.ok(pending.value);
    }
  });

  it('reads a request spent by the other context as a sign-in, when a new session is there', async () => {
    // The popup and the background claim at the same instant: the worker gives the session once.
    const before = session('epoch-1');
    const { connect, state } = seams({
      pending: pendingArea({ ...waiting(), before: 'epoch-1' }),
      claims: [{ ok: false, reason: 'expired' }],
      held: { [ENDPOINT]: before },
    });
    state.held = { [ENDPOINT]: session('epoch-2') };

    assert.equal(await pollConnect(connect), 'signed-in');
  });

  it('does not read a session that was there before the request as its sign-in: the control', async () => {
    const { connect, waited } = seams({
      pending: pendingArea({ ...waiting(), before: 'epoch-1' }),
      claims: [{ ok: false, reason: 'expired' }],
      held: { [ENDPOINT]: session('epoch-1') },
    });

    assert.equal(await pollConnect(connect), 'expired');
    // It looked four times, half a second apart, before it said so.
    assert.deepEqual(waited, [500, 500, 500]);
  });

  it('waits for the session the other context is still storing, rather than saying expired', async () => {
    // Raised in review: the other context was answered first and writes the session in three steps,
    // so this claim, answered just after, can find nothing yet.
    const { connect, state } = seams({
      pending: pendingArea(waiting()),
      claims: [{ ok: false, reason: 'expired' }],
    });
    let looks = 0;
    state.onWait = () => {
      looks += 1;
      if (looks === 2) state.held = { [ENDPOINT]: session('epoch-2') };
    };

    assert.equal(await pollConnect(connect), 'signed-in');
  });

  it('says a refusal at once: a refused request was never spent', async () => {
    const { connect, waited } = seams({ pending: pendingArea(waiting()), claims: [{ ok: false, reason: 'refused' }] });

    assert.equal(await pollConnect(connect), 'refused');
    assert.deepEqual(waited, []);
  });

  it('leaves alone a request that took the place of the one it claimed', async () => {
    const pending = pendingArea(waiting());
    const { connect } = seams({ pending, claims: [{ ok: true, identity: { subject: 'u_1' } }] });
    const original = connect.sessions.claim;
    connect.sessions.claim = async (endpoint, claim) => {
      // « Start again » in the other context, while this claim is in the air.
      pending.value = { ...waiting(), request: 'req_2', claim: 'claim-2' };

      return original(endpoint, claim);
    };

    assert.equal(await pollConnect(connect), 'signed-in');
    assert.equal(pending.value?.request, 'req_2');
  });

  it('forgets the request on « Start again »', async () => {
    const pending = pendingArea(waiting());

    await forgetConnect({ pending });

    assert.equal(pending.value, undefined);
  });
});

describe('the request kept in storage', () => {
  const kept: PendingConnect = {
    endpoint: ENDPOINT,
    request: 'req_1',
    claim: 'claim-secret-1',
    word: 'PLUM 47',
    approveAt: 'https://app.fruitback.test/connect/req_1',
    consoleAt: 'https://app.fruitback.test/',
    expiresAt: NOW,
    interval: 5,
  };

  it('reads back what was written, and nothing that is not one', () => {
    assert.deepEqual(parsePending(kept), kept);
    assert.deepEqual(parsePending({ ...kept, before: 'e' }), { ...kept, before: 'e' });
    for (const broken of [
      undefined,
      null,
      'x',
      { ...kept, claim: '' },
      { ...kept, interval: 0 },
      { ...kept, before: 1 },
    ]) {
      assert.equal(parsePending(broken), undefined, JSON.stringify(broken));
    }
  });
});

describe('the name of the browser the console shows', () => {
  it('says the browser and the system, and nothing more', () => {
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)';
    assert.equal(browserLabel(`${mac} Chrome/131.0.0.0 Safari/537.36`), 'Chrome on macOS');
    assert.equal(
      browserLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36 Edg/131.0'),
      'Edge on Windows',
    );
    assert.equal(
      browserLabel('Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0'),
      'Firefox on Linux',
    );
    assert.equal(
      browserLabel('Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) Chrome/131.0 Safari/537.36'),
      'Chrome on ChromeOS',
    );
    assert.equal(browserLabel(''), 'A browser');
  });
});

describe('a request that the other context ended (FRU-251)', () => {
  const waiting = (): PendingConnect => ({
    endpoint: ENDPOINT,
    request: 'req_1',
    claim: 'claim-secret-1',
    word: 'PLUM 47',
    approveAt: 'https://app.fruitback.test/connect/req_1',
    consoleAt: 'https://app.fruitback.test/',
    expiresAt: NOW + 60_000,
    interval: 5,
  });

  it('is said to the popup once, though the background claimed it, and the background keeps it', async () => {
    // Raised in review: the background ended the request while the popup showed the word, and the
    // popup then found nothing and drew the screen of before, without the sentence that says why.
    const { connect, ended } = seams({ pending: pendingArea(waiting()), claims: [{ ok: false, reason: 'refused' }] });

    assert.equal(await pollConnect(connect, { keep: true }), 'refused');
    assert.deepEqual(ended.value, { request: 'req_1', outcome: 'refused', at: NOW });
    // The background, again: it keeps what it read.
    assert.equal(await pollConnect(connect, { keep: true }), 'refused');
    // The popup: said once, then forgotten.
    assert.equal(await pollConnect(connect), 'refused');
    assert.equal(await pollConnect(connect), 'none');
  });

  it('is not kept when the popup ended it: the popup says it itself, once', async () => {
    const { connect, ended } = seams({ pending: pendingArea(waiting()), claims: [{ ok: false, reason: 'refused' }] });

    assert.equal(await pollConnect(connect), 'refused');
    assert.equal(ended.value, undefined);
    assert.equal(await pollConnect(connect), 'none');
  });

  it('keeps no claim, and is forgotten after ten minutes, or by « Start again »', async () => {
    const { connect, ended, state } = seams({
      pending: pendingArea(waiting()),
      claims: [{ ok: true, identity: { subject: 'u_1' } }],
    });

    assert.equal(await pollConnect(connect, { keep: true }), 'signed-in');
    assert.doesNotMatch(JSON.stringify(ended.value), /claim-secret/);
    state.now = NOW + 10 * 60 * 1000 + 1;
    assert.equal(await pollConnect(connect), 'none');
    assert.equal(ended.value, undefined);

    ended.value = { request: 'req_1', outcome: 'expired', at: NOW };
    await forgetConnect(connect);
    assert.equal(ended.value, undefined);
  });

  it('reads back how a request ended, and nothing else', () => {
    assert.deepEqual(parseEnded({ request: 'r', outcome: 'expired', at: 1 }), {
      request: 'r',
      outcome: 'expired',
      at: 1,
    });
    for (const broken of [
      null,
      { request: 'r', outcome: 'waiting', at: 1 },
      { request: 'r', outcome: 'refused' },
      { outcome: 'refused', at: 1 },
    ]) {
      assert.equal(parseEnded(broken), undefined, JSON.stringify(broken));
    }
  });
});
