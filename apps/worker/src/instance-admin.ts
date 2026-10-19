import type { SeedStage } from '@fruitback/shared';
import type { Account, ConnectorAttention, ConnectorKind, Role, Visibility, WorkspaceSuspension } from './accounts.ts';
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

/** The writes that an administrator does (FRU-280, FRU-281, FRU-282). */
export const ADMIN_WRITES = ['instance-admin', 'suspension', 'workspace-suspension'] as const;
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
];

/** The kinds of action that `admin_actions` keeps. */
export const ADMIN_ACTIONS = [
  'admin-named',
  'admin-removed',
  'account-suspended',
  'account-restored',
  'workspace-suspended',
  'workspace-restored',
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
export const WORKSPACE_FILTERS = ['all', 'attention', 'empty'] as const;
export const USER_FILTERS = ['all', 'admins', 'alone'] as const;

export type AdminQuery<Show extends string> = { q?: string; show: Show };

export type StageCounts = Record<SeedStage, number>;

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
  workspaces: (WorkspaceName & { role: string })[];
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
  seed: string;
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
 * One action of an administrator on a member of a workspace (FRU-281), or on the workspace itself
 * (FRU-282), as its owners read it. `target` is the member, absent for an action on the workspace.
 * `reason` is the reason of a suspension or a restoration of the workspace.
 */
export type TracedAction = {
  action: AdminActionKind;
  at: string;
  admin: { email: string; name?: string };
  target?: { email: string; name?: string };
  reason?: string;
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
  /** The actions of the administrators, the newest first. */
  actions(): Promise<AdminAction[]>;
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
    id: noteIdOf(note.site.id, note.seed),
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
    const target = write.pattern.exec(pathname)?.[1] as string;

    switch (write.write) {
      case 'instance-admin':
        return changeRole(request, target, admin, reads, now, headers);
      case 'suspension':
        if (context.endSessionsOf === undefined) return notFound();

        return changeSuspension(request, target, admin, reads, context.endSessionsOf, now, headers);
      case 'workspace-suspension':
        return changeWorkspaceSuspension(request, target, admin, reads, now, headers);
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
      const actions = await reads.actions();
      await traced(actions.flatMap((action) => (action.workspace === undefined ? [] : [action.workspace.id])));

      return json(200, { actions }, headers);
    }
  }
}
