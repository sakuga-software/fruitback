import type { AccountState } from './popup-state.ts';
import type { Sessions, StoredSession } from './session.ts';

/**
 * The session of the account of the Fruitback of this build, as the popup and the side panel find
 * it (FRU-560, FRU-735). One rule for both: the side panel said « signed in » for a session that
 * Fruitback had ended, because it only looked at what storage held.
 */

/**
 * The account state of `cloud`, out of what this browser holds.
 *
 * Asked only when there is an account: `ensureAccess` answers from the grant it holds while that is
 * fresh, and refreshes it otherwise. A refusal forgets the session (`session.ts`), so `ended` is
 * said once. A pairing is not an account, and is not asked.
 */
export async function accountOf(
  cloud: string | undefined,
  held: Record<string, StoredSession>,
  sessions: Pick<Sessions, 'ensureAccess'>,
): Promise<AccountState> {
  if (cloud === undefined || held[cloud]?.account !== true) return 'none';
  const access = await sessions.ensureAccess(cloud).catch(() => undefined);
  if (access === undefined || (!access.ok && access.reason === 'unavailable')) return 'unreachable';
  if (!access.ok) return access.reason === 'session-revoked-or-expired' ? 'ended' : 'none';

  return 'ok';
}

/**
 * This browser holds a session of `cloud`: an account, or a pairing (FRU-663). An account that
 * ended is not one: `accountOf` forgot it after `held` was read.
 */
export function holdsCloudSession(
  cloud: string | undefined,
  held: Record<string, StoredSession>,
  state: AccountState,
): boolean {
  return cloud !== undefined && held[cloud] !== undefined && state !== 'ended';
}

/** `holdsCloudSession`, read now: what the side panel asks before it says « Sign in to Fruitback ». */
export async function signedInTo(
  cloud: string | undefined,
  sessions: Pick<Sessions, 'list' | 'ensureAccess'>,
): Promise<boolean> {
  if (cloud === undefined) return false;
  const held = await sessions.list();
  const state = await accountOf(cloud, held, sessions);
  // Kentō #07eb72: a sign-in that landed during the refresh holds a new session. `ended` forgot only
  // the one that was refused (`end` in `session-storage.ts`), so a session held now is that new one.
  if (state === 'ended') return (await sessions.list())[cloud] !== undefined;

  return holdsCloudSession(cloud, held, state);
}
