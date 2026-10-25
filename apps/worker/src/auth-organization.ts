import { type AccountStore, type SharedSite, type Workspace, can, mailboxOf } from './accounts.ts';
import { newId, roleOf } from './account-rows.ts';
import { AUTH_BASE_PATH, type Auth, INVITATION_SECONDS, INVITER_GONE } from './auth.ts';
import {
  type AuthRouteContext,
  AuthUnavailable,
  EMAIL_LINKS_PER_WINDOW,
  EMAIL_LINK_WINDOW_MS,
  headersFor,
  mutationAllowed,
  sessionOfCookie,
} from './auth-routes.ts';
import { MAX_BODY_BYTES, readBoundedText } from './bounded-body.ts';
import {
  ORGANIZATION_PATHS,
  type OrganizationRule,
  type OrganizationValue,
  readOrganizationInput,
} from './organization-paths.ts';
import { type Kv, KvError } from './kv.ts';
import { MailError, type Mailer, invitationMessage } from './mail.ts';
import type { SessionStore } from './session.ts';
import { forgetSeenOf } from './last-seen.ts';
import { refusedWhileSuspended } from './workspace-suspension.ts';

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
 *
 * **The guest of one site (FRU-250).** An invitation of a guest names its sites (`sites`), each a
 * site of the workspace, read in the store before better-auth keeps the invitation, and written
 * beside it after. When the person accepts, the sites are copied to `site_shares` **before**
 * better-auth writes the member: there is no moment when a guest is a member with sites that are not
 * theirs. A guest invitation that names no site is refused at the acceptance.
 */

export type OrganizationRouteContext = Pick<AuthRouteContext, 'consoleUrl' | 'clientIp' | 'trackIp'> & {
  auth: Auth | Promise<Auth>;
  accounts: Pick<
    AccountStore,
    | 'role'
    | 'account'
    | 'memberships'
    | 'localeOf'
    | 'sites'
    | 'shareByInvitation'
    | 'sitesOfInvitations'
    | 'shareOnAcceptance'
    | 'sharedIn'
    | 'unshare'
    | 'ownerOfAddress'
    | 'addresses'
    | 'suspension'
  >;
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
  findOne(input: { model: 'invitation' | 'member' | 'user'; where: { field: string; value: string }[] }): Promise<{
    organizationId?: unknown;
    banned?: unknown;
    inviterId?: unknown;
    role?: unknown;
    status?: unknown;
    email?: unknown;
    expiresAt?: unknown;
    mailed?: unknown;
  } | null>;
  update(input: {
    model: 'invitation';
    where: { field: string; value: string }[];
    update: { mailed: boolean } | { email: string };
  }): Promise<unknown>;
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
async function afterSomebodyWent(
  context: Pick<OrganizationRouteContext, 'sessions' | 'accounts'>,
  adapter: InvitationAdapter,
  workspace: string,
  person: string,
): Promise<void> {
  forgetSeenOf(workspace, person);
  const steps = await Promise.allSettled([
    context.sessions.endSessionsOf({ subject: person, workspace }, Date.now()),
    cancelInvitationsOf(adapter, workspace, person),
    // What was shared with a guest goes with them (FRU-250). A share with no member gives nothing
    // already: this keeps no row of a person who is gone.
    context.accounts.unshare(workspace, person),
  ]);
  const failed = steps.find((step) => step.status === 'rejected');
  if (failed !== undefined) throw new AuthUnavailable(String(failed.reason), { cause: failed.reason });
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
  if (role !== undefined && can(role, 'manage-members')) return true;
  // An administrator of the instance invites into a workspace they are not a member of (FRU-283).
  // Their word stands while they are one: `role` is `admin`, and the account is not banned, as
  // `IS_ADMIN` of `instance-admin-postgres.ts` reads it. An administrator removed or suspended since
  // stands behind nothing.
  const inviter = await adapter.findOne({
    model: 'user',
    where: [{ field: 'id', value: String(invitation.inviterId) }],
  });

  return inviter?.role === 'admin' && inviter.banned !== true;
}

/** Whether an invitation was sent to the address of `person` (FRU-282). */
async function isInvitedPerson(
  context: Pick<OrganizationRouteContext, 'accounts'>,
  adapter: InvitationAdapter,
  person: string,
  invitationId: string,
): Promise<boolean> {
  const invitation = await adapter.findOne({ model: 'invitation', where: [{ field: 'id', value: invitationId }] });
  if (invitation === null) return false;

  return isAddressOf(context, person, String(invitation.email));
}

/**
 * Whether this address is one of `person` (FRU-450): their primary address, or another one that a
 * provider or Fruitback proved. An address that waits for its verification is nobody's.
 */
async function isAddressOf(
  context: Pick<OrganizationRouteContext, 'accounts'>,
  person: string,
  email: string,
): Promise<boolean> {
  return (await context.accounts.ownerOfAddress(email)) === person;
}

/**
 * An acceptance or a refusal of an invitation sent to another address of the person (FRU-450).
 * better-auth takes them from a session of the address of the invitation only, and knows one address
 * of an account: the invitation names the primary one for the length of the call, and its own after.
 * `undefined`: the invitation is not one of another address of the person, and is left to better-auth.
 *
 * WARNING: a process that stops between the two writes leaves the invitation with the primary address
 * of the person (raised in review of #613). That address is of the same account, so nobody else can
 * accept it, and the account still can; only the address the list shows is not the one it was sent
 * to. A list of the invitations of the workspace read during the call shows the primary address too.
 * Two acceptances do not cross: an acceptance runs alone in its workspace (`oneAtATime`). A column of its own on `invitation` would hold the address of before; it was not worth a
 * migration of a table of better-auth for that.
 */
async function asPrimaryAddress(
  context: Pick<OrganizationRouteContext, 'accounts'>,
  adapter: InvitationAdapter,
  person: string,
  invitationId: string,
): Promise<{ restore(): Promise<void> } | undefined> {
  const invitation = await adapter.findOne({ model: 'invitation', where: [{ field: 'id', value: invitationId }] });
  if (invitation === null || invitation.status !== 'pending') return undefined;
  const account = await context.accounts.account(person);
  const sent = String(invitation.email).toLowerCase();
  if (account === undefined || sent === account.email || !(await isAddressOf(context, person, sent))) return undefined;
  const where = [{ field: 'id', value: invitationId }];
  await adapter.update({ model: 'invitation', where, update: { email: account.email } });

  return {
    async restore() {
      // Only when it still names the primary address this call wrote: never over another change.
      await adapter.update({
        model: 'invitation',
        where: [...where, { field: 'email', value: account.email }],
        update: { email: sent },
      });
    },
  };
}

/**
 * Whether a message of this invitation left (FRU-269), kept on the invitation so that the list says it
 * after a reload. A message that left stays left: a « Resend » that sent nothing does not take it back.
 */
async function noteMailed(adapter: InvitationAdapter, invitationId: string, mailed: boolean): Promise<void> {
  if (!mailed) {
    const kept = await adapter.findOne({ model: 'invitation', where: [{ field: 'id', value: invitationId }] });
    if (kept?.mailed === true) return;
  }
  await adapter.update({ model: 'invitation', where: [{ field: 'id', value: invitationId }], update: { mailed } });
}

/** An invitation made by this call, that cannot wait: its sites were not written (FRU-250). */
async function cancelInvitation(adapter: InvitationAdapter, invitationId: string): Promise<void> {
  await adapter.updateMany({
    model: 'invitation',
    where: [{ field: 'id', value: invitationId }],
    update: { status: 'canceled' },
  });
}

/**
 * The sites of an invitation of a guest, copied to the shares of the person before better-auth
 * accepts it (FRU-250). `refused`: a guest invitation that names no site now, which nobody accepts.
 * `workspace`: the shares were written there.
 *
 * Written only for the person the invitation is for, while it waits, and who is not a member of its
 * workspace yet: better-auth refuses every other call, and the shares of a member already there must
 * stay as they are. Any other invitation is left to better-auth.
 */
async function shareBeforeAcceptance(
  context: Pick<OrganizationRouteContext, 'accounts'>,
  adapter: InvitationAdapter,
  person: string,
  invitationId: string,
): Promise<{ refused?: { code: string; message: string }; workspace?: string }> {
  const invitation = await adapter.findOne({ model: 'invitation', where: [{ field: 'id', value: invitationId }] });
  if (invitation === null || invitation.role !== 'guest') return {};
  // Every other caller, and an invitation that no longer waits, gets the answer of better-auth: the
  // refusal below is for the person of the invitation only (raised by the review of #334).
  const workspace = String(invitation.organizationId);
  if (!(await isAddressOf(context, person, String(invitation.email)))) return {};
  if (invitation.status !== 'pending' || !(new Date(String(invitation.expiresAt)).getTime() > Date.now())) return {};
  if ((await context.accounts.role(workspace, person)) !== undefined) return {};
  const sites = (await context.accounts.sitesOfInvitations([invitationId])).get(invitationId) ?? [];
  if (sites.length === 0) {
    return {
      refused: { code: GUEST_WITHOUT_SITE, message: 'This invitation of a guest names no site of the workspace' },
    };
  }
  await context.accounts.shareOnAcceptance(person, invitationId);

  return { workspace };
}

/** The code of an invitation of a guest that names no site any more (FRU-250): its sites were removed. */
export const GUEST_WITHOUT_SITE = 'GUEST_INVITATION_NAMES_NO_SITE';

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
  // A call that changes a workspace runs alone in it (FRU-209): see `oneAtATime`. An acceptance
  // names no workspace, and changes the one of its invitation: two « Join » of one guest at the same
  // moment wrote and removed the same shares (FRU-250, raised by the heavy review of #334).
  const changed =
    workspace ??
    (path === '/organization/accept-invitation' ? await workspaceOfInvitation(auth, read.input) : undefined);
  const call: Call = { request, path, rule, input: read.input, workspace, changed, auth, mine };

  return changed !== undefined && rule.method === 'POST'
    ? oneAtATime(changed, () => answerOrganizationCall(call, context, headers))
    : answerOrganizationCall(call, context, headers);
}

/** The workspace of the invitation an acceptance names, or `undefined` for one that does not exist. */
async function workspaceOfInvitation(
  auth: Auth,
  input: Record<string, OrganizationValue>,
): Promise<string | undefined> {
  const adapter = (await auth.$context).adapter as unknown as InvitationAdapter;
  const invitation = await adapter.findOne({
    model: 'invitation',
    where: [{ field: 'id', value: String(input.invitationId) }],
  });

  return typeof invitation?.organizationId === 'string' ? invitation.organizationId : undefined;
}

/** A call that passed what needs no workspace: its route, what it sent, and who sent it. */
type Call = {
  request: Request;
  path: string;
  rule: OrganizationRule;
  input: Record<string, OrganizationValue>;
  workspace: string | undefined;
  /** The workspace that a `POST` changes: the one it names, or the one of the invitation it accepts. */
  changed: string | undefined;
  auth: Auth;
  mine: { userId: string };
};

const waiting = new Map<string, Promise<unknown>>();

/**
 * One call at a time for a workspace, in this process (FRU-209).
 *
 * better-auth reads, then writes, in no transaction: it counts the owners and then removes one, it
 * looks for an invitation of an address and then writes one. Two calls at the same moment both read
 * before either writes. On a real PostgreSQL, two owners who demoted themselves at once left a
 * workspace with no owner, which nobody can repair or delete; and four invitations of one address
 * wrote two or three rows (both measured). PGlite has one connection and hid it.
 *
 * WARNING: this holds for one process. Two replicas of the worker do not share it, as they do not
 * share the `Kv`.
 */
export async function oneAtATime<T>(workspace: string, run: () => Promise<T>): Promise<T> {
  const before = waiting.get(workspace) ?? Promise.resolve();
  const mine = before.then(run, run);
  const settled = mine.catch(() => undefined);
  waiting.set(workspace, settled);
  try {
    return await mine;
  } finally {
    if (waiting.get(workspace) === settled) waiting.delete(workspace);
  }
}

async function answerOrganizationCall(
  call: Call,
  context: OrganizationRouteContext,
  headers: Record<string, string>,
): Promise<Response> {
  const { request, path, rule, workspace, auth, mine } = call;
  const read = { input: call.input };
  /** The sites a guest is invited on (FRU-250), read in this workspace. */
  let guestSites: SharedSite[] | undefined;
  /** The invitation that waits for the address of a « Resend », whose sites are written already. */
  let waiting: string | undefined;
  const adapter = (await auth.$context).adapter as unknown as InvitationAdapter;

  if (workspace !== undefined) {
    // Read by the store of the worker, which takes one role of the four and nothing else. Not a
    // member answers like a workspace that does not exist, as on the routes of the console.
    const role = await context.accounts.role(workspace, mine.userId);
    if (role === undefined) {
      // Somebody who left, and whose call failed after better-auth wrote it, asks again: what
      // follows a departure runs now. For anybody else it finds nothing to end.
      if (path === '/organization/leave') await afterSomebodyWent(context, adapter, workspace, mine.userId);

      return json(404, { error: 'not-found' }, headers);
    }
    if (rule.needs !== undefined && !can(role, rule.needs)) return json(403, { error: 'forbidden', role }, headers);

    // better-auth finds the workspace of an invitation from the invitation. The role was read in the
    // workspace the call names: the invitation must be one of it, or it does not exist.
    if (rule.ofTheWorkspace === 'invitation') {
      const invitation = await adapter.findOne({
        model: 'invitation',
        where: [{ field: 'id', value: String(read.input.invitationId) }],
      });
      if (invitation?.organizationId !== workspace) return json(404, { error: 'not-found' }, headers);
      // better-auth cancels an invitation whatever its state (1.7.7): one that was accepted read
      // « cancelled » to the admin, and its person stayed a member.
      if (invitation.status !== 'pending') {
        return json(400, { code: 'INVITATION_NOT_FOUND', message: 'This invitation no longer waits' }, headers);
      }
    }
    // The sites of a guest (FRU-250): a guest names one at least, each a site of this workspace, and
    // another role names none. Read before better-auth keeps anything.
    if (path === '/organization/invite-member') {
      const named = read.input.sites as readonly string[] | undefined;
      if ((read.input.role === 'guest') !== (named !== undefined)) {
        return json(400, { error: 'invalid-request', field: 'sites' }, headers);
      }
      if (named !== undefined) {
        const own = new Map((await context.accounts.sites(workspace)).map((site) => [site.id, site.origin]));
        if (!named.every((site) => own.has(site)))
          return json(400, { error: 'invalid-request', field: 'sites' }, headers);
        guestSites = named.map((site) => ({ id: site, origin: own.get(site) as string }));
      }
    }
    // A « Resend » sends the invitation that waits, as it is: better-auth keeps its role, and the
    // message would name the role of the call. A guest's names the same sites (FRU-250).
    if (path === '/organization/invite-member' && read.input.resend === true) {
      const waits = await adapter.findOne({
        model: 'invitation',
        where: [
          { field: 'organizationId', value: workspace },
          { field: 'email', value: String(read.input.email) },
          { field: 'status', value: 'pending' },
        ],
      });
      if (waits !== null && waits.role !== read.input.role) {
        return json(400, { error: 'invalid-request', field: 'role' }, headers);
      }
      if (waits !== null && guestSites !== undefined) {
        const id = String((waits as { id?: unknown }).id);
        const kept = (await context.accounts.sitesOfInvitations([id])).get(id) ?? [];
        const same =
          kept.length === guestSites.length && guestSites.every((site) => kept.some((each) => each.id === site.id));
        if (!same) return json(400, { error: 'invalid-request', field: 'sites' }, headers);
      }
      // better-auth makes a new invitation for a « Resend » of an address that has none waiting, or
      // whose invitation is past its end: the id it answers says which (heavy review of #334).
      waiting = waits === null ? undefined : String((waits as { id?: unknown }).id);
    }
  }

  // The guard of the writes of a suspended workspace (FRU-282), after the role is read. An acceptance
  // names no workspace, so no role is read: the guard tells the suspension to the person of the
  // invitation only. Anybody else who holds its id gets the refusal of better-auth, as before.
  const accepting = path === '/organization/accept-invitation';
  if (
    rule.method === 'POST' &&
    call.changed !== undefined &&
    (!accepting || (await isInvitedPerson(context, adapter, mine.userId, String(read.input.invitationId))))
  ) {
    const asker = accepting ? 'invited' : 'member';
    const refused = await refusedWhileSuspended(context.accounts, call.changed, { organization: path }, headers, asker);
    if (refused !== undefined) return refused;
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

  // The sites of a guest are copied before the member is written (FRU-250).
  const shared =
    path === '/organization/accept-invitation'
      ? await shareBeforeAcceptance(context, adapter, mine.userId, String(read.input.invitationId))
      : undefined;
  if (shared?.refused !== undefined) return json(400, shared.refused, headers);

  const invited = path === '/organization/invite-member' ? String(read.input.email) : undefined;
  // The request better-auth reads is written here: the fields of the rule, as they were read, but
  // the ones the worker keeps.
  const handed = Object.fromEntries(Object.entries(read.input).filter(([name]) => !(rule.kept ?? []).includes(name)));
  const address = new URL(`${AUTH_BASE_PATH}${path}`, request.url);
  if (rule.method === 'GET')
    for (const [name, value] of Object.entries(handed)) address.searchParams.set(name, String(value));
  const forwardedHeaders = headersFor(request, context);
  forwardedHeaders.delete('Content-Length');
  if (rule.method === 'POST') forwardedHeaders.set('Content-Type', 'application/json');
  // FRU-450: an invitation sent to another address of the person names their primary one for the call.
  const retargeted =
    path === '/organization/accept-invitation' || path === '/organization/reject-invitation'
      ? await asPrimaryAddress(context, adapter, mine.userId, String(read.input.invitationId))
      : undefined;
  let answer: Response;
  try {
    answer = await auth.handler(
      new Request(address, {
        method: rule.method,
        headers: forwardedHeaders,
        ...(rule.method === 'POST' ? { body: JSON.stringify(handed) } : {}),
      }),
    );
  } finally {
    await retargeted?.restore();
  }

  // An acceptance that better-auth refused leaves no share: the person is no member, and the rows
  // would give nothing, but they are theirs to keep only as a guest. A person who is a member, by
  // another acceptance of the same invitation, keeps the rows of that one.
  if (
    shared?.workspace !== undefined &&
    !answer.ok &&
    (await context.accounts.role(shared.workspace, mine.userId)) === undefined
  ) {
    await context.accounts.unshare(shared.workspace, mine.userId);
  }

  // Somebody who left keeps no extension for the workspace. `remove-member` does the same in a hook
  // of the plugin (`auth.ts`); `leave` runs none in 1.7.7, so it is here.
  if (path === '/organization/leave' && answer.ok && workspace !== undefined) {
    await afterSomebodyWent(context, adapter, workspace, mine.userId);
  }
  // A hook of the worker that fails inside the plugin comes back as a `500` of better-auth, with
  // its own body. The caller answers `502`, as for any failure of better-auth.
  if (answer.status >= 500) throw new AuthUnavailable(`better-auth answered ${answer.status} on ${path}`);
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
    // What was shared with a guest goes with them (FRU-250), and with the role of a guest.
    if (role !== 'guest') await context.accounts.unshare(workspace, changed);
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
    // The sites of a new invitation of a guest, beside it (FRU-250). When they cannot be written, the
    // invitation does not wait: a guest who accepted it would read nothing.
    if (guestSites !== undefined && kept.id !== waiting) {
      let written = false;
      try {
        written = await context.accounts.shareByInvitation(
          workspace,
          kept.id,
          guestSites.map((site) => site.id),
        );
      } finally {
        if (!written) await cancelInvitation(adapter, kept.id);
      }
      // A site that was removed between the read and the write.
      if (!written) return json(400, { error: 'invalid-request', field: 'sites' }, headers);
    }
    let mailed = false;
    // The count is taken in one step, after better-auth kept the invitation: a call that it refused
    // spends nothing, and of two calls at the same moment the one that goes over sends nothing.
    let may = false;
    if (context.mailer !== undefined) {
      try {
        may = await mayMail(context.kv, { workspace, invited, inviter: mine.userId });
      } catch (error) {
        if (!(error instanceof KvError)) throw error;
        // The counts did not answer (FRU-67), and better-auth has kept the invitation already: a
        // `503` would say that nothing was done. No message goes out uncounted, and the answer says
        // so, as it does when a window is full: the person joins from the console.
        console.error(
          `[fruitback] the counts of the invitations did not answer, no message was sent: ${error.message}`,
        );
      }
    }
    if (may && context.mailer !== undefined) {
      try {
        await context.mailer.send(
          await messageOf(context, {
            to: invited,
            role: String(read.input.role),
            workspace,
            inviter: mine.userId,
            sites: (guestSites ?? []).map((site) => site.origin),
          }),
        );
        mailed = true;
      } catch (error) {
        if (!(error instanceof MailError)) throw error;
        console.error(`[fruitback] ${error.message}`);
        await noteMailed(adapter, kept.id, false);

        return json(502, { error: 'mail-unavailable' }, headers);
      }
    }
    await noteMailed(adapter, kept.id, mailed);

    told = JSON.stringify({ ...kept, mailed, ...(guestSites === undefined ? {} : { sites: guestSites }) });
  }

  // An invitation past its end waits no more: better-auth refuses it at the acceptance, and still
  // lists it as `pending` (1.7.7). The screens showed it, and « Join » failed.
  if ((path === '/organization/list-invitations' || path === '/organization/list-user-invitations') && answer.ok) {
    const read: unknown = await answer
      .clone()
      .json()
      .catch(() => undefined);
    if (!Array.isArray(read)) throw new AuthUnavailable(`better-auth answered no list on ${path}`);
    // FRU-450: the invitations sent to the other addresses of the person too. better-auth lists the
    // ones of an address that a call in the process names, and the ones of the session otherwise.
    const listed: unknown[] = [...read];
    if (path === '/organization/list-user-invitations') {
      const account = await context.accounts.account(mine.userId);
      const others = (await context.accounts.addresses(mine.userId)).filter((each) => each.email !== account?.email);
      const api = auth.api as unknown as { listUserInvitations(input: object): Promise<unknown> };
      for (const other of others) {
        const more = await api.listUserInvitations({ query: { email: other.email } });
        if (Array.isArray(more)) listed.push(...more);
      }
    }
    const now = Date.now();
    const waiting = (listed as { id?: unknown; status?: unknown; expiresAt?: unknown }[]).filter(
      (each) => each.status !== 'pending' || new Date(String(each.expiresAt)).getTime() > now,
    );
    // The sites an invitation of a guest names (FRU-250): the person sees where they are invited,
    // and whoever invites sees it in the list.
    const named = await context.accounts.sitesOfInvitations(
      waiting.flatMap((each) => (typeof each.id === 'string' ? [each.id] : [])),
    );
    told = JSON.stringify(
      waiting.map((each) => {
        const sites = typeof each.id === 'string' ? named.get(each.id) : undefined;

        return sites === undefined ? each : { ...each, sites };
      }),
    );
  }

  // The sites of each guest (FRU-250), for « Sites » of the screen of the members. Only a role that
  // reads the members gets here.
  if (path === '/organization/list-members' && answer.ok && workspace !== undefined) {
    const listed = (await answer
      .clone()
      .json()
      .catch(() => undefined)) as { members?: unknown } | undefined;
    if (!Array.isArray(listed?.members)) throw new AuthUnavailable('better-auth answered no members');
    const shares = await context.accounts.sharedIn(workspace);
    told = JSON.stringify({
      ...listed,
      members: (listed.members as { userId?: unknown; role?: unknown }[]).map((each) =>
        each.role === 'guest' ? { ...each, sites: shares.get(String(each.userId)) ?? [] } : each,
      ),
    });
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
export async function mayMail(kv: Kv, sent: { workspace: string; invited: string; inviter: string }): Promise<boolean> {
  const windows: [string, number, number][] = [
    // By mailbox: `carol+1@…` and `carol+2@…` are one, and six of them were six messages in it.
    [`fruitback:invitation:${sent.workspace}:${mailboxOf(sent.invited)}`, EMAIL_LINK_WINDOW_MS, INVITATIONS_PER_WINDOW],
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
  invitation: { to: string; role: string; workspace: string; inviter: string; sites: readonly string[] },
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
      ...(invitation.role === 'guest' ? { sites: invitation.sites } : {}),
    },
    locale,
  );
}

/**
 * Sends the message of an invitation that an administrator of the instance made (FRU-283), as the
 * route of a member sends one: under the same three windows (`mayMail`), in the language of the
 * person invited when their address says one, else of the administrator. Answers whether it left.
 * A count or a mail that does not answer sends nothing, and says so: the invitation waits all the
 * same, and the console gives its link by hand.
 */
export async function mailAdminInvitation(
  context: { kv: Kv; mailer: Mailer; consoleUrl: string; accounts: Pick<AccountStore, 'localeOf'> },
  invitation: {
    to: string;
    role: string;
    workspace: { id: string; name: string };
    inviter: { id: string; email: string; name?: string; locale?: string };
  },
): Promise<boolean> {
  try {
    if (
      !(await mayMail(context.kv, {
        workspace: invitation.workspace.id,
        invited: invitation.to,
        inviter: invitation.inviter.id,
      }))
    )
      return false;
    const locale = (await context.accounts.localeOf(invitation.to)) ?? invitation.inviter.locale ?? 'en';
    await context.mailer.send(
      invitationMessage(
        invitation.to,
        {
          inviter: invitation.inviter.name || invitation.inviter.email,
          workspace: invitation.workspace.name,
          role: invitation.role,
          link: `${new URL(context.consoleUrl).origin}/invitations`,
          days: INVITATION_DAYS,
        },
        locale,
      ),
    );

    return true;
  } catch (error) {
    if (!(error instanceof KvError) && !(error instanceof MailError)) throw error;
    console.error(`[fruitback] the invitation of an administrator was not mailed: ${error.message}`);

    return false;
  }
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

/**
 * A new name for a workspace, written by the organization plugin (FRU-236): `POST
 * /console/workspaces/<id>` calls this, and `/organization/update` stays closed to a request. That
 * route also takes a slug, a logo and metadata, which a workspace does not have: the one field
 * handed over here is the name.
 *
 * The caller validated the name, and read the role of the person in the store of the worker. The
 * plugin reads the person of the cookie and their role again, in its own table, and refuses anybody
 * who may not update the workspace: two readers, as on the routes of the members.
 *
 * It throws `AuthUnavailable` when better-auth does not write it: the caller answers `502`.
 */
export async function renameWorkspaceWithPlugin(
  auth: Auth,
  headers: Headers,
  workspace: string,
  name: string,
): Promise<Workspace> {
  const plugin = auth.api as unknown as {
    updateOrganization(input: object): Promise<{ id?: unknown; name?: unknown } | null>;
  };
  let renamed: { id?: unknown; name?: unknown } | null;
  try {
    renamed = await plugin.updateOrganization({ body: { organizationId: workspace, data: { name } }, headers });
  } catch (error) {
    throw new AuthUnavailable(error instanceof Error ? error.message : String(error), { cause: error });
  }
  if (renamed?.id !== workspace || typeof renamed.name !== 'string') {
    throw new AuthUnavailable('better-auth renamed a workspace and answered another one');
  }

  return { id: workspace, name: renamed.name };
}
