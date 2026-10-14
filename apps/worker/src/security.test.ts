import { PROOF_GRACE_MS, RECHECK_MS } from './domain-proof.ts';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_FRESH_SECONDS, SESSION_RENEWAL_SECONDS, SESSION_TTL_SECONDS } from './auth.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ACCESS_TTL_SECONDS,
  CODE_ALPHABET,
  PAIRING_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
  createPairingCode,
  createRefreshToken,
} from './session.ts';
// The constants come from the modules, never from their text: a mutation run rewrites that text (FRU-179).
import { ALGORITHM, CLOCK_SKEW_SECONDS, MAX_TOKEN_BYTES, stripClaimedVerification } from './identity.ts';
import { DEFAULT_TRUSTED_PROXY_HOPS } from './env.ts';
import { DEFAULT_LIMIT } from './rate-limit.ts';
import {
  CONNECTS_PER_ADDRESS,
  POLL_WINDOW_SECONDS,
  CONNECT_TTL_SECONDS,
  CONNECT_WINDOW_MS,
  MAX_LIVE_REQUESTS,
  MAX_WORD_MISSES,
  WORDS,
  createClaim,
  createRequestId,
} from './connect.ts';
import { readConfig } from './env.ts';
import { handleRequest } from './app.ts';
import { beforePostgres } from './before-postgres.fixture.ts';

/**
 * `SECURITY.md` states numbers, and a security document that drifts from the code is worse than none
 * — it is a promise nobody is keeping.
 *
 * Every figure it quotes is built here from the constant it describes and looked for **in context**,
 * not as a bare number: `20` appears in a document for a dozen reasons, and matching it alone would
 * go green against a rate limit that had moved. What is asserted is the sentence.
 *
 * This cannot check a *property* that changed — a new route, a new thing stored in the clear, a
 * guarantee dropped. Those are a hand edit, and `CLAUDE.md` says so beside the rule.
 */

/**
 * Read by path, so say which path when it is not there.
 *
 * GitHub looks in `.github/SECURITY.md` as well as the root, so a later tidy-up can move this file
 * and leave the suite failing with a bare `ENOENT` that names a line of test code rather than the
 * thing that actually broke.
 */
function readSecurityDoc(): string {
  for (const candidate of ['../../../SECURITY.md', '../../../.github/SECURITY.md']) {
    try {
      return readFileSync(fileURLToPath(new URL(candidate, import.meta.url)), 'utf8');
    } catch {
      continue;
    }
  }

  assert.fail('SECURITY.md is in neither the repository root nor .github/; this suite asserts on it');
}

const SECURITY = readSecurityDoc();

/**
 * The reviewer's guide states the same lifetimes, in the reviewer's words (FRU-46).
 *
 * `docs/reviewing.md` tells somebody how long their pairing code is good for and what a log out
 * leaves behind, so it carries the three numbers `SECURITY.md` already carries — a second place for
 * them to drift, and this is what stops it. Each assertion quotes enough of the sentence around the
 * number to pin which lifetime it is about: `15 minutes` and `10 minutes` would otherwise satisfy
 * each other's check the day the two constants meet.
 */
describe('the reviewer guide states the lifetimes the worker issues', () => {
  const REVIEWING = readFileSync(fileURLToPath(new URL('../../../docs/reviewing.md', import.meta.url)), 'utf8');

  it('says how long a pairing code is good for', () => {
    const phrase = `${PAIRING_TTL_SECONDS / 60} minutes after they are minted`;
    assert.ok(REVIEWING.includes(phrase), `docs/reviewing.md does not say a pairing code expires ${phrase}`);
  });

  /**
   * **The lifetime is not the window.** `verifyIdentityToken` accepts a token until
   * `exp + CLOCK_SKEW_SECONDS`, so what outlives a log out is the sum — and the first version of this
   * assertion derived it from `ACCESS_TTL_SECONDS` alone, which let the guide say one minute less
   * than the code does. `SECURITY.md` had it right all along. Raised in review.
   */
  it('says how long an access token outlives a log out, skew included', () => {
    const window = (ACCESS_TTL_SECONDS + CLOCK_SKEW_SECONDS) / 60;
    const phrase = `**${window} minutes**`;
    assert.ok(
      REVIEWING.includes(phrase),
      `docs/reviewing.md does not say the access token outlives a log out ${phrase}`,
    );
  });

  it('says how long a refresh token the revoke never reached stays alive', () => {
    const phrase = `within ${REFRESH_TTL_SECONDS / 86_400} days`;
    assert.ok(REVIEWING.includes(phrase), `docs/reviewing.md does not say the refresh token expires ${phrase}`);
  });
});

describe('SECURITY.md states what the code does', () => {
  it('quotes the rate limit this worker actually applies', () => {
    assert.ok(
      SECURITY.includes(`\`RATE_LIMIT_PER_MINUTE\` (${DEFAULT_LIMIT} by default)`),
      `SECURITY.md does not name ${DEFAULT_LIMIT} as the rate-limit default`,
    );
  });

  /** FRU-149: what a member who was removed keeps is an access token, for its lifetime and the skew. */
  it('says how long an access token outlives a member who was removed', () => {
    const phrase = `**${(ACCESS_TTL_SECONDS + CLOCK_SKEW_SECONDS) / 60} minutes at\n  most**, its ${ACCESS_TTL_SECONDS / 60} minutes and the ${CLOCK_SKEW_SECONDS} seconds of clock skew`;
    assert.ok(SECURITY.includes(phrase), `SECURITY.md does not say that a removed member keeps a token ${phrase}`);
  });

  it('quotes what a burst can get through the shared window', () => {
    // The number a reader would use to size a quota. It is `2 × limit − 1`, held against the code by
    // `rate-limit.test.ts`, so it moves with the default.
    const phrase = `at most ${2 * DEFAULT_LIMIT - 1} requests in any 60\nseconds`;

    assert.ok(
      SECURITY.includes(phrase) || SECURITY.includes(phrase.replace('\n', ' ')),
      `SECURITY.md does not say a burst gets at most ${2 * DEFAULT_LIMIT - 1} requests through`,
    );
  });

  it('quotes the proxy hops this worker actually trusts', () => {
    assert.ok(
      SECURITY.includes(`\`TRUSTED_PROXY_HOPS\` (${DEFAULT_TRUSTED_PROXY_HOPS} by default`),
      `SECURITY.md does not name ${DEFAULT_TRUSTED_PROXY_HOPS} as the proxy-hop default`,
    );
  });

  it('quotes the session lifetimes the worker issues', () => {
    assert.ok(
      SECURITY.includes(`valid ${PAIRING_TTL_SECONDS / 60} minutes`),
      `SECURITY.md does not say a pairing code lasts ${PAIRING_TTL_SECONDS / 60} minutes`,
    );
    assert.ok(
      SECURITY.includes(`HS256 identity token, ${ACCESS_TTL_SECONDS / 60} minutes`),
      `SECURITY.md does not say an access token lasts ${ACCESS_TTL_SECONDS / 60} minutes`,
    );
    assert.ok(
      SECURITY.includes(`${REFRESH_TTL_SECONDS / 86_400} days`),
      `SECURITY.md does not say a refresh token lasts ${REFRESH_TTL_SECONDS / 86_400} days`,
    );
  });

  it('quotes what a request of the extension is made of, and how long it lives (FRU-238)', () => {
    const bits = (value: string) => Buffer.from(value, 'base64url').length * 8;
    for (const sentence of [
      `| Request id   | ${bits(createRequestId())} bits, public`,
      `| Claim        | ${bits(createClaim())} bits, secret`,
      `one of ${WORDS.length} words and two digits`,
      `a request lives ${CONNECT_TTL_SECONDS / 60} minutes`,
      `a claim asked again within ${POLL_WINDOW_SECONDS} seconds`,
      `${CONNECTS_PER_ADDRESS} requests per address in ${CONNECT_WINDOW_MS / 60_000} minutes; ${MAX_LIVE_REQUESTS} requests waiting`,
      `refused after ${MAX_WORD_MISSES} approvals with a word`,
    ]) {
      const loose = sentence.replace(/\s+/g, ' ');
      assert.ok(SECURITY.replace(/\s+/g, ' ').includes(loose), `SECURITY.md does not say: ${sentence}`);
    }
  });

  it('quotes how long a session of better-auth lasts, and how often its end moves (FRU-147)', () => {
    assert.ok(
      SECURITY.includes(
        `It lasts ${SESSION_TTL_SECONDS / 86_400} days, and each day it is used moves its end by ${SESSION_TTL_SECONDS / 86_400} days`,
      ),
      'SECURITY.md does not give the lifetime of a session of better-auth',
    );
    assert.equal(SESSION_RENEWAL_SECONDS, 86_400, 'SECURITY.md says « each day it is used »');
  });

  it('quotes how old a session may be and still take a way to sign in away (FRU-249)', () => {
    assert.ok(SECURITY.includes('**The session must be of the last day**'), 'SECURITY.md does not say it');
    assert.equal(SESSION_FRESH_SECONDS, 86_400, 'SECURITY.md says « of the last day »');
  });

  it('quotes how often a domain is proven again, and how long a DNS that does not answer is waited for (FRU-103)', () => {
    const hours = (ms: number) => ms / 3_600_000;
    const words = [
      'zero',
      'one',
      'two',
      'three',
      'four',
      'five',
      'six',
      'seven',
      'eight',
      'nine',
      'ten',
      'eleven',
      'twelve',
    ];
    assert.ok(
      SECURITY.includes(`every ${words[hours(RECHECK_MS)]} hours`),
      `SECURITY.md does not say a proof is asked every ${hours(RECHECK_MS)} hours`,
    );
    assert.ok(
      SECURITY.includes(`${words[hours(RECHECK_MS)]} hours at most`),
      'SECURITY.md does not say how long a removed record still proves the domain',
    );
    assert.ok(
      SECURITY.includes(`for ${hours(PROOF_GRACE_MS)} hours at most`),
      `SECURITY.md does not say a proof nobody confirms holds ${hours(PROOF_GRACE_MS)} hours`,
    );
  });

  it('quotes the token cap and the clock skew the verifier enforces', () => {
    const maxBytes = MAX_TOKEN_BYTES;
    const skew = CLOCK_SKEW_SECONDS;

    assert.ok(
      SECURITY.includes(`over ${maxBytes / 1024} KiB is refused`),
      `SECURITY.md does not say a token over ${maxBytes / 1024} KiB is refused`,
    );
    assert.ok(
      SECURITY.includes(`capped at ${skew} seconds`),
      `SECURITY.md does not say clock skew is capped at ${skew} seconds`,
    );
  });

  /**
   * The two figures the first version of this suite did **not** derive, while its own docstring
   * claimed every one of them was. Raised in review, and it was right: changing `CODE_LENGTH` or
   * `REFRESH_TOKEN_BYTES` would have left the document stale with the suite green.
   *
   * Measured from what the functions actually produce rather than from the constants, because what
   * the document promises a reader is the strength of the credential they are handed.
   */
  it('quotes the entropy the credentials actually carry', () => {
    // The radix comes from the implementation's own alphabet, not from a literal 32. A hard-coded
    // radix is the same defect one level down: shrink the alphabet to 31 symbols and the arithmetic
    // still says 60 bits while the document overstates what a code is worth. Raised in review.
    const radix = CODE_ALPHABET.length;
    assert.ok(radix > 1, `CODE_ALPHABET has ${radix} symbols; a code drawn from it carries nothing`);

    const codeBits = Math.round(createPairingCode().replaceAll('-', '').length * Math.log2(radix));
    const refreshBits = Buffer.from(createRefreshToken(), 'base64url').byteLength * 8;

    assert.ok(
      SECURITY.includes(`${codeBits} bits, valid`),
      `SECURITY.md does not say a pairing code carries ${codeBits} bits`,
    );
    assert.ok(
      SECURITY.includes(`${refreshBits} bits, `),
      `SECURITY.md does not say a refresh token carries ${refreshBits} bits`,
    );
  });

  it('names the only algorithm the verifier accepts', () => {
    assert.ok(SECURITY.includes(`\`${ALGORITHM}\` is **asserted against**`));
  });

  /**
   * The claim this file exists to make, and the one that would be worst to get wrong.
   *
   * Asserted against `readConfig` rather than against a constant: what a self-hoster is promised is
   * the behaviour of a worker configured with nothing, which is what this builds.
   */
  it('is right that a worker configured with nothing serves reads to anyone', () => {
    const result = readConfig({ FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: '*' });

    assert.ok(result.ok);
    assert.equal(result.config.read, 'public');
    assert.ok(SECURITY.includes('The read path is public by default'));
  });

  /**
   * The document promises that a browser cannot mint a verified reporter. The prose is checked for
   * exactly once, and the mechanism behind it separately — a heading that survived a deleted guard
   * would be the worst version of this file.
   */
  it('is right that a browser cannot claim a verified reporter', () => {
    assert.equal(
      SECURITY.includes("### `reporter.verified` is the worker's word"),
      true,
      'SECURITY.md no longer makes the claim this test guards',
    );

    assert.deepEqual(
      stripClaimedVerification({ name: 'CEO', verified: true }),
      { name: 'CEO' },
      'SECURITY.md promises the flag is stripped, and nothing strips it',
    );
  });
});

describe('the preflight lets through what the widget actually sends', () => {
  /**
   * `read: 'authenticated'` is the mitigation SECURITY.md names, and it was unreachable from a
   * browser (FRU-25).
   *
   * `embed.ts` sends `Authorization: Bearer …` on the read **and** on the write when a host mints a
   * token. That header is not CORS-safelisted, so both requests are preflighted — and a preflight
   * that does not list it is refused by the browser before the worker sees anything. Nothing
   * server-side could have caught this: the request never arrived. Raised in review.
   */
  it('allows the Authorization header, or authenticated reads answer nobody', async () => {
    const response = await handleRequest(
      new Request('https://worker.test/feedback?url=https://acme.test/', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://acme.test',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'authorization',
        },
      }),
      beforePostgres({ FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: 'https://acme.test' }),
      { clientIp: '198.51.100.41' },
    );

    assert.equal(response.status, 204);
    const allowed = (response.headers.get('Access-Control-Allow-Headers') ?? '').toLowerCase();
    assert.ok(allowed.includes('authorization'), `the preflight allows only: ${allowed}`);
  });

  /** The widget names the header; the worker must allow the same one. */
  it('allows the header the widget is written to send', () => {
    const embed = readFileSync(
      fileURLToPath(new URL('../../../packages/widget/src/embed.ts', import.meta.url)),
      'utf8',
    );

    assert.ok(/Authorization: `Bearer /.test(embed), 'embed.ts no longer sends Authorization; this guard is stale');
  });
});
