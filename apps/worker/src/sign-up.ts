import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Who may create an account (FRU-278, decision of 2026-10-18 in FRU-260).
 *
 * `FRUITBACK_SIGN_UP` has two values:
 *
 * - `invited`, the default: a sign-in that would create an account is refused, except in three cases.
 *   The address has an invitation that waits (FRU-104, FRU-250). The instance has no account yet: the
 *   first one is its administrator (FRU-261). The sign-in is the link of `FRUITBACK_FIRST_ADMIN`, or of
 *   the command `admin-link` (FRU-221).
 * - `anyone`: every sign-in creates the account it needs, as before FRU-278.
 *
 * A person who has an account signs in as before, whatever the value.
 *
 * **One place decides**: `databaseHooks.user.create.before` in `auth.ts`. Every way to sign in goes
 * through better-auth, and better-auth creates each account through that hook: the link of the
 * e-mail, GitHub, Google, and any route of better-auth. `sign-up.test.ts` fails on a way to sign in
 * that has no case, and on a write to the table `user` outside the files it names.
 */

export const SIGN_UP_MODES = ['invited', 'anyone'] as const;
export type SignUp = (typeof SIGN_UP_MODES)[number];

/** A self-hosted instance takes the people it invites, and nobody else. The Cloud sets `anyone`. */
export const DEFAULT_SIGN_UP: SignUp = 'invited';

/** What `readConfig` says of a value that is not one of `SIGN_UP_MODES`. The value is not quoted. */
export const SIGN_UP_REFUSED = 'FRUITBACK_SIGN_UP (invited, the default, or anyone)';

/**
 * The code of a sign-in that would create an account, and that the instance refuses. better-auth
 * puts it in `?error=` of the console on the way back from a provider, and `POST /console/auth/email/redeem`
 * answers `invitation-required`.
 */
export const INVITATION_REQUIRED = 'INVITATION_REQUIRED';

/** The value of the variable, or the default. Another value goes through as written, and the schema refuses it. */
export function readSignUp(value: string | undefined): string {
  return value === undefined || value.trim() === '' ? DEFAULT_SIGN_UP : value.trim();
}

/** What the instance knows about a new address when better-auth asks to create its account. */
export type SignUpFacts = {
  /** The instance has no account at all. */
  firstAccount: boolean;
  /** An invitation for this address waits, and has not ended. */
  invited: boolean;
  /** The operator made the link that this sign-in spends (FRU-221). */
  byOperator: boolean;
};

/** Whether an account may be created for a new address. */
export function maySignUp(mode: SignUp, facts: SignUpFacts): boolean {
  return mode === 'anyone' || facts.firstAccount || facts.invited || facts.byOperator;
}

/**
 * The address of the link of an operator that is spent now, in this async context.
 *
 * No request can set it: only `redeemLink` of `auth-routes.ts` does, after `adminLinkAt` said that
 * the worker made this link.
 */
const operatorLink = new AsyncLocalStorage<string>();

/** Runs `work` with `email` as the address of a link that the operator made. */
export function asOperatorLink<T>(email: string, work: () => Promise<T>): Promise<T> {
  return operatorLink.run(email, work);
}

/** Whether `email` is the address of a link of the operator that is spent in this async context. */
export function isOperatorLink(email: string): boolean {
  return operatorLink.getStore() === email;
}
