import { type Action, normalizeEmail } from './accounts.ts';
import { roleOf } from './account-rows.ts';

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
 * - `list-invitations`, `get-invitation`, `invite-member`, `accept-invitation`, `reject-invitation`,
 *   `cancel-invitation`, `list-user-invitations`: the invitations are FRU-104.
 * - `list`, `get-organization`, `get-active-member`, `get-active-member-role`, `has-permission`:
 *   `GET /console/me` already answers the workspaces of a person and their role in each.
 * - `set-active`: no call of the worker reads an « active » workspace. Each open route names its
 *   workspace, and the worker refuses a call that does not.
 * - every route of a team, and of a role made at run time: both are off.
 */

/** A value of a request, read: the value to hand over, or `undefined` for one that is refused. */
type Reader = (value: unknown) => string | number | undefined;

const ID = /^[A-Za-z0-9_-]{1,80}$/;
const id: Reader = (value) => (typeof value === 'string' && ID.test(value) ? value : undefined);

/** A whole number in a query, which arrives as text. */
const count =
  (min: number, max: number): Reader =>
  (value) => {
    const read = typeof value === 'string' && /^\d{1,6}$/.test(value) ? Number(value) : value;

    return typeof read === 'number' && Number.isInteger(read) && read >= min && read <= max ? read : undefined;
  };

export type OrganizationRule = {
  method: 'GET' | 'POST';
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
  /** The fields a call must have. `organizationId` is one of them on every route. */
  required: readonly string[];
  why: string;
};

/** How many members one call lists. The plugin stops a workspace at a hundred members. */
export const MEMBERS_PAGE = 100;

export const ORGANIZATION_PATHS: Readonly<Record<string, OrganizationRule>> = {
  '/organization/list-members': {
    method: 'GET',
    needs: 'read-members',
    fields: { organizationId: id, limit: count(1, MEMBERS_PAGE), offset: count(0, 100_000) },
    required: ['organizationId'],
    why: 'the screen of the members. The plugin asks no permission of a member, so a guest would read it: the worker asks `can`',
  },
  '/organization/update-member-role': {
    method: 'POST',
    needs: 'manage-members',
    fields: { organizationId: id, memberId: id, role: (value) => roleOf(value) },
    required: ['organizationId', 'memberId', 'role'],
    why: 'an owner or an admin changes the role of a member: one role, one of the four',
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
};

/**
 * What better-auth is handed for a call, read from what the caller sent: the fields of the rule and
 * no other. `undefined` names nothing: the call is refused, with the field that refused it.
 */
export function readOrganizationInput(
  rule: OrganizationRule,
  sent: Readonly<Record<string, unknown>>,
): { ok: true; input: Record<string, string | number> } | { ok: false; field: string } {
  const input: Record<string, string | number> = {};

  for (const [name, value] of Object.entries(sent)) {
    const reader = Object.hasOwn(rule.fields, name) ? rule.fields[name] : undefined;
    const read = reader?.(value);
    if (read === undefined) return { ok: false, field: name };
    input[name] = read;
  }
  for (const name of rule.required) if (!Object.hasOwn(input, name)) return { ok: false, field: name };

  return { ok: true, input };
}
