import type { Role } from './accounts.ts';
import { verifyIdentityToken } from './identity.ts';
import type { SessionIdentity, SessionStore } from './session.ts';

/**
 * Whether the session of an extension is still valid now, read in the store (FRU-238).
 *
 * An access token lives 10 minutes, and nothing reaches a token already minted: a session ended in
 * « My account », by a log out or a replay, or a person removed from a workspace, still holds a token
 * that verifies until it expires. **A route that reads** keeps that window: it is documented in
 * `SECURITY.md`. **A route that writes for an extension calls this function**, and pays one read of
 * the store for it (decided on 2026-10-14, for the creation of a site, FRU-255, and every write after
 * it). It answers the person of the session, or `undefined`, and the route answers `401`.
 *
 * What it checks, each from the store and not from the token:
 *
 * - the token is signed with the worker key, and names its chain (`sid`). A token minted before the
 *   chain was in it names none and is refused: the extension refreshes, and its next token names it;
 * - a token of that chain is live and not expired: the session did not end;
 * - the session is the one the token says: the same person, and the same workspace or the same account;
 * - the person is still a member of the workspace of the session, or the account is still there.
 *
 * The role for the action is the route's to read: this says who the session is, now.
 */

export type SessionCheck = {
  sessions: SessionStore;
  /** The worker key, which signs the tokens of the sessions. */
  secret: string;
  /** The role of an account in a workspace. Absent on a worker with no accounts. */
  roleIn?: (workspace: string, account: string) => Promise<Role | undefined>;
  /** Whether an account is still there. Absent on a worker with no accounts: no session of an account is. */
  accountExists?: (account: string) => Promise<boolean>;
  now?: number;
};

export async function sessionStillValid(token: string, check: SessionCheck): Promise<SessionIdentity | undefined> {
  const now = check.now ?? Date.now();
  const verified = await verifyIdentityToken(token, check.secret, now);
  if (!verified.ok || verified.chain === undefined) return undefined;

  const identity = await check.sessions.liveIdentity(verified.chain, now);
  if (identity === undefined) return undefined;
  // The chain is the one of this person, of this workspace or of this account.
  if (
    identity.subject !== verified.reporter.id ||
    identity.workspace !== verified.workspace ||
    (identity.account === true) !== (verified.account === true)
  ) {
    return undefined;
  }

  if (identity.account === true) {
    return check.accountExists !== undefined && (await check.accountExists(identity.subject)) ? identity : undefined;
  }
  if (identity.workspace !== undefined && check.roleIn !== undefined) {
    return (await check.roleIn(identity.workspace, identity.subject)) === undefined ? undefined : identity;
  }

  return identity;
}
