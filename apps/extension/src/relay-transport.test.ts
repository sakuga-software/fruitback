import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRelayTransport, randomId } from './relay-transport.ts';
import {
  CHANNEL,
  type BridgeMessage,
  type RelayRequest,
  type RelayRequestMessage,
  type RelayResponse,
} from './protocol.ts';

/**
 * The three things that go wrong on a channel with correlation ids, none of which can be seen from
 * outside the browser: an answer resolving the wrong call, an answer arriving after nobody is
 * waiting, and two calls in flight at once. The widget reads and writes independently, so the last
 * one is the ordinary case rather than the exotic one.
 */

const READ: RelayRequest = { url: 'https://worker.test/feedback?url=x', method: 'GET', headers: {} };
const WRITE: RelayRequest = { url: 'https://worker.test/feedback', method: 'POST', headers: {}, body: '{}' };

function harness() {
  const posted: RelayRequestMessage[] = [];
  const listeners: ((message: BridgeMessage) => void)[] = [];
  const timers: { run: () => void; cancelled: boolean }[] = [];
  let minted = 0;

  const transport = createRelayTransport({
    post: (message) => void posted.push(message),
    subscribe: (listener) => void listeners.push(listener),
    newId: () => `id-${(minted += 1)}`,
    setTimer: (run) => {
      const timer = { run, cancelled: false };
      timers.push(timer);

      return () => {
        timer.cancelled = true;
      };
    },
  });

  const answer = (id: string, response: RelayResponse): void => {
    for (const listener of listeners) listener({ channel: CHANNEL, kind: 'relay-response', id, response });
  };

  return { transport, posted, listeners, timers, answer };
}

const OK: RelayResponse = { ok: true, status: 200, body: 'first' };

/** What a promise holds right now, without waiting for it. */
async function peek<T>(promise: Promise<T>): Promise<T | 'pending'> {
  for (let tick = 0; tick < 3; tick += 1) await Promise.resolve();

  return Promise.race([promise, Promise.resolve('pending' as const)]);
}

describe('createRelayTransport', () => {
  it('posts the request and answers with the response that carries its id', async () => {
    const { transport, posted, answer } = harness();
    const call = transport(READ);

    assert.partialDeepStrictEqual(posted, [{ channel: CHANNEL, kind: 'relay-request', id: 'id-1', request: READ }]);

    answer('id-1', OK);
    assert.deepEqual(await call, OK);
  });

  it('leaves a call waiting when the answer is for another one', async () => {
    const { transport, answer } = harness();
    const call = transport(READ);

    answer('id-99', OK);

    assert.equal(await peek(call), 'pending');
  });

  /**
   * The read and the write are independent, so both can be in flight. Answered in reverse order on
   * purpose: a single pending slot would pass this test in order and fail it here.
   */
  it('gives two calls at once their own answers', async () => {
    const { transport, answer } = harness();
    const read = transport(READ);
    const write = transport(WRITE);

    answer('id-2', { ok: true, status: 201, body: 'written' });
    answer('id-1', { ok: true, status: 200, body: 'read' });

    assert.deepEqual(await write, { ok: true, status: 201, body: 'written' });
    assert.deepEqual(await read, { ok: true, status: 200, body: 'read' });
  });

  it('subscribes once, however many calls it makes', async () => {
    const { transport, listeners, answer } = harness();
    void transport(READ);
    void transport(WRITE);
    answer('id-1', OK);
    answer('id-2', OK);

    assert.equal(listeners.length, 1);
  });

  /**
   * The failure this timeout exists for: the composer disables its send button while a submit is in
   * flight, so a call nobody answers leaves a reviewer with a dead button and a written note inside
   * it. A refusal is a failed call, and a failed call keeps the note.
   */
  it('gives up rather than leave a call unanswered for ever', async () => {
    const { transport, timers } = harness();
    const call = transport(WRITE);

    assert.equal(await peek(call), 'pending');
    timers[0]?.run();

    assert.deepEqual(await call, { ok: false, status: 0, body: 'relay-timeout' });
  });

  it('settles nobody when the answer arrives after the timeout', async () => {
    const { transport, timers, answer } = harness();
    const call = transport(READ);
    timers[0]?.run();
    answer('id-1', OK);

    assert.deepEqual(await call, { ok: false, status: 0, body: 'relay-timeout' });
  });

  it('cancels the timer once the answer is in', async () => {
    const { transport, timers, answer } = harness();
    const call = transport(READ);
    answer('id-1', OK);
    await call;

    assert.equal(timers[0]?.cancelled, true);
  });
});

/**
 * `crypto.randomUUID` is secure-context only and this runs on `http://` staging sites too, so the
 * branch that matters is the one a test on a modern machine would never take. Each is exercised by
 * handing `randomId` a source that has only what that branch needs.
 */
describe('randomId', () => {
  const sources = {
    randomUUID: { crypto: { randomUUID: () => '9f8b7c6d-1111-2222-3333-444455556666' } },
    'getRandomValues, on an http page': {
      crypto: { getRandomValues: (array: Uint8Array<ArrayBuffer>) => array.map((_, index) => index * 7) },
    },
    'no crypto at all': {},
  };

  for (const [name, source] of Object.entries(sources)) {
    it(`builds an id from ${name}`, () => {
      const id = randomId(source);

      assert.equal(id.length, 16, `${name} produced ${JSON.stringify(id)}`);
      assert.match(id, /^[0-9a-f]{16}$/, `${name} produced ${JSON.stringify(id)}`);
    });
  }

  it('does not hand two calls the same id', () => {
    const ids = new Set(Array.from({ length: 200 }, () => randomId(globalThis)));

    assert.equal(ids.size, 200);
  });
});
