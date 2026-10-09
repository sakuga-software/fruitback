import { createHmac, randomBytes } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import type { Seed } from '@fruitback/shared';
import type { AccountStore } from './accounts.ts';
import { open, seal } from './secrets.ts';

/**
 * An address that receives each note of a site (FRU-122).
 *
 * The notes stay in the worker: an address that only receives cannot give them back to draw a pin.
 * So this is no store. A note is kept first, then a row says it must be sent, and a loop sends the
 * rows that are due. The widget is answered when the note is kept, and a receiver that is down costs
 * the reporter nothing.
 *
 * `docs/rest-connector.md` is the contract a receiver is written against. A change to the body, to a
 * header or to the signature is a change of that contract.
 */

/** What the worker keeps for a connector of this kind, sealed: where to send, and what to sign with. */
export type RestTarget = { url: string; secret: string };

export function sealTarget(target: RestTarget, secretsKey: string): string {
  return seal(JSON.stringify(target), secretsKey);
}

/** The target, or `undefined` for a value this key does not open or that is not a target. */
export function openTarget(sealed: string, secretsKey: string): RestTarget | undefined {
  const plain = open(sealed, secretsKey);
  if (plain === undefined) return undefined;

  try {
    const { url, secret } = JSON.parse(plain) as { url?: unknown; secret?: unknown };

    return typeof url === 'string' && typeof secret === 'string' ? { url, secret } : undefined;
  } catch {
    return undefined;
  }
}

/** A secret the worker makes when the person gives none. It is answered once, and never again. */
export function newSecret(): string {
  return `fbs_${randomBytes(32).toString('base64url')}`;
}

export const SECRET_MIN_LENGTH = 16;
const SECRET_MAX_LENGTH = 256;

export function isAcceptableSecret(secret: string): boolean {
  return secret.length >= SECRET_MIN_LENGTH && secret.length <= SECRET_MAX_LENGTH && !/\s/.test(secret);
}

/**
 * The addresses the worker must not call: itself, its host and the private networks around it.
 *
 * WARNING: a workspace chooses where the worker sends, so this is what stops a person from making
 * the worker read a service that only the worker can reach. `100.64.0.0/10` is in the list: it is
 * the range of a mesh network such as Tailscale, which the host of the Cloud is on.
 */
/** The range of a mesh network. `SECURITY.md` names it, and a test holds the two together. */
export const MESH_RANGE = ['100.64.0.0', 10] as const;

const INTERNAL = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  MESH_RANGE,
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const) {
  INTERNAL.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 127],
  ['64:ff9b::', 96],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  INTERNAL.addSubnet(network, prefix, 'ipv6');
}

/** Whether an IP address is one of the public internet. An IPv4 address inside an IPv6 one is read as IPv4. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 4) return !INTERNAL.check(address, 'ipv4');

  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped !== undefined) return !INTERNAL.check(mapped, 'ipv4');
  // `BlockList` also checks an IPv4 rule against a mapped address written in hexadecimal.
  return !INTERNAL.check(address, 'ipv6');
}

const URL_MAX_LENGTH = 2_048;

/**
 * The address as the worker keeps it, or `undefined` when it must not be called.
 *
 * https only: the body holds a note and the request is signed, not encrypted. No name and password
 * in the address: they would be kept in a label the console shows. An IP address written in the
 * address is checked here, and a name is checked when it is resolved, at each attempt.
 */
export function parseTargetUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > URL_MAX_LENGTH) return undefined;

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hostname === '') return undefined;

  const literal = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(literal) !== 0 && !isPublicAddress(literal)) return undefined;
  if (literal === 'localhost' || literal.endsWith('.localhost')) return undefined;

  url.hash = '';

  return url.toString();
}

/** What the console shows for a target: its host, never its path, which can hold a token. */
export function targetLabel(url: string): string {
  return `REST · ${new URL(url).host}`;
}

export const SIGNATURE_HEADER = 'X-Fruitback-Signature';
export const TIMESTAMP_HEADER = 'X-Fruitback-Timestamp';
export const DELIVERY_HEADER = 'X-Fruitback-Delivery';

/**
 * `sha256=` and the HMAC-SHA256, in hexadecimal, of the timestamp, a dot and the body.
 *
 * The timestamp is signed with the body so a receiver can refuse an old request: a copy of a request
 * cannot be sent again later with a new time.
 */
export function signature(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** The body of a delivery. `version` moves when a field changes meaning or goes. */
export const DELIVERY_VERSION = 1;

export type DeliveryBody = {
  version: typeof DELIVERY_VERSION;
  event: 'note.created';
  workspace: string;
  site: { id: string; origin?: string };
  /** What Fruitback calls the note, as its thread shows it. */
  identifier: string;
  seed: Seed;
};

export function deliveryBody(note: Omit<DeliveryBody, 'version' | 'event'>): string {
  return JSON.stringify({ version: DELIVERY_VERSION, event: 'note.created', ...note } satisfies DeliveryBody);
}

/**
 * How long the worker waits after each failed attempt, in seconds. After the last one it gives up,
 * and the console offers a new attempt. Seven attempts in about a day and a half.
 */
export const RETRY_AFTER_SECONDS = [60, 300, 1_800, 7_200, 21_600, 86_400] as const;

/** A delivery nobody asked to try again is removed after this long. Its body holds a note. */
export const ABANDONED_KEPT_DAYS = 30;

export type SendResult = { status: number };
/** Sends one request. It rejects when no answer came: a name that resolves to an internal address, a timeout. */
export type Send = (url: string, headers: Record<string, string>, body: string) => Promise<SendResult>;

export type DeliverySeams = {
  accounts: AccountStore;
  secretsKey: string | undefined;
  send: Send;
  now?: () => number;
  /** How many deliveries one pass attempts. The others wait for the next pass. */
  limit?: number;
};

/**
 * One pass over the deliveries that are due. Answers how many arrived and how many did not.
 *
 * It never rejects for one delivery: a receiver that is down must not stop the notes of the others.
 * Without the key that opens the targets, nothing is attempted and nothing is counted as a failure:
 * the rows wait for the key.
 */
export async function deliverDue({
  accounts,
  secretsKey,
  send,
  now = Date.now,
  limit = 20,
}: DeliverySeams): Promise<{ delivered: number; failed: number }> {
  let delivered = 0;
  let failed = 0;
  if (secretsKey === undefined) return { delivered, failed };

  for (const delivery of await accounts.dueDeliveries(now(), limit)) {
    const kept = await accounts.sealedKey(delivery.connectorId);
    const target = kept?.kind === 'rest' ? openTarget(kept.sealed, secretsKey) : undefined;

    let status: number | undefined;
    let error: string | undefined;
    if (target === undefined) {
      error = 'The address of this connector could not be opened';
    } else {
      const timestamp = Math.floor(now() / 1_000);
      try {
        status = (
          await send(
            target.url,
            {
              'Content-Type': 'application/json',
              'User-Agent': 'Fruitback',
              [DELIVERY_HEADER]: delivery.id,
              [TIMESTAMP_HEADER]: String(timestamp),
              [SIGNATURE_HEADER]: signature(target.secret, timestamp, delivery.body),
            },
            delivery.body,
          )
        ).status;
      } catch (thrown) {
        error = thrown instanceof Error ? thrown.message.slice(0, 200) : 'The request did not finish';
      }
    }

    if (status !== undefined && status >= 200 && status < 300) {
      await accounts.settleDelivery(delivery.id, { delivered: true });
      delivered += 1;
      continue;
    }

    const wait = RETRY_AFTER_SECONDS[delivery.attempts];
    await accounts.settleDelivery(delivery.id, {
      delivered: false,
      at: now(),
      ...(status === undefined ? {} : { status }),
      ...(error === undefined ? {} : { error }),
      ...(wait === undefined ? {} : { nextAt: now() + wait * 1_000 }),
    });
    failed += 1;
  }

  await accounts.dropAbandonedDeliveries(now() - ABANDONED_KEPT_DAYS * 24 * 60 * 60 * 1_000);

  return { delivered, failed };
}
