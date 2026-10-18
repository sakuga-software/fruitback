import type { SeedStage } from '@fruitback/shared';
import type { Account, ConnectorAttention, ConnectorKind, Role, Visibility } from './accounts.ts';
import type { WorkerConfig } from './env.ts';
import { lastMailSentAt } from './mail.ts';
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
 *   migration gives it to the oldest one. No route gives it or takes it away (FRU-274).
 * - **The guard.** `instanceAdminOf` of `console-api.ts` reads the cookie of the console and then the
 *   role in the database, at each call. Every other caller gets `404`, as for a path that does not
 *   exist. `handleInstanceAdmin` asks the guard before it reads `ADMIN_ROUTES`, so a route of the
 *   table cannot skip it.
 * - **The trace.** A read that names a workspace the administrator is not a member of writes one row
 *   for that workspace in `admin_reads`, before the answer leaves. A trace that cannot be written
 *   fails the read. The owners of the workspace read the rows.
 * - **What an answer never holds**: a secret, a token, a digest, a key of a connector, an address of
 *   the database, or the text of a note. Counts, names and labels only.
 */

/** Where the routes of the administrator of the instance are. */
export const ADMIN_PATH = '/console/admin';

/** The reads that an administrator does, as the trace names them. */
export const ADMIN_READS = ['instance', 'workspaces', 'workspace', 'users'] as const;
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
];

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

export type AdminWorkspace = WorkspaceName & {
  createdAt: string;
  owners: { id: string; name?: string; email: string }[];
  members: number;
  sites: number;
  notes: StageCounts;
  destinations: AdminConnector[];
  pendingDeliveries: number;
};

export type AdminWorkspaceDetail = WorkspaceName & {
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
  workspaces: (WorkspaceName & { role: string })[];
  /** The ways the person signed in: `email`, `github`, `google`. */
  providers: string[];
  /** The last day the person was seen in one of their workspaces (FRU-249), as `YYYY-MM-DD`. */
  lastSeen?: string;
  pendingInvitations: { workspace: WorkspaceName; role?: string }[];
};

/** A connector that needs attention, with its workspace. */
export type AttentionConnector = AdminConnector & { workspace: WorkspaceName };

/** One read of an administrator in a workspace, as its owners read it. */
export type TracedRead = { admin: { email: string; name?: string }; what: AdminRead; at: string };

/** What the administrator reads in the database. `instance-admin-postgres.ts` is the one store. */
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
  /** Writes one row for each of `workspaces` that `admin` is not a member of, in one statement. */
  trace(
    admin: Pick<Account, 'id' | 'email'>,
    workspaces: readonly string[],
    what: AdminRead,
    now: number,
  ): Promise<void>;
  /** The reads in a workspace, the newest first. */
  reads(workspace: string): Promise<TracedRead[]>;
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

  const route = ADMIN_ROUTES.find((each) => each.pattern.test(pathname));
  const { reads, facts } = context;
  if (route === undefined || reads === undefined || facts === undefined) return notFound();
  if (request.method !== 'GET') return json(405, { error: 'method-not-allowed' }, headers);

  const url = new URL(request.url);
  const now = context.now ?? Date.now();
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
  }
}
