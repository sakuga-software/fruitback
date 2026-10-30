import { type Action, MAX_GUEST_SITES, normalizeEmail } from './accounts.ts';

/**
 * The routes of the organization plugin of better-auth that a request reaches (FRU-149), each with
 * the rule that covers it. `auth-organization.ts` serves them under `/console/auth`, and answers
 * `404` for any other path of the plugin: a route that a later version adds stays closed until it has
 * a line here. `auth.ts` closes the same paths inside better-auth, from this list.
 *
 * This file imports nothing of better-auth, and nothing that does.
 *
 * **Closed on purpose, each with its reason** (the names are the ones of 1.7.7):
 *
 * - `create`, `delete`: a workspace is made and deleted by the routes of the worker
 *   (`POST /console/workspaces`, `DELETE /console/workspaces/<id>`). The first one validates the name
 *   and calls the plugin in the process; the plugin would take a slug, a logo and metadata that
 *   nothing reads. The second one revokes the tokens of the trackers first.
 * - `update`, `check-slug`: no screen renames a workspace, and a workspace has no slug.
 * - `get-full-organization`: it answers the members **and the invitations** in one body, to any
 *   member, a guest included (measured). An id of an invitation is worth its link.
 * - `get-invitation`: it reads one invitation by its id. The console lists the invitations of the
 *   person who is signed in (`list-user-invitations`), so no id travels in a link.
 * - `list`, `get-organization`, `get-active-member`, `get-active-member-role`, `has-permission`:
 *   `GET /console/me` already answers the workspaces of a person and their role in each.
 * - `set-active`: no call of the worker reads an « active » workspace. Each open route names its
 *   workspace, and the worker refuses a call that does not.
 * - every route of a team, and of a role made at run time: both are off.
 */

/** A value of a request, read: the value to hand over, or `undefined` for one that is refused. */
type Reader = (value: unknown) => string | number | boolean | readonly string[] | undefined;

const ID = /^[A-Za-z0-9_-]{1,80}$/;
const id: Reader = (value) => (typeof value === 'string' && ID.test(value) ? value : undefined);

/** A whole number in a query, which arrives as text. */
const count =
  (min: number, max: number): Reader =>
  (value) => {
    const read = typeof value === 'string' && /^\d{1,6}$/.test(value) ? Number(value) : value;

    return typeof read === 'number' && Number.isInteger(read) && read >= min && read <= max ? read : undefined;
  };

/**
 * The roles somebody can be invited with (FRU-104). Not `owner`: a workspace gets a second owner by a
 * change of role, from its owner. `guest` since FRU-250, with the sites the invitation shares
 * (`sites`): a guest reads those and no other.
 */
export const INVITED_ROLES = ['admin', 'member', 'guest'] as const;

/**
 * The roles a change of role gives (FRU-209): `owner`, `admin` and `member`. Not `guest`: a guest
 * reads the sites of their invitation, and a change of role names none, so it would make a guest
 * who reads nothing. A guest is made by an invitation only.
 */
export const GIVEN_ROLES = ['owner', 'admin', 'member'] as const;

/**
 * The sites of an invitation of a guest (FRU-250): 1 to `MAX_GUEST_SITES` ids, each once. That each
 * is a site of the workspace is read by the route, in the store.
 */
const siteIds: Reader = (value) =>
  Array.isArray(value) &&
  value.length >= 1 &&
  value.length <= MAX_GUEST_SITES &&
  value.every((each) => id(each) !== undefined) &&
  new Set(value).size === value.length
    ? (value as string[])
    : undefined;

export type OrganizationRule = {
  method: 'GET' | 'POST';
  /**
   * `workspace` (when absent): the call names a workspace in `organizationId`, and the caller has a
   * role in it. `person`: the call is about the person of the cookie only, in no workspace: the
   * invitations they received. better-auth reads the address of the session, and nothing of the call
   * names another person.
   */
  scope?: 'person';
  /**
   * The call names an invitation in `invitationId`, and the worker reads that it is one of the
   * workspace the call names: better-auth finds the workspace from the invitation, so without this
   * the role would be read in one workspace and the invitation cancelled in another.
   */
  ofTheWorkspace?: 'invitation';
  /**
   * The action of `RIGHTS` the caller must have in the workspace, asked of `can` before better-auth
   * reads the request. Absent: any member, whatever their role.
   */
  needs?: Action;
  /**
   * Every field the route takes, in its query for a `GET` and in its body for a `POST`, with what
   * reads it. A field that is not here refuses the call: `organizationSlug` would name another
   * workspace than the one the worker checked the role in, and `filterField` reads any column.
   */
  fields: Readonly<Record<string, Reader>>;
  /** The fields a call must have. `organizationId` is one of them on every route of a workspace. */
  required: readonly string[];
  /**
   * The fields the worker reads and keeps, and does not hand to better-auth: the plugin would write a
   * field it does not know on its row (1.7.7 spreads the rest of the body in the invitation).
   */
  kept?: readonly string[];
  why: string;
};

/** How many members one call lists. The plugin stops a workspace at a hundred members. */
export const MEMBERS_PAGE = 100;

/** How long a search of the members is, in characters (FRU-496): a name or an address. */
export const MEMBERS_SEARCH = 100;

/** A search of the members: text of 1 to `MEMBERS_SEARCH` characters. */
const search: Reader = (value) =>
  typeof value === 'string' && value.length >= 1 && value.length <= MEMBERS_SEARCH ? value : undefined;

export const ORGANIZATION_PATHS: Readonly<Record<string, OrganizationRule>> = {
  '/organization/list-members': {
    method: 'GET',
    needs: 'read-members',
    fields: { organizationId: id, limit: count(1, MEMBERS_PAGE), offset: count(0, 100_000), q: search },
    required: ['organizationId'],
    why: 'the screen of the members, a page at a time, and the ones whose name or address holds `q`. The worker reads them itself (FRU-496). The plugin asks no permission of a member, so a guest would read it: the worker asks `can`',
  },
  '/organization/update-member-role': {
    method: 'POST',
    needs: 'manage-members',
    fields: {
      organizationId: id,
      memberId: id,
      role: (value) => ((GIVEN_ROLES as readonly unknown[]).includes(value) ? (value as string) : undefined),
    },
    required: ['organizationId', 'memberId', 'role'],
    why: 'an owner or an admin changes the role of a member: one role, owner, admin or member. Not guest: a guest is made by an invitation, which names their sites',
  },
  '/organization/remove-member': {
    method: 'POST',
    needs: 'manage-members',
    fields: {
      organizationId: id,
      memberIdOrEmail: (value) => id(value) ?? (typeof value === 'string' ? normalizeEmail(value) : undefined),
    },
    required: ['organizationId', 'memberIdOrEmail'],
    why: 'an owner or an admin removes a member, whose extensions stop',
  },
  '/organization/leave': {
    method: 'POST',
    fields: { organizationId: id },
    required: ['organizationId'],
    why: 'a person leaves a workspace, whatever their role, unless they are its last owner',
  },
  '/organization/invite-member': {
    method: 'POST',
    needs: 'manage-members',
    fields: {
      organizationId: id,
      email: (value) => (typeof value === 'string' ? normalizeEmail(value) : undefined),
      role: (value) => ((INVITED_ROLES as readonly unknown[]).includes(value) ? (value as string) : undefined),
      // Only `true`: an invitation that exists is sent again, and lasts from now.
      resend: (value) => (value === true ? true : undefined),
      // The sites of a guest (FRU-250), and only of a guest: the route reads them in the store.
      sites: siteIds,
    },
    required: ['organizationId', 'email', 'role'],
    kept: ['sites'],
    why: 'an owner or an admin invites an address as an admin, a member, or a guest of the sites it names. The worker sends a message when it has a mailer; the console also gives a link to send by hand, and neither link opens anything',
  },
  '/organization/list-invitations': {
    method: 'GET',
    needs: 'manage-members',
    fields: { organizationId: id },
    required: ['organizationId'],
    why: 'whoever invites sees what waits, to send it again or to cancel it. The worker reads the ones that wait itself (FRU-496): the plugin reads every invitation ever made, and stops at a hundred. The plugin answers it to any member, a guest included: the worker asks `can`',
  },
  '/organization/cancel-invitation': {
    method: 'POST',
    needs: 'manage-members',
    ofTheWorkspace: 'invitation',
    fields: { organizationId: id, invitationId: id },
    required: ['organizationId', 'invitationId'],
    why: 'an owner or an admin cancels an invitation of their workspace',
  },
  '/organization/list-user-invitations': {
    method: 'GET',
    scope: 'person',
    fields: {},
    required: [],
    why: 'somebody who signed in reads the invitations sent to the address they proved',
  },
  '/organization/accept-invitation': {
    method: 'POST',
    scope: 'person',
    fields: { invitationId: id },
    required: ['invitationId'],
    why: 'the person an invitation names joins the workspace. better-auth takes it from a session of that address only',
  },
  '/organization/reject-invitation': {
    method: 'POST',
    scope: 'person',
    fields: { invitationId: id },
    required: ['invitationId'],
    why: 'the person an invitation names declines it',
  },
};

/** A value of a call, as a reader of its rule read it. */
export type OrganizationValue = string | number | boolean | readonly string[];

/**
 * What better-auth is handed for a call, read from what the caller sent: the fields of the rule and
 * no other. `undefined` names nothing: the call is refused, with the field that refused it.
 */
export function readOrganizationInput(
  rule: OrganizationRule,
  sent: Readonly<Record<string, unknown>>,
): { ok: true; input: Record<string, OrganizationValue> } | { ok: false; field: string } {
  const input: Record<string, OrganizationValue> = {};

  for (const [name, value] of Object.entries(sent)) {
    const reader = Object.hasOwn(rule.fields, name) ? rule.fields[name] : undefined;
    const read = reader?.(value);
    if (read === undefined) return { ok: false, field: name };
    input[name] = read;
  }
  for (const name of rule.required) if (!Object.hasOwn(input, name)) return { ok: false, field: name };
  // A rule of a workspace that forgot to require its workspace would check a role in none.
  if (rule.scope !== 'person' && typeof input.organizationId !== 'string')
    return { ok: false, field: 'organizationId' };

  return { ok: true, input };
}
