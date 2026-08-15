import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readBearerToken, signIdentityToken, stripClaimedVerification, verifyIdentityToken } from './identity.ts';

const SECRET = 'a-secret-long-enough-to-not-be-guessed';
const HOUR = 3_600_000;

function inSeconds(fromNow: number): number {
  return Math.floor((Date.now() + fromNow) / 1000);
}

describe('verifyIdentityToken', () => {
  it('accepts a token this worker could have minted, and reports what it says', async () => {
    const token = await signIdentityToken(
      { sub: 'user_42', name: 'Alice', email: 'alice@acme.test', exp: inSeconds(HOUR) },
      SECRET,
    );

    const result = await verifyIdentityToken(token, SECRET);

    assert.ok(result.ok);
    assert.deepEqual(result.reporter, {
      id: 'user_42',
      name: 'Alice',
      email: 'alice@acme.test',
      verified: true,
    });
  });

  it('refuses a token signed with another secret', async () => {
    const token = await signIdentityToken({ sub: 'user_42', exp: inSeconds(HOUR) }, 'someone-elses-secret-value-here');

    assert.deepEqual(await verifyIdentityToken(token, SECRET), { ok: false, reason: 'bad-signature' });
  });

  it('refuses a payload edited after signing', async () => {
    // The attack this exists for: take a valid token, rewrite the name, keep the signature.
    const token = await signIdentityToken({ sub: 'user_42', name: 'Alice', exp: inSeconds(HOUR) }, SECRET);
    const [, signature] = token.split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ sub: 'user_1', name: 'CEO', exp: inSeconds(HOUR) })).toString(
      'base64url',
    );

    assert.deepEqual(await verifyIdentityToken(`${forged}.${signature}`, SECRET), {
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('refuses an expired token', async () => {
    const token = await signIdentityToken({ sub: 'user_42', exp: inSeconds(-HOUR) }, SECRET);

    assert.deepEqual(await verifyIdentityToken(token, SECRET), { ok: false, reason: 'expired' });
  });

  it('refuses a token with no expiry, because that is a password', async () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'user_42' })).toString('base64url');
    const token = `${payload}.${(await signIdentityToken({ sub: 'x', exp: 1 }, SECRET)).split('.')[1]}`;

    const result = await verifyIdentityToken(token, SECRET);

    assert.equal(result.ok, false);
  });

  it('refuses anything that is not two parts', async () => {
    for (const value of ['', 'nope', 'a.b.c', '.', 'a.']) {
      const result = await verifyIdentityToken(value, SECRET);
      assert.equal(result.ok, false, `${value} should be refused`);
    }
  });

  it('ignores a name in the seed and reports only what the token says', async () => {
    // A page can claim one identity in the seed and hold a token for another. The token wins, whole:
    // merging them would let a claim ride into Linear under a verified banner.
    const token = await signIdentityToken({ sub: 'user_42', exp: inSeconds(HOUR) }, SECRET);

    const result = await verifyIdentityToken(token, SECRET);

    assert.ok(result.ok);
    assert.deepEqual(result.reporter, { id: 'user_42', verified: true });
  });
});

describe('stripClaimedVerification', () => {
  it('removes a verified flag the client tried to assert', () => {
    // The whole check. A browser posting this would otherwise read in Linear as an identity the
    // worker vouched for.
    assert.deepEqual(stripClaimedVerification({ name: 'CEO', verified: true }), { name: 'CEO' });
  });

  it('keeps what the client may legitimately say', () => {
    assert.deepEqual(stripClaimedVerification({ name: 'Alice', email: 'alice@acme.test' }), {
      name: 'Alice',
      email: 'alice@acme.test',
    });
  });

  it('drops a reporter that said nothing but verified', () => {
    assert.equal(stripClaimedVerification({ verified: true }), undefined);
  });

  it('leaves an absent reporter absent', () => {
    assert.equal(stripClaimedVerification(undefined), undefined);
  });
});

describe('readBearerToken', () => {
  it('reads the token out of an Authorization header', () => {
    assert.equal(readBearerToken('Bearer abc.def'), 'abc.def');
    assert.equal(readBearerToken('bearer abc.def'), 'abc.def');
  });

  it('is undefined for anything else', () => {
    for (const value of [null, '', 'abc.def', 'Basic abc', 'Bearer', 'Bearer a b']) {
      assert.equal(readBearerToken(value), undefined, `${value} is not a bearer token`);
    }
  });
});
