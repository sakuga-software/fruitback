import { isOneOf } from './one-of.ts';
import { json } from './http.ts';
import { handleNotes } from './console-notes.ts';
import { askLinear, handleConnectors, listRepositories } from './console-connectors.ts';
import { readJsonObject } from './bounded-body.ts';
import {
  type InstanceAdminContext,
  type InstanceAdminReads,
  type InstanceFacts,
  handleInstanceAdmin,
  isAdminPath,
} from './instance-admin.ts';
import { type NoteIndex, noNotes } from './notes-index.ts';
import {
  type Account,
  type AccountStore,
  type Action,
  type ConnectorKind,
  type Destination,
  type Domain,
  MAX_DESTINATIONS,
  MAX_DOMAINS,
  type Site,
  VISIBILITIES,
  WRITERS,
  type Workspace,
  type Visibility,
  type Writers,
  can,
  destinationId,
  siteOrigin,
  readLocaleTag,
  readPersonName,
  onlyOf,
  readableSites,
  workspaceName,
} from './accounts.ts';
import { readSiteChoices, readSitePage, readableSite, siteChoicesPage } from './console-sites.ts';
import { seen } from './last-seen.ts';
import {
  type ProofState,
  type TxtResolver,
  checkProof,
  previewPattern,
  proofRecord,
  proofState,
  readDomain,
  sayLoss,
  systemResolver,
} from './domain-proof.ts';
import { type GithubApp, openInstallation, readGithubRepository } from './github-connector.ts';
import { GITHUB_STATES } from './github.ts';
import { LinearKeyForbidden, LinearKeyRefused, listLinearStates, listLinearTeams, readLinearPlaces } from './linear.ts';
import { rememberTrackerStates } from './tracker-states.ts';
import type { Kv } from './kv.ts';
import { type LinearOAuth, revokeLinear } from './linear-oauth.ts';
import { OWN_SOURCE, isBuiltIn, originOf, readSiteStatus } from './site-statuses.ts';
import { invalidatePages } from './note-helpers.ts';
import { DEFAULT_NOTE_STAGE, MAX_STATUSES, NOTE_STAGES, type NoteStage } from '@fruitback/shared';
import { StoreError } from './store.ts';
import { pairsByCode } from './pair-page.ts';
import { PAIRING_TTL_SECONDS, type SessionStore, createPairing } from './session.ts';
import { memberSuspensionView, refusedWhileSuspended } from './workspace-suspension.ts';
import { handleLogo } from './workspace-logo.ts';
import { handleAgentKeys } from './agent-keys.ts';
import { handleAgentTrigger } from './agent-triggers.ts';

/**
 * What the console reads and writes (FRU-99): the account, its workspaces, their sites, and the code
 * that connects a browser (FRU-100).
 *
 * **Every call is a person, checked twice.** The cookie of a session of better-auth says who, read
 * in the database at each call, and the role this person has in the workspace, read from the
 * accounts on every call, says what: a member removed a minute ago is refused at once.
 */

export type ConsoleApiContext = {
  accounts: AccountStore;
  sessions: SessionStore;
  now?: number;
  /** What opens and closes the connector keys (FRU-121). Absent, a workspace connects no tracker. */
  secretsKey?: string;
  /** Where a ticket for the way to Linear is kept (FRU-134). */
  kv?: Kv;
  /** The index of the notes (FRU-237). Absent: the sites are answered with no count. */
  noteIndex?: NoteIndex;
  /** The Linear application, when this worker has one: a workspace then connects Linear with no key. */
  linearOAuth?: LinearOAuth;
  /** The GitHub App of the connectors (FRU-360). Absent: a workspace does not install it here. */
  githubApp?: GithubApp;
  publicUrl?: string;
  /**
   * The person of the cookie of better-auth, or `undefined` (FRU-147). Absent: better-auth is off,
   * and every call answers `401`: nobody signs in to the console without it (FRU-150).
   */
  cookieSession?: (request: Request) => Promise<string | undefined>;
  /** `FRUITBACK_CONSOLE_URL`: the one origin a call with the cookie may change something from. */
  consoleUrl?: string;
  /** What asks the DNS for the proof of a domain (FRU-103). A suite hands over a double. */
  resolveTxt?: TxtResolver;
  /**
   * Makes a workspace for the person of the cookie of this request, through the organization plugin
   * of better-auth (FRU-149). Absent, the store makes it: a test that gives no plugin.
   */
  createWorkspace?: (request: Request, name: string) => Promise<Workspace>;
  /**
   * Renames a workspace for the person of the cookie of this request, through the organization plugin
   * of better-auth (FRU-236). Absent: better-auth is off, nobody is signed in, and the route is not
   * reached.
   */
  renameWorkspace?: (request: Request, workspace: string, name: string) => Promise<Workspace>;
  /** What the administrator of the instance reads (FRU-261). Absent: every route of the administrator answers `404`. */
  instance?: {
    reads?: InstanceAdminReads;
    facts: InstanceFacts;
    /** The last release when it is newer than this worker (FRU-520). Absent: no question to GitHub. */
    latestRelease?: InstanceAdminContext['latestRelease'];
    /** What the writes of an administrator in a workspace use beside the database (FRU-283). */
    writes?: Pick<InstanceAdminContext, 'mailInvitation' | 'oneAtATime'>;
  };
};

/** How long a domain is not asked again on a click: a person who presses twice asks the DNS once. */
export const CHECK_AGAIN_MS = 10_000;

/** A domain as the console reads it: what to write in the DNS, and where the proof stands. */
type DomainView = {
  id: string;
  domain: string;
  state: ProofState;
  record: { type: 'TXT'; name: string; value: string };
  /** The wildcard the previews of this domain are, as the extension writes it. */
  previews: string;
  previewsSite?: string;
  verifiedAt?: string;
  lostAt?: string;
  checkedAt?: string;
};

function domainView(domain: Domain, now: number): DomainView {
  const record = proofRecord(domain.workspaceId, domain.domain);
  const iso = (time: number | undefined) => (time === undefined ? undefined : new Date(time).toISOString());
  const at = { verifiedAt: iso(domain.verifiedAt), lostAt: iso(domain.lostAt), checkedAt: iso(domain.checkedAt) };

  return {
    id: domain.id,
    domain: domain.domain,
    state: proofState(domain, now),
    record: { type: 'TXT', ...record },
    previews: previewPattern(domain.domain),
    ...(domain.previewsSite === undefined ? {} : { previewsSite: domain.previewsSite }),
    ...Object.fromEntries(Object.entries(at).filter(([, value]) => value !== undefined)),
  };
}

/**
 * The statuses an order names, as `{ source, key }`, or `undefined` for a list that holds anything
 * else, or one status twice: the same status in two places is no order (FRU-366).
 */
function statusIdsOf(asked: readonly unknown[]): { source: string; key: string }[] | undefined {
  const order: { source: string; key: string }[] = [];
  const seen = new Set<string>();
  for (const each of asked) {
    const entry = typeof each === 'object' && each !== null ? (each as Record<string, unknown>) : undefined;
    const read = readSiteStatus({ source: entry?.source, key: entry?.key, stage: DEFAULT_NOTE_STAGE });
    if (!read.ok) return undefined;
    const id = JSON.stringify([read.status.source, read.status.key]);
    if (seen.has(id)) return undefined;
    seen.add(id);
    order.push({ source: read.status.source, key: read.status.key });
  }

  return order;
}

function visibilityOf(value: unknown): Visibility | undefined {
  return isOneOf(value, VISIBILITIES) ? value : undefined;
}

function writersOf(value: unknown): Writers | undefined {
  return isOneOf(value, WRITERS) ? value : undefined;
}

/** The fields of a site the console shows, and the client id a script tag names. */
type SiteView = {
  id: string;
  origin: string;
  visibility: Visibility;
  writers: Writers;
  destination?: Destination;
  destinations?: Destination[];
};

/**
 * WARNING: a destination names the tracker, so it is for a role that may see the tracker only.
 *
 * `destination` is the first of `destinations`: where a note goes when nobody chose. It stays for a
 * console that knows one destination for a site.
 */
function siteView(site: Site, seesTracker: boolean): SiteView {
  const [first] = site.destinations;

  return {
    id: site.id,
    origin: site.origin,
    visibility: site.visibility,
    writers: site.writers,
    ...(seesTracker && first !== undefined ? { destination: first, destinations: site.destinations } : {}),
  };
}

/** What the index answers, or nothing when it does not answer (FRU-237): said in the log. */
async function counted<T>(read: () => Promise<T> | undefined): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    console.error(
      `[fruitback] the index of the notes did not answer: ${error instanceof Error ? error.message : String(error)}`,
    );

    return undefined;
  }
}

/** What the worker calls each kind of source in the label of a destination. */
const KIND_NAMES: Record<ConnectorKind, string> = { linear: 'Linear', rest: 'REST API', github: 'GitHub' };

/** The place does not exist in the tracker of the connector: nothing must be kept for it. */
export class UnknownPlace extends Error {}

/**
 * What a read of a tracker needs (FRU-453): the console's context, and the session routes of the
 * extension, which choose a place too. The keys of the connectors are opened here and never leave.
 */
export type TrackerContext = Pick<ConsoleApiContext, 'accounts' | 'secretsKey' | 'linearOAuth' | 'githubApp' | 'now'>;

/** What a source offers to choose (FRU-453), as the console's routes answer it. */
export type SourceOffer =
  | { kind: 'linear'; teams: Awaited<ReturnType<typeof listLinearTeams>>['teams'] }
  | { kind: 'github'; repositories: { fullName: string; private: boolean }[] }
  | { kind: 'rest' };

/**
 * The teams of a Linear, the repositories of a GitHub, or nothing to choose for an address: what the
 * console reads from `/connectors/<id>/teams` and `/repositories`, for the popup (FRU-453). `undefined`
 * for a connector of another workspace, or one this worker cannot open.
 */
export async function offerOf(
  context: TrackerContext,
  workspace: string,
  connector: string,
): Promise<SourceOffer | undefined> {
  const kept = await context.accounts.sealedKey(connector);
  if (kept === undefined || kept.workspaceId !== workspace) return undefined;
  if (kept.kind === 'rest') return { kind: 'rest' };
  if (kept.kind === 'github') {
    if (context.githubApp === undefined || context.secretsKey === undefined) return undefined;

    // The popup reads the list alone (FRU-453): its contract does not change with the count (FRU-500).
    const { repositories } = await listRepositories(context, workspace, connector, kept.sealed);

    return { kind: 'github', repositories };
  }
  if (context.secretsKey === undefined) return undefined;

  return { kind: 'linear', teams: (await askLinear(context, connector, kept.sealed, listLinearTeams)).teams };
}

/**
 * A place named by the popup (FRU-453), checked as the console checks one: a connector of this
 * workspace, a team or a repository its key reaches, and the label the tracker answers. `undefined`
 * for a connector of another workspace; `UnknownPlace` is thrown for a place the key does not reach.
 */
export async function placeOf(
  context: TrackerContext,
  workspace: string,
  asked: { connector: string; teamId?: string; projectId?: string },
): Promise<Destination | undefined> {
  const named = await context.accounts.sealedKey(asked.connector);
  if (named === undefined || named.workspaceId !== workspace) return undefined;
  const body =
    named.kind === 'github'
      ? {
          connector: asked.connector,
          repository: asked.teamId,
          ...(asked.projectId === undefined ? {} : { projectId: asked.projectId }),
        }
      : asked;
  const wanted = destinationOf(body, named.kind);
  if (wanted === undefined) throw new UnknownPlace();
  const [kept] = await labelled(context, workspace, [wanted]);
  if (kept === undefined) throw new UnknownPlace();

  return kept;
}

/**
 * The destinations with the label a member reads when they choose one (FRU-123): « Linear · Design ».
 *
 * The worker writes the label from what the tracker answers, never from the request: a member
 * chooses by this word, so it must name the place the note goes to. Linear is asked once for a
 * connector, for the teams and the projects of its places only, and never for the list of its teams
 * (FRU-501); what it answers is noted on the connector. It throws `UnknownPlace` for a team or a
 * project the key does not reach.
 */
async function labelled(
  context: TrackerContext,
  workspaceId: string,
  wanted: readonly Destination[],
): Promise<Destination[]> {
  const connectors = await context.accounts.connectors(workspaceId);
  const linear = await linearNamesOf(context, connectors, wanted);
  const out: Destination[] = [];

  for (const destination of wanted) {
    const connector = connectors.find((each) => each.id === destination.connector);
    if (connector === undefined) throw new UnknownPlace();
    if (connector.kind === 'rest') {
      out.push({ ...destination, label: `${KIND_NAMES.rest} · ${connector.label}` });
      continue;
    }
    // FRU-359: the repository is its own name. FRU-382: GitHub says whether it is private, so that the
    // console warns about a public one without the list of the repositories.
    if (connector.kind === 'github') {
      const isPrivate = await privacyOf(context, connector.id, destination.teamId);
      // Only GitHub's word is written: whatever a destination came with is dropped here.
      const { private: _asked, ...place } = destination;
      out.push({
        ...place,
        label: `${KIND_NAMES.github} · ${destination.teamId ?? ''}`,
        ...(isPrivate === undefined ? {} : { private: isPrivate }),
      });
      continue;
    }

    const named = linear.get(destination);
    if (named === undefined) throw new UnknownPlace();

    // FRU-574: the page of the team at Linear, as Linear answers it now. Whatever a destination came
    // with is dropped: only the worker's own address is written.
    const { url: _asked, ...place } = destination;
    out.push({
      ...place,
      label: [KIND_NAMES[connector.kind], named.team, ...(named.project === undefined ? [] : [named.project])].join(
        ' · ',
      ),
      ...(named.url === undefined ? {} : { url: named.url }),
    });
  }

  return out;
}

/**
 * The names of the places of Linear among `wanted` (FRU-501): one call for each connector, with the
 * ids of its places. A place the key does not reach has no entry.
 */
async function linearNamesOf(
  context: TrackerContext,
  connectors: readonly { id: string; kind: ConnectorKind }[],
  wanted: readonly Destination[],
): Promise<Map<Destination, { team: string; project?: string; url?: string }>> {
  const names = new Map<Destination, { team: string; project?: string; url?: string }>();
  for (const connector of connectors) {
    if (connector.kind !== 'linear') continue;
    const places = wanted.flatMap((destination) =>
      destination.connector === connector.id && destination.teamId !== undefined
        ? [{ destination, place: { teamId: destination.teamId, projectId: destination.projectId } }]
        : [],
    );
    if (places.length === 0) continue;
    const kept = await context.accounts.sealedKey(connector.id);
    if (kept === undefined) continue;
    const read = await askLinear(context, connector.id, kept.sealed, (authorization) =>
      readLinearPlaces(
        authorization,
        places.map(({ place }) => place),
      ),
    );
    for (const [index, { destination }] of places.entries()) {
      const named = read[index];
      if (named !== undefined) names.set(destination, named);
    }
  }

  return names;
}

/**
 * Whether the repository of a `github` destination is private (FRU-382), asked of GitHub with a token
 * that reads the metadata of that repository alone. `undefined` when it is not known: no App here, an
 * installation that does not cover it, or a GitHub that does not answer. The destination is written
 * all the same, as before: GitHub is asked again when a note goes there.
 */
async function privacyOf(
  context: TrackerContext,
  connector: string,
  repository: string | undefined,
): Promise<boolean | undefined> {
  if (context.githubApp === undefined || repository === undefined) return undefined;
  try {
    const kept = await context.accounts.sealedKey(connector);
    if (kept === undefined) return undefined;

    return (await context.githubApp.repository(openInstallation(kept.sealed, context.secretsKey), repository))?.private;
  } catch (error) {
    if (!(error instanceof StoreError)) throw error;
    console.error(`[fruitback] GitHub did not say whether a repository is private: ${error.message}`);

    return undefined;
  }
}

const ID = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * The destination a body asks for, for a connector of this kind.
 *
 * A tracker has teams, so a team is required. An address that only receives has none, and a team
 * given for one is refused: it would be kept and mean nothing. A `github` connector takes a
 * `repository`, `owner/name`, and no team and no project (FRU-359). The destination keeps the
 * repository as its `teamId`.
 */
function destinationOf(body: Record<string, unknown> | undefined, kind: ConnectorKind): Destination | undefined {
  const { connector, teamId, projectId } = body ?? {};
  if (typeof connector !== 'string' || !ID.test(connector)) return undefined;
  // `null` is « none », as the route takes it for the project of a tracker.
  if (kind === 'rest')
    return (teamId ?? undefined) === undefined && (projectId ?? undefined) === undefined ? { connector } : undefined;
  if (kind === 'github') {
    const repository = readGithubRepository(body?.repository);
    if (repository === undefined || teamId !== undefined || projectId !== undefined) return undefined;

    return { connector, teamId: repository };
  }
  if (typeof teamId !== 'string' || !ID.test(teamId)) return undefined;
  if (projectId !== undefined && projectId !== null && (typeof projectId !== 'string' || !ID.test(projectId))) {
    return undefined;
  }

  return { connector, teamId, ...(typeof projectId === 'string' ? { projectId } : {}) };
}

const WORKSPACE_PATH = /^\/console\/workspaces\/([A-Za-z0-9_-]+)(\/.*)?$/;

/**
 * The address of the logo of a workspace (FRU-428), from the worker: what `logo` of the contract
 * says. `updatedAt` is its version, so a new logo is a new address.
 */
export function logoPath(workspace: string, updatedAt: number): string {
  return `/console/workspaces/${encodeURIComponent(workspace)}/logo?v=${updatedAt}`;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Who calls: the person of the cookie of a session of better-auth (FRU-147). Since FRU-150 it is the
 * one way: a token in `Authorization` names nobody on these routes.
 *
 * **A call that changes something must come from the console**: its `Origin`, and not a request with
 * none. The browser sends the cookie with a request of any page of the same site as the worker
 * (`demo.fruitback.com` is one), whatever `SameSite` says. `consoleCors` refuses another origin
 * before this; a request with no `Origin` reaches this line, and is refused here.
 *
 * **The account is read at each call**, and a suspended one is refused (FRU-281) as an account that
 * is gone. `sessionOfCookie` refuses its cookie first: this is the second lock, for a cookie that
 * another function reads.
 */
async function callerOf(
  request: Request,
  context: ConsoleApiContext,
): Promise<{ ok: true; account: Account } | { ok: false; status: number; body: Record<string, string> }> {
  const subject = context.cookieSession === undefined ? undefined : await context.cookieSession(request);
  if (subject === undefined) return { ok: false, status: 401, body: { error: 'identity-required' } };
  const origin = context.consoleUrl === undefined ? undefined : new URL(context.consoleUrl).origin;
  if (!SAFE_METHODS.has(request.method) && (origin === undefined || request.headers.get('Origin') !== origin)) {
    return { ok: false, status: 403, body: { error: 'origin-not-allowed' } };
  }
  const account = await context.accounts.account(subject);
  if (account === undefined || account.suspended === true) {
    return { ok: false, status: 401, body: { error: 'identity-required', reason: 'no-account' } };
  }

  return { ok: true, account };
}

/**
 * The account of the cookie when it is the administrator of the instance (FRU-261), or `undefined`.
 * The role is read in the database at this call: an account whose role was taken away a second ago
 * is refused at once, with its session still open.
 */
export async function instanceAdminOf(request: Request, context: ConsoleApiContext): Promise<Account | undefined> {
  const identified = await callerOf(request, context);
  if (!identified.ok) return undefined;
  const { account } = identified;

  return (await context.accounts.isInstanceAdmin(account.id)) ? account : undefined;
}

/**
 * The console's routes under `/console/`, except the session ones, or `undefined` for a path that is
 * not one of them.
 */
export async function handleConsoleApi(
  request: Request,
  pathname: string,
  context: ConsoleApiContext,
  headers: Record<string, string>,
): Promise<Response | undefined> {
  // The administrator of the instance (FRU-261): its guard runs before anything else of the path.
  if (isAdminPath(pathname)) {
    return handleInstanceAdmin(
      request,
      pathname,
      {
        admin: () => instanceAdminOf(request, context),
        endSessionsOf: (account, now) => context.sessions.endSessionsOf({ subject: account }, now),
        // As the deletion by its owner, below: Linear revokes its tokens, and its extensions stop (FRU-284).
        afterDeletion: {
          revoke: (sealed) => revokeLinear(sealed, context.secretsKey),
          endWorkspaceSessions: (workspace, now) => context.sessions.endSessionsOf({ workspace }, now),
        },
        ...(context.instance?.reads === undefined ? {} : { reads: context.instance.reads }),
        ...(context.instance === undefined ? {} : { facts: context.instance.facts }),
        ...(context.instance?.latestRelease === undefined ? {} : { latestRelease: context.instance.latestRelease }),
        ...context.instance?.writes,
        ...(context.now === undefined ? {} : { now: context.now }),
      },
      headers,
    );
  }

  const isApi =
    pathname === '/console/me' ||
    pathname === '/console/me/locale' ||
    pathname === '/console/me/name' ||
    pathname === '/console/workspaces' ||
    WORKSPACE_PATH.test(pathname);
  if (!isApi) return undefined;

  const identified = await callerOf(request, context);
  if (!identified.ok) return json(identified.status, identified.body, headers);
  const { account } = identified;

  if (pathname === '/console/me') {
    if (request.method !== 'GET') return json(405, { error: 'method-not-allowed' }, headers);
    const [memberships, instanceAdmin] = await Promise.all([
      context.accounts.memberships(account.id),
      context.accounts.isInstanceAdmin(account.id),
    ]);

    return json(
      200,
      {
        account,
        instanceAdmin,
        // FRU-282: each workspace says whether it is suspended, and since when, for the banner.
        // Not why (FRU-328): the reason is a note of the administrator of the instance.
        // FRU-428: the address of its logo, or `null`.
        workspaces: memberships.map(({ workspace, role, suspension, logoAt }) => ({
          ...workspace,
          role,
          logo: logoAt === undefined ? null : logoPath(workspace.id, logoAt),
          ...memberSuspensionView(suspension),
        })),
      },
      headers,
    );
  }

  // The language the person reads (FRU-119). Their own account only: the subject of the token.
  if (pathname === '/console/me/locale') {
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
    const body = await readJsonObject(request);
    const locale = body?.locale === null ? undefined : readLocaleTag(body?.locale);
    if (body?.locale !== null && locale === undefined) return json(400, { error: 'invalid-locale' }, headers);
    await context.accounts.setLocale(account.id, locale);

    return json(200, { account: { ...account, locale } }, headers);
  }

  // The name on the notes of the person (FRU-249). Their own account only. The notes already sent
  // keep the name they were sent with; their extensions sign the new one from their next access token.
  if (pathname === '/console/me/name') {
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
    const name = readPersonName((await readJsonObject(request))?.name);
    if (name === undefined) return json(400, { error: 'invalid-name' }, headers);
    await context.accounts.setName(account.id, name);
    await context.sessions.renameSessionsOf(account.id, name, context.now ?? Date.now());

    return json(200, { account: { ...account, name } }, headers);
  }

  if (pathname === '/console/workspaces') {
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
    const name = workspaceName((await readJsonObject(request))?.name);
    if (name === undefined) return json(400, { error: 'invalid-name' }, headers);
    // By the organization plugin (FRU-149): its hooks see the workspace and its first member.
    const workspace =
      context.createWorkspace === undefined
        ? await context.accounts.createWorkspace(name, account.id)
        : await context.createWorkspace(request, name);

    return json(201, { ...workspace, role: 'owner', logo: null }, headers);
  }

  const [, workspaceId, rest = ''] = WORKSPACE_PATH.exec(pathname) as RegExpExecArray;
  const role = await context.accounts.role(workspaceId as string, account.id);
  // Not a member answers like a workspace that does not exist: a caller must not learn which ids are real.
  if (role === undefined) return json(404, { error: 'not-found' }, headers);
  const allowed = (action: Action): boolean => can(role, action);
  const forbidden = (): Response => json(403, { error: 'forbidden', role }, headers);
  // A member who calls the console in their workspace is seen there today (FRU-249).
  await seen(context.accounts, workspaceId as string, account.id);

  // The one guard of the writes of a suspended workspace (FRU-282), before every route below.
  if (!SAFE_METHODS.has(request.method)) {
    const refused = await refusedWhileSuspended(
      context.accounts,
      workspaceId as string,
      { method: request.method, rest },
      headers,
    );
    if (refused !== undefined) return refused;
  }

  // FRU-428: the logo of the workspace. Every member reads it, who manages the workspace changes it.
  if (rest === '/logo') {
    return handleLogo(request, {
      accounts: context.accounts,
      workspace: workspaceId as string,
      manages: allowed('manage-workspace'),
      forbidden,
      addressAt: (at) => logoPath(workspaceId as string, at),
      headers,
      now: context.now ?? Date.now(),
    });
  }

  // FRU-461: the agent keys of the workspace, for who manages it.
  const agentKeys = await handleAgentKeys(rest, request, {
    accounts: context.accounts,
    workspace: workspaceId as string,
    account: account.id,
    manages: allowed('manage-workspace'),
    forbidden,
    readBody: readJsonObject,
    json,
    headers,
    now: context.now ?? Date.now(),
  });
  if (agentKeys !== undefined) return agentKeys;

  // FRU-468: the trigger of a site that starts an agent, for who manages the workspace.
  const agentTrigger = await handleAgentTrigger(rest, request, {
    accounts: context.accounts,
    workspace: workspaceId as string,
    manages: allowed('manage-workspace'),
    forbidden,
    readBody: readJsonObject,
    json,
    headers,
    now: context.now ?? Date.now(),
  });
  if (agentTrigger !== undefined) return agentTrigger;

  // « Last seen » of the members (FRU-249): the day of each, for an owner or an admin only.
  if (rest === '/members/seen') {
    if (request.method !== 'GET') return json(405, { error: 'method-not-allowed' }, headers);
    if (!allowed('manage-members')) return forbidden();

    return json(200, { seen: await context.accounts.lastSeen(workspaceId as string) }, headers);
  }

  // The reads of an administrator of the instance in this workspace (FRU-261), and their actions on
  // its members (FRU-281): its owners read them.
  if (rest === '/admin-reads') {
    if (request.method !== 'GET') return json(405, { error: 'method-not-allowed' }, headers);
    if (role !== 'owner') return forbidden();
    const reads = context.instance?.reads;
    if (reads === undefined) return json(404, { error: 'not-found' }, headers);
    const [traced, actions] = await Promise.all([
      reads.reads(workspaceId as string),
      reads.actionsIn(workspaceId as string),
    ]);

    return json(200, { reads: traced, actions }, headers);
  }

  // The notes of the workspace, and « Send again » (FRU-244): `console-notes.ts`.
  const notes = await handleNotes(rest, request, {
    workspace: workspaceId as string,
    account: account.id,
    // The sites a guest reads (FRU-250), read only for a route of the notes.
    reach: () => context.accounts.reach(workspaceId as string, account.id),
    allowed,
    noteIndex: context.noteIndex,
    accounts: context.accounts,
    kv: context.kv,
    now: context.now ?? Date.now(),
    headers,
  });
  if (notes !== undefined) return notes;

  /**
   * Sites as the console reads them, each with its notes and, for whoever sees the tracker, what did
   * not arrive (FRU-237). The index reads the notes of these sites only (FRU-497). An index that does
   * not answer costs the counts, never the sites.
   */
  const sitesWithNotes = async (sites: readonly Site[], options: { counts?: boolean; every?: boolean } = {}) => {
    const { counts = true, every = false } = options;
    const seesTracker = allowed('see-tracker');
    // Every site of the workspace: the index counts them all with no list, which is faster than a list
    // of hundreds of ids (measured on the bench, FRU-497). Otherwise only the sites of the answer.
    const ids = every ? undefined : sites.map((site) => site.id);
    const [notes, undelivered] =
      counts && sites.length > 0
        ? await Promise.all([
            counted(() => context.noteIndex?.summary(workspaceId as string, ids)),
            seesTracker ? counted(() => context.noteIndex?.undelivered(workspaceId as string, ids)) : undefined,
          ])
        : [undefined, undefined];

    return sites.map((site) => ({
      ...siteView(site, seesTracker),
      ...(notes === undefined ? {} : (notes.get(site.id) ?? noNotes())),
      ...(undelivered === undefined ? {} : { undelivered: undelivered.get(site.id) ?? 0 }),
    }));
  };

  // The sites to choose from (FRU-497): their id, address and visibility, by address, a page at a time.
  if (rest === '/sites/choices') {
    if (request.method !== 'GET') return json(405, { error: 'method-not-allowed' }, headers);
    if (!allowed('read-feedback')) return forbidden();
    const reach = await context.accounts.reach(workspaceId as string, account.id);
    if (reach === undefined) return json(404, { error: 'not-found' }, headers);
    const asked = readSiteChoices(new URL(request.url).searchParams);
    if (!asked.ok) return json(400, { error: asked.error }, headers);

    return json(200, await siteChoicesPage(context.accounts, workspaceId as string, reach, asked.query), headers);
  }

  if (rest === '/sites') {
    if (request.method === 'GET') {
      if (!allowed('read-feedback')) return forbidden();

      // A guest reads the sites shared with them and no other (FRU-250), and the counts of those.
      const reach = await context.accounts.reach(workspaceId as string, account.id);
      if (reach === undefined) return json(404, { error: 'not-found' }, headers);
      const params = new URL(request.url).searchParams;
      // `counts=none`: the sites and their destinations, and no read of the notes (FRU-497).
      const counts = params.get('counts') !== 'none';
      // FRU-497: one page of the grid, and the notes of its sites only.
      const page = readSitePage(params);
      if (page?.ok === false) return json(400, { error: page.error }, headers);
      if (page !== undefined) {
        const { sites, total } = await context.accounts.sitePage(workspaceId as string, {
          ...page.query,
          ...onlyOf(reach),
        });

        return json(200, { sites: await sitesWithNotes(sites, { counts }), total }, headers);
      }
      const sites = readableSites(await context.accounts.sites(workspaceId as string), reach);

      return json(200, { sites: await sitesWithNotes(sites, { counts, every: reach.sites === 'every' }) }, headers);
    }
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
    if (!allowed('manage-sites')) return forbidden();

    const body = await readJsonObject(request);
    const origin = typeof body?.url === 'string' ? siteOrigin(body.url) : undefined;
    if (origin === undefined) return json(400, { error: 'invalid-url' }, headers);
    const visibility = visibilityOf(body?.visibility ?? 'members');
    if (visibility === undefined) return json(400, { error: 'invalid-visibility' }, headers);
    // FRU-330: absent, a new site is « Members only » and a site that exists keeps what it had.
    const writers = body?.writers === undefined ? undefined : writersOf(body.writers);
    if (body?.writers !== undefined && writers === undefined) return json(400, { error: 'invalid-writers' }, headers);

    const site = await context.accounts.addSite(workspaceId as string, {
      origin,
      visibility,
      ...(writers === undefined ? {} : { writers }),
    });

    // A new site, as the list answers it (FRU-237): no note yet, and nothing waiting.
    return json(
      201,
      {
        ...siteView(site, allowed('see-tracker')),
        ...(context.noteIndex === undefined ? {} : noNotes()),
        ...(context.noteIndex !== undefined && allowed('see-tracker') ? { undelivered: 0 } : {}),
      },
      headers,
    );
  }

  const removal = /^\/sites\/([A-Za-z0-9_-]+)$/.exec(rest);
  // One site, for its page (FRU-497): what the list says of it, and the notes of this site only.
  if (removal !== null && request.method === 'GET') {
    if (!allowed('read-feedback')) return forbidden();
    const reach = await context.accounts.reach(workspaceId as string, account.id);
    if (reach === undefined) return json(404, { error: 'not-found' }, headers);
    const site = await readableSite(context.accounts, workspaceId as string, reach, removal[1] as string);
    if (site === undefined) return json(404, { error: 'not-found' }, headers);
    const [one] = await sitesWithNotes([site]);

    return json(200, one, headers);
  }
  if (removal !== null) {
    if (request.method !== 'DELETE') return json(405, { error: 'method-not-allowed' }, headers);
    if (!allowed('manage-sites')) return forbidden();

    const removed = await context.accounts.removeSite(workspaceId as string, removal[1] as string);

    return removed ? new Response(null, { status: 204, headers }) : json(404, { error: 'not-found' }, headers);
  }

  // Where the notes of a site go (FRU-121): a connector of this workspace, or the worker's own store.
  const destination = /^\/sites\/([A-Za-z0-9_-]+)\/destination$/.exec(rest);
  if (destination !== null) {
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
    if (!allowed('manage-sites')) return forbidden();
    // This route writes a list of one place, or of none. A site with two places or more is set by
    // the list route only: a console of before FRU-123 must not take the other places away.
    const current = await context.accounts.site(workspaceId as string, destination[1] as string);
    if (current !== undefined && current.destinations.length > 1) {
      return json(409, { error: 'site-has-destinations', count: current.destinations.length }, headers);
    }

    const body = await readJsonObject(request);
    // The kind of the connector says what a destination holds. A connector of another workspace
    // answers like one that does not exist.
    const named = typeof body?.connector === 'string' ? await context.accounts.sealedKey(body.connector) : undefined;
    if (typeof body?.connector === 'string' && ID.test(body.connector) && named?.workspaceId !== workspaceId) {
      return json(404, { error: 'not-found' }, headers);
    }
    const wanted = body?.connector === null || named === undefined ? undefined : destinationOf(body, named.kind);
    if (body?.connector !== null && wanted === undefined) return json(400, { error: 'invalid-destination' }, headers);
    // This route sets the one destination of a site, as before FRU-123. The label is written when
    // the tracker answers. A tracker that does not answer does not stop the change: the place is
    // then shown with the name of its source only.
    let kept = wanted;
    if (wanted !== undefined) {
      try {
        [kept] = await labelled(context, workspaceId as string, [wanted]);
      } catch (error) {
        if (!(error instanceof StoreError) && !(error instanceof UnknownPlace)) throw error;
      }
    }
    const set = await context.accounts.setDestination(workspaceId as string, destination[1] as string, kept);

    return set ? json(200, { destination: wanted ?? null }, headers) : json(404, { error: 'not-found' }, headers);
  }

  // Every place a site can send to, in order (FRU-123): the first one is where a note goes when
  // nobody chose, and a member chooses among the others in the widget.
  const places = /^\/sites\/([A-Za-z0-9_-]+)\/destinations$/.exec(rest);
  if (places !== null) {
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
    if (!allowed('manage-sites')) return forbidden();

    const body = await readJsonObject(request);
    const asked = body?.destinations;
    if (!Array.isArray(asked) || asked.length > MAX_DESTINATIONS) {
      return json(400, { error: 'invalid-destinations', max: MAX_DESTINATIONS }, headers);
    }
    const wanted: Destination[] = [];
    for (const each of asked as unknown[]) {
      const entry = typeof each === 'object' && each !== null ? (each as Record<string, unknown>) : undefined;
      const named =
        typeof entry?.connector === 'string' ? await context.accounts.sealedKey(entry.connector) : undefined;
      // A connector of another workspace answers like one that does not exist.
      if (named === undefined || named.workspaceId !== workspaceId) return json(404, { error: 'not-found' }, headers);
      const one = destinationOf(entry, named.kind);
      if (one === undefined) return json(400, { error: 'invalid-destination' }, headers);
      wanted.push(one);
    }
    // The same place twice is one choice with two names: it is refused, not folded.
    const names = wanted.map((one) => destinationId(places[1] as string, one));
    if (new Set(names).size !== names.length) return json(400, { error: 'duplicate-destination' }, headers);

    let kept: Destination[];
    try {
      kept = await labelled(context, workspaceId as string, wanted);
    } catch (error) {
      if (error instanceof UnknownPlace) return json(400, { error: 'invalid-destination' }, headers);
      throw error;
    }
    const set = await context.accounts.setDestinations(workspaceId as string, places[1] as string, kept);

    return set ? json(200, { destinations: kept }, headers) : json(404, { error: 'not-found' }, headers);
  }

  // The statuses of a site (FRU-366): read, add or change, order, remove. `manage-sites`, the role
  // that already chooses where the notes of a site go. docs/decisions/statuses.md is the model.
  const statusPath =
    /^\/sites\/([A-Za-z0-9_-]+)\/statuses(?:\/(order|tracker|settings)|\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_:-]{1,64}))?$/.exec(
      rest,
    );
  if (statusPath !== null) {
    if (!allowed('manage-sites')) return forbidden();
    const site = statusPath[1] as string;
    const notFound = () => json(404, { error: 'not-found' }, headers);

    // GET and POST on the list: every status of the site, or one status added or changed. POST, as
    // every write of the console: its CORS allows GET, POST and DELETE (console-cors.ts).
    if (statusPath[2] === undefined && statusPath[3] === undefined) {
      if (request.method === 'GET') {
        const [listed, held] = await Promise.all([
          context.accounts.siteStatuses(workspaceId as string, site),
          context.accounts.siteStatusNotes(workspaceId as string, site),
        ]);
        if (listed === undefined || held === undefined) return notFound();
        // FRU-386: the notes in each status of the worker's store, 0 included, so the console shows
        // them and asks where they go before a delete. A state of a tracker has its notes there.
        const own = [...NOTE_STAGES, ...listed.filter((row) => row.source === OWN_SOURCE).map((row) => row.key)];
        const notes = Object.fromEntries(own.map((key) => [key, held[key] ?? 0]));

        return json(200, { statuses: listed, notes }, headers);
      }
      if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
      const body = await readJsonObject(request);
      const read = readSiteStatus(body === undefined ? undefined : { ...body, origin: 'tracker' });
      if (!read.ok) return json(400, { error: 'invalid-status', refusal: read.refusal }, headers);
      const status = { ...read.status, origin: originOf(read.status.source, read.status.key) };
      // A built-in status is the status of its stage: the notes with no status of their own are in it.
      if (isBuiltIn(status.source, status.key) && status.stage !== status.key) {
        return json(400, { error: 'invalid-status', refusal: 'built-in-stage' }, headers);
      }
      // A status comes from the worker's store or from a connector this site sends to: a state of
      // another tracker is a state that no note of this site can be in.
      const current = await context.accounts.site(workspaceId as string, site);
      if (current === undefined) return notFound();
      if (status.source !== OWN_SOURCE && !current.destinations.some((place) => place.connector === status.source)) {
        return json(400, { error: 'invalid-status', refusal: 'unknown-source' }, headers);
      }
      const saved = await context.accounts.putSiteStatus(workspaceId as string, site, status);
      if (!saved.saved && saved.reason === 'not-found') return notFound();
      if (!saved.saved) return json(409, { error: 'too-many-statuses', max: MAX_STATUSES }, headers);
      // The notes it moved changed stage: their pages read again (balanced review of #487).
      if (context.kv !== undefined) await invalidatePages(context.kv, saved.pages);

      return json(200, { status }, headers);
    }

    // FRU-368: GET …/statuses/tracker, the states of each Linear team the site sends to (FRU-369: and of
    // each GitHub connector, once), read now, each
    // with the stage its connector gives it (its type, or an exception of FRU-102), and its colour at
    // Linear; and the switch of the site. A team that did not answer says so, the others are listed.
    // What is read is kept for the read of the pins (`rememberTrackerStates`): opening the page is
    // what shows a change made at Linear at once.
    if (statusPath[2] === 'tracker') {
      if (request.method !== 'GET') return json(405, { error: 'method-not-allowed' }, headers);
      const current = await context.accounts.site(workspaceId as string, site);
      const trackerColours = await context.accounts.siteTrackerColours(workspaceId as string, site);
      if (current === undefined || trackerColours === undefined) return notFound();
      const trackers = [];
      const githubListed = new Set<string>();
      for (const place of current.destinations) {
        const kept = await context.accounts.sealedKey(place.connector);
        if (kept === undefined || kept.workspaceId !== workspaceId) continue;
        // FRU-369: a GitHub connector has the four states of GITHUB_STATES, whatever its repository, so
        // it is one list per connector, never one per repository (heavy review of pull request 495). Its
        // name is the connector's: two repositories of it share the list. Nothing is asked of GitHub.
        if (kept.kind === 'github') {
          if (githubListed.has(place.connector)) continue;
          githubListed.add(place.connector);
          const connector = (await context.accounts.connectors(workspaceId as string)).find(
            (each) => each.id === place.connector,
          );
          trackers.push({
            connector: place.connector,
            label: `${KIND_NAMES.github} · ${connector?.label ?? place.connector}`,
            // No exception of FRU-102 here: its ids are those of Linear, and a site re-stages a status
            // of GitHub in its own rows (`siteStages`), as the ticket asks.
            states: [...GITHUB_STATES],
          });
          continue;
        }
        if (kept.kind !== 'linear') continue;
        // The team says which of two places of one connector a list is (lite review of pull request 495).
        const named = {
          connector: place.connector,
          ...(place.teamId === undefined ? {} : { teamId: place.teamId }),
          ...(place.label === undefined ? {} : { label: place.label }),
        };
        if (context.secretsKey === undefined || place.teamId === undefined) {
          trackers.push({ ...named, error: 'tracker-unreachable' });
          continue;
        }
        const team = place.teamId;
        try {
          const read = await askLinear(context, place.connector, kept.sealed, (authorization) =>
            listLinearStates(authorization, [team]),
          );
          const states = read.map((state) => ({
            id: state.id,
            name: state.name,
            type: state.type,
            stage: Object.hasOwn(kept.settings.stages, state.id)
              ? (kept.settings.stages[state.id] as NoteStage)
              : state.stage,
            ...(state.color === undefined ? {} : { color: state.color }),
          }));
          // What is kept is Linear's alone, the stage of each type: the read applies the exceptions.
          await rememberTrackerStates(
            context.kv,
            place.connector,
            team,
            read.map((state) => ({
              id: state.id,
              name: state.name,
              stage: state.stage,
              ...(state.color === undefined ? {} : { color: state.color }),
            })),
          );
          trackers.push({ ...named, states });
        } catch (error) {
          if (
            !(error instanceof StoreError || error instanceof LinearKeyRefused || error instanceof LinearKeyForbidden)
          )
            throw error;
          trackers.push({ ...named, error: 'tracker-unreachable' });
        }
      }

      return json(200, { trackerColours, trackers }, headers);
    }

    // FRU-368: POST …/statuses/settings, `{ trackerColours }`: the switch of the site.
    if (statusPath[2] === 'settings') {
      if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
      const asked = (await readJsonObject(request))?.trackerColours;
      if (typeof asked !== 'boolean') return json(400, { error: 'invalid-settings' }, headers);
      const set = await context.accounts.setSiteTrackerColours(workspaceId as string, site, asked);

      return set ? json(200, { trackerColours: asked }, headers) : notFound();
    }

    // POST …/statuses/order: each status named takes its place in the list.
    if (statusPath[2] === 'order') {
      if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
      const asked = (await readJsonObject(request))?.order;
      const order = Array.isArray(asked) && asked.length <= MAX_STATUSES ? statusIdsOf(asked) : undefined;
      if (order === undefined) return json(400, { error: 'invalid-order', max: MAX_STATUSES }, headers);
      const ordered = await context.accounts.orderSiteStatuses(workspaceId as string, site, order);
      if (ordered === 'not-found') return notFound();
      if (ordered === 'unknown-status') return json(400, { error: 'unknown-status' }, headers);

      return json(200, { order }, headers);
    }

    // DELETE …/statuses/<source>/<key>?moveTo=<key>: the notes in it go to `moveTo` first.
    if (request.method !== 'DELETE') return json(405, { error: 'method-not-allowed' }, headers);
    // An empty `moveTo`, as a form with nothing chosen sends it, is no `moveTo` (balanced review of #487).
    const moveTo = new URL(request.url).searchParams.get('moveTo') || undefined;
    const removed = await context.accounts.removeSiteStatus(
      workspaceId as string,
      site,
      { source: statusPath[3] as string, key: statusPath[4] as string },
      moveTo,
    );
    if (removed.removed) {
      // The notes it moved changed status and stage: their pages read again (balanced review of #487).
      if (context.kv !== undefined) await invalidatePages(context.kv, removed.pages);

      return json(200, { moved: removed.moved }, headers);
    }
    if (removed.reason === 'in-use') return json(409, { error: 'status-in-use', notes: removed.notes }, headers);
    if (removed.reason === 'invalid-target') return json(400, { error: 'invalid-target' }, headers);

    return notFound();
  }

  // The domains a workspace proves it owns, to cover the previews of a site (FRU-103). An admin's
  // business, like the sites: a domain is what lends a session to every page under it.
  if (rest === '/domains' || rest.startsWith('/domains/')) {
    if (!allowed('manage-sites')) return forbidden();
    return domainRoute(request, rest, workspaceId as string, context, headers);
  }

  // The connectors of the workspace (FRU-507): `console-connectors.ts`.
  const connectors = await handleConnectors(rest, request, {
    context,
    workspaceId: workspaceId as string,
    account,
    allowed,
    forbidden,
    headers,
  });
  if (connectors !== undefined) return connectors;

  if (rest === '/connect') {
    // The console of the Cloud opens `/connect` and asks for no code (FRU-313, FRU-325).
    if (!pairsByCode(context.publicUrl)) return json(404, { error: 'not-found' }, headers);
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
    if (!allowed('read-feedback')) return forbidden();

    // FRU-100: a code for this person, in this workspace. The console puts it after the `#` of the
    // worker's pairing page, and the extension reads it from there (FRU-92).
    const { code, expiresAt } = await createPairing(
      context.sessions,
      {
        subject: account.id,
        email: account.email,
        workspace: workspaceId as string,
        ...(account.name === undefined ? {} : { name: account.name }),
      },
      context.now,
    );

    return json(201, { code, expiresIn: PAIRING_TTL_SECONDS, expiresAt: new Date(expiresAt).toISOString() }, headers);
  }

  // FRU-236: the name of a workspace, changed by who manages it. The rule of the name is the one
  // of the creation. Nothing else of the workspace moves: its id, its sites, its members, and the
  // sessions of its extensions, which name the id.
  if (rest === '' && request.method === 'POST') {
    if (!allowed('manage-workspace')) return forbidden();
    const name = workspaceName((await readJsonObject(request))?.name);
    if (name === undefined) return json(400, { error: 'invalid-name' }, headers);
    if (context.renameWorkspace === undefined) return json(404, { error: 'not-found' }, headers);
    const renamed = await context.renameWorkspace(request, workspaceId as string, name);
    const logo = await context.accounts.logo(workspaceId as string);

    return json(
      200,
      { ...renamed, role, logo: logo === undefined ? null : logoPath(renamed.id, logo.updatedAt) },
      headers,
    );
  }

  if (rest === '') {
    if (request.method !== 'DELETE') return json(405, { error: 'method-not-allowed' }, headers);
    if (!allowed('delete-workspace')) return forbidden();
    // The tokens of its trackers are revoked at Linear first, as when one connector is removed
    // (FRU-149): once the rows are gone, nothing holds a token to revoke it with. What Linear answers
    // changes nothing.
    for (const connector of await context.accounts.connectors(workspaceId as string)) {
      if (connector.kind !== 'linear') continue;
      const leaving = await context.accounts.sealedKey(connector.id);
      if (leaving !== undefined) await revokeLinear(leaving.sealed, context.secretsKey);
    }
    await context.accounts.deleteWorkspace(workspaceId as string);
    // Nobody is a member of it any more: the extensions that were paired for it stop.
    await context.sessions.endSessionsOf({ workspace: workspaceId as string }, context.now ?? Date.now());

    return new Response(null, { status: 204, headers });
  }

  return json(404, { error: 'not-found' }, headers);
}

/**
 * `/domains` of a workspace (FRU-103): list, add, ask the DNS, name the site whose previews a
 * proven domain covers, remove.
 */
async function domainRoute(
  request: Request,
  rest: string,
  workspace: string,
  context: ConsoleApiContext,
  headers: Record<string, string>,
): Promise<Response> {
  const now = context.now ?? Date.now();
  const { accounts } = context;

  if (rest === '/domains') {
    if (request.method === 'GET') {
      return json(200, { domains: (await accounts.domains(workspace)).map((each) => domainView(each, now)) }, headers);
    }
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
    const domain = readDomain((await readJsonObject(request))?.domain);
    if (domain === undefined) return json(400, { error: 'invalid-domain' }, headers);
    const known = await accounts.domains(workspace);
    // Counted, then written: two calls of one admin at the same moment can both pass at 19, and leave
    // 21. The bound is the cost of the DNS for one workspace, not a wall between two: it is not held
    // in a transaction.
    if (!known.some((each) => each.domain === domain) && known.length >= MAX_DOMAINS) {
      return json(409, { error: 'too-many-domains', max: MAX_DOMAINS }, headers);
    }

    // Not asked here: the record is written after the console shows it.
    return json(201, domainView(await accounts.addDomain(workspace, domain, now), now), headers);
  }

  const match = /^\/domains\/([A-Za-z0-9_-]+)(\/check|\/previews)?$/.exec(rest);
  // A domain of another workspace answers like one that does not exist.
  const domain = match === null ? undefined : (await accounts.domains(workspace)).find((each) => each.id === match[1]);
  if (match === null || domain === undefined) return json(404, { error: 'not-found' }, headers);

  if (match[2] === undefined) {
    if (request.method !== 'DELETE') return json(405, { error: 'method-not-allowed' }, headers);
    await accounts.removeDomain(workspace, domain.id);

    return new Response(null, { status: 204, headers });
  }
  if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);

  if (match[2] === '/check') {
    if (domain.checkedAt !== undefined && now - domain.checkedAt < CHECK_AGAIN_MS) {
      return json(200, domainView(domain, now), headers);
    }
    const answer = await checkProof(context.resolveTxt ?? systemResolver, workspace, domain.domain);
    await accounts.noteDomainCheck(domain.id, answer, now);
    // The same line as the timer writes, when this click is the check that finds the proof ended.
    sayLoss(domain, answer, now);
    const checked = (await accounts.domains(workspace)).find((each) => each.id === domain.id);
    if (checked === undefined) return json(404, { error: 'not-found' }, headers);

    // `unknown`: the DNS did not answer, and the console says so rather than « not found ».
    return json(200, { ...domainView(checked, now), ...(answer === 'unknown' ? { unanswered: true } : {}) }, headers);
  }

  // The previews: a proven domain only. Taking them away is always allowed.
  const body = await readJsonObject(request);
  if (body?.site !== null && typeof body?.site !== 'string') return json(400, { error: 'invalid-site' }, headers);
  const site = body.site ?? undefined;
  if (site !== undefined && proofState(domain, now) !== 'proven') {
    return json(409, { error: 'domain-not-proven', state: proofState(domain, now) }, headers);
  }
  const set = await accounts.setPreviews(workspace, domain.id, site);
  if (!set) return json(404, { error: 'not-found' }, headers);

  return json(
    200,
    domainView({ ...domain, ...(site === undefined ? { previewsSite: undefined } : { previewsSite: site }) }, now),
    headers,
  );
}
