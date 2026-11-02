import type { Auth } from './auth.ts';

/**
 * The parts of better-auth the worker reaches past its typed surface (FRU-507): the database
 * adapter, the internal adapter, and the endpoints of the plugins it installs.
 *
 * `Auth` is the type of an instance with the default options, so the plugins of `auth.ts` and the
 * adapter do not show in it. Each type below names only what the worker calls, as better-auth 1.7
 * answers it. The casts are here and nowhere else: a change of better-auth that breaks one of these
 * shapes is read in this file.
 */

/** A condition of a lookup, as the worker writes one. */
type Where = { field: string; value: string }[];

/** A row of `session`. A date is a `Date` from Postgres and a string from a JSON adapter. */
export type SessionRow = {
  id: string;
  createdAt: Date | string;
  expiresAt: Date | string;
  updatedAt: Date | string;
  userAgent?: string | null;
  ipAddress?: string | null;
  browser?: string | null;
};

/** A row of `account`: which provider a person linked. */
export type AccountRow = { id: string; providerId: string };

/** What the worker reads of a row of `invitation`, `member` or `user`. Each field is checked where it is read. */
export type InvitationFields = {
  organizationId?: unknown;
  banned?: unknown;
  inviterId?: unknown;
  role?: unknown;
  status?: unknown;
  email?: unknown;
  expiresAt?: unknown;
  mailed?: unknown;
};

/** The database adapter of better-auth, with the layer of `auth-at-rest.ts` in front of it. */
export type AuthAdapter = {
  findMany(input: { model: 'session'; where: Where }): Promise<SessionRow[]>;
  findMany(input: { model: 'account'; where: Where }): Promise<AccountRow[]>;
  findOne(input: { model: 'invitation' | 'member' | 'user'; where: Where }): Promise<InvitationFields | null>;
  delete(input: { model: 'session'; where: Where }): Promise<void>;
  update(input: {
    model: 'invitation';
    where: Where;
    update: { mailed: boolean } | { email: string };
  }): Promise<unknown>;
  updateMany(input: { model: 'invitation'; where: Where; update: { status: 'canceled' } }): Promise<unknown>;
};

/** The internal adapter of better-auth: the users, the accounts and the table `verification`. */
export type InternalAdapter = {
  findUserByEmail(email: string): Promise<{ user: { id: string } } | null>;
  findAccountByKey(key: { providerId: string; accountId: string }): Promise<{ userId: string } | null>;
  findAccounts(userId: string): Promise<{ providerId: string }[]>;
  createAccount(account: { userId: string; providerId: string; accountId: string }): Promise<unknown>;
  createVerificationValue(data: { identifier: string; value: string; expiresAt: Date }): Promise<unknown>;
  findVerificationValue(identifier: string): Promise<{ value: string; expiresAt: Date } | null>;
  consumeVerificationValue(identifier: string): Promise<{ value: string; expiresAt: Date } | null>;
  deleteVerificationByIdentifier(identifier: string): Promise<void>;
};

/** The workspace an organization endpoint answers, before it is checked. */
type OrganizationAnswer = { id?: unknown; name?: unknown } | null;

/**
 * The endpoints the worker calls on `auth.api`. Those that answer a `Response` are called with
 * `asResponse` or answer one by themselves; the others answer their body.
 */
export type AuthApi = {
  signInSocial(input: object): Promise<Response>;
  linkSocialAccount(input: object): Promise<Response>;
  unlinkAccount(input: object): Promise<Response>;
  signInMagicLink(input: object): Promise<unknown>;
  magicLinkVerify(input: object): Promise<Response>;
  listUserInvitations(input: object): Promise<unknown>;
  createOrganization(input: object): Promise<OrganizationAnswer>;
  updateOrganization(input: object): Promise<OrganizationAnswer>;
};

/** The database adapter of this instance. */
export async function adapterOf(auth: Auth): Promise<AuthAdapter> {
  return (await auth.$context).adapter as unknown as AuthAdapter;
}

/** The internal adapter of this instance. */
export async function internalAdapterOf(auth: Auth): Promise<InternalAdapter> {
  return (await auth.$context).internalAdapter as unknown as InternalAdapter;
}

/** The endpoints of this instance, its plugins included. The object is `auth.api` itself. */
export function apiOf(auth: Auth): AuthApi {
  return auth.api as unknown as AuthApi;
}
