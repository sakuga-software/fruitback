import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TransportRequest, TransportResponse } from './transport.ts';
import { callWorker, errorOf, noteWriteFailure } from './worker-client.ts';

const OK: TransportResponse = { ok: true, status: 200, body: '{}' };

/** A transport that records each request and answers `answer`. */
function recorder(answer: TransportResponse = OK) {
  const sent: TransportRequest[] = [];

  return {
    sent,
    transport: async (request: TransportRequest) => {
      sent.push(request);

      return answer;
    },
  };
}

const BASE = { endpoint: 'https://worker.test', clientId: 'acme' };

describe('callWorker (FRU-509)', () => {
  it('sends the token of the host in a header, and the type of a body', async () => {
    const { sent, transport } = recorder();

    await callWorker(
      { ...BASE, transport, identityToken: async () => 'token.1' },
      { url: 'https://worker.test/feedback', method: 'POST', contentType: 'application/json', body: '{}' },
    );

    assert.deepEqual(sent, [
      {
        url: 'https://worker.test/feedback',
        method: 'POST',
        body: '{}',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token.1' },
      },
    ]);
  });

  it('sends no header for a read with no token', async () => {
    const { sent, transport } = recorder();

    await callWorker({ ...BASE, transport }, { url: 'https://worker.test/feedback', method: 'GET' });

    assert.deepEqual(sent[0]?.headers, {});
  });

  it('asks for the token at each call, so an expired one is replaced', async () => {
    const { sent, transport } = recorder();
    let calls = 0;
    const options = { ...BASE, transport, identityToken: async () => `token.${++calls}` };

    await callWorker(options, { url: 'https://worker.test/a', method: 'GET' });
    await callWorker(options, { url: 'https://worker.test/b', method: 'GET' });

    assert.deepEqual(
      sent.map((request) => request.headers.Authorization),
      ['Bearer token.1', 'Bearer token.2'],
    );
  });

  /** The read of the page drops a read that a newer one replaced while the token was asked for. */
  it('sends nothing and answers undefined when the call is no longer wanted after the token', async () => {
    const { sent, transport } = recorder();
    let wanted = true;
    const options = {
      ...BASE,
      transport,
      identityToken: async () => {
        wanted = false;

        return 'token.1';
      },
    };

    const answer = await callWorker(options, { url: 'https://worker.test/feedback', method: 'GET' }, () => wanted);

    assert.equal(answer, undefined);
    assert.equal(sent.length, 0);
  });
});

describe('noteWriteFailure (FRU-509)', () => {
  const answer = (status: number, body = '{}'): TransportResponse => ({ ok: status < 400, status, body });

  it('reads 429 as wait, 401 as signed-out, another failure as retry, and a success as nothing', () => {
    assert.equal(noteWriteFailure(answer(429)), 'wait');
    assert.equal(noteWriteFailure(answer(401)), 'signed-out');
    assert.equal(noteWriteFailure(answer(500)), 'retry');
    assert.equal(noteWriteFailure(answer(404)), 'retry');
    assert.equal(noteWriteFailure(answer(200)), undefined);
  });

  it('reads a refusal only where the caller says so, and after 429 and 401', () => {
    const refuses = (response: TransportResponse) => response.status === 404 || response.status === 401;

    assert.equal(noteWriteFailure(answer(404), refuses), 'refused');
    assert.equal(noteWriteFailure(answer(401), refuses), 'signed-out');
  });
});

describe('errorOf', () => {
  it('reads the error of a JSON body, and nothing of another body', () => {
    assert.equal(errorOf('{"error":"check-in-progress"}'), 'check-in-progress');
    assert.equal(errorOf('<html>'), undefined);
  });
});
