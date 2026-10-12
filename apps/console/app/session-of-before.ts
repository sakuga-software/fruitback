/**
 * The session of the console of before (FRU-98, FRU-99), for a worker that does not serve
 * better-auth yet. FRU-150 removes this file with the path of before.
 *
 * The console and the worker are not deployed at the same instant (FRU-148). Until the worker says
 * in `GET /auth/providers` that it serves better-auth, the console signs in as before: an access
 * token in this module, in memory, and a refresh cookie that this script cannot read. Against a
 * worker that serves better-auth, nothing here runs, and the console holds no token at all.
 */

import { reach } from './transport.ts';

let access: string | undefined;

/** The header of the access token, when this tab holds one. */
export function authorization(): Record<string, string> {
  return access === undefined ? {} : { Authorization: `Bearer ${access}` };
}

/** Whether this tab holds an access token: the first call asks for one. */
export function holdsToken(): boolean {
  return access !== undefined;
}

let inFlight: Promise<boolean> | undefined;

/**
 * Spends the cookie for a fresh access token. `false` means signed out.
 *
 * WARNING: one refresh at a time. Two calls that spend the same refresh token race, and the worker
 * reads the second as a retry: whichever answer lands last decides which token the browser keeps.
 * Every caller joins the refresh already in flight, like `refreshOnce` in the extension.
 */
export function refresh(): Promise<boolean> {
  inFlight ??= spend().finally(() => {
    inFlight = undefined;
  });

  return inFlight;
}

async function spend(): Promise<boolean> {
  const response = await reach('/console/session/refresh', { method: 'POST' });
  // No answer is not a refusal: the access token this tab holds can still be good.
  if (response === undefined) return false;
  if (!response.ok) {
    access = undefined;

    return false;
  }
  const body = (await response.json().catch(() => ({}))) as { accessToken?: unknown };
  if (typeof body.accessToken !== 'string') return false;
  access = body.accessToken;

  return true;
}

/** Keeps the access token of an answer of `/auth/email/redeem`. */
export function holdAccess(token: string): void {
  access = token;
}

export async function logOut(): Promise<void> {
  await reach('/console/session/logout', { method: 'POST' });
  access = undefined;
}
