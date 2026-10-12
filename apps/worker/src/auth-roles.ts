import { ACTIONS, type Action, ROLES, can } from './accounts.ts';

/**
 * The four roles of a workspace, in the words of better-auth's access control (FRU-144).
 *
 * **`RIGHTS` of `accounts.ts` stays the one table.** Nothing here says what a role may do: this file
 * asks `can(role, action)` for each role and each action, and writes the answer in the shape that
 * the organization plugin reads. The routes of the worker go on calling `can`.
 *
 * This file imports nothing of better-auth, so a worker that has it switched off can load it.
 */

/** The resource of the access control that holds the actions of `ACTIONS`, under their own names. */
export const FRUITBACK_RESOURCE = 'fruitback';

/**
 * A permission that the organization plugin asks of a role before one of its own routes runs:
 * `organization`, `member` and `invitation` are its resources, with these actions (read:
 * plugins/organization, « Permissions »).
 *
 * The plugin also declares `team` and `ac`. No role gets one: teams and the roles made at run time
 * are off.
 */
export type PluginPermissions = {
  organization?: readonly ('update' | 'delete')[];
  member?: readonly ('create' | 'update' | 'delete')[];
  invitation?: readonly ('create' | 'cancel')[];
};

/**
 * What each action of `ACTIONS` gives in the plugin's own words: to invite and to remove a person
 * is `manage-members`, to rename the workspace is `manage-workspace`, to delete it is
 * `delete-workspace`.
 *
 * `Record<Action, …>`: an action added to `ACTIONS` does not compile until it has a line here, and
 * `roleStatements` refuses at run time an action that has none.
 */
export const IMPLIED: Record<Action, PluginPermissions> = {
  'read-feedback': {},
  'see-tracker': {},
  // The plugin asks no permission to list the members: the route of the worker asks `can` (FRU-149).
  'read-members': {},
  'manage-sites': {},
  'manage-members': { member: ['create', 'update', 'delete'], invitation: ['create', 'cancel'] },
  'manage-workspace': { organization: ['update'] },
  'delete-workspace': { organization: ['delete'] },
};

/** The source of the projection. A test gives another one, to plant an action that has no line. */
export type RoleTable = {
  roles: readonly string[];
  actions: readonly string[];
  can(role: string, action: string): boolean;
  implied: Readonly<Record<string, PluginPermissions>>;
};

const TABLE: RoleTable = {
  roles: ROLES,
  actions: ACTIONS,
  can: (role, action) => can(role as (typeof ROLES)[number], action as Action),
  implied: IMPLIED,
};

/** The permissions of one role: a resource, and the actions of it that the role may do. */
export type Statements = Record<string, string[]>;

/**
 * The permissions of each role, as `newRole` of better-auth takes them.
 *
 * A resource a role has no action of is absent, and better-auth refuses a request for it.
 */
export function roleStatements(table: RoleTable = TABLE): Record<string, Statements> {
  const out: Record<string, Statements> = {};

  for (const role of table.roles) {
    const statements: Statements = {};
    const grant = (resource: string, actions: readonly string[]): void => {
      if (actions.length === 0) return;
      statements[resource] = [...new Set([...(statements[resource] ?? []), ...actions])];
    };

    for (const action of table.actions) {
      if (!Object.hasOwn(table.implied, action)) {
        throw new Error(
          `The action « ${action} » has no line in IMPLIED of auth-roles.ts: say what it gives in better-auth, or that it gives nothing`,
        );
      }
      if (!table.can(role, action)) continue;

      grant(FRUITBACK_RESOURCE, [action]);
      for (const [resource, actions] of Object.entries(table.implied[action] ?? {})) grant(resource, actions);
    }
    out[role] = statements;
  }

  return out;
}
