import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
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

/**
 * Signs any header and payload bytes with HS256, so a test can build a token whose signature is valid
 * but whose content the typed API would never produce.
 */
function signRaw(header: unknown, payload: string, secret: string = SECRET): string {
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(payload).toString('base64url');
  const signature = createHmac('sha256', secret).update(`${encodedHeader}.${encodedPayload}`).digest('base64url');

  return `${encodedHeader}.${encodedPayload}.${signature}`;
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

  it('refuses a token with its signature removed', async () => {
    // With no length check, an empty signature compares zero bytes and passes: any payload would verify.
    const token = await signIdentityToken({ sub: 'user_1', name: 'CEO', exp: inSeconds(HOUR) }, SECRET);
    const [header, payload] = token.split('.') as [string, string];

    assert.deepEqual(await verifyIdentityToken(`${header}.${payload}.`, SECRET), {
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('refuses a token with a truncated signature', async () => {
    // A correct prefix of the signature is not the signature.
    const token = await signIdentityToken({ sub: 'user_1', exp: inSeconds(HOUR) }, SECRET);
    const [header, payload, signature] = token.split('.') as [string, string, string];

    for (const kept of [1, 22, signature.length - 4]) {
      assert.deepEqual(
        await verifyIdentityToken(`${header}.${payload}.${signature.slice(0, kept)}`, SECRET),
        { ok: false, reason: 'bad-signature' },
        `a signature cut to ${kept} characters should be refused`,
      );
    }
  });

  it('refuses a token longer than 4096 characters, even when it is correctly signed', async () => {
    const token = await signIdentityToken({ sub: 'user_42', name: 'x'.repeat(4096), exp: inSeconds(HOUR) }, SECRET);
    assert.ok(token.length > 4096);

    assert.deepEqual(await verifyIdentityToken(token, SECRET), { ok: false, reason: 'malformed' });
  });

  it('accepts a token of exactly 4096 characters', async () => {
    // The limit is inclusive. Pad the name until the token is exactly at the limit.
    let token = '';
    for (let length = 2900; token.length < 4096; length += 1) {
      token = await signIdentityToken({ sub: 'user_42', name: 'x'.repeat(length), exp: inSeconds(HOUR) }, SECRET);
    }
    assert.equal(token.length, 4096);

    assert.equal((await verifyIdentityToken(token, SECRET)).ok, true);
  });

  it('refuses a correctly signed token with no subject, or an empty one', async () => {
    // A verified reporter with no identity. The signature is good; the claims are not.
    for (const sub of [undefined, '', 42, null]) {
      const token = await signToken(
        { ...(sub === undefined ? {} : { sub }), name: 'CEO', exp: inSeconds(HOUR) },
        SECRET,
      );

      assert.deepEqual(
        await verifyIdentityToken(token, SECRET),
        { ok: false, reason: 'invalid-claims' },
        `sub ${JSON.stringify(sub)} should be refused`,
      );
    }
  });

  it('refuses a correctly signed token whose expiry is not a finite number', async () => {
    for (const exp of ['"9999999999"', 'null']) {
      const token = signRaw({ alg: 'HS256', typ: 'JWT' }, `{"sub":"user_42","exp":${exp}}`);

      assert.deepEqual(
        await verifyIdentityToken(token, SECRET),
        { ok: false, reason: 'invalid-claims' },
        `exp ${exp} should be refused`,
      );
    }
  });

  it('refuses a correctly signed token that never expires', async () => {
    // JSON.parse reads 1e309 as Infinity, and Infinity is later than any clock.
    const token = signRaw({ alg: 'HS256', typ: 'JWT' }, '{"sub":"user_42","exp":1e309}');

    assert.deepEqual(await verifyIdentityToken(token, SECRET), { ok: false, reason: 'invalid-claims' });
  });

  it('accepts a token that expired less than a minute ago', async () => {
    // The clock of the client site may run fast by up to a minute.
    const now = 1_800_000_000_000;
    const token = await signIdentityToken({ sub: 'user_42', exp: now / 1000 - 30 }, SECRET);

    assert.equal((await verifyIdentityToken(token, SECRET, now)).ok, true);
  });

  it('refuses a token that expired exactly a minute ago, and later', async () => {
    const now = 1_800_000_000_000;

    for (const ago of [60, 61, 3600]) {
      const token = await signIdentityToken({ sub: 'user_42', exp: now / 1000 - ago }, SECRET);

      assert.deepEqual(
        await verifyIdentityToken(token, SECRET, now),
        { ok: false, reason: 'expired' },
        `expired ${ago} s ago should be refused`,
      );
    }
    const almost = await signIdentityToken({ sub: 'user_42', exp: now / 1000 - 59 }, SECRET);
    assert.equal((await verifyIdentityToken(almost, SECRET, now)).ok, true);
  });

  it('accepts a token issued up to a minute in the future, and refuses one issued later', async () => {
    const now = 1_800_000_000_000;
    const exp = now / 1000 + 3600;

    const atLimit = await signIdentityToken({ sub: 'user_42', exp, iat: now / 1000 + 60 }, SECRET);
    assert.equal((await verifyIdentityToken(atLimit, SECRET, now)).ok, true);

    const beyond = await signIdentityToken({ sub: 'user_42', exp, iat: now / 1000 + 61 }, SECRET);
    assert.deepEqual(await verifyIdentityToken(beyond, SECRET, now), { ok: false, reason: 'not-yet-valid' });
  });

  it('refuses a header whose type is not JWT, and accepts one with no type', async () => {
    const payload = JSON.stringify({ sub: 'user_42', exp: inSeconds(HOUR) });

    assert.deepEqual(await verifyIdentityToken(signRaw({ alg: 'HS256', typ: 'JOSE' }, payload), SECRET), {
      ok: false,
      reason: 'malformed',
    });
    assert.equal((await verifyIdentityToken(signRaw({ alg: 'HS256' }, payload), SECRET)).ok, true);
  });

  it('refuses a header that is JSON but not an object', async () => {
    for (const header of [null, 42, 'HS256']) {
      const token = signRaw(header, JSON.stringify({ sub: 'user_42', exp: inSeconds(HOUR) }));

      assert.deepEqual(
        await verifyIdentityToken(token, SECRET),
        { ok: false, reason: 'malformed' },
        `header ${JSON.stringify(header)} should be refused`,
      );
    }
  });

  it('refuses a correctly signed payload that is JSON but not an object', async () => {
    for (const payload of ['null', '42', '"user_42"']) {
      assert.deepEqual(
        await verifyIdentityToken(signRaw({ alg: 'HS256', typ: 'JWT' }, payload), SECRET),
        { ok: false, reason: 'malformed' },
        `payload ${payload} should be refused`,
      );
    }
  });

  it('refuses a correctly signed payload that is not JSON', async () => {
    assert.deepEqual(await verifyIdentityToken(signRaw({ alg: 'HS256', typ: 'JWT' }, 'sub=user_42'), SECRET), {
      ok: false,
      reason: 'malformed',
    });
  });

  it('reports the workspace of a session token beside the reporter', async () => {
    const token = await signIdentityToken({ sub: 'user_42', exp: inSeconds(HOUR), ws: 'ws_1' }, SECRET);

    const result = await verifyIdentityToken(token, SECRET);

    assert.ok(result.ok);
    assert.equal(result.workspace, 'ws_1');
    assert.deepEqual(result.reporter, { id: 'user_42', verified: true });
  });

  it('leaves out an empty name, email or workspace', async () => {
    const token = await signIdentityToken(
      { sub: 'user_42', name: '', email: '', ws: '', exp: inSeconds(HOUR) },
      SECRET,
    );

    assert.deepEqual(await verifyIdentityToken(token, SECRET), {
      ok: true,
      reporter: { id: 'user_42', verified: true },
    });
  });
});

/**
 * The key made from a secret cannot be exported (FRU-190). WebCrypto keeps the bytes of a key that
 * is not extractable out of reach of any code that holds the `CryptoKey`: `exportKey` refuses it.
 * The key never leaves `hmac`, so no answer of the worker shows the flag. This case reads the keys
 * that `importKey` hands back, and a mutation run counts `extractable: true` killed by an assertion,
 * not by running out of time.
 */
describe('the signing key', () => {
  it('cannot be exported, when a token is signed and when one is verified', async (t) => {
    const keys: CryptoKey[] = [];
    const importKey = crypto.subtle.importKey.bind(crypto.subtle);
    t.mock.method(crypto.subtle, 'importKey', async (...args: Parameters<typeof importKey>) => {
      const key = await importKey(...args);
      keys.push(key);

      return key;
    });

    const token = await signIdentityToken({ sub: 'user_42', exp: inSeconds(HOUR) }, SECRET);
    assert.equal((await verifyIdentityToken(token, SECRET)).ok, true);

    assert.equal(keys.length, 2);
    for (const key of keys) {
      assert.equal(key.extractable, false);
      await assert.rejects(crypto.subtle.exportKey('raw', key));
    }
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
