import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ACCESS_TTL_SECONDS,
  PAIRING_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
  createPairingCode,
  createRefreshToken,
} from './session.ts';
import { DEFAULT_TRUSTED_PROXY_HOPS } from './env.ts';
import { DEFAULT_LIMIT } from './rate-limit.ts';
import { readConfig } from './env.ts';
import { handleRequest } from './app.ts';

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
const IDENTITY = readFileSync(fileURLToPath(new URL('./identity.ts', import.meta.url)), 'utf8');

/**
 * Reads a constant out of a source file, for the ones that are not exported.
 *
 * Plain literals only, and a computed one fails loudly rather than being evaluated: this file exists
 * to check a security document, and running source out of it to do that is the wrong trade.
 */
function constantIn(source: string, name: string): string {
  const match = new RegExp(`const ${name} = ('?[\\w.]+'?);`).exec(source);
  const value = match?.[1];
  assert.ok(
    value !== undefined,
    `${name} is gone from identity.ts, or is no longer a plain literal; SECURITY.md describes it`,
  );

  return value.replace(/^'|'$/g, '');
}

describe('SECURITY.md states what the code does', () => {
  it('quotes the rate limit this worker actually applies', () => {
    assert.ok(
      SECURITY.includes(`\`RATE_LIMIT_PER_MINUTE\` (${DEFAULT_LIMIT} by default)`),
      `SECURITY.md does not name ${DEFAULT_LIMIT} as the rate-limit default`,
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

  it('quotes the token cap and the clock skew the verifier enforces', () => {
    const maxBytes = Number(constantIn(IDENTITY, 'MAX_TOKEN_BYTES'));
    const skew = constantIn(IDENTITY, 'CLOCK_SKEW_SECONDS');

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
    const alphabet = new Set(createPairingCode().replaceAll('-', ''));
    assert.ok(alphabet.size > 1, 'a pairing code drew one symbol; something is very wrong');

    const codeBits = Math.round(createPairingCode().replaceAll('-', '').length * Math.log2(32));
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
    assert.ok(SECURITY.includes(`\`${constantIn(IDENTITY, 'ALGORITHM')}\` is **asserted against**`));
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

    const stripped = /export function stripClaimedVerification/.test(IDENTITY);
    assert.equal(stripped, true, 'SECURITY.md promises the flag is stripped, and nothing strips it');
  });
});

describe('the preflight lets through what the widget actually sends', () => {
  /**
   * `read: 'authenticated'` is the mitigation SECURITY.md names, and it was unreachable from a
   * browser (SKG-518).
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
      { FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: 'https://acme.test' },
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
