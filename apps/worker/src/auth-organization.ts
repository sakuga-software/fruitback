import { type AccountStore, type Workspace, can } from './accounts.ts';
import { newId, roleOf } from './account-rows.ts';
import { AUTH_BASE_PATH, type Auth, INVITATION_SECONDS, INVITER_GONE } from './auth.ts';
import { type AuthRouteContext, AuthUnavailable, headersFor, mutationAllowed, sessionOfCookie } from './auth-routes.ts';
import { MAX_BODY_BYTES, readBoundedText } from './bounded-body.ts';
import { ORGANIZATION_PATHS, type OrganizationRule, readOrganizationInput } from './organization-paths.ts';
import { EMAIL_LINKS_PER_WINDOW, EMAIL_LINK_WINDOW_MS } from './console-routes.ts';
import type { Kv } from './kv.ts';
import { MailError, type Mailer, invitationMessage } from './mail.ts';
import type { SessionStore } from './session.ts';

/**
 * The routes of the organization plugin of better-auth, under `/console/auth/organization/` (FRU-149).
 *
 * **better-auth is the second reader of each call, never the first.** Before it reads a request, the
 * worker has checked, in this order:
 *
 * 1. the path is one of `ORGANIZATION_PATHS`, and the method is the one of its rule: else `404`, `405`;
 * 2. the cookie is a session: else `401`;
 * 3. a call that changes something comes from the console: else `403` (`mutationAllowed`);
 * 4. the request holds the fields of the rule and no other, and names its workspace: else `400`;
 *    (a route of the person, `scope: 'person'`, names none: it is about the invitations that the
 *    address of the session received, and points 5 and 6 do not apply to it);
 * 5. the caller has **one** role in that workspace, read by `accounts.role`, which reads `guest,admin`
 *    as no role: else `404`, as for a workspace that does not exist;
 * 6. that role may do what the rule needs, by `can`: else `403`.
 *
 * Then better-auth is handed a request that the worker wrote, with those fields. Its own checks stay:
 * the last owner, the permission of the role, the workspace of the member that is named.
 *
 * What a guest does not read is point 6 on `list-members`, and the routes that are not in the list.
 */

export type OrganizationRouteContext = Pick<AuthRouteContext, 'consoleUrl' | 'clientIp' | 'trackIp'> & {
  auth: Auth | Promise<Auth>;
  accounts: Pick<AccountStore, 'role' | 'account' | 'memberships' | 'localeOf'>;
  sessions: Pick<SessionStore, 'endSessionsOf'>;
  /**
   * What sends an invitation (FRU-104). Absent: the invitation is kept all the same, and the console
   * gives the link to send by hand (the decision on FRU-107).
   */
  mailer: Mailer | undefined;
  kv: Kv;
};

/** How long an invitation waits, in days: the message says the number that the plugin was given. */
export const INVITATION_DAYS = INVITATION_SECONDS / 86_400;

/**
 * How many messages one workspace sends one address in a window: the numbers of the sign-in link.
 * It counts by workspace and address, not by address alone: a count of every workspace together let
 * somebody else close the window of an address, and told an admin that it was invited elsewhere.
 * Past it the invitation is kept and no message goes (`mailed: false`).
 */
export const INVITATIONS_PER_WINDOW = EMAIL_LINKS_PER_WINDOW;

/**
 * How many invitation messages one account sends, in every workspace together, and how many one
 * workspace sends, whoever invites (FRU-209). The window of an address bounds neither: one account
 * made 12 workspaces and sent 60 messages to 60 addresses (measured), and anybody makes a
 * workspace. Past either, the invitation is kept and no message goes, as for the address.
 *
 * The numbers are for a team that invites its people in one sitting; they are not measured.
 */
export const INVITATIONS_PER_INVITER = 20;
export const INVITATIONS_PER_WORKSPACE = 40;
export const INVITER_WINDOW_MS = 60 * 60 * 1000;

/** The adapter of better-auth, to read which workspace an invitation is of, and who made it. */
type InvitationAdapter = {
  findOne(input: {
    model: 'invitation' | 'member';
    where: { field: string; value: string }[];
  }): Promise<{ organizationId?: unknown; inviterId?: unknown; role?: unknown } | null>;
  updateMany(input: {
    model: 'invitation';
    where: { field: string; value: string }[];
    update: { status: 'canceled' };
  }): Promise<unknown>;
};

/**
 * An invitation is the word of whoever made it (FRU-209). When that person is removed, leaves, or
 * loses `manage-members`, the invitations of theirs that wait in the workspace are cancelled in the
 * same call. An admin who was removed left a second admin behind, for 7 days, or for ever with
 * « Resend ».
 */
async function cancelInvitationsOf(adapter: InvitationAdapter, workspace: string, inviter: string): Promise<void> {
  await adapter.updateMany({
    model: 'invitation',
    where: [
      { field: 'organizationId', value: workspace },
      { field: 'inviterId', value: inviter },
      { field: 'status', value: 'pending' },
    ],
    update: { status: 'canceled' },
  });
}

/**
 * What follows a departure that better-auth already wrote: each step runs whatever the other does,
 * and the first failure is thrown when both are done. A cancellation that failed must not leave
 * the extensions of the person alive, nor the other way round.
 */
async function afterSomebodyWent(...steps: Promise<unknown>[]): Promise<void> {
  const failed = (await Promise.allSettled(steps)).find((step) => step.status === 'rejected');
  if (failed !== undefined) throw failed.reason;
}

/**
 * Whether whoever made an invitation still invites to its workspace: the second lock, at the
 * acceptance. It holds when the cancellation above did not run (it comes after the write of the
 * plugin, in no transaction), and for an invitation that waited before the cancellation existed.
 * An invitation that does not exist is left to better-auth, which answers it.
 */
async function inviterStillInvites(adapter: InvitationAdapter, invitationId: string): Promise<boolean> {
  const invitation = await adapter.findOne({ model: 'invitation', where: [{ field: 'id', value: invitationId }] });
  if (invitation === null) return true;
  const member = await adapter.findOne({
    model: 'member',
    where: [
      { field: 'organizationId', value: String(invitation.organizationId) },
      { field: 'userId', value: String(invitation.inviterId) },
    ],
  });
  const role = roleOf(member?.role);

  return role !== undefined && can(role, 'manage-members');
}

const PREFIX = `${AUTH_BASE_PATH}/organization/`;

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

/**
 * What the caller sent: the query of a `GET`, the body of a `POST`. `undefined`: not an object.
 * `'too-large'`: a body over the cap of the worker, which is not read to its end.
 */
async function sentBy(
  request: Request,
  rule: OrganizationRule,
): Promise<Record<string, unknown> | 'too-large' | undefined> {
  if (rule.method === 'GET') {
    const query = new URL(request.url).searchParams;
    const sent: Record<string, unknown> = {};
    for (const name of new Set(query.keys())) {
      const values = query.getAll(name);
      // A field given twice: better-auth and the worker could each read another one.
      if (values.length !== 1) return undefined;
      sent[name] = values[0];
    }

    return sent;
  }

  const text = await readBoundedText(request);
  if (text === null) return 'too-large';
  try {
    const parsed: unknown = JSON.parse(text);

    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The answer for a path of the organization plugin, or `undefined` for another path.
 *
 * `paths` is the list of the open routes. A test gives a shorter one, and the route it left out
 * answers `404`.
 *
 * WARNING: like `handleAuthRoutes`, this rejects when better-auth does. The caller answers `502`.
 */
export async function handleOrganizationRoutes(
  request: Request,
  pathname: string,
  context: OrganizationRouteContext,
  headers: Record<string, string>,
  paths: Readonly<Record<string, OrganizationRule>> = ORGANIZATION_PATHS,
): Promise<Response | undefined> {
  if (!pathname.startsWith(PREFIX)) return undefined;

  const path = pathname.slice(AUTH_BASE_PATH.length);
  const rule = Object.hasOwn(paths, path) ? paths[path] : undefined;
  if (rule === undefined) return json(404, { error: 'not-found' }, headers);
  if (request.method !== rule.method) return json(405, { error: 'method-not-allowed' }, headers);

  const auth = await context.auth;
  const mine = await sessionOfCookie(auth, request);
  if (mine === undefined) return json(401, { error: 'identity-required' }, headers);
  if (!mutationAllowed(request, context.consoleUrl)) return json(403, { error: 'origin-not-allowed' }, headers);

  const sent = await sentBy(request, rule);
  if (sent === 'too-large') return json(413, { error: 'payload-too-large', maxBytes: MAX_BODY_BYTES }, headers);
  if (sent === undefined) return json(400, { error: 'invalid-request' }, headers);
  const read = readOrganizationInput(rule, sent);
  if (!read.ok) return json(400, { error: 'invalid-request', field: read.field }, headers);
  // A route of the person names no workspace: better-auth reads the address of the session.
  const workspace = rule.scope === 'person' ? undefined : String(read.input.organizationId);
  const adapter = (await auth.$context).adapter as unknown as InvitationAdapter;

  if (workspace !== undefined) {
    // Read by the store of the worker, which takes one role of the four and nothing else. Not a
    // member answers like a workspace that does not exist, as on the routes of the console.
    const role = await context.accounts.role(workspace, mine.userId);
    if (role === undefined) return json(404, { error: 'not-found' }, headers);
    if (rule.needs !== undefined && !can(role, rule.needs)) return json(403, { error: 'forbidden', role }, headers);

    // better-auth finds the workspace of an invitation from the invitation. The role was read in the
    // workspace the call names: the invitation must be one of it, or it does not exist.
    if (rule.ofTheWorkspace === 'invitation') {
      const invitation = await adapter.findOne({
        model: 'invitation',
        where: [{ field: 'id', value: String(read.input.invitationId) }],
      });
      if (invitation?.organizationId !== workspace) return json(404, { error: 'not-found' }, headers);
    }
  }

  if (
    path === '/organization/accept-invitation' &&
    !(await inviterStillInvites(adapter, String(read.input.invitationId)))
  ) {
    return json(
      400,
      { code: INVITER_GONE, message: 'Whoever made this invitation no longer invites to the workspace' },
      headers,
    );
  }

  const invited = path === '/organization/invite-member' ? String(read.input.email) : undefined;
  // The request better-auth reads is written here: the fields of the rule, as they were read.
  const address = new URL(`${AUTH_BASE_PATH}${path}`, request.url);
  if (rule.method === 'GET')
    for (const [name, value] of Object.entries(read.input)) address.searchParams.set(name, String(value));
  const forwardedHeaders = headersFor(request, context);
  forwardedHeaders.delete('Content-Length');
  if (rule.method === 'POST') forwardedHeaders.set('Content-Type', 'application/json');
  const answer = await auth.handler(
    new Request(address, {
      method: rule.method,
      headers: forwardedHeaders,
      ...(rule.method === 'POST' ? { body: JSON.stringify(read.input) } : {}),
    }),
  );

  // Somebody who left keeps no extension for the workspace. `remove-member` does the same in a hook
  // of the plugin (`auth.ts`); `leave` runs none in 1.7.7, so it is here.
  if (path === '/organization/leave' && answer.ok && workspace !== undefined) {
    await afterSomebodyWent(
      context.sessions.endSessionsOf({ subject: mine.userId, workspace }, Date.now()),
      cancelInvitationsOf(adapter, workspace, mine.userId),
    );
  }
  // Somebody who is removed, or whose new role does not invite, keeps no invitation that waits.
  if (
    (path === '/organization/remove-member' || path === '/organization/update-member-role') &&
    answer.ok &&
    workspace !== undefined
  ) {
    const told = (await answer
      .clone()
      .json()
      .catch(() => undefined)) as { member?: { userId?: unknown }; userId?: unknown; role?: unknown } | undefined;
    const changed = path === '/organization/remove-member' ? told?.member?.userId : told?.userId;
    if (typeof changed !== 'string') throw new AuthUnavailable('better-auth answered a member with no person');
    const role = path === '/organization/remove-member' ? undefined : roleOf(told?.role);
    if (role === undefined || !can(role, 'manage-members')) await cancelInvitationsOf(adapter, workspace, changed);
  }

  // The invitation is kept: its message goes now, when the worker sends mail and the window of this
  // workspace for this address allows one more. The answer says which, in `mailed`: with `false` the
  // person who invites gives the link of the console by hand. No refusal here: the invitation
  // exists, and a `429` said that an address was invited already, here or elsewhere.
  let told: string | undefined;
  if (invited !== undefined && answer.ok && workspace !== undefined) {
    // No message for an answer that names no invitation: nothing would wait for the person.
    const kept = (await answer
      .clone()
      .json()
      .catch(() => undefined)) as { id?: unknown } | undefined;
    if (typeof kept?.id !== 'string') throw new AuthUnavailable('better-auth answered an invitation with no id');
    let mailed = false;
    // The count is taken in one step, after better-auth kept the invitation: a call that it refused
    // spends nothing, and of two calls at the same moment the one that goes over sends nothing.
    if (context.mailer !== undefined && (await mayMail(context.kv, { workspace, invited, inviter: mine.userId }))) {
      try {
        await context.mailer.send(
          await messageOf(context, { to: invited, role: String(read.input.role), workspace, inviter: mine.userId }),
        );
        mailed = true;
      } catch (error) {
        if (!(error instanceof MailError)) throw error;
        console.error(`[fruitback] ${error.message}`);

        return json(502, { error: 'mail-unavailable' }, headers);
      }
    }

    told = JSON.stringify({ ...kept, mailed });
  }

  const merged = new Headers(answer.headers);
  for (const [name, value] of Object.entries(headers)) merged.set(name, value);
  if (told !== undefined) merged.delete('Content-Length');

  return new Response(told ?? answer.body, { status: answer.status, statusText: answer.statusText, headers: merged });
}

/**
 * Whether one more invitation message may go: under the window of the address in this workspace,
 * of the account that invites, and of the workspace.
 *
 * The three are read first, and nothing is counted when one is full: a workspace past its count
 * would otherwise spend the count of each admin who tries, in every workspace of theirs, and an
 * account past its own would spend the window of each address it tries. Then each is counted in one
 * step, and the message goes only when none came back over: of two calls at the same moment, the
 * one that goes over sends nothing. Only that call, in a race, spends a count for no message.
 */
async function mayMail(kv: Kv, sent: { workspace: string; invited: string; inviter: string }): Promise<boolean> {
  const windows: [string, number, number][] = [
    [`fruitback:invitation:${sent.workspace}:${sent.invited}`, EMAIL_LINK_WINDOW_MS, INVITATIONS_PER_WINDOW],
    [`fruitback:invitations-of:${sent.inviter}`, INVITER_WINDOW_MS, INVITATIONS_PER_INVITER],
    [`fruitback:invitations-in:${sent.workspace}`, INVITER_WINDOW_MS, INVITATIONS_PER_WORKSPACE],
  ];
  for (const [key, , most] of windows) {
    if (Number((await kv.get(key)) ?? 0) >= most) return false;
  }
  const counts = await Promise.all(windows.map(([key, ttl]) => kv.incr(key, ttl)));

  return counts.every((count, index) => count <= (windows[index] as [string, number, number])[2]);
}

/**
 * The message of an invitation: who invites, to which workspace, in the language of the person it is
 * for when they have an account that says one, else in the language of the person who invites.
 *
 * The link is the page of the console that lists the invitations of whoever signed in. It names no
 * invitation.
 */
async function messageOf(
  context: OrganizationRouteContext,
  invitation: { to: string; role: string; workspace: string; inviter: string },
) {
  const inviter = await context.accounts.account(invitation.inviter);
  const named = (await context.accounts.memberships(invitation.inviter)).find(
    (each) => each.workspace.id === invitation.workspace,
  );
  const locale = (await context.accounts.localeOf(invitation.to)) ?? inviter?.locale ?? 'en';

  return invitationMessage(
    invitation.to,
    {
      inviter: inviter?.name || inviter?.email || 'Somebody',
      workspace: named?.workspace.name ?? 'a workspace',
      role: invitation.role,
      link: `${new URL(context.consoleUrl).origin}/invitations`,
      days: INVITATION_DAYS,
    },
    locale,
  );
}

/**
 * A new workspace for the person of this cookie, made by the organization plugin (FRU-149):
 * `POST /console/workspaces` calls this, and the route of the plugin stays closed to a request.
 *
 * The caller validated the name. The plugin wants a slug, and a workspace has none: it gets a value
 * that nothing reads. `keepCurrentActiveOrganization`: no call of the worker reads an « active »
 * workspace, so none is written in the session.
 *
 * The person is the one of the cookie, read by better-auth: the body names nobody.
 *
 * It throws `AuthUnavailable` when better-auth does not make it: the caller answers `502`, as on the
 * other calls that read the cookie.
 */
export async function createWorkspaceWithPlugin(auth: Auth, headers: Headers, name: string): Promise<Workspace> {
  const plugin = auth.api as unknown as {
    createOrganization(input: object): Promise<{ id?: unknown; name?: unknown } | null>;
  };
  let made: { id?: unknown; name?: unknown } | null;
  try {
    made = await plugin.createOrganization({
      body: { name, slug: newId('slug'), keepCurrentActiveOrganization: true },
      headers,
    });
  } catch (error) {
    throw new AuthUnavailable(error instanceof Error ? error.message : String(error), { cause: error });
  }
  if (typeof made?.id !== 'string' || typeof made.name !== 'string') {
    throw new AuthUnavailable('better-auth made a workspace and answered no id for it');
  }

  return { id: made.id, name: made.name };
}
