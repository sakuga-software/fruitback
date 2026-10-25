/**
 * A provider linked from « My account » whose address is not the one of the account (FRU-415, step 1).
 *
 * better-auth links an address that differs (`accountLinking.allowDifferentEmails`), and this file
 * puts the conditions around it. The routes are in `auth-routes.ts`.
 *
 * - **The link starts by a `POST` of the console** (`POST /console/auth/link/<provider>`). The hook
 *   `markLinkStart` writes the id of the session that started it in the state of better-auth, in its
 *   `serverContext`: no request writes there.
 * - **The way back from the provider writes no row.** `guardLink` runs in `validateUserInfo` of
 *   better-auth, before it writes. It refuses an address that is missing or that the provider did
 *   not verify, a provider account of another person, an address of another account, and a provider
 *   that the account has already. Otherwise it keeps the link as a pending one, for
 *   `PENDING_LINK_MS`, and refuses with `LINK_NEEDS_CONFIRMATION`: the person comes back to
 *   « My account », which asks « Link the Google account x@y to your Fruitback account? ».
 * - **The confirmation writes the row**: `POST /console/me/sign-in/pending`, from the session that
 *   started the link, once. It reads every condition again, then sends an alert to the address of the
 *   account.
 * - **The identity is the id of the provider account** (`sub` of Google, `id` of GitHub), read by the
 *   provider's own `accountSubject`, as better-auth reads it. The address is shown, and is not kept.
 *
 * A sign-in with a provider is not a link of this file: its state has no `link`, and the rule of
 * FRU-97 stays (one verified address is one account).
 */

/** The code of the way back that asks for the confirmation. The worker writes `?confirm=` in its place. */
export const LINK_NEEDS_CONFIRMATION = 'link_needs_confirmation';
/** The provider gave no address: GitHub can give none. */
export const EMAIL_NOT_FOUND = 'email_not_found';
/** The provider did not say that the address is verified. */
export const EMAIL_NOT_VERIFIED = 'email_not_verified';
/** The address is the one of another Fruitback account. */
export const EMAIL_ALREADY_USED = 'email_already_used';
/** The provider account opens another Fruitback account. The code of better-auth for the same refusal. */
export const ACCOUNT_OF_ANOTHER = 'account_already_linked_to_different_user';
/** The account has an account of this provider linked already. */
export const PROVIDER_ALREADY_LINKED = 'provider_already_linked';
/** A link that the route of the worker did not start: no session in its state. */
export const LINK_NOT_STARTED = 'link_not_started';

/** How long a link waits for its confirmation: the life of the state of better-auth (600 s in 1.7.10). */
export const PENDING_LINK_MS = 10 * 60 * 1000;

/** The key of the `serverContext` of the state that holds the start of a link. */
const STARTED = 'fruitbackLink';

/** A workspace id, as the console puts it in the address of « My account ». */
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** A link that waits for its confirmation. `session`: the id of the session that started it. */
export type PendingLink = {
  provider: string;
  accountId: string;
  email: string;
  session: string;
  workspace?: string;
};

/** The identifier of the pending link of a person, in the table `verification`: one per person. */
export function pendingLinkKey(userId: string): string {
  return `fruitback-link:${userId}`;
}

/** What this file reads and writes through the internal adapter of better-auth 1.7.10. */
export type LinkAdapter = {
  findUserByEmail(email: string): Promise<{ user: { id: string } } | null>;
  findAccountByKey(key: { providerId: string; accountId: string }): Promise<{ userId: string } | null>;
  findAccounts(userId: string): Promise<{ providerId: string }[]>;
  createAccount(account: { userId: string; providerId: string; accountId: string }): Promise<unknown>;
  createVerificationValue(data: { identifier: string; value: string; expiresAt: Date }): Promise<unknown>;
  findVerificationValue(identifier: string): Promise<{ value: string; expiresAt: Date } | null>;
  consumeVerificationValue(identifier: string): Promise<{ value: string; expiresAt: Date } | null>;
  deleteVerificationByIdentifier(identifier: string): Promise<void>;
};

/** A row of `verification` read as a pending link, or `undefined` when it is not one or has expired. */
export function readPending(row: { value: string; expiresAt: Date } | null, now = Date.now()): PendingLink | undefined {
  if (row === null || new Date(row.expiresAt).getTime() <= now) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { provider, accountId, email, session, workspace } = parsed as Record<string, unknown>;
  if (
    typeof provider !== 'string' ||
    typeof accountId !== 'string' ||
    typeof email !== 'string' ||
    typeof session !== 'string'
  ) {
    return undefined;
  }

  return { provider, accountId, email, session, ...(typeof workspace === 'string' ? { workspace } : {}) };
}

/**
 * Why this provider account may not be linked to `userId`, `linked` when it is linked to them
 * already, or `undefined` when it may be. Read at the way back, and again at the confirmation.
 */
export async function refusalOf(
  adapter: LinkAdapter,
  link: { userId: string; providerId: string; accountId: string; email: string },
): Promise<string | 'linked' | undefined> {
  const owner = await adapter.findAccountByKey({ providerId: link.providerId, accountId: link.accountId });
  if (owner !== null) return owner.userId === link.userId ? 'linked' : ACCOUNT_OF_ANOTHER;
  // better-auth keeps an address in lower case.
  const holder = await adapter.findUserByEmail(link.email.toLowerCase());
  if (holder !== null && holder.user.id !== link.userId) return EMAIL_ALREADY_USED;
  const mine = await adapter.findAccounts(link.userId);
  if (mine.some((row) => row.providerId === link.providerId)) return PROVIDER_ALREADY_LINKED;

  return undefined;
}

/** What better-auth gives `validateUserInfo` (1.7.10, `utils/validate-user-info.mjs`). */
type UserInfoInput = {
  user: { id?: unknown; email?: unknown; emailVerified?: unknown };
  source?: { action?: string; method?: string; oauth?: { providerId?: string; profile?: unknown } };
};

type Provider = { id: string; accountSubject?: (input: { profile: unknown; tokens: object }) => unknown };

/** The part of the context of a call of better-auth that `guardLink` reads. */
type LinkContext = {
  context: { internalAdapter: unknown; socialProviders: unknown };
};

/** The functions of `better-auth/api` that this file calls. `auth.ts` loads them. */
export type LinkApi = {
  getOAuthState(): Promise<{ link?: unknown; serverContext?: Record<string, unknown> } | null>;
  addOAuthServerContext(values: Record<string, unknown>): Promise<void>;
  getSessionFromCtx(context: never): Promise<{ session: { id: string } } | null>;
};

/** The id of the provider account, read by the provider's own `accountSubject`, as better-auth does. */
async function accountIdOf(context: LinkContext, providerId: string, profile: unknown): Promise<string | undefined> {
  const listed = await context.context.socialProviders;
  const provider = (Array.isArray(listed) ? (listed as Provider[]) : []).find((each) => each.id === providerId);
  if (provider?.accountSubject === undefined) return undefined;
  const subject = await provider.accountSubject({ profile, tokens: {} });
  if (typeof subject !== 'string' && typeof subject !== 'number') return undefined;
  const id = String(subject);

  return id.trim() === '' ? undefined : id;
}

/** The workspace of the address of « My account » that the route of the worker wrote as `callbackURL`. */
function workspaceOf(callbackURL: unknown): string | undefined {
  if (typeof callbackURL !== 'string') return undefined;
  try {
    const id = /^\/w\/([^/]+)\/account$/.exec(new URL(callbackURL).pathname)?.[1];

    return id !== undefined && WORKSPACE_ID.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The `before` hook of `/link-social`: the id of the session that starts the link goes into the state.
 * `/link-social` is closed to a request; the route of the worker calls it in the process.
 */
export function markLinkStart(api: LinkApi) {
  return async (context: { path?: string; body?: { callbackURL?: unknown } }): Promise<void> => {
    if (context.path !== '/link-social') return;
    const found = await api.getSessionFromCtx(context as never);
    // No session: better-auth refuses the call itself.
    if (found === null) return;
    const workspace = workspaceOf(context.body?.callbackURL);
    await api.addOAuthServerContext({
      [STARTED]: { session: found.session.id, ...(workspace === undefined ? {} : { workspace }) },
    });
  };
}

/**
 * `validateUserInfo` of better-auth: the conditions of a link, on the way back from the provider.
 * It answers a code of refusal, or keeps a pending link and answers `LINK_NEEDS_CONFIRMATION`.
 */
export function guardLink(api: LinkApi, now: () => number = Date.now) {
  return async (data: UserInfoInput, context: LinkContext): Promise<{ error: string } | undefined> => {
    if (data.source?.action !== 'link-account') return undefined;
    const state = await api.getOAuthState();
    // A sign-in that joins a provider of the same verified address (FRU-97): not a link of this file.
    if (state?.link === undefined || state.link === null) return undefined;
    const started = state.serverContext?.[STARTED] as { session?: unknown; workspace?: unknown } | undefined;
    if (typeof started?.session !== 'string') return { error: LINK_NOT_STARTED };
    const userId = data.user.id;
    const providerId = data.source.oauth?.providerId;
    if (typeof userId !== 'string' || typeof providerId !== 'string') return { error: LINK_NOT_STARTED };

    const email = data.user.email;
    if (typeof email !== 'string' || email.trim() === '') return { error: EMAIL_NOT_FOUND };
    if (data.user.emailVerified !== true) return { error: EMAIL_NOT_VERIFIED };
    const accountId = await accountIdOf(context, providerId, data.source.oauth?.profile);
    if (accountId === undefined) return { error: 'unable_to_get_user_info' };

    const adapter = context.context.internalAdapter as LinkAdapter;
    const refusal = await refusalOf(adapter, { userId, providerId, accountId, email });
    // Linked to this person already: better-auth updates its row, which holds no token.
    if (refusal === 'linked') return undefined;
    if (refusal !== undefined) return { error: refusal };

    const pending: PendingLink = {
      provider: providerId,
      accountId,
      email,
      session: started.session,
      ...(typeof started.workspace === 'string' ? { workspace: started.workspace } : {}),
    };
    const identifier = pendingLinkKey(userId);
    await adapter.deleteVerificationByIdentifier(identifier);
    await adapter.createVerificationValue({
      identifier,
      value: JSON.stringify(pending),
      expiresAt: new Date(now() + PENDING_LINK_MS),
    });

    return { error: LINK_NEEDS_CONFIRMATION };
  };
}
