import type { AccountStore, WorkspaceSuspension } from './accounts.ts';

/**
 * A workspace that an administrator of the instance suspended (FRU-282). D3 of FRU-260, and the
 * decision 4 of 2026-10-19: « Lecture seule, avec un bandeau ».
 *
 * - **Its sites answer as unknown.** `clientMap` of the store leaves them out, so the widget and the
 *   extension find each of them as a site that does not exist: the same status, and the same body.
 *   The notes stay in the database.
 * - **Its members read.** They sign in, and the console reads everything as before. `/console/me`
 *   says `suspended`, `suspendedAt` and `reason` for each workspace. The banner of the console
 *   shows the day, and not the reason, which is a note of the administrator (FRU-328).
 * - **Every write of the workspace is refused** by `refusedWhileSuspended`, with `409` and
 *   `workspace-suspended`. Each dispatcher that writes a workspace asks it before its routes: the
 *   console API, the routes of the organization plugin, and the way back from Linear.
 * - **What stays allowed** is `ALLOWED_WHILE_SUSPENDED`, each with its reason.
 * - **Its deliveries wait.** `dueDeliveries` leaves them out: no attempt, and no count. After the
 *   restoration, the next pass of the timer sends them.
 */

/** How a workspace says its suspension in an answer (FRU-282): the same three fields everywhere. */
export function suspensionView(suspension: WorkspaceSuspension | undefined): {
  suspended: boolean;
  suspendedAt?: string;
  reason?: string;
} {
  if (suspension === undefined) return { suspended: false };

  return {
    suspended: true,
    suspendedAt: new Date(suspension.since).toISOString(),
    ...(suspension.reason === undefined ? {} : { reason: suspension.reason }),
  };
}

export type SuspensionFields = ReturnType<typeof suspensionView>;

/** The answer to a write of a suspended workspace. */
export const SUSPENDED_STATUS = 409;
export const SUSPENDED_ERROR = 'workspace-suspended';

/**
 * A write of a workspace, as the guard names it: a call of the console API, by its method and its
 * path after the id of the workspace, or a call of the organization plugin, by its path.
 */
export type WorkspaceWrite = { method: string; rest: string } | { organization: string };

/** The writes that a suspension does not refuse. */
export const ALLOWED_WHILE_SUSPENDED: readonly (WorkspaceWrite & { why: string })[] = [
  {
    method: 'DELETE',
    rest: '',
    why: 'its owner deletes the workspace: the data of a person goes when they ask, paid or not, and a suspension uses no service',
  },
  {
    organization: '/organization/leave',
    why: 'a member leaves the workspace: nobody is kept in a workspace that they do not want',
  },
];

function allowed(write: WorkspaceWrite): boolean {
  return ALLOWED_WHILE_SUSPENDED.some((each) =>
    'organization' in each
      ? 'organization' in write && write.organization === each.organization
      : 'rest' in write && write.method === each.method && write.rest === each.rest,
  );
}

/**
 * The refusal of a write of `workspace` while it is suspended, or `undefined` when the write goes on.
 * `asker` is `invited` for a person who is not a member yet: they read that the workspace is
 * suspended, but not since when nor why, which only its members read.
 *
 * WARNING: call it after the role of the caller is read. A person who is not a member must get the
 * `404` of a workspace that does not exist, and not learn that this one is suspended.
 */
export async function refusedWhileSuspended(
  accounts: Pick<AccountStore, 'suspension'>,
  workspace: string,
  write: WorkspaceWrite,
  headers: Record<string, string>,
  asker: 'member' | 'invited' = 'member',
): Promise<Response | undefined> {
  if (allowed(write)) return undefined;
  const suspension = await accounts.suspension(workspace);
  if (suspension === undefined) return undefined;
  const { suspended: _, ...since } = suspensionView(suspension);
  const told = asker === 'member' ? since : {};

  return new Response(JSON.stringify({ error: SUSPENDED_ERROR, ...told }), {
    status: SUSPENDED_STATUS,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}
