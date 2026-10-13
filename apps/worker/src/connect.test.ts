import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_BROWSER_LENGTH,
  UNNAMED_BROWSER,
  WORDS,
  createClaim,
  createConnectionId,
  createRequestId,
  drawWord,
  isClaim,
  isConnectionId,
  isRequestId,
  normalizeWord,
  readBrowserLabel,
  stateOf,
} from './connect.ts';
import { signIdentityToken, verifyIdentityToken } from './identity.ts';
import { identityOf } from './session-rows.ts';
import { mintAccessToken } from './session.ts';

/**
 * The parts of FRU-238 that hold with no database: the values a request is made of, the word, the
 * label, the state, and the token of a session of an account. The routes and the store are in
 * `connect-routes.test.ts` and `connect-postgres.test.ts`.
 */

const SECRET = 'a-worker-secret-of-exactly-enough';

describe('the values of a request (FRU-238)', () => {
  it('makes a request id of 128 bits and a claim of 256, each new, and reads only their own shape', () => {
    const requests = new Set(Array.from({ length: 500 }, createRequestId));
    const claims = new Set(Array.from({ length: 500 }, createClaim));
    assert.equal(requests.size, 500);
    assert.equal(claims.size, 500);
    for (const request of requests) assert.equal(Buffer.from(request, 'base64url').length, 16);
    for (const claim of claims) assert.equal(Buffer.from(claim, 'base64url').length, 32);

    const [request] = requests as unknown as [string];
    const [claim] = claims as unknown as [string];
    assert.ok(isRequestId(request) && isClaim(claim) && isConnectionId(createConnectionId()));
    // A claim is never a request, and the other way round: one cannot stand for the other.
    assert.equal(isRequestId(claim), false);
    assert.equal(isClaim(request), false);
    for (const wrong of [claim.slice(1), `${claim}A`, `${claim.slice(1)}+`, `${claim.slice(1)}/`, '', 42, undefined]) {
      assert.equal(isClaim(wrong), false, String(wrong));
    }
    for (const wrong of [request.slice(1), `${request}A`, `${request.slice(1)}.`, null]) {
      assert.equal(isRequestId(wrong), false, String(wrong));
    }
  });

  it('draws a word of the list and two digits, every word and every number, and no word of the hour', () => {
    const drawn = Array.from({ length: 20_000 }, drawWord);
    for (const word of drawn) assert.match(word, /^[A-Z]+ [0-9]{2}$/);
    const words = new Set(drawn.map((word) => word.split(' ')[0]));
    const digits = new Set(drawn.map((word) => word.split(' ')[1]));

    // 20,000 draws of 64 words and 100 numbers: each is drawn, or the draw is not uniform.
    assert.deepEqual([...words].sort(), [...WORDS].sort());
    assert.equal(digits.size, 100);
    // Drawn in one instant, and still apart: nothing reads the clock.
    assert.ok(new Set(drawn.slice(0, 50)).size > 40);
  });

  it('has 64 words in capitals, none twice, none the start of another', () => {
    assert.equal(WORDS.length, 64);
    assert.equal(new Set(WORDS).size, 64);
    for (const word of WORDS) {
      assert.match(word, /^[A-Z]{3,6}$/);
      for (const other of WORDS) if (other !== word) assert.equal(other.startsWith(word), false, `${word} ${other}`);
    }
  });

  it('reads a word as a person types it', () => {
    for (const typed of ['PLUM 47', 'plum 47', ' Plum  47 ', 'plum47', 'PLUM-47', 'plum\t47']) {
      assert.equal(normalizeWord(typed), 'PLUM 47', typed);
    }
    for (const other of ['PLUM 48', 'PLUMS 47', 'PLUM 4', 'PLUM', '47'])
      assert.notEqual(normalizeWord(other), 'PLUM 47');
  });

  it('keeps a label on one line, with no control and no mark of direction, and short', () => {
    assert.equal(readBrowserLabel('Chrome on macOS'), 'Chrome on macOS');
    assert.equal(readBrowserLabel(' Firefox\r\n on\tLinux '), 'Firefox on Linux');
    assert.equal(readBrowserLabel('\u202eSOcam no emorhC'), 'SOcam no emorhC');
    assert.equal(readBrowserLabel('a\u2066b\u2069c\u200fd\u00ade'), 'abcde');
    assert.equal(readBrowserLabel('Edge\u0000\u0007 on Windows'), 'Edge on Windows');
    assert.equal([...readBrowserLabel('é'.repeat(100))].length, MAX_BROWSER_LENGTH);
    for (const nothing of ['', '   ', '\u200b', 7, null, undefined, {}, ['Chrome']]) {
      assert.equal(readBrowserLabel(nothing), UNNAMED_BROWSER, JSON.stringify(nothing));
    }
  });

  it('says where a request stands, an approved one that nobody claimed in time included', () => {
    const row = { word: 'PLUM 47', browser: 'A browser', createdAt: 0, expiresAt: 100, misses: 0 };
    assert.equal(stateOf(row, 99), 'pending');
    assert.equal(stateOf(row, 100), 'expired');
    assert.equal(stateOf({ ...row, outcome: 'approved', account: 'a' }, 99), 'approved');
    assert.equal(stateOf({ ...row, outcome: 'approved', account: 'a' }, 100), 'expired');
    assert.equal(stateOf({ ...row, outcome: 'refused' }, 99), 'refused');
    assert.equal(stateOf({ ...row, outcome: 'refused' }, 100), 'refused');
    assert.equal(stateOf({ ...row, outcome: 'approved', claimedAt: 50 }, 100), 'claimed');
  });
});

describe('the token of a session of an account (FRU-238)', () => {
  it('names the account and no workspace, and says so in a claim the worker alone writes', async () => {
    const now = Date.now();
    const token = await mintAccessToken({ subject: 'acc_alice', email: 'alice@acme.dev', account: true }, SECRET, now);

    const verified = await verifyIdentityToken(token, SECRET, now);
    assert.ok(verified.ok);
    assert.deepEqual(verified, {
      ok: true,
      reporter: { id: 'acc_alice', email: 'alice@acme.dev', verified: true },
      account: true,
    });
    const payload = JSON.parse(Buffer.from(token.split('.')[1] as string, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    assert.equal(payload.scope, 'account');
    assert.equal('ws' in payload, false);
  });

  it('refuses to mint a token of an account that names a workspace too', async () => {
    await assert.rejects(
      () => mintAccessToken({ subject: 'acc_alice', workspace: 'ws_acme', account: true }, SECRET, Date.now()),
      /names no workspace/,
    );
  });

  it('refuses a token with a scope it does not write, or with the scope of an account beside a workspace', async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    for (const claims of [
      { sub: 'acc_alice', exp, scope: 'account', ws: 'ws_acme' },
      { sub: 'acc_alice', exp, scope: 'admin' },
      { sub: 'acc_alice', exp, scope: true },
    ]) {
      const token = await signIdentityToken(claims as never, SECRET);
      assert.deepEqual(
        await verifyIdentityToken(token, SECRET),
        { ok: false, reason: 'invalid-claims' },
        JSON.stringify(claims),
      );
    }
    // The control: a token of a workspace, and one of an account, verify.
    for (const claims of [
      { sub: 'acc_alice', exp, ws: 'ws_acme' },
      { sub: 'acc_alice', exp, scope: 'account' },
    ]) {
      assert.equal((await verifyIdentityToken(await signIdentityToken(claims as never, SECRET), SECRET)).ok, true);
    }
  });

  it('reads a row of a session of an account only when it names its own person and no workspace', () => {
    assert.deepEqual(identityOf({ subject: 'acc_alice', account_id: 'acc_alice', workspace: null }), {
      subject: 'acc_alice',
      account: true,
    });
    assert.equal(identityOf({ subject: 'acc_alice', account_id: 'acc_mallory', workspace: null }), undefined);
    assert.equal(identityOf({ subject: 'acc_alice', account_id: 'acc_alice', workspace: 'ws_acme' }), undefined);
    // A row of before, or of a pairing: no account.
    assert.deepEqual(identityOf({ subject: 'acc_alice', workspace: 'ws_acme' }), {
      subject: 'acc_alice',
      workspace: 'ws_acme',
    });
    assert.deepEqual(identityOf({ subject: 'acc_alice', account_id: null, workspace: 'ws_acme' }), {
      subject: 'acc_alice',
      workspace: 'ws_acme',
    });
  });
});
