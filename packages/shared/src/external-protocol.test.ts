import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EXTERNAL_CONNECT_STATES, EXTERNAL_REFUSALS, parseExternalAnswer } from './external-protocol.ts';

describe('an answer of the extension to the console (FRU-512)', () => {
  it('reads each answer the extension gives, and only its keys', () => {
    assert.deepEqual(parseExternalAnswer({ v: 1, ok: true, signedIn: false }), { v: 1, ok: true, signedIn: false });
    assert.deepEqual(parseExternalAnswer({ v: 1, ok: true, request: 'req_1', more: 1 }), {
      v: 1,
      ok: true,
      request: 'req_1',
    });
    for (const state of EXTERNAL_CONNECT_STATES) {
      assert.deepEqual(parseExternalAnswer({ v: 1, ok: true, state }), { v: 1, ok: true, state });
    }
    for (const reason of EXTERNAL_REFUSALS) {
      assert.deepEqual(parseExternalAnswer({ v: 1, ok: false, reason }), { v: 1, ok: false, reason });
    }
  });

  it('reads nothing of another version, of a value of the wrong kind, or of a word the protocol does not have', () => {
    for (const wrong of [
      undefined,
      null,
      'ok',
      {},
      { v: 2, ok: true, signedIn: true },
      { v: '1', ok: true, signedIn: true },
      { v: 1, ok: 'true', signedIn: true },
      { v: 1, ok: true, signedIn: 'yes' },
      { v: 1, ok: true, request: 7 },
      { v: 1, ok: true, state: 'done' },
      { v: 1, ok: true },
      { v: 1, ok: false, reason: 'nope' },
      { v: 1, ok: false },
      // Two answers in one: neither is read (review of the pull request).
      { v: 1, ok: true, signedIn: true, request: 'req_1' },
      { v: 1, ok: true, request: 'req_1', state: 'signed-in' },
      { v: 1, ok: true, signedIn: false, state: 'waiting' },
    ]) {
      assert.equal(parseExternalAnswer(wrong), undefined, JSON.stringify(wrong));
    }
  });
});
