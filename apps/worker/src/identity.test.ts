import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readBearerToken, signIdentityToken, stripClaimedVerification, verifyIdentityToken } from './identity.ts';

const SECRET = 'a-secret-long-enough-to-not-be-guessed';
const HOUR = 3_600_000;

function inSeconds(fromNow: number): number {
  return Math.floor((Date.now() + fromNow) / 1000);
}

/** Signs claims the typed API would refuse, so the verifier's own checks can be exercised. */
async function signToken(claims: Record<string, unknown>, secret: string): Promise<string> {
  return signIdentityToken(claims as unknown as Parameters<typeof signIdentityToken>[0], secret);
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
    const [header, , signature] = token.split('.') as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ sub: 'user_1', name: 'CEO', exp: inSeconds(HOUR) })).toString(
      'base64url',
    );

    assert.deepEqual(await verifyIdentityToken(`${header}.${forged}.${signature}`, SECRET), {
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('refuses an expired token', async () => {
    const token = await signIdentityToken({ sub: 'user_42', exp: inSeconds(-HOUR) }, SECRET);

    assert.deepEqual(await verifyIdentityToken(token, SECRET), { ok: false, reason: 'expired' });
  });

  it('refuses a token with no expiry, because that is a password', async () => {
    const token = await signToken({ sub: 'user_42' }, SECRET);

    assert.deepEqual(await verifyIdentityToken(token, SECRET), { ok: false, reason: 'invalid-claims' });
  });

  it('refuses a token dated in the future', async () => {
    const token = await signIdentityToken({ sub: 'user_42', exp: inSeconds(2 * HOUR), iat: inSeconds(HOUR) }, SECRET);

    assert.deepEqual(await verifyIdentityToken(token, SECRET), { ok: false, reason: 'not-yet-valid' });
  });

  it('refuses anything that is not three segments', async () => {
    for (const value of ['', 'nope', 'a.b', 'a.b.c.d', '..', 'a.b.']) {
      const result = await verifyIdentityToken(value, SECRET);
      assert.equal(result.ok, false, `${value} should be refused`);
    }
  });

  it('refuses `alg: none`, which is the whole reason to check the header', async () => {
    // The classic JWT forgery: drop the signature, say the token is unsigned, and a verifier that
    // reads its algorithm out of the token believes it. Refused before the signature is looked at.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'user_1', name: 'CEO', exp: inSeconds(HOUR) })).toString(
      'base64url',
    );

    assert.deepEqual(await verifyIdentityToken(`${header}.${payload}.`, SECRET), {
      ok: false,
      reason: 'unsupported-alg',
    });
  });

  it('refuses an algorithm it does not verify, rather than trying', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS512', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'user_1', exp: inSeconds(HOUR) })).toString('base64url');
    const signature = (await signIdentityToken({ sub: 'user_1', exp: inSeconds(HOUR) }, SECRET)).split('.')[2];

    assert.deepEqual(await verifyIdentityToken(`${header}.${payload}.${signature}`, SECRET), {
      ok: false,
      reason: 'unsupported-alg',
    });
  });

  it('signs the header as well as the payload', async () => {
    // Swapping the header of a valid token has to break the signature: the signing input is
    // `header.payload`, not the payload alone.
    const token = await signIdentityToken({ sub: 'user_42', exp: inSeconds(HOUR) }, SECRET);
    const [, payload, signature] = token.split('.') as [string, string, string];
    const rewritten = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'other' })).toString('base64url');

    assert.deepEqual(await verifyIdentityToken(`${rewritten}.${payload}.${signature}`, SECRET), {
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('is a standard compact JWS any library can read', async () => {
    const token = await signIdentityToken({ sub: 'user_42', exp: inSeconds(HOUR) }, SECRET);
    const [header] = token.split('.') as [string];

    assert.equal(token.split('.').length, 3);
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'HS256', typ: 'JWT' });
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
