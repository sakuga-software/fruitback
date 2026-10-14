import type { AccountStore } from './accounts.ts';

/**
 * « Last seen » of a member (FRU-249, decision of Mathieu on 2026-10-13, Q7): the day of UTC of their
 * last call to the console in a workspace, or of the last refresh of an extension of theirs for it.
 *
 * **A day, and no hour**: the screen says « Today », « Yesterday », « 3 days ago », and an hour would
 * tell a colleague when somebody works. **One write a day at most** for a person in a workspace, in
 * this process: the day written last is remembered here, and a call of the same day writes nothing.
 * Only an owner or an admin reads it (`GET /console/workspaces/<id>/members/seen`).
 */

/** The day of UTC of an instant, as `YYYY-MM-DD`. */
export function dayOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** What this process wrote last, by workspace and account. Emptied when it grows past the bound. */
const written = new Map<string, string>();
const MAX_REMEMBERED = 10_000;

/**
 * Notes that `account` was seen in `workspace` now. It never fails the call it is part of: a « Last
 * seen » that could not be written says an older day, and the person's call goes on.
 */
export async function seen(
  accounts: AccountStore,
  workspace: string,
  account: string,
  now = Date.now(),
): Promise<void> {
  const day = dayOf(now);
  const key = `${workspace} ${account}`;
  if (written.get(key) === day) return;
  try {
    await accounts.markSeen(workspace, account, day);
    if (written.size >= MAX_REMEMBERED) written.clear();
    written.set(key, day);
  } catch (error) {
    console.error(`[fruitback] the day a member was last seen was not written: ${String(error)}`);
  }
}

/**
 * A person left a workspace, or was removed from it: their day there went with the membership, so
 * this process forgets that it wrote one. Somebody who comes back the same day is seen again.
 */
export function forgetSeenOf(workspace: string, account: string): void {
  written.delete(`${workspace} ${account}`);
}

/** For the tests: what this process remembers goes, so the next call writes again. */
export function forgetSeen(): void {
  written.clear();
}
