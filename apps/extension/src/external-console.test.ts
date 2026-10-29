import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ConnectSeams, EndedConnect, PendingConnect } from './connect.ts';
import type { ClaimResult, SessionResponse, StoredSession } from './session.ts';
import {
  DEFAULT_CONSOLE,
  type ExternalSender,
  acceptedExternal,
  cloudConsole,
  createExternalConsole,
  externallyConnectable,
  fromConsole,
  parseExternalMessage,
} from './external-console.ts';

const CLOUD = 'https://api.fruitback.test';
const CONSOLE = 'https://app.fruitback.test';
const NOW = 1_700_000_000_000;
const STARTED = {
  request: 'req_1',
  claim: 'claim-secret-1',
  word: 'PLUM 47',
  verificationUri: `${CONSOLE}/connect/req_1`,
  expiresIn: 900,
  interval: 5,
};
const SENDER: ExternalSender = { origin: CONSOLE, url: `${CONSOLE}/setup`, frameId: 0, tab: { id: 7 } };

describe('the console that may talk to the extension, fixed at build (FRU-487)', () => {
  it('is the console of the Cloud for the build of the store, and none for a self-hosted build', () => {
    assert.equal(cloudConsole(undefined, undefined), DEFAULT_CONSOLE);
    assert.equal(DEFAULT_CONSOLE, 'https://app.fruitback.com');
    // A build for a self-hosted instance names no Cloud: no console either, whatever is asked.
    assert.equal(cloudConsole(undefined, ''), undefined);
    assert.equal(cloudConsole('https://app.fruitback.com', ''), undefined);
    // Another Cloud names its console, or has none.
    assert.equal(cloudConsole(undefined, CLOUD), undefined);
    assert.equal(cloudConsole('', undefined), undefined);
  });

  it('takes one exact origin of the site of the Cloud, and the loopback of the dev loop', () => {
    assert.equal(cloudConsole(CONSOLE, CLOUD), CONSOLE);
    assert.equal(cloudConsole(`${CONSOLE}/`, CLOUD), CONSOLE);
    assert.equal(cloudConsole('http://localhost:5178', 'http://localhost:8789'), 'http://localhost:5178');
  });

  it('stops the build on a joker, a path, another site, or plain http', () => {
    for (const wrong of [
      'https://*.fruitback.test',
      '*://app.fruitback.test',
      'https://app.fruitback.test/*',
      'https://app.fruitback.test/setup',
      'https://app.fruitback.test?x=1',
      'https://app.fruitback.test#x',
      'https://user@app.fruitback.test',
      'http://app.fruitback.test',
      'https://app.fruitback.test.evil.example',
      'https://evil.example',
      'not a url',
    ]) {
      assert.throws(() => cloudConsole(wrong, CLOUD), /WXT_FRUITBACK_CONSOLE/, wrong);
    }
  });

  it('is in the manifest of Chromium only, as one pattern on the exact host', () => {
    assert.deepEqual(externallyConnectable(CONSOLE, 'chromium'), { matches: [`${CONSOLE}/*`] });
    assert.equal(externallyConnectable(CONSOLE, 'firefox'), undefined);
    assert.equal(externallyConnectable(CONSOLE, 'safari'), undefined);
    assert.equal(externallyConnectable(undefined, 'chromium'), undefined);
  });

  it('is written by the build hook of the manifest, from the same function', () => {
    const config = readFileSync(new URL('../wxt.config.ts', import.meta.url), 'utf8');
    assert.match(config, /cloudConsole\(process\.env\.WXT_FRUITBACK_CONSOLE, process\.env\.WXT_FRUITBACK_CLOUD\)/);
    assert.match(config, /externallyConnectable\(CONSOLE, family\)/);
    // No other place writes the key: a joker would slip in there. Its one line names it twice.
    assert.equal(config.match(/externally_connectable/g)?.length, 2);
    assert.match(config, /\.externally_connectable = connectable;/);
  });
});

describe('a message of the console, key by key (FRU-487)', () => {
  it('takes the three messages of version 1', () => {
    assert.deepEqual(parseExternalMessage({ type: 'fruitback:hello', v: 1 }), { kind: 'hello' });
    assert.deepEqual(parseExternalMessage({ type: 'fruitback:connect', v: 1 }), { kind: 'connect' });
    assert.deepEqual(parseExternalMessage({ type: 'fruitback:claim', v: 1, request: 'req_1' }), {
      kind: 'claim',
      request: 'req_1',
    });
  });

  it('refuses a key more, a key less, another version, another type, and a request that is not one', () => {
    for (const wrong of [
      null,
      'fruitback:hello',
      [{ type: 'fruitback:hello', v: 1 }],
      { type: 'fruitback:hello' },
      { type: 'fruitback:hello', v: 2 },
      { type: 'fruitback:hello', v: '1' },
      { type: 'fruitback:hello', v: 1, endpoint: 'https://evil.example' },
      { type: 'fruitback:connect', v: 1, claim: 'x' },
      { type: 'fruitback:claim', v: 1 },
      { type: 'fruitback:claim', v: 1, request: 'req 1' },
      { type: 'fruitback:claim', v: 1, request: 'a'.repeat(201) },
      { type: 'fruitback:claim', v: 1, request: 'req_1', claim: 'x' },
      { type: 'fruitback:pair', v: 1 },
      { type: 'toString', v: 1 },
      { type: '__proto__', v: 1 },
      Object.assign(Object.create({ inherited: true }), { type: 'fruitback:hello', v: 1 }),
    ]) {
      assert.equal(parseExternalMessage(wrong), undefined, JSON.stringify(wrong));
    }
  });
});

describe('the sender of a message (FRU-487)', () => {
  it('is the top frame of a tab of the console', () => {
    assert.equal(fromConsole(SENDER, CONSOLE), true);
  });

  it('is refused from another origin, a frame, no tab, another extension, or a build with no console', () => {
    assert.equal(fromConsole({ ...SENDER, origin: 'https://evil.example' }, CONSOLE), false);
    assert.equal(fromConsole({ ...SENDER, origin: 'https://app.fruitback.test.evil.example' }, CONSOLE), false);
    assert.equal(fromConsole({ ...SENDER, url: 'https://evil.example/' }, CONSOLE), false);
    assert.equal(fromConsole({ ...SENDER, frameId: 3 }, CONSOLE), false);
    assert.equal(fromConsole({ origin: CONSOLE, url: `${CONSOLE}/`, frameId: 0 }, CONSOLE), false);
    assert.equal(
      fromConsole(
        { id: 'another', origin: 'chrome-extension://another', url: 'chrome-extension://another/x' },
        CONSOLE,
      ),
      false,
    );
    assert.equal(fromConsole({ ...SENDER, url: 'not a url' }, CONSOLE), false);
    assert.equal(fromConsole(SENDER, undefined), false);
  });

  it('is decided before any answer, and only in a build that signs in to a Cloud', () => {
    const hello = { type: 'fruitback:hello', v: 1 };
    assert.deepEqual(acceptedExternal(hello, SENDER, { console: CONSOLE, cloud: CLOUD }), { kind: 'hello' });
    assert.equal(acceptedExternal(hello, SENDER, { console: CONSOLE, cloud: undefined }), undefined);
    assert.equal(acceptedExternal(hello, { ...SENDER, frameId: 1 }, { console: CONSOLE, cloud: CLOUD }), undefined);
    assert.equal(acceptedExternal({ ...hello, v: 0 }, SENDER, { console: CONSOLE, cloud: CLOUD }), undefined);
  });
});

function fakes({
  answer = { status: 201, body: STARTED } as SessionResponse,
  claims = [] as ClaimResult[],
  held = {} as Record<string, StoredSession>,
} = {}) {
  const state = { now: NOW, held, pending: undefined as PendingConnect | undefined };
  const posted: string[] = [];
  const claimed: string[] = [];
  const ended: { value: EndedConnect | undefined } & NonNullable<ConnectSeams['ended']> = {
    value: undefined,
    read: async () => ended.value,
    write: async (next) => {
      ended.value = next;
    },
  };
  const connect: ConnectSeams = {
    pending: {
      read: async () => state.pending,
      write: async (next) => {
        state.pending = next;
      },
    },
    ended,
    browser: 'Chrome on macOS',
    now: () => state.now,
    wait: async () => undefined,
    post: async (url) => {
      posted.push(url);

      return answer;
    },
    sessions: {
      list: async () => state.held,
      claim: async (_endpoint, claim) => {
        claimed.push(claim);
        const next = claims.shift() ?? { ok: false, reason: 'waiting' };
        if (next.ok)
          state.held = { ...state.held, [CLOUD]: { refreshToken: 'r', identity: { subject: 'u' }, epoch: 'e2' } };

        return next;
      },
    },
  };
  const answerConsole = createExternalConsole({ console: CONSOLE, cloud: CLOUD, connect, now: () => state.now });

  return { answerConsole, state, posted, claimed };
}

describe('the answers to the console (FRU-487)', () => {
  it('says the extension is here, and whether it is signed in, and nothing else', async () => {
    const { answerConsole, state } = fakes();
    assert.deepEqual(await answerConsole({ kind: 'hello' }), { v: 1, ok: true, signedIn: false });
    state.held = { [CLOUD]: { refreshToken: 'r', identity: { subject: 'u', email: 'ana@acme.dev' }, epoch: 'e' } };
    assert.deepEqual(await answerConsole({ kind: 'hello' }), { v: 1, ok: true, signedIn: true });
  });

  it('starts a request with the Cloud and answers its id: the claim and the word stay here', async () => {
    const { answerConsole, state, posted } = fakes();
    const answer = await answerConsole({ kind: 'connect' });

    assert.deepEqual(answer, { v: 1, ok: true, request: 'req_1' });
    assert.deepEqual(posted, [`${CLOUD}/session/connect`]);
    assert.equal(state.pending?.claim, 'claim-secret-1');
    assert.doesNotMatch(JSON.stringify(answer), /claim-secret|PLUM/);
    // A second ask takes the request that waits: one request at a time, and no call to the worker.
    assert.deepEqual(await answerConsole({ kind: 'connect' }), { v: 1, ok: true, request: 'req_1' });
    assert.equal(posted.length, 1);
  });

  it('refuses to start while the browser holds a session of the Cloud', async () => {
    const { answerConsole, posted } = fakes({
      held: { [CLOUD]: { refreshToken: 'r', identity: { subject: 'u' }, epoch: 'e' } },
    });
    assert.deepEqual(await answerConsole({ kind: 'connect' }), { v: 1, ok: false, reason: 'signed-in' });
    assert.deepEqual(posted, []);
  });

  it('refuses a request that another console approves', async () => {
    const { answerConsole } = fakes({
      answer: { status: 201, body: { ...STARTED, verificationUri: `https://other.fruitback.test/connect/req_1` } },
    });
    assert.deepEqual(await answerConsole({ kind: 'connect' }), { v: 1, ok: false, reason: 'unavailable' });
  });

  it('says the Cloud did not answer', async () => {
    const { answerConsole } = fakes({ answer: { status: 503, body: {} } });
    assert.deepEqual(await answerConsole({ kind: 'connect' }), { v: 1, ok: false, reason: 'unavailable' });
  });

  it('claims the request that waits, once per interval, and keeps the session', async () => {
    const { answerConsole, state, claimed } = fakes({
      claims: [
        { ok: false, reason: 'waiting' },
        { ok: true, identity: { subject: 'u' } },
      ],
    });
    await answerConsole({ kind: 'connect' });

    assert.deepEqual(await answerConsole({ kind: 'claim', request: 'req_1' }), { v: 1, ok: true, state: 'waiting' });
    // Asked again at once: the worker is not called.
    assert.deepEqual(await answerConsole({ kind: 'claim', request: 'req_1' }), { v: 1, ok: true, state: 'waiting' });
    assert.equal(claimed.length, 1);
    state.now += 5_000;
    assert.deepEqual(await answerConsole({ kind: 'claim', request: 'req_1' }), {
      v: 1,
      ok: true,
      state: 'signed-in',
    });
    assert.deepEqual(claimed, ['claim-secret-1', 'claim-secret-1']);
    assert.notEqual(state.held[CLOUD], undefined);
    assert.equal(state.pending, undefined);
    // Claimed already: the session held says so, with no call.
    assert.deepEqual(await answerConsole({ kind: 'claim', request: 'req_1' }), {
      v: 1,
      ok: true,
      state: 'signed-in',
    });
    assert.equal(claimed.length, 2);
  });

  it('claims no other request than the one that waits', async () => {
    const { answerConsole, claimed } = fakes();
    await answerConsole({ kind: 'connect' });
    assert.deepEqual(await answerConsole({ kind: 'claim', request: 'req_2' }), {
      v: 1,
      ok: false,
      reason: 'unknown-request',
    });
    assert.deepEqual(claimed, []);
  });
});
