import { type IdentityClaims, signIdentityToken } from './identity.ts';

/**
 * A durable identity for the extension's reviewer (SKG-535).
 *
 * The reviewer is not a visitor who typed a name into the popover. They are somebody an operator
 * vouched for, and the worker has to be able to say so on its own word. That is what turns
 * `reporter.verified` from a flag SKG-498 defined into a flag something actually sets.
 *
 * **The admin names the person, never the browser.** A pairing code is minted for Alice, with her
 * name and her address in it, and whoever redeems that code gets a session that says Alice. An
 * extension that supplied its own name at pairing time would be the browser asserting an identity
 * again, which is the exact hole SKG-498 closed.
 *
 * **The access token is an ordinary identity token.** `identity.ts` already mints and verifies
 * HS256 JWTs, and the read and write paths already check them. Minting the same shape here means
 * there is one verification path in this worker rather than two, and `read: 'authenticated'`
 * (SKG-533) starts accepting the extension with no change at all.
 *
 * **Codes and refresh tokens are stored as SHA-256 digests.** They are bearer credentials that live
 * on disk for weeks, so a copy of the database must not be a set of working logins. Nothing here
 * compares a secret byte by byte either: a lookup is by digest, on a primary key.
 *
 * No OAuth, no identity provider, no user table to administer. A self-hoster runs one container.
 */

/** Who a session speaks for. The worker's word, taken from the pairing the operator created. */
export type SessionIdentity = {
  /** Stable id for the person. Becomes `sub` on the access token, and `reporter.id` on a seed. */
  subject: string;
  name?: string;
  email?: string;
};

export type SessionRecord = SessionIdentity & { expiresAt: number };

/**
 * What a session needs to persist, and the reason it is an interface rather than a table.
 *
 * It is deliberately **not** `SeedStore`. Seeds go wherever the team already tracks issues — Linear,
 * GitHub, a file — and none of those is a place to keep credentials. A Linear-backed worker still
 * needs its sessions on a disk it owns. So this has its own implementation, its own file and its own
 * environment variable, the way SKG-526 made every connector validate its own.
 */
export type SessionStore = {
  createPairing(pairing: { codeHash: string; identity: SessionIdentity; expiresAt: number }): Promise<void>;
  /**
   * Spends the code **and** opens the session it buys, or answers `undefined`.
   *
   * One operation, for two separate reasons. Two reviewers redeeming the same code at once must
   * produce one session rather than two, so the code is marked spent by a statement that acts on
   * whether it changed a row. And the code must not be spendable without the session it paid for:
   * marking it redeemed, then failing to write the session — a full volume, a locked file — burns
   * the only code the reviewer has and leaves them nothing. Raised in review.
   */
  redeemPairing(redemption: {
    codeHash: string;
    tokenHash: string;
    expiresAt: number;
    now: number;
  }): Promise<SessionIdentity | undefined>;
  /** The live session behind this refresh token, or `undefined` when it is expired or revoked. */
  findSession(tokenHash: string, now: number): Promise<SessionRecord | undefined>;
  /** `true` when this call is what revoked it. A second logout is not an error, it is a no-op. */
  revokeSession(tokenHash: string, now: number): Promise<boolean>;
  /** Drops what is expired. Called on redeem, so a worker nobody administers still stays small. */
  purge(now: number): Promise<void>;
};

/**
 * Crockford's base32, and the reason is that a person retypes this.
 *
 * `I`, `L`, `O` and `U` are absent: the first three are unreadable next to `1` and `0` in the fonts
 * a terminal and a popup actually use, and the fourth is left out so a random code cannot spell
 * something the operator has to apologise for.
 */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Twelve characters of a 32-symbol alphabet: 60 bits. The rate limiter is the second lock. */
const CODE_LENGTH = 12;

/** 256 bits, opaque. It is never typed, so it is not drawn from the readable alphabet. */
const REFRESH_TOKEN_BYTES = 32;

/** A pairing code is handed over in person or over chat, and redeemed straight away or not at all. */
export const PAIRING_TTL_SECONDS = 15 * 60;

/** Short, because revocation cannot reach a token already minted. The refresh path is the check. */
export const ACCESS_TTL_SECONDS = 10 * 60;

/** Long, because the alternative is a reviewer who re-pairs every morning and keeps the code in a file. */
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * One reason each, and that is the design rather than a gap.
 *
 * A caller who can tell "no such code" from "that code is spent" can work out which codes existed,
 * so there is no variant for the first case — not an unused one either, because a union member
 * nothing ever returns reads as a distinction this worker makes.
 */
export type PairingFailure = 'code-spent-or-expired';
export type SessionFailure = 'session-revoked-or-expired';

export type IssuedSession = {
  refreshToken: string;
  accessToken: string;
  /** Seconds, so a client refreshes on a duration rather than on a clock it has to trust. */
  expiresIn: number;
  identity: SessionIdentity;
};

/** The code as the operator reads it out: `ABCD-EFGH-JKMN`. */
export function createPairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  const characters = Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length] as string);

  return [characters.slice(0, 4), characters.slice(4, 8), characters.slice(8, 12)]
    .map((group) => group.join(''))
    .join('-');
}

/**
 * What the reviewer typed, as the digest it was stored under.
 *
 * The dashes are decoration and the case is not information, so both are dropped. `I` and `L` become
 * `1` and `O` becomes `0`, which is Crockford's own rule and is why those letters are missing from
 * the alphabet: a code cannot contain them, so the substitution can never change a valid code into a
 * different valid one.
 */
export function normalizePairingCode(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
}

export function createRefreshToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(REFRESH_TOKEN_BYTES))).toString('base64url');
}

/** What a bearer credential is stored as. Never the credential itself. */
export async function digest(value: string): Promise<string> {
  const hashed = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));

  return Buffer.from(hashed).toString('base64url');
}

/**
 * Mints a pairing code for the person the operator names.
 *
 * Returns the code once. It is not readable again — the store keeps only its digest — so an operator
 * who loses it mints another rather than recovering that one.
 */
export async function createPairing(
  store: SessionStore,
  identity: SessionIdentity,
  now: number = Date.now(),
): Promise<{ code: string; expiresAt: number }> {
  const code = createPairingCode();
  const expiresAt = now + PAIRING_TTL_SECONDS * 1000;

  await store.createPairing({ codeHash: await digest(normalizePairingCode(code)), identity, expiresAt });

  return { code, expiresAt };
}

/**
 * Spends a pairing code and opens a session.
 *
 * Both failures answer the same way on purpose: a caller who can tell "no such code" from "that code
 * is spent" can enumerate which codes existed.
 */
export async function redeemPairing(
  store: SessionStore,
  code: string,
  secret: string,
  now: number = Date.now(),
): Promise<{ ok: true; session: IssuedSession } | { ok: false; reason: PairingFailure }> {
  await store.purge(now);

  // The refresh token is minted before the store is asked, so the code and the session it buys are
  // written by one operation. A code cannot be spent without the session existing.
  const refreshToken = createRefreshToken();
  const identity = await store.redeemPairing({
    codeHash: await digest(normalizePairingCode(code)),
    tokenHash: await digest(refreshToken),
    expiresAt: now + REFRESH_TTL_SECONDS * 1000,
    now,
  });
  if (identity === undefined) return { ok: false, reason: 'code-spent-or-expired' };

  return {
    ok: true,
    session: {
      refreshToken,
      accessToken: await mintAccessToken(identity, secret, now),
      expiresIn: ACCESS_TTL_SECONDS,
      identity,
    },
  };
}

/**
 * A fresh access token for a session that is still live.
 *
 * The refresh token is **not** rotated. Rotation is the stronger design, and it needs a replay
 * window the extension does not have yet: a refresh whose answer is lost to a dropped connection
 * would log the reviewer out with no way back. See the note on SKG-535 — it belongs with the
 * extension half, where a retry can be observed.
 */
export async function refreshSession(
  store: SessionStore,
  refreshToken: string,
  secret: string,
  now: number = Date.now(),
): Promise<
  | { ok: true; accessToken: string; expiresIn: number; identity: SessionIdentity }
  | { ok: false; reason: SessionFailure }
> {
  const session = await store.findSession(await digest(refreshToken), now);
  if (session === undefined) return { ok: false, reason: 'session-revoked-or-expired' };

  const { expiresAt: _session, ...identity } = session;

  return {
    ok: true,
    accessToken: await mintAccessToken(identity, secret, now),
    expiresIn: ACCESS_TTL_SECONDS,
    identity,
  };
}

/**
 * Ends a session on the worker, not only in the extension.
 *
 * A logout that cleared the extension's storage and nothing else leaves a working refresh token in
 * whatever copied it. This is what the ticket means by revoking for real.
 */
export async function revokeSession(
  store: SessionStore,
  refreshToken: string,
  now: number = Date.now(),
): Promise<boolean> {
  return store.revokeSession(await digest(refreshToken), now);
}

/** The same token a client site mints for itself, signed here instead. See `identity.ts`. */
async function mintAccessToken(identity: SessionIdentity, secret: string, now: number): Promise<string> {
  const seconds = Math.floor(now / 1000);
  const claims: IdentityClaims = {
    sub: identity.subject,
    ...(identity.name === undefined ? {} : { name: identity.name }),
    ...(identity.email === undefined ? {} : { email: identity.email }),
    iat: seconds,
    exp: seconds + ACCESS_TTL_SECONDS,
  };

  return signIdentityToken(claims, secret);
}
