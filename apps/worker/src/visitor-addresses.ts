import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { NOTIFY_TOKEN_TTL_MS } from './done-notices.ts';

/**
 * « A confirmed e-mail » (FRU-705): a visitor with no account links the key of their browser to an
 * address they confirm by a link, before their first edit or deletion. Every browser that confirmed the
 * same address on a site is the same visitor there, so their notes are theirs on another device, or
 * after they cleared the browser and confirmed again.
 *
 * - **The worker keeps digests, never the address.** `identity` is a SHA-256 of the site and of the
 *   address (`emailVisitorDigestOf`), `visitor` the digest of the key of the browser (`visitorDigestOf`).
 *   The address goes to the mailer, once, and nowhere else.
 * - **The link is the token of FRU-604, for another use**: an HMAC-SHA256 under a key derived from
 *   `FRUITBACK_AUTH_SECRET` for this use alone, that names the site, the browser that asked, the
 *   identity and the expiry. The worker keeps nothing for a link nobody opens. It lasts
 *   `VISITOR_LINK_TTL_MS` (30 minutes, as the token of an address of a note), and serves once: `Kv`
 *   marks it spent once the confirmation is kept (`visitor-email-routes.ts`).
 * - **The link opens the page of the site**, `#fruitback-confirm=<token>`, and the widget sends it with
 *   the key of its browser. Only the browser that asked confirms: a link a person forwards, or one sent
 *   to the address of somebody else, opens nothing elsewhere.
 * - **An address not confirmed gives no right.** On a site that recognises its visitors by an address,
 *   the routes of an edit and of a deletion ask for a confirmed browser (`by: 'email'`).
 */

/** How long a link of confirmation works: 30 minutes, the life of the token of FRU-604. */
export const VISITOR_LINK_TTL_MS = NOTIFY_TOKEN_TTL_MS;

/** The anchor of the page that carries a link of confirmation, as `#fruitback-note=` carries a note. */
export const CONFIRM_ANCHOR = 'fruitback-confirm';

/** The confirmed browsers of the sites, in the database of the worker. */
export type VisitorAddresses = {
  /** The identity this browser confirmed on this site, or `undefined`. */
  identityOf(site: string, visitor: string): Promise<string | undefined>;
  /**
   * Links this browser to this identity on this site, and gives the notes this browser left there to
   * the identity, in one transaction: they are the notes of that address now, on every browser of it.
   * A browser confirmed before takes the new identity.
   */
  confirm(site: string, visitor: string, identity: string, now: number): Promise<void>;
};

/**
 * The digest of a visitor known by a confirmed address (FRU-705): the site and the address, in lower
 * case. Another prefix than the key of a browser and a person the site signs, so no digest of one is
 * the digest of another.
 */
export function emailVisitorDigestOf(site: string, email: string): string {
  return createHash('sha256').update(`fruitback-email-visitor\n${site}\n${email.toLowerCase()}`).digest('base64url');
}

/** What a link of confirmation names. */
export type VisitorLink = { site: string; visitor: string; identity: string; expiry: number };

/** The token of a link: `<expiry>.<visitor>.<identity>.<mac>`, digests only, which the page carries. */
export function visitorLinkToken(secret: string, link: Omit<VisitorLink, 'expiry'>, now: number): string {
  const expiry = now + VISITOR_LINK_TTL_MS;

  return `${expiry}.${link.visitor}.${link.identity}.${macOf(secret, { ...link, expiry })}`;
}

/**
 * The link this token names, when this worker made it for this site and it is not out of date, else
 * `undefined`. It does not say whether the link served already: `Kv` does.
 */
export function readVisitorLinkToken(
  secret: string,
  site: string,
  token: unknown,
  now: number,
): (VisitorLink & { mac: string }) | undefined {
  if (typeof token !== 'string' || token.length > 300) return undefined;
  const parts = token.split('.');
  if (parts.length !== 4) return undefined;
  const [expiryText, visitor, identity, mac] = parts as [string, string, string, string];
  if (!/^\d{1,16}$/u.test(expiryText) || !DIGEST.test(visitor) || !DIGEST.test(identity)) return undefined;
  const expiry = Number(expiryText);
  if (!Number.isSafeInteger(expiry) || expiry < now || expiry > now + VISITOR_LINK_TTL_MS) return undefined;
  const given = Buffer.from(mac, 'utf8');
  const expected = Buffer.from(macOf(secret, { site, visitor, identity, expiry }), 'utf8');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;

  return { site, visitor, identity, expiry, mac };
}

/** A SHA-256 in base64url: 43 characters. */
const DIGEST = /^[A-Za-z0-9_-]{43}$/u;

function macOf(secret: string, link: VisitorLink): string {
  // A key for this use only: the same secret signs the sessions of better-auth and the token of FRU-604.
  const key = createHmac('sha256', secret).update('fruitback visitor-email link v1').digest();

  return createHmac('sha256', key)
    .update(JSON.stringify([link.site, link.visitor, link.identity, link.expiry]))
    .digest('base64url');
}
