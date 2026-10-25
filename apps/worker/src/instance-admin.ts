import type { NoteStage } from '@fruitback/shared';
import {
  type Account,
  type ConnectorAttention,
  type ConnectorKind,
  type Role,
  type Visibility,
  type WorkspaceSuspension,
  normalizeEmail,
  workspaceName,
} from './accounts.ts';
import { type SuspensionFields, suspensionView } from './workspace-suspension.ts';
import { cursorOf, noteIdOf, pageOf, queryOf as noteQueryOf } from './console-notes.ts';
import type { WorkerConfig } from './env.ts';
import { lastMailSentAt } from './mail.ts';
import type { AuthorKind, Channel, NoteCursor, NoteQuery } from './notes-index.ts';
import type { SignUp } from './sign-up.ts';

/**
 * The administrator of the instance, and what they read (FRU-261).
 *
 * Mathieu, 2026-10-18 (FRU-260): « le premier compte utilisateur est forcèment admin lors de sa
 * création sur l'interface, géré par better-auth avec le flag admin en base ».
 *
 * - **Who.** The account whose `role` of `user` is `admin`, and that is not banned. The column is the
 *   one of the admin plugin of better-auth, and the plugin is not mounted: see `REFUSED_PLUGINS` of
 *   `auth.ts`. No variable names an administrator.
 * - **How one becomes it.** The trigger of `0016_first_admin` gives the role to the first account, in
 *   the transaction that creates it, and to no later account. On a database that had accounts, the
 *   migration gives it to the oldest one. Then an administrator names another one, or takes the role
 *   away, with `POST /console/admin/users/<id>/instance-admin` (FRU-280).
 * - **One administrator stays.** The route refuses to take the role from the last administrator, and
 *   refuses an administrator who takes it from themselves. The check and the write are in one
 *   transaction, under the advisory lock of the trigger of `0016_first_admin`.
 * - **The guard.** `instanceAdminOf` of `console-api.ts` reads the cookie of the console and then the
 *   role in the database, at each call. Every other caller gets `404`, as for a path that does not
 *   exist. `handleInstanceAdmin` asks the guard before it reads `ADMIN_ROUTES` and
 *   `ADMIN_WRITE_ROUTES`, so a route of the tables cannot skip it.
 * - **The trace.** A read that names a workspace the administrator is not a member of writes one row
 *   for that workspace in `admin_reads`, before the answer leaves. A trace that cannot be written
 *   fails the read. The owners of the workspace read the rows.
 * - **The actions.** Each action that changes something writes one row in `admin_actions`, in the
 *   transaction of the change. An action that changes nothing writes no row. The administrators of the
 *   instance read the rows with `GET /console/admin/actions`.
 * - **What an answer never holds**: a secret, a token, a digest, a key of a connector, or an address of
 *   the database. Counts, names and labels only, except on `notes`.
 * - **The notes** (FRU-272): every note of the index, with its excerpt of 64 characters. The whole
 *   text only for a note that the worker keeps in its own table, matched by its site and by the id
 *   that the widget gave it. A note that went to a tracker has its excerpt only: the worker does not
 *   call the tracker of a client to read more.
 * - **Suspension** (FRU-281): `POST /console/admin/users/<id>/suspension` writes `banned` of `user`.
 *   A suspended account signs in by no way, and every session it held ends: the sessions of the
 *   console in the transaction of the change, the sessions of the extension after it. A restored
 *   account signs in again, and its old sessions stay ended. The rules of the role apply: nobody
 *   suspends themselves, and nobody suspends the last administrator.
 * - **Suspension of a workspace** (FRU-282): `POST /console/admin/workspaces/<id>/suspension` writes a
 *   row of `workspace_suspensions`, and a restoration deletes it. `workspace-suspension.ts` says what
 *   a suspended workspace does.
 * - **Deletion of a workspace** (FRU-284): `POST /console/admin/workspaces/<id>/deletion`, body
 *   `{ name }`, deletes the workspace by the path of its owner, when `name` is its name. It is at once,
 *   and nothing undoes it. Its action keeps the id and the name of the workspace in `detail`, so it
 *   stays readable after the workspace goes.
 * - **Writes in a workspace** (FRU-283, « Directes, tracées »): the role of a member, a member added,
 *   the owner, an invitation, a new workspace for an account. Each is written at once, in one
 *   transaction under the lock of the role, and leaves an action that the owners of the workspace
 *   read. The rules of the routes of the members hold: a workspace keeps an owner, a role is one of
 *   `GIVEN_ROLES`, an invitation one of `admin` and `member`, and a suspended workspace refuses them.
 * - **Deletion of an account** (FRU-285): `POST /console/admin/users/<id>/deletion`, body `{ email }`.
 *   Refused while the account owns a workspace alone, for the administrator themselves, and for the
 *   last administrator. Its sessions of the console and of the extension end, and its notes stay.
 */

/** Where the routes of the administrator of the instance are. */
export const ADMIN_PATH = '/console/admin';

/** The reads that an administrator does, as the trace names them. */
export const ADMIN_READS = ['instance', 'workspaces', 'workspace', 'users', 'notes', 'actions'] as const;
export type AdminRead = (typeof ADMIN_READS)[number];

/**
 * Every route under `ADMIN_PATH`, and the read each one is. The dispatcher reads this table only
 * after the guard, and the test of the guard calls each entry with `example`.
 */
export const ADMIN_ROUTES: readonly { read: AdminRead; pattern: RegExp; example: string }[] = [
  { read: 'instance', pattern: /^\/console\/admin\/instance$/, example: '/console/admin/instance' },
  { read: 'workspaces', pattern: /^\/console\/admin\/workspaces$/, example: '/console/admin/workspaces' },
  {
    read: 'workspace',
    pattern: /^\/console\/admin\/workspaces\/([A-Za-z0-9_-]{1,80})$/,
    example: '/console/admin/workspaces/ws_00000000000000000000',
  },
  { read: 'users', pattern: /^\/console\/admin\/users$/, example: '/console/admin/users' },
  { read: 'notes', pattern: /^\/console\/admin\/notes$/, example: '/console/admin/notes' },
  { read: 'actions', pattern: /^\/console\/admin\/actions$/, example: '/console/admin/actions' },
];

/** The writes that an administrator does (FRU-280, FRU-281, FRU-282, FRU-284). */
export const ADMIN_WRITES = [
  'instance-admin',
  'suspension',
  'workspace-suspension',
  'workspace-deletion',
  'member-role',
  'member-add',
  'owner',
  'invitation',
  'new-workspace',
  'account-deletion',
] as const;
export type AdminWrite = (typeof ADMIN_WRITES)[number];

/**
 * Every route under `ADMIN_PATH` that writes, each one a `POST`. The dispatcher reads this table only
 * after the guard, as `ADMIN_ROUTES`.
 */
export const ADMIN_WRITE_ROUTES: readonly { write: AdminWrite; pattern: RegExp; example: string }[] = [
  {
    write: 'instance-admin',
    pattern: /^\/console\/admin\/users\/([A-Za-z0-9_-]{1,80})\/instance-admin$/,
    example: '/console/admin/users/acc_00000000000000000000/instance-admin',
  },
  {
    write: 'suspension',
    pattern: /^\/console\/admin\/users\/([A-Za-z0-9_-]{1,80})\/suspension$/,
    example: '/console/admin/users/acc_00000000000000000000/suspension',
  },
  {
    write: 'workspace-suspension',
    pattern: /^\/console\/admin\/workspaces\/([A-Za-z0-9_-]{1,80})\/suspension$/,
    example: '/console/admin/workspaces/ws_00000000000000000000/suspension',
  },
  {
    write: 'workspace-deletion',
    pattern: /^\/console\/admin\/workspaces\/([A-Za-z0-9_-]{1,80})\/deletion$/,
    example: '/console/admin/workspaces/ws_00000000000000000000/deletion',
  },
  {
    write: 'member-role',
    pattern: /^\/console\/admin\/workspaces\/([A-Za-z0-9_-]{1,80})\/members\/([A-Za-z0-9_-]{1,80})\/role$/,
    example: '/console/admin/workspaces/ws_00000000000000000000/members/acc_00000000000000000000/role',
  },
  {
    write: 'member-add',
    pattern: /^\/console\/admin\/workspaces\/([A-Za-z0-9_-]{1,80})\/members$/,
    example: '/console/admin/workspaces/ws_00000000000000000000/members',
  },
  {
    write: 'owner',
    pattern: /^\/console\/admin\/workspaces\/([A-Za-z0-9_-]{1,80})\/owner$/,
    example: '/console/admin/workspaces/ws_00000000000000000000/owner',
  },
  {
    write: 'invitation',
    pattern: /^\/console\/admin\/workspaces\/([A-Za-z0-9_-]{1,80})\/invitations$/,
    example: '/console/admin/workspaces/ws_00000000000000000000/invitations',
  },
  // Not `POST /console/admin/workspaces`: that path is the list, which a `GET` reads.
  { write: 'new-workspace', pattern: /^\/console\/admin\/new-workspace$/, example: '/console/admin/new-workspace' },
  {
    write: 'account-deletion',
    pattern: /^\/console\/admin\/users\/([A-Za-z0-9_-]{1,80})\/deletion$/,
    example: '/console/admin/users/acc_00000000000000000000/deletion',
  },
];

/** The kinds of action that `admin_actions` keeps. */
export const ADMIN_ACTIONS = [
  'admin-named',
  'admin-removed',
  'account-suspended',
  'account-restored',
  'workspace-suspended',
  'workspace-restored',
  'workspace-deleted',
  'member-role-changed',
  'member-added',
  'owner-changed',
  'member-invited',
  'workspace-created',
  'account-deleted',
] as const;
export type AdminActionKind = (typeof ADMIN_ACTIONS)[number];

/** One action of an administrator, as the administrators of the instance read it. */
export type AdminAction = {
  action: AdminActionKind;
  at: string;
  actor: { id?: string; email: string; name?: string };
  target?: { id?: string; email: string; name?: string };
  workspace?: { id: string; name: string };
  detail?: Record<string, unknown>;
};

/**
 * What a change of the role of administrator gives:
 * - `changed` false: the account already had the role that was asked, and no row was written;
 * - `unknown-account`: no account has this id;
 * - `self-removal`: the administrator asked to take the role from themselves;
 * - `last-admin`: the account is the last administrator of the instance;
 * - `not-admin`: the account that asked is no longer an administrator.
 */
export type RoleChange =
  | { ok: true; changed: boolean; instanceAdmin: boolean }
  | { ok: false; refused: 'unknown-account' | 'self-removal' | 'last-admin' | 'not-admin' };

/**
 * What a suspension or a restoration gives (FRU-281):
 * - `changed` false: the account was already in the state that was asked, and no row was written;
 * - `unknown-account`: no account has this id;
 * - `self-suspension`: the administrator asked to suspend themselves;
 * - `last-admin`: the account is the last administrator of the instance;
 * - `not-admin`: the account that asked is no longer an administrator.
 */
export type SuspensionChange =
  | { ok: true; changed: boolean; suspended: boolean }
  | { ok: false; refused: 'unknown-account' | 'self-suspension' | 'last-admin' | 'not-admin' };

/**
 * What a suspension or a restoration of a workspace gives (FRU-282):
 * - `changed` false: the workspace was already in the state that was asked, and no row was written;
 * - `suspension`: the suspension that holds after the call, absent for a workspace that is not suspended;
 * - `unknown-workspace`: no workspace has this id;
 * - `not-admin`: the account that asked is no longer an administrator.
 */
export type WorkspaceSuspensionChange =
  | { ok: true; changed: boolean; suspension?: WorkspaceSuspension }
  | { ok: false; refused: 'unknown-workspace' | 'not-admin' };

/** What a deletion of a workspace took with it (FRU-284): the counts at the moment of the deletion. */
export type WorkspaceGone = {
  sites: number;
  members: number;
  invitations: number;
  connectors: number;
  keptNotes: number;
};

/**
 * What a deletion of a workspace by an administrator gives (FRU-284):
 * - `ok`: the workspace is deleted. `gone` counts what went with it. `revoke` holds the sealed keys of
 *   its Linear connectors, read in the transaction, for the route to revoke after the commit: the
 *   route never answers them;
 * - `unknown-workspace`: no workspace has this id;
 * - `not-admin`: the account that asked is no longer an administrator;
 * - `name-mismatch`: the name in the body is not the name of the workspace, and nothing is deleted.
 */
export type WorkspaceDeletion =
  | { ok: true; workspace: WorkspaceName; gone: WorkspaceGone; revoke: string[] }
  | { ok: false; refused: 'unknown-workspace' | 'not-admin' | 'name-mismatch' };

/** The roles an administrator gives a member (FRU-283): the ones of `update-member-role`, never `guest`. */
export const ADMIN_GIVEN_ROLES = ['owner', 'admin', 'member'] as const;
export type AdminGivenRole = (typeof ADMIN_GIVEN_ROLES)[number];

/**
 * The roles of an invitation by an administrator (FRU-283): `admin` or `member`. Not `guest`, which
 * names its sites, and not `owner`, which no invitation gives.
 */
export const ADMIN_INVITED_ROLES = ['admin', 'member'] as const;
export type AdminInvitedRole = (typeof ADMIN_INVITED_ROLES)[number];

/** What refuses every write of an administrator in a workspace (FRU-283). */
type InWorkspaceRefusal = 'unknown-workspace' | 'not-admin' | 'workspace-suspended';

/**
 * What a write of an administrator in a workspace gives (FRU-283). `changed` false: the workspace
 * was already as asked, and no action was written.
 * - `not-a-member`: the account is not a member of the workspace;
 * - `last-owner`: the change would leave the workspace with no owner;
 * - `unknown-account`: no account has this address;
 * - `already-member`: the account is a member already, so it is not added again;
 * - `suspended-account`: the account is suspended (FRU-281), and cannot own a workspace it cannot open;
 * - `has-account`: an account has this address, so it is added, not invited;
 * - `already-invited`: an invitation of this address waits in the workspace.
 */
export type MemberRoleChange =
  | { ok: true; changed: boolean; role: AdminGivenRole }
  | { ok: false; refused: InWorkspaceRefusal | 'not-a-member' | 'last-owner' };
export type MemberAddition =
  | { ok: true; member: { id: string; email: string; role: AdminGivenRole } }
  | { ok: false; refused: InWorkspaceRefusal | 'unknown-account' | 'already-member' };
export type OwnerChange =
  | { ok: true; changed: boolean; owner: { id: string; email: string }; previous: string[] }
  | { ok: false; refused: InWorkspaceRefusal | 'unknown-account' | 'suspended-account' };
export type AdminInvitation =
  | {
      ok: true;
      invitation: { id: string; email: string; role: AdminInvitedRole; expiresAt: number };
      workspace: WorkspaceName;
    }
  | { ok: false; refused: InWorkspaceRefusal | 'has-account' | 'already-invited' | 'already-member' };
export type WorkspaceCreation =
  | { ok: true; workspace: WorkspaceName; owner: { id: string; email: string } }
  | { ok: false; refused: 'not-admin' | 'unknown-account' | 'suspended-account' };

/**
 * What a deletion of an account gives (FRU-285):
 * - `ok`: the account is gone; `workspaces` are the ones it was a member of;
 * - `unknown-account`, `not-admin`: nothing to find;
 * - `self-deletion`: the administrator asked to delete their own account;
 * - `last-admin`: the account is the last administrator of the instance;
 * - `email-mismatch`: the address in the body is not the one of the account;
 * - `sole-owner`: the account owns these workspaces alone (« Refusé tant qu'il y a des workspaces »).
 */
export type AccountDeletion =
  | { ok: true; account: { id: string; email: string }; workspaces: WorkspaceName[] }
  | { ok: false; refused: 'unknown-account' | 'not-admin' | 'self-deletion' | 'last-admin' | 'email-mismatch' }
  | { ok: false; refused: 'sole-owner'; workspaces: WorkspaceName[] };

/** How long an invitation of an administrator waits, as one of a member (`INVITATION_SECONDS` of `auth.ts`). */
export const ADMIN_INVITATION_MS = 7 * 24 * 60 * 60 * 1000;

/** The longest reason of a suspension of a workspace, in characters. A longer one is refused, never cut. */
export const SUSPENSION_REASON_LENGTH = 200;

/** Whether a path is one of the administrator of the instance, known or not. */
export function isAdminPath(pathname: string): boolean {
  return pathname === ADMIN_PATH || pathname.startsWith(`${ADMIN_PATH}/`);
}

/** The most rows a list answers. `total` says how many the filter has. */
export const ADMIN_PAGE = 100;

/** The longest search a list takes. */
export const ADMIN_QUERY_LENGTH = 200;

/** What each list can show. `all` is the default. */
export const WORKSPACE_FILTERS = ['all', 'attention', 'empty', 'suspended'] as const;
export const USER_FILTERS = ['all', 'admins', 'alone'] as const;

export type AdminQuery<Show extends string> = { q?: string; show: Show };

export type StageCounts = Record<NoteStage, number>;

/** A workspace, as the administrator names it in an answer. */
export type WorkspaceName = { id: string; name: string };

export type AdminConnector = {
  id: string;
  kind: ConnectorKind;
  label: string;
  attention?: ConnectorAttention;
};

export type AdminWorkspace = WorkspaceName &
  SuspensionFields & {
    createdAt: string;
    owners: { id: string; name?: string; email: string }[];
    members: number;
    sites: number;
    notes: StageCounts;
    destinations: AdminConnector[];
    pendingDeliveries: number;
  };

export type AdminWorkspaceDetail = WorkspaceName &
  SuspensionFields & {
    createdAt: string;
    members: { id: string; name?: string; email: string; role: Role | string; lastSeen?: string }[];
    sites: {
      id: string;
      origin: string;
      visibility: Visibility | string;
      destinations: { connector: string; label?: string }[];
      notes: StageCounts;
    }[];
    destinations: (AdminConnector & { createdAt: string })[];
    pendingDeliveries: number;
    pendingInvitations: number;
  };

export type AdminUser = {
  id: string;
  name?: string;
  email: string;
  createdAt: string;
  instanceAdmin: boolean;
  /** An administrator of the instance suspended the account (FRU-281). */
  suspended: boolean;
  /** `soleOwner`: the account owns this workspace alone (FRU-285), so it cannot be deleted yet. */
  workspaces: (WorkspaceName & { role: string; soleOwner?: true })[];
  /** The ways the person signed in: `email`, `github`, `google`. */
  providers: string[];
  /** The last day the person was seen in one of their workspaces (FRU-249), as `YYYY-MM-DD`. */
  lastSeen?: string;
  pendingInvitations: { workspace: WorkspaceName; role?: string }[];
};

/** A connector that needs attention, with its workspace. */
export type AttentionConnector = AdminConnector & { workspace: WorkspaceName };

/** What the list of the notes of the instance filters on: the list of a workspace, less `author`. */
export type AdminNoteQuery = Omit<NoteQuery, 'author' | 'sites' | 'searchesReference'> & { workspace?: string };

/** What the list of the notes of the instance searches, in the order the console names them. */
export const ADMIN_NOTES_SEARCHED = ['excerpt', 'page', 'site', 'workspace', 'stage', 'reference'] as const;

/** One note of the instance, as the index keeps it. `text`: only for a note that the worker keeps. */
export type AdminNote = {
  workspace: WorkspaceName;
  site: { id: string; origin: string };
  note: string;
  pageUrl: string;
  excerpt: string;
  text?: string;
  stage: string;
  channel: Channel | null;
  author: AuthorKind;
  place: { kind: 'fruitback' } | { kind: 'connector'; connector?: { id: string; kind: string; label: string } };
  reference?: string;
  referenceUrl?: string;
  createdAt: number;
  checkedAt: number;
};

/** One read of an administrator in a workspace, as its owners read it. */
export type TracedRead = { admin: { email: string; name?: string }; what: AdminRead; at: string };

/**
 * The kinds of action on a workspace itself (FRU-282, FRU-284). They have no member as their target.
 * No owner reads `workspace-deleted`: the workspace is gone, and its owners with it.
 */
export const WORKSPACE_ACTIONS = ['workspace-suspended', 'workspace-restored', 'workspace-deleted'] as const;
export type WorkspaceActionKind = (typeof WORKSPACE_ACTIONS)[number];

/** Whether an action is on a workspace itself, and not on one of its members. */
export function isWorkspaceAction(action: string): action is WorkspaceActionKind {
  return (WORKSPACE_ACTIONS as readonly string[]).includes(action);
}

/**
 * One action of an administrator, as the owners of the workspace read it. The `action` tells the shape:
 * - an action on a member (FRU-281) always has `target`, the member;
 * - an action on the workspace (FRU-282) has no `target`, and no `reason`: the reason of a suspension
 *   is a note of the administrator of the instance, which `actions` answers to them only (FRU-328).
 */
export type TracedAction =
  | {
      action: Exclude<AdminActionKind, WorkspaceActionKind>;
      at: string;
      admin: { email: string; name?: string };
      target: { email: string; name?: string };
      /** The role that the action gave (FRU-283): a role changed, a member added, an invitation. */
      role?: string;
    }
  | {
      action: WorkspaceActionKind;
      at: string;
      admin: { email: string; name?: string };
    };

/** What the administrator reads and writes in the database. `instance-admin-postgres.ts` is the one store. */
export type InstanceAdminReads = {
  counts(): Promise<{ workspaces: number; accounts: number; admins: number }>;
  /** The connectors that need attention, at most `ADMIN_PAGE`, and how many there are in all. */
  attention(): Promise<{ connectors: AttentionConnector[]; total: number }>;
  workspaces(query: AdminQuery<(typeof WORKSPACE_FILTERS)[number]>): Promise<{
    workspaces: AdminWorkspace[];
    total: number;
  }>;
  workspace(id: string): Promise<AdminWorkspaceDetail | undefined>;
  users(query: AdminQuery<(typeof USER_FILTERS)[number]>): Promise<{ users: AdminUser[]; total: number }>;
  /** One page of the notes of the instance, the newest first, and how many the filter has. */
  notes(query: AdminNoteQuery): Promise<{ notes: AdminNote[]; total: number; next?: NoteCursor }>;
  /** Writes one row for each of `workspaces` that `admin` is not a member of, in one statement. */
  trace(
    admin: Pick<Account, 'id' | 'email'>,
    workspaces: readonly string[],
    what: AdminRead,
    now: number,
  ): Promise<void>;
  /** The reads in a workspace, the newest first. */
  reads(workspace: string): Promise<TracedRead[]>;
  /**
   * Gives the role of administrator of the instance to `target`, or takes it away (FRU-280), and
   * writes the action in `admin_actions`. The checks and the writes are in one transaction, under a lock.
   */
  setInstanceAdmin(
    actor: Pick<Account, 'id' | 'email'>,
    target: string,
    admin: boolean,
    now: number,
  ): Promise<RoleChange>;
  /** The actions of the administrators, the newest first: those of one kind, when `kind` is given (FRU-284). */
  actions(kind?: AdminActionKind): Promise<AdminAction[]>;
  /** Whether the account is suspended (FRU-281). `false` for an id that no account has. */
  isSuspended(account: string): Promise<boolean>;
  /**
   * Suspends `target`, or restores it (FRU-281), and writes the action in `admin_actions`: one row
   * for each workspace of the account at this moment, or one row with no workspace. A suspension
   * deletes the sessions of the console of the account. The checks and the writes are in one
   * transaction, under the lock of `setInstanceAdmin`.
   */
  setSuspended(
    actor: Pick<Account, 'id' | 'email'>,
    target: string,
    suspended: boolean,
    now: number,
  ): Promise<SuspensionChange>;
  /**
   * The actions of the administrators on the members of a workspace (FRU-281) and on the workspace
   * (FRU-282), the newest first.
   */
  actionsIn(workspace: string): Promise<TracedAction[]>;
  /**
   * Suspends a workspace, or restores it (FRU-282), and writes the action in `admin_actions`, with
   * `reason` in its `detail`. A call that changes nothing writes nothing: a suspended workspace keeps
   * its first reason. The checks and the writes are in one transaction.
   */
  setWorkspaceSuspended(
    actor: Pick<Account, 'id' | 'email'>,
    workspace: string,
    suspended: boolean,
    reason: string | undefined,
    now: number,
  ): Promise<WorkspaceSuspensionChange>;
  /**
   * Deletes a workspace when `name` is its name (FRU-284), by `dropWorkspace` of
   * `accounts-postgres.ts`, and writes the action in `admin_actions` with the id and the name of the
   * workspace and what went, in `detail`. The checks, the action and the deletion are in one
   * transaction, under the lock of `setInstanceAdmin`.
   */
  deleteWorkspace(
    actor: Pick<Account, 'id' | 'email'>,
    workspace: string,
    name: string,
    now: number,
  ): Promise<WorkspaceDeletion>;
  /** Gives `account` another role in `workspace` (FRU-283). The workspace keeps an owner. */
  setMemberRole(
    actor: Pick<Account, 'id' | 'email'>,
    workspace: string,
    account: string,
    role: AdminGivenRole,
    now: number,
  ): Promise<MemberRoleChange>;
  /** Adds the account of `email` to `workspace` with `role` (FRU-283). */
  addMember(
    actor: Pick<Account, 'id' | 'email'>,
    workspace: string,
    email: string,
    role: AdminGivenRole,
    now: number,
  ): Promise<MemberAddition>;
  /**
   * Makes the account of `email` the owner of `workspace` (FRU-283), a member already or not. Each
   * other owner becomes an admin: they keep their access, and one owner stays.
   */
  setOwner(actor: Pick<Account, 'id' | 'email'>, workspace: string, email: string, now: number): Promise<OwnerChange>;
  /** Invites an address that has no account into `workspace` (FRU-283), as an invitation of a member. */
  invite(
    actor: Pick<Account, 'id' | 'email'>,
    workspace: string,
    email: string,
    role: AdminInvitedRole,
    now: number,
  ): Promise<AdminInvitation>;
  /** Whether a message of an invitation left (FRU-269), as the route of a member keeps it. */
  noteMailed(invitation: string, mailed: boolean): Promise<void>;
  /**
   * Deletes an account (FRU-285) when `email` is its address, and writes the action for each of its
   * workspaces. Refused while it owns a workspace alone. The checks, the actions and the deletion are
   * in one transaction, under the lock of `setInstanceAdmin`.
   */
  deleteAccount(
    actor: Pick<Account, 'id' | 'email'>,
    target: string,
    email: string,
    now: number,
    /** `check`: the checks alone, and nothing is written. */
    options?: { check?: boolean },
  ): Promise<AccountDeletion>;
  /** Makes a workspace whose owner is the account of `email` (FRU-283). */
  createWorkspace(
    actor: Pick<Account, 'id' | 'email'>,
    name: string,
    email: string,
    now: number,
  ): Promise<WorkspaceCreation>;
};

/** When this process started: the first load of this file, which `app.ts` loads at once. */
const STARTED_AT = Date.now();

/** Who may make an account on this instance, and the variable that says it (FRU-278). */
export function signUpPolicyOf(config: WorkerConfig): { policy: SignUp; variable: 'FRUITBACK_SIGN_UP' } {
  return { policy: config.signUp, variable: 'FRUITBACK_SIGN_UP' };
}

/**
 * What the configuration of this worker says, for `GET /console/admin/instance`. Each means of
 * sign-in names the variables that turn it on. No value of a secret, not even in part: the address
 * of the database holds a password, so the answer names its schema and not the address.
 */
export function instanceFactsOf(config: WorkerConfig, mounted: { auth: boolean; email: boolean }) {
  return {
    startedAt: new Date(STARTED_AT).toISOString(),
    store: config.store.provider,
    database: { kind: 'postgresql', schema: config.databaseSchema },
    mail: {
      provider: config.mail === undefined ? null : 'scaleway-tem',
      sender: config.mail?.from ?? null,
      variables: ['FRUITBACK_MAIL_FROM', 'FRUITBACK_SCALEWAY_TEM'],
    },
    signIn: {
      email: { on: mounted.auth && mounted.email, variables: ['FRUITBACK_MAIL_FROM', 'FRUITBACK_SCALEWAY_TEM'] },
      github: { on: mounted.auth && config.authGithub !== undefined, variables: ['FRUITBACK_AUTH_GITHUB_OAUTH'] },
      google: { on: mounted.auth && config.google !== undefined, variables: ['FRUITBACK_GOOGLE_OAUTH'] },
    },
    publicUrl: { value: config.publicUrl ?? null, variable: 'FRUITBACK_PUBLIC_URL' },
    consoleUrl: { value: config.consoleUrl ?? null, variable: 'FRUITBACK_CONSOLE_URL' },
    signUp: signUpPolicyOf(config),
  };
}

export type InstanceFacts = ReturnType<typeof instanceFactsOf>;

export type InstanceAdminContext = {
  /** The account of the cookie when it is the administrator of the instance, read at this call. */
  admin: () => Promise<Account | undefined>;
  /** Absent: a worker with no database of accounts. Every route then answers `404`. */
  reads?: InstanceAdminReads;
  /**
   * Ends every session of the extension of an account, and its codes that nobody redeemed (FRU-281).
   * Absent: the route of the suspension answers `404`.
   */
  endSessionsOf?: (account: string, now: number) => Promise<void>;
  /**
   * What a deletion of a workspace does after its commit (FRU-284), as the deletion by its owner:
   * revoke one sealed key of a Linear connector, and end the sessions of the extension of the
   * workspace. Absent: the route of the deletion answers `404`.
   */
  afterDeletion?: {
    revoke: (sealed: string) => Promise<void>;
    endWorkspaceSessions: (workspace: string, now: number) => Promise<void>;
  };
  /**
   * Sends the message of an invitation of an administrator (FRU-283), under the windows of the
   * invitations of a member. Answers whether it left. Absent: no message, and the console gives the
   * link by hand, as for a member on a worker with no mail.
   */
  mailInvitation?: (invitation: {
    to: string;
    role: string;
    workspace: WorkspaceName;
    inviter: Pick<Account, 'id' | 'email' | 'name' | 'locale'>;
  }) => Promise<boolean>;
  /**
   * One write at a time in a workspace, in this process, with the routes of the organization plugin
   * (`oneAtATime` of `auth-organization.ts`): better-auth counts the owners, then writes, in no
   * transaction. Absent: the write runs as it comes.
   */
  oneAtATime?: <T>(workspace: string, run: () => Promise<T>) => Promise<T>;
  facts?: InstanceFacts;
  now?: number;
};

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

/** `q` and `show` of a list, or `undefined` for a value that the list does not take. */
function queryOf<Show extends string>(url: URL, filters: readonly Show[]): AdminQuery<Show> | undefined {
  const show = url.searchParams.get('show') ?? 'all';
  if (!(filters as readonly string[]).includes(show)) return undefined;
  const q = (url.searchParams.get('q') ?? '').replace(/\s+/g, ' ').trim();
  if (q.length > ADMIN_QUERY_LENGTH) return undefined;

  return { show: show as Show, ...(q === '' ? {} : { q }) };
}

const ID = /^[A-Za-z0-9_-]{1,80}$/;

type ParsedNotes = { ok: true; query: AdminNoteQuery } | { ok: false; error: string };

/** The query of `notes`: the query of the list of a workspace, plus `workspace`, less `mine`. */
function notesQueryOf(params: URLSearchParams): ParsedNotes {
  if (params.has('mine')) return { ok: false, error: 'invalid-mine' };
  const workspace = params.get('workspace') ?? undefined;
  if (workspace !== undefined && !ID.test(workspace)) return { ok: false, error: 'invalid-workspace' };
  const parsed = noteQueryOf(params, '');
  if (!parsed.ok) return parsed;

  return { ok: true, query: { ...parsed.query, ...(workspace === undefined ? {} : { workspace }) } };
}

/** Where a note went: the worker's store, a connector, or a connector that was removed since. */
function placeView(place: AdminNote['place']) {
  if (place.kind === 'fruitback') return { kind: 'fruitback' };
  if (place.connector === undefined) return { kind: 'removed' };

  return { kind: place.connector.kind, connector: place.connector.id, label: place.connector.label };
}

function adminNoteView(note: AdminNote) {
  return {
    id: noteIdOf(note.site.id, note.note),
    workspace: note.workspace,
    site: note.site,
    page: pageOf(note.pageUrl),
    excerpt: note.excerpt,
    ...(note.text === undefined ? {} : { text: note.text }),
    stage: note.stage,
    channel: note.channel,
    author: { kind: note.author },
    place: placeView(note.place),
    ...(note.reference === undefined ? {} : { ref: note.reference }),
    ...(note.referenceUrl === undefined ? {} : { url: note.referenceUrl }),
    createdAt: new Date(note.createdAt).toISOString(),
    checkedAt: new Date(note.checkedAt).toISOString(),
  };
}

/** What `refused` of a `RoleChange` answers. An account that is gone, or no longer an administrator, finds nothing. */
const REFUSED: Record<Extract<RoleChange, { ok: false }>['refused'], { status: number; error: string }> = {
  'unknown-account': { status: 404, error: 'not-found' },
  'not-admin': { status: 404, error: 'not-found' },
  'self-removal': { status: 409, error: 'self-removal' },
  'last-admin': { status: 409, error: 'last-admin' },
};

/** What `refused` of a `SuspensionChange` answers, as `REFUSED` for the role. */
const SUSPENSION_REFUSED: Record<
  Extract<SuspensionChange, { ok: false }>['refused'],
  { status: number; error: string }
> = {
  'unknown-account': { status: 404, error: 'not-found' },
  'not-admin': { status: 404, error: 'not-found' },
  'self-suspension': { status: 409, error: 'self-suspension' },
  'last-admin': { status: 409, error: 'last-admin' },
};

/**
 * `POST /console/admin/users/<id>/suspension`, body `{ suspended: true | false }` (FRU-281).
 *
 * WARNING: the sessions of the extension are in another transaction, so the order is the rule:
 * - a suspension commits first, then ends the sessions of the extension. A refusal ends nothing;
 * - a restoration ends them first, then commits. A session that a failed suspension left live is
 *   ended before the account can act again;
 * - a suspension that changes nothing ends them again: a click after a failure finishes the work.
 */
async function changeSuspension(
  request: Request,
  target: string,
  admin: Account,
  reads: InstanceAdminReads,
  endSessionsOf: (account: string, now: number) => Promise<void>,
  now: number,
  headers: Record<string, string>,
): Promise<Response> {
  const body: unknown = await request.json().catch(() => undefined);
  const asked = typeof body === 'object' && body !== null ? (body as { suspended?: unknown }).suspended : undefined;
  if (typeof asked !== 'boolean') return json(400, { error: 'invalid-suspended' }, headers);

  if (!asked && (await reads.isSuspended(target))) await endSessionsOf(target, now);
  const change = await reads.setSuspended(admin, target, asked, now);
  if (!change.ok) {
    const { status, error } = SUSPENSION_REFUSED[change.refused];

    return json(status, { error }, headers);
  }
  if (change.suspended) await endSessionsOf(target, now);

  return json(200, { user: { id: target, suspended: change.suspended }, changed: change.changed }, headers);
}

/** What `refused` of a `WorkspaceSuspensionChange` answers. */
const WORKSPACE_REFUSED: Record<
  Extract<WorkspaceSuspensionChange, { ok: false }>['refused'],
  { status: number; error: string }
> = {
  'unknown-workspace': { status: 404, error: 'not-found' },
  'not-admin': { status: 404, error: 'not-found' },
};

/** The reason of a body: `undefined` for none, `false` for a value that is refused. One line, trimmed. */
function reasonOf(value: unknown): string | undefined | false {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return false;
  const reason = value.replace(/\s+/g, ' ').trim();
  if ([...reason].length > SUSPENSION_REASON_LENGTH) return false;

  return reason === '' ? undefined : reason;
}

/**
 * `POST /console/admin/workspaces/<id>/suspension`, body `{ suspended: true | false, reason? }`
 * (FRU-282). The administrator can be a member of the workspace: they then read it as every member
 * does, and restore it from here.
 */
async function changeWorkspaceSuspension(
  request: Request,
  workspace: string,
  admin: Account,
  reads: InstanceAdminReads,
  now: number,
  headers: Record<string, string>,
): Promise<Response> {
  const body: unknown = await request.json().catch(() => undefined);
  const fields = typeof body === 'object' && body !== null ? (body as { suspended?: unknown; reason?: unknown }) : {};
  if (typeof fields.suspended !== 'boolean') return json(400, { error: 'invalid-suspended' }, headers);
  const reason = reasonOf(fields.reason);
  if (reason === false) return json(400, { error: 'invalid-reason', maxLength: SUSPENSION_REASON_LENGTH }, headers);

  const change = await reads.setWorkspaceSuspended(admin, workspace, fields.suspended, reason, now);
  if (!change.ok) {
    const { status, error } = WORKSPACE_REFUSED[change.refused];

    return json(status, { error }, headers);
  }

  return json(
    200,
    { workspace: { id: workspace, ...suspensionView(change.suspension) }, changed: change.changed },
    headers,
  );
}

/** What `refused` of a `WorkspaceDeletion` answers. A name that differs is the one refusal the console shows. */
const DELETION_REFUSED: Record<
  Extract<WorkspaceDeletion, { ok: false }>['refused'],
  { status: number; error: string }
> = {
  'unknown-workspace': { status: 404, error: 'not-found' },
  'not-admin': { status: 404, error: 'not-found' },
  'name-mismatch': { status: 409, error: 'name-mismatch' },
};

/**
 * `POST /console/admin/workspaces/<id>/deletion`, body `{ name }` (FRU-284). The name is the one of
 * the workspace, as the administrator typed it: spaces at its ends are dropped, and nothing else.
 *
 * WARNING: the order is the rule. The tokens of Linear are revoked after the commit, never before: a
 * refusal must leave the connectors of the workspace working. A token that Linear did not revoke is
 * held by no row after the commit, as when its owner deletes the workspace and Linear does not answer.
 */
async function deleteWorkspace(
  request: Request,
  workspace: string,
  admin: Account,
  reads: InstanceAdminReads,
  after: NonNullable<InstanceAdminContext['afterDeletion']>,
  now: number,
  headers: Record<string, string>,
): Promise<Response> {
  const body: unknown = await request.json().catch(() => undefined);
  const name = typeof body === 'object' && body !== null ? (body as { name?: unknown }).name : undefined;
  if (typeof name !== 'string' || name.trim() === '') return json(400, { error: 'invalid-name' }, headers);

  const deletion = await reads.deleteWorkspace(admin, workspace, name.trim(), now);
  if (!deletion.ok) {
    const { status, error } = DELETION_REFUSED[deletion.refused];

    return json(status, { error }, headers);
  }
  // A revocation is best effort, as `revokeLinear` says: a key that cannot be opened, or a call that
  // throws, is written in the log and must not leave the extensions of the deleted workspace alive.
  for (const sealed of deletion.revoke) {
    await after.revoke(sealed).catch((error: unknown) => {
      console.error(`[fruitback] a Linear token of a deleted workspace was not revoked: ${String(error)}`);
    });
  }
  // Nobody is a member of it any more: the extensions that were paired for it stop.
  await after.endWorkspaceSessions(workspace, now);

  return json(200, { workspace: deletion.workspace, gone: deletion.gone }, headers);
}

/**
 * What a refusal of a write in a workspace answers (FRU-283). A workspace that does not exist, and a
 * caller who is no longer an administrator, find nothing. The rest is a `409` that the console says.
 */
const IN_WORKSPACE_REFUSED: Readonly<Record<string, { status: number; error: string }>> = {
  'unknown-workspace': { status: 404, error: 'not-found' },
  'not-admin': { status: 404, error: 'not-found' },
  'workspace-suspended': { status: 409, error: 'workspace-suspended' },
  'not-a-member': { status: 409, error: 'not-a-member' },
  'last-owner': { status: 409, error: 'last-owner' },
  'unknown-account': { status: 409, error: 'unknown-account' },
  'already-member': { status: 409, error: 'already-member' },
  'suspended-account': { status: 409, error: 'suspended-account' },
  'has-account': { status: 409, error: 'has-account' },
  'already-invited': { status: 409, error: 'already-invited' },
};

function refusedIn(refused: string, headers: Record<string, string>): Response {
  const { status, error } = IN_WORKSPACE_REFUSED[refused] ?? { status: 409, error: refused };

  return json(status, { error }, headers);
}

/** The fields of a body, or `{}` for one that is not an object. */
async function fieldsOf(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => undefined);

  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function oneOf<T extends string>(value: unknown, among: readonly T[]): T | undefined {
  return (among as readonly unknown[]).includes(value) ? (value as T) : undefined;
}

/**
 * The writes of an administrator in a workspace (FRU-283): the role of a member, a member added, the
 * owner, an invitation, a new workspace. Each body is read here; the store checks the workspace, the
 * role of the caller and the rules of the members in one transaction, and writes the action.
 */
async function writeInWorkspace(
  write: 'member-role' | 'member-add' | 'owner' | 'invitation' | 'new-workspace',
  request: Request,
  match: RegExpExecArray,
  admin: Account,
  context: InstanceAdminContext,
  reads: InstanceAdminReads,
  now: number,
  headers: Record<string, string>,
): Promise<Response> {
  const fields = await fieldsOf(request);
  const workspace = match[1] as string;
  const serial = context.oneAtATime ?? (<T>(_: string, run: () => Promise<T>) => run());

  switch (write) {
    case 'member-role': {
      const role = oneOf(fields.role, ADMIN_GIVEN_ROLES);
      if (role === undefined) return json(400, { error: 'invalid-role', roles: ADMIN_GIVEN_ROLES }, headers);
      const change = await serial(workspace, () =>
        reads.setMemberRole(admin, workspace, match[2] as string, role, now),
      );
      if (!change.ok) return refusedIn(change.refused, headers);

      return json(200, { member: { id: match[2], role: change.role }, changed: change.changed }, headers);
    }
    case 'member-add': {
      const email = typeof fields.email === 'string' ? normalizeEmail(fields.email) : undefined;
      if (email === undefined) return json(400, { error: 'invalid-email' }, headers);
      const role = oneOf(fields.role, ADMIN_GIVEN_ROLES);
      if (role === undefined) return json(400, { error: 'invalid-role', roles: ADMIN_GIVEN_ROLES }, headers);
      const added = await serial(workspace, () => reads.addMember(admin, workspace, email, role, now));
      if (!added.ok) return refusedIn(added.refused, headers);

      return json(200, { member: added.member }, headers);
    }
    case 'owner': {
      const email = typeof fields.email === 'string' ? normalizeEmail(fields.email) : undefined;
      if (email === undefined) return json(400, { error: 'invalid-email' }, headers);
      const change = await serial(workspace, () => reads.setOwner(admin, workspace, email, now));
      if (!change.ok) return refusedIn(change.refused, headers);

      return json(200, { owner: change.owner, previous: change.previous, changed: change.changed }, headers);
    }
    case 'invitation': {
      const email = typeof fields.email === 'string' ? normalizeEmail(fields.email) : undefined;
      if (email === undefined) return json(400, { error: 'invalid-email' }, headers);
      const role = oneOf(fields.role, ADMIN_INVITED_ROLES);
      if (role === undefined) return json(400, { error: 'invalid-role', roles: ADMIN_INVITED_ROLES }, headers);
      const invited = await serial(workspace, () => reads.invite(admin, workspace, email, role, now));
      if (!invited.ok) return refusedIn(invited.refused, headers);
      // After the commit, as for a member: the invitation exists whether its message leaves or not,
      // and the answer says which, so the console gives the link by hand when it did not.
      let mailed = false;
      if (context.mailInvitation !== undefined) {
        mailed = await context.mailInvitation({ to: email, role, workspace: invited.workspace, inviter: admin });
      }
      await reads.noteMailed(invited.invitation.id, mailed);

      return json(
        200,
        {
          invitation: {
            id: invited.invitation.id,
            email,
            role,
            expiresAt: new Date(invited.invitation.expiresAt).toISOString(),
            mailed,
          },
        },
        headers,
      );
    }
    case 'new-workspace': {
      const name = workspaceName(fields.name);
      if (name === undefined) return json(400, { error: 'invalid-name' }, headers);
      const email = typeof fields.owner === 'string' ? normalizeEmail(fields.owner) : undefined;
      if (email === undefined) return json(400, { error: 'invalid-email' }, headers);
      const made = await reads.createWorkspace(admin, name, email, now);
      if (!made.ok) return refusedIn(made.refused, headers);

      return json(201, { workspace: made.workspace, owner: made.owner }, headers);
    }
  }
}

/** What a refused deletion of an account answers (FRU-285). */
const ACCOUNT_DELETION_REFUSED: Record<
  Exclude<Extract<AccountDeletion, { ok: false }>['refused'], 'sole-owner'>,
  { status: number; error: string }
> = {
  'unknown-account': { status: 404, error: 'not-found' },
  'not-admin': { status: 404, error: 'not-found' },
  'self-deletion': { status: 409, error: 'self-deletion' },
  'last-admin': { status: 409, error: 'last-admin' },
  'email-mismatch': { status: 409, error: 'email-mismatch' },
};

/**
 * `POST /console/admin/users/<id>/deletion`, body `{ email }` (FRU-285).
 *
 * WARNING: the sessions of the extension are in another store, so the order is the rule, as for a
 * restoration (`changeSuspension`): they end before the transaction, so a deletion that then fails
 * leaves no session that a retry would miss, and again after it, for a pairing made in between.
 * A refusal ends nothing.
 */
async function deleteAccount(
  request: Request,
  target: string,
  admin: Account,
  reads: InstanceAdminReads,
  endSessionsOf: (account: string, now: number) => Promise<void>,
  now: number,
  headers: Record<string, string>,
): Promise<Response> {
  const fields = await fieldsOf(request);
  const email = typeof fields.email === 'string' ? normalizeEmail(fields.email) : undefined;
  if (email === undefined) return json(400, { error: 'invalid-email' }, headers);

  // The refusals that need no write are read first: a refused deletion ends no session.
  const known = await reads.deleteAccount(admin, target, email, now, { check: true });
  if (!known.ok) {
    if (known.refused === 'sole-owner')
      return json(409, { error: 'sole-owner', workspaces: known.workspaces }, headers);
    const { status, error } = ACCOUNT_DELETION_REFUSED[known.refused];

    return json(status, { error }, headers);
  }
  await endSessionsOf(target, now);
  const deleted = await reads.deleteAccount(admin, target, email, now);
  if (!deleted.ok) {
    if (deleted.refused === 'sole-owner')
      return json(409, { error: 'sole-owner', workspaces: deleted.workspaces }, headers);
    const { status, error } = ACCOUNT_DELETION_REFUSED[deleted.refused];

    return json(status, { error }, headers);
  }
  await endSessionsOf(target, now);

  return json(200, { user: deleted.account, workspaces: deleted.workspaces }, headers);
}

/** `POST /console/admin/users/<id>/instance-admin`, body `{ admin: true | false }` (FRU-280). */
async function changeRole(
  request: Request,
  target: string,
  admin: Account,
  reads: InstanceAdminReads,
  now: number,
  headers: Record<string, string>,
): Promise<Response> {
  const body: unknown = await request.json().catch(() => undefined);
  const asked = typeof body === 'object' && body !== null ? (body as { admin?: unknown }).admin : undefined;
  if (typeof asked !== 'boolean') return json(400, { error: 'invalid-admin' }, headers);

  const change = await reads.setInstanceAdmin(admin, target, asked, now);
  if (!change.ok) {
    const { status, error } = REFUSED[change.refused];

    return json(status, { error }, headers);
  }

  return json(200, { user: { id: target, instanceAdmin: change.instanceAdmin }, changed: change.changed }, headers);
}

/**
 * The routes under `ADMIN_PATH`, or `undefined` for a path that is not one. The guard runs first,
 * for every path under `ADMIN_PATH`: a caller who is not the administrator learns nothing, not even
 * which paths exist.
 */
export async function handleInstanceAdmin(
  request: Request,
  pathname: string,
  context: InstanceAdminContext,
  headers: Record<string, string>,
): Promise<Response | undefined> {
  if (!isAdminPath(pathname)) return undefined;
  const notFound = (): Response => json(404, { error: 'not-found' }, headers);

  const admin = await context.admin();
  if (admin === undefined) return notFound();

  const { reads, facts } = context;
  const now = context.now ?? Date.now();
  const write = ADMIN_WRITE_ROUTES.find((each) => each.pattern.test(pathname));
  if (write !== undefined) {
    if (reads === undefined || facts === undefined) return notFound();
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
    const match = write.pattern.exec(pathname) as RegExpExecArray;
    const target = match[1] as string;

    switch (write.write) {
      case 'instance-admin':
        return changeRole(request, target, admin, reads, now, headers);
      case 'suspension':
        if (context.endSessionsOf === undefined) return notFound();

        return changeSuspension(request, target, admin, reads, context.endSessionsOf, now, headers);
      case 'workspace-suspension':
        return changeWorkspaceSuspension(request, target, admin, reads, now, headers);
      case 'workspace-deletion':
        if (context.afterDeletion === undefined) return notFound();

        return deleteWorkspace(request, target, admin, reads, context.afterDeletion, now, headers);
      case 'account-deletion':
        if (context.endSessionsOf === undefined) return notFound();

        return deleteAccount(request, target, admin, reads, context.endSessionsOf, now, headers);
      case 'member-role':
      case 'member-add':
      case 'owner':
      case 'invitation':
      case 'new-workspace':
        return writeInWorkspace(write.write, request, match, admin, context, reads, now, headers);
    }
  }

  const route = ADMIN_ROUTES.find((each) => each.pattern.test(pathname));
  if (route === undefined || reads === undefined || facts === undefined) return notFound();
  if (request.method !== 'GET') return json(405, { error: 'method-not-allowed' }, headers);

  const url = new URL(request.url);
  const traced = (workspaces: readonly string[]) => reads.trace(admin, workspaces, route.read, now);

  switch (route.read) {
    case 'instance': {
      const [counts, attention] = await Promise.all([reads.counts(), reads.attention()]);
      await traced(attention.connectors.map((connector) => connector.workspace.id));

      return json(
        200,
        {
          ...facts,
          mail: { ...facts.mail, lastSentAt: lastMailSentAt() ?? null },
          counts,
          attention: { count: attention.total, connectors: attention.connectors },
        },
        headers,
      );
    }
    case 'workspaces': {
      const query = queryOf(url, WORKSPACE_FILTERS);
      if (query === undefined) return json(400, { error: 'invalid-query' }, headers);
      const found = await reads.workspaces(query);
      await traced(found.workspaces.map((workspace) => workspace.id));

      return json(200, found, headers);
    }
    case 'workspace': {
      const id = route.pattern.exec(pathname)?.[1] as string;
      const workspace = await reads.workspace(id);
      if (workspace === undefined) return notFound();
      await traced([workspace.id]);

      return json(200, workspace, headers);
    }
    case 'users': {
      const query = queryOf(url, USER_FILTERS);
      if (query === undefined) return json(400, { error: 'invalid-query' }, headers);
      const found = await reads.users(query);
      await traced(
        found.users.flatMap((each) => [
          ...each.workspaces.map((workspace) => workspace.id),
          ...each.pendingInvitations.map((invitation) => invitation.workspace.id),
        ]),
      );

      return json(200, found, headers);
    }
    case 'notes': {
      const query = notesQueryOf(url.searchParams);
      if (!query.ok) return json(400, { error: query.error }, headers);
      const found = await reads.notes(query.query);
      await traced(found.notes.map((note) => note.workspace.id));

      return json(
        200,
        {
          notes: found.notes.map(adminNoteView),
          total: found.total,
          searched: ADMIN_NOTES_SEARCHED,
          ...(found.next === undefined ? {} : { next: cursorOf(found.next) }),
        },
        headers,
      );
    }
    case 'actions': {
      // `kind` (FRU-284): the page Instance lists the deleted workspaces alone, with no read of the others.
      const kind = url.searchParams.get('kind') ?? undefined;
      if (kind !== undefined && !(ADMIN_ACTIONS as readonly string[]).includes(kind))
        return json(400, { error: 'invalid-kind' }, headers);
      const actions = await reads.actions(kind as AdminActionKind | undefined);
      await traced(actions.flatMap((action) => (action.workspace === undefined ? [] : [action.workspace.id])));

      return json(200, { actions }, headers);
    }
  }
}
