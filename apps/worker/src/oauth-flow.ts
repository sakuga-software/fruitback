import type { Kv } from './kv.ts';

/**
 * The parts that a way to a provider and back shares (FRU-134, then FRU-360): Linear's OAuth, and the
 * installation of the GitHub App. Each flow names its own cookie, its own path and its own keys.
 */

/** A minute to go from the console to the worker. The ticket is spent by that one navigation. */
export const TICKET_TTL_MS = 60 * 1_000;
/** Ten minutes to come back from the provider. A `state` older than that is a page somebody left open. */
export const STATE_TTL_MS = 10 * 60 * 1_000;

export function random(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url');
}

/** Reads a value of the Kv once. The Kv has no delete: an entry that ends in a millisecond reads as spent. */
export async function spend(kv: Kv, key: string): Promise<Record<string, unknown> | undefined> {
  const kept = await kv.get(key);
  if (kept === undefined || kept === '') return undefined;
  await kv.set(key, '', 1);

  try {
    return JSON.parse(kept) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** A ticket as the console reads it: a value of the Kv that says who starts, and the address of the start. */
export async function issueTicket(
  kv: Kv,
  prefix: string,
  who: { workspace: string; account: string },
): Promise<string> {
  const ticket = random(24);
  await kv.set(`${prefix}${ticket}`, JSON.stringify(who), TICKET_TTL_MS);

  return ticket;
}

/** Who a ticket names, once, or `undefined` for a ticket that is malformed, spent or unknown. */
export async function spendTicket(
  kv: Kv,
  prefix: string,
  ticket: string,
): Promise<{ workspace: string; account: string } | undefined> {
  const who = /^[\w-]{16,64}$/.test(ticket) ? await spend(kv, `${prefix}${ticket}`) : undefined;
  if (typeof who?.workspace !== 'string' || typeof who.account !== 'string') return undefined;

  return { workspace: who.workspace, account: who.account };
}

export function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);

  return new Response(null, { status: 302, headers });
}

/** `SameSite=Lax`, not `Strict`: the provider sends the person back with a navigation from another site. */
export function stateCookie(name: string, path: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

export function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=') || undefined;
  }

  return undefined;
}

/**
 * The `state` of a callback, and what the worker kept for it, spent. `undefined` when the `state` is
 * not the one this browser left with, or not one this worker issued.
 */
export async function spendState(
  request: Request,
  kv: Kv,
  { cookie, prefix }: { cookie: string; prefix: string },
): Promise<Record<string, unknown> | undefined> {
  const state = new URL(request.url).searchParams.get('state') ?? '';
  if (state === '' || readCookie(request, cookie) !== state) return undefined;

  return spend(kv, `${prefix}${state}`);
}
