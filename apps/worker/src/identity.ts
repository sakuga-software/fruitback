import type { SeedReporter } from '@fruitback/shared';

/**
 * Turning a claim into an identity (SKG-498).
 *
 * Anyone can type a name into the popover, so `seed.reporter` is a claim by whoever was on the page.
 * A client site that already knows who its visitor is can say so properly: it mints a short-lived
 * JWT, signed with a secret it shares with this worker, and the widget sends it along. Only a token
 * that verifies here produces `reporter.verified`.
 *
 * **The token never reaches Linear.** It arrives in an `Authorization` header rather than in the
 * seed, because the seed is stored verbatim in an issue description that anyone with workspace
 * access can read — a credential in there would outlive its expiry by months.
 *
 * A standard **JWS compact JWT, HS256**, so a client site can mint one with whatever library it
 * already has instead of reimplementing a bespoke scheme. The cost of that interoperability is the
 * header: `alg` is attacker-controlled, and a verifier that believes it accepts `none` and validates
 * everything. So the algorithm is not read from the token — it is *asserted* against it, and
 * anything but `HS256` is refused before a byte of the signature is looked at.
 */

export type IdentityClaims = {
  /** Stable id for the person, as the client site knows them. */
  sub: string;
  name?: string;
  email?: string;
  /** Seconds since the epoch. Required — a token that never expires is a password. */
  exp: number;
  /** Optional; rejected when it is in the future, which is a clock or a forgery. */
  iat?: number;
};

export type IdentityFailure =
  | 'malformed'
  | 'unsupported-alg'
  | 'bad-signature'
  | 'expired'
  | 'not-yet-valid'
  | 'invalid-claims';

export type IdentityResult = { ok: true; reporter: SeedReporter } | { ok: false; reason: IdentityFailure };

const encoder = new TextEncoder();

/** The only algorithm this worker will verify. Not a default — a requirement. */
const ALGORITHM = 'HS256';

/** Longer than this and the payload is not an identity token, whatever it is. */
const MAX_TOKEN_BYTES = 4096;

/** A minute of slack for a client clock that runs fast. Anything more is not clock drift. */
const CLOCK_SKEW_SECONDS = 60;

export function readBearerToken(header: string | null): string | undefined {
  if (header === null) return undefined;

  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());

  return match?.[1];
}

/**
 * A compact JWS: `base64url(header).base64url(payload).base64url(signature)`.
 *
 * Exported because the tests mint tokens with it, and because a client site wanting to check its own
 * integration should have one reference implementation to compare against. Any JWT library set to
 * HS256 produces the same bytes.
 */
export async function signIdentityToken(claims: IdentityClaims, secret: string): Promise<string> {
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ alg: ALGORITHM, typ: 'JWT' })));
  const payload = base64UrlEncode(encoder.encode(JSON.stringify(claims)));
  const signature = base64UrlEncode(new Uint8Array(await hmac(`${header}.${payload}`, secret)));

  return `${header}.${payload}.${signature}`;
}

export async function verifyIdentityToken(
  token: string,
  secret: string,
  now: number = Date.now(),
): Promise<IdentityResult> {
  if (token.length > MAX_TOKEN_BYTES) return { ok: false, reason: 'malformed' };

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };

  const [header, payload, signature] = parts as [string, string, string];

  // Before the signature, not after. `alg: none` is the whole reason JWT verifiers get written
  // wrong: read the algorithm out of the token and a forger picks it for you.
  const algorithm = readJson<{ alg?: unknown; typ?: unknown }>(header);
  if (algorithm === undefined) return { ok: false, reason: 'malformed' };
  if (algorithm.alg !== ALGORITHM) return { ok: false, reason: 'unsupported-alg' };
  if (algorithm.typ !== undefined && algorithm.typ !== 'JWT') return { ok: false, reason: 'malformed' };

  let expected: ArrayBuffer;
  try {
    expected = await hmac(`${header}.${payload}`, secret);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  // Compared byte by byte in constant time. A `===` on the base64 leaks how much of the signature
  // was right through how long the comparison took, which is enough to forge one byte at a time.
  if (!timingSafeEqual(base64UrlDecode(signature), new Uint8Array(expected))) {
    return { ok: false, reason: 'bad-signature' };
  }

  const claims = readJson<IdentityClaims>(payload);
  if (claims === undefined) return { ok: false, reason: 'malformed' };

  if (typeof claims.sub !== 'string' || claims.sub.length === 0) return { ok: false, reason: 'invalid-claims' };
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) return { ok: false, reason: 'invalid-claims' };

  const seconds = now / 1000;
  if (claims.exp + CLOCK_SKEW_SECONDS <= seconds) return { ok: false, reason: 'expired' };
  if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_SECONDS > seconds) {
    return { ok: false, reason: 'not-yet-valid' };
  }

  return {
    ok: true,
    // Only what the token says. A name in the seed alongside a token identifying someone else must
    // not survive: the whole point is that this line is the worker's word.
    reporter: {
      id: claims.sub,
      ...(typeof claims.name === 'string' && claims.name.length > 0 ? { name: claims.name } : {}),
      ...(typeof claims.email === 'string' && claims.email.length > 0 ? { email: claims.email } : {}),
      verified: true,
    },
  };
}

/**
 * Whatever the client asserted, minus the one field it may not assert.
 *
 * A browser posting `reporter: { name: 'CEO', verified: true }` would otherwise read in Linear as an
 * identity this worker checked. Stripping it is not defence in depth; it is the check.
 */
export function stripClaimedVerification(reporter: SeedReporter | undefined): SeedReporter | undefined {
  if (reporter === undefined) return undefined;

  const { verified: _claimed, ...claimed } = reporter;

  return Object.keys(claimed).length > 0 ? claimed : undefined;
}

function readJson<T>(segment: string): T | undefined {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(segment)));

    return typeof parsed === 'object' && parsed !== null ? (parsed as T) : undefined;
  } catch {
    return undefined;
  }
}

async function hmac(signingInput: string, secret: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);

  return crypto.subtle.sign('HMAC', key, encoder.encode(signingInput));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;

  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);

  return difference === 0;
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function base64UrlDecode(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64url'));
}
