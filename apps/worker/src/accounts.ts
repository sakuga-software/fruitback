import type { ClientMap } from './clients.ts';

/**
 * People, teams and the sites a team reviews (FRU-96).
 *
 * Until here the worker knew clients, from its environment, and sessions, from a pairing code. With
 * `FRUITBACK_ACCOUNTS_PATH` it also knows who signed in, which workspaces they belong to, and which
 * sites each workspace reviews. The console writes those sites, and the worker reads them as its
 * client map: a site is a client whose workspace is its own.
 *
 * **The pairing code stays the only thing that opens a session.** Signing in by e-mail or by GitHub
 * ends with the worker minting a code for the account, in its workspace. Nothing here mints a token.
 */

/** An account is a person, known by an address a provider or a link proved they read. */
/** `locale` is the language the person reads: their e-mails are written in it (FRU-119). */
export type Account = { id: string; email: string; name?: string; locale?: string };

/**
 * A language tag as `Intl` writes it, or `undefined` for a value that is not one.
 *
 * The value comes from a browser. It is stored and later chooses the words of an e-mail, so it is
 * parsed here and never kept as typed.
 */
export function readLocaleTag(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 35) return undefined;
  try {
    return new Intl.Locale(value.trim()).toString();
  } catch {
    return undefined;
  }
}

export type Workspace = { id: string; name: string };

/**
 * The four roles of the design (board « My account »).
 *
 * - `owner`: everything, and the only one who can delete the workspace.
 * - `admin`: sites, sources and members.
 * - `member`: every site of the workspace, and the links to the tracker.
 * - `guest`: leaves and reads notes, never sees the tracker. Sharing a site with one guest is FRU-104.
 */
export const ROLES = ['owner', 'admin', 'member', 'guest'] as const;
export type Role = (typeof ROLES)[number];

/** What a person can do in a workspace. Each one is a route of the console. */
export const ACTIONS = [
  'read-feedback',
  'see-tracker',
  'manage-sites',
  'manage-members',
  'manage-workspace',
  'delete-workspace',
] as const;
export type Action = (typeof ACTIONS)[number];

const RIGHTS: Record<Role, readonly Action[]> = {
  owner: ACTIONS,
  admin: ['read-feedback', 'see-tracker', 'manage-sites', 'manage-members', 'manage-workspace'],
  member: ['read-feedback', 'see-tracker'],
  guest: ['read-feedback'],
};

/** Whether this role may do this. The one table, so a route cannot hold its own copy of the rule. */
export function can(role: Role, action: Action): boolean {
  return RIGHTS[role].includes(action);
}

/**
 * Who reads the notes of a site: the two words of the design (P2) in place of the three modes.
 *
 * `members` is `read: 'authenticated'`, with a session of the workspace. `everyone` is `public`.
 */
export const VISIBILITIES = ['members', 'everyone'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export type Site = { id: string; workspaceId: string; origin: string; visibility: Visibility };

/** How a sign-in method names the person. `email` is the link, and its subject is the address. */
export const PROVIDERS = ['email', 'github', 'google', 'linear'] as const;
export type Provider = (typeof PROVIDERS)[number];

export type AccountStore = {
  /**
   * The account behind this sign-in, created on the first one.
   *
   * **Two providers that prove the same address are one account.** A provider that did not verify
   * the address must not call this: an unverified address would join the account of its owner.
   */
  signIn(login: {
    provider: Provider;
    subject: string;
    email: string;
    name?: string;
    /** Kept only for an account that has no language yet: a sign-in from another browser changes nothing. */
    locale?: string;
  }): Promise<Account>;
  account(id: string): Promise<Account | undefined>;
  /** The language the person chose. `undefined` removes the choice. */
  setLocale(account: string, locale: string | undefined): Promise<void>;
  /** The language of the account behind this address, if there is one and it has one. */
  localeOf(email: string): Promise<string | undefined>;
  createWorkspace(name: string, owner: string): Promise<Workspace>;
  /** Every workspace this account belongs to, with its role there, oldest first. */
  memberships(account: string): Promise<{ workspace: Workspace; role: Role }[]>;
  role(workspace: string, account: string): Promise<Role | undefined>;
  addSite(workspace: string, site: { origin: string; visibility: Visibility }): Promise<Site>;
  sites(workspace: string): Promise<Site[]>;
  removeSite(workspace: string, site: string): Promise<boolean>;
  /** Removes the workspace, its members and its sites. Notes already in a tracker stay there. */
  deleteWorkspace(workspace: string): Promise<void>;
  /** Every site, as the client map the routing reads. */
  clientMap(): Promise<ClientMap>;
  /**
   * Keeps a sign-in link for an address (FRU-98): the digest of its code, never the code.
   *
   * The account does not exist yet, and is not created here: an address is proven when its link is
   * opened, and only then does `signIn` make it an account.
   */
  createEmailLink(link: { codeHash: string; email: string; expiresAt: number }): Promise<void>;
  /** Spends a link once and answers its address, or `undefined` for a link spent, expired or unknown. */
  spendEmailLink(codeHash: string, now: number): Promise<string | undefined>;
};

/**
 * A site as a client of the routing (FRU-95): its workspace, its one origin, and who reads it.
 *
 * Exported because this projection is the whole contract between the accounts and the read path.
 */
export function clientOf(site: Site): ClientMap[string] {
  return {
    workspace: site.workspaceId,
    origins: [site.origin],
    read: site.visibility === 'members' ? 'authenticated' : 'public',
  };
}

/**
 * The origin of an address a person pasted, or `undefined` when it is not a site.
 *
 * The design says « adding a site is pasting its URL » (P3). A path or a query is what people paste,
 * and the origin is what the browser sends, so that is what is kept.
 */
export function siteOrigin(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    if (url.username !== '' || url.password !== '') return undefined;

    return url.origin;
  } catch {
    return undefined;
  }
}

/** An address as an account stores it: trimmed, lower case. A provider can answer either case. */
export function normalizeEmail(value: string): string | undefined {
  const email = value.trim().toLowerCase();

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : undefined;
}
