import { handleNotes } from './console-notes.ts';
import { type NoteIndex, noNotes } from './notes-index.ts';
import {
  type AccountStore,
  type Action,
  type Connector,
  type ConnectorAttention,
  type ConnectorKind,
  type ConnectorSettings,
  type Destination,
  type Domain,
  MAX_DESTINATIONS,
  MAX_DOMAINS,
  type Site,
  VISIBILITIES,
  type Workspace,
  type Visibility,
  can,
  destinationId,
  siteOrigin,
  readConnectorSettings,
  readLocaleTag,
  readPersonName,
} from './accounts.ts';
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
import { noteConnectorCall } from './connector-health.ts';
import { LinearKeyForbidden, LinearKeyRefused, listLinearStates, listLinearTeams } from './linear.ts';
import { isAcceptableSecret, newSecret, parseTargetUrl, sealTarget, targetLabel } from './rest-connector.ts';
import type { Kv } from './kv.ts';
import { type LinearOAuth, linearAuthorization, linearTicket, revokeLinear } from './linear-oauth.ts';
import { seal } from './secrets.ts';
import { StoreError } from './store.ts';
import { PAIRING_TTL_SECONDS, type SessionStore, createPairing } from './session.ts';

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

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

async function readBody(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await request.text());

    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** A workspace name is a label a person reads: one line, and short. */
const MAX_NAME = 80;

function workspaceName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.replace(/\s+/g, ' ').trim();

  return name === '' || name.length > MAX_NAME ? undefined : name;
}

function visibilityOf(value: unknown): Visibility | undefined {
  return (VISIBILITIES as readonly unknown[]).includes(value) ? (value as Visibility) : undefined;
}

/** The fields of a site the console shows, and the client id a script tag names. */
type SiteView = {
  id: string;
  origin: string;
  visibility: Visibility;
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
const KIND_NAMES: Record<ConnectorKind, string> = { linear: 'Linear', rest: 'REST API' };

/** The place does not exist in the tracker of the connector: nothing must be kept for it. */
class UnknownPlace extends Error {}

/**
 * A call to the Linear of a connector, with its stored key. What Linear answers is noted on the
 * connector, as for a note (FRU-102): a refusal makes it « Needs attention », and an answer ends it.
 */
async function askLinear<T>(
  context: ConsoleApiContext,
  connector: string,
  sealed: string,
  ask: (authorization: string) => Promise<T>,
): Promise<T> {
  const moment = context.now;
  const clock = moment === undefined ? undefined : () => moment;
  try {
    // A key goes as it is. A token of OAuth near its end is refreshed first.
    const authorization = await linearAuthorization(connector, sealed, {
      accounts: context.accounts,
      secretsKey: context.secretsKey,
      oauth: context.linearOAuth,
    });
    const answer = await ask(authorization);
    await noteConnectorCall(context.accounts, connector, undefined, clock);

    return answer;
  } catch (error) {
    await noteConnectorCall(context.accounts, connector, error, clock);
    throw error;
  }
}

/**
 * The destinations with the label a member reads when they choose one (FRU-123): « Linear · Design ».
 *
 * The worker writes the label from what the tracker answers, never from the request: a member
 * chooses by this word, so it must name the place the note goes to. A tracker is asked once for a
 * connector, and what it answers is noted on the connector. It throws `UnknownPlace` for a team or a
 * project the key does not reach.
 */
async function labelled(
  context: ConsoleApiContext,
  workspaceId: string,
  wanted: readonly Destination[],
): Promise<Destination[]> {
  const connectors = await context.accounts.connectors(workspaceId);
  const teamsOf = new Map<string, Awaited<ReturnType<typeof listLinearTeams>>['teams']>();
  const out: Destination[] = [];

  for (const destination of wanted) {
    const connector = connectors.find((each) => each.id === destination.connector);
    if (connector === undefined) throw new UnknownPlace();
    if (connector.kind === 'rest') {
      out.push({ ...destination, label: `${KIND_NAMES.rest} · ${connector.label}` });
      continue;
    }

    let teams = teamsOf.get(connector.id);
    if (teams === undefined) {
      const kept = await context.accounts.sealedKey(connector.id);
      if (kept === undefined) throw new UnknownPlace();
      teams = (await askLinear(context, connector.id, kept.sealed, listLinearTeams)).teams;
      teamsOf.set(connector.id, teams);
    }
    const team = teams.find((each) => each.id === destination.teamId);
    const project =
      destination.projectId === undefined
        ? undefined
        : team?.projects.find((each) => each.id === destination.projectId);
    if (team === undefined || (destination.projectId !== undefined && project === undefined)) throw new UnknownPlace();

    out.push({
      ...destination,
      label: [KIND_NAMES[connector.kind], team.name, ...(project === undefined ? [] : [project.name])].join(' · '),
    });
  }

  return out;
}

const CONNECTORS_UNAVAILABLE = { error: 'connectors-unavailable' } as const;

/** Whether a workspace can connect Linear with OAuth here: the application, a key to seal with, an address. */
function linearOAuthReady(context: ConsoleApiContext): boolean {
  return context.linearOAuth !== undefined && context.secretsKey !== undefined && context.publicUrl !== undefined;
}

function connectorView(connector: Connector): {
  id: string;
  kind: string;
  label: string;
  createdAt: string;
  attention?: ConnectorAttention;
  settings: ConnectorSettings;
} {
  return {
    id: connector.id,
    kind: connector.kind,
    label: connector.label,
    createdAt: connector.createdAt,
    settings: connector.settings,
    // Absent for a connector that works: the console draws « Needs attention » from this field only.
    ...(connector.attention === undefined ? {} : { attention: connector.attention }),
  };
}

const ID = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * The destination a body asks for, for a connector of this kind.
 *
 * A tracker has teams, so a team is required. An address that only receives has none, and a team
 * given for one is refused: it would be kept and mean nothing.
 */
function destinationOf(body: Record<string, unknown> | undefined, kind: ConnectorKind): Destination | undefined {
  const { connector, teamId, projectId } = body ?? {};
  if (typeof connector !== 'string' || !ID.test(connector)) return undefined;
  // `null` is « none », as the route takes it for the project of a tracker.
  if (kind === 'rest')
    return (teamId ?? undefined) === undefined && (projectId ?? undefined) === undefined ? { connector } : undefined;
  if (typeof teamId !== 'string' || !ID.test(teamId)) return undefined;
  if (projectId !== undefined && projectId !== null && (typeof projectId !== 'string' || !ID.test(projectId))) {
    return undefined;
  }

  return { connector, teamId, ...(typeof projectId === 'string' ? { projectId } : {}) };
}

const WORKSPACE_PATH = /^\/console\/workspaces\/([A-Za-z0-9_-]+)(\/.*)?$/;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Who calls: the person of the cookie of a session of better-auth (FRU-147). Since FRU-150 it is the
 * one way: a token in `Authorization` names nobody on these routes.
 *
 * **A call that changes something must come from the console**: its `Origin`, and not a request with
 * none. The browser sends the cookie with a request of any page of the same site as the worker
 * (`demo.fruitback.com` is one), whatever `SameSite` says. `consoleCors` refuses another origin
 * before this; a request with no `Origin` reaches this line, and is refused here.
 */
async function callerOf(
  request: Request,
  context: ConsoleApiContext,
): Promise<{ ok: true; subject: string } | { ok: false; status: number; body: Record<string, string> }> {
  const subject = context.cookieSession === undefined ? undefined : await context.cookieSession(request);
  if (subject === undefined) return { ok: false, status: 401, body: { error: 'identity-required' } };
  const origin = context.consoleUrl === undefined ? undefined : new URL(context.consoleUrl).origin;
  if (!SAFE_METHODS.has(request.method) && (origin === undefined || request.headers.get('Origin') !== origin)) {
    return { ok: false, status: 403, body: { error: 'origin-not-allowed' } };
  }

  return { ok: true, subject };
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
  const isApi =
    pathname === '/console/me' ||
    pathname === '/console/me/locale' ||
    pathname === '/console/me/name' ||
    pathname === '/console/workspaces' ||
    WORKSPACE_PATH.test(pathname);
  if (!isApi) return undefined;

  const identified = await callerOf(request, context);
  if (!identified.ok) return json(identified.status, identified.body, headers);
  const subject = identified.subject;
  const account = await context.accounts.account(subject);
  if (account === undefined) return json(401, { error: 'identity-required', reason: 'no-account' }, headers);

  if (pathname === '/console/me') {
    if (request.method !== 'GET') return json(405, { error: 'method-not-allowed' }, headers);
    const memberships = await context.accounts.memberships(account.id);

    return json(
      200,
      { account, workspaces: memberships.map(({ workspace, role }) => ({ ...workspace, role })) },
      headers,
    );
  }

  // The language the person reads (FRU-119). Their own account only: the subject of the token.
  if (pathname === '/console/me/locale') {
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
    const body = (await request.json().catch(() => undefined)) as { locale?: unknown } | undefined;
    const locale = body?.locale === null ? undefined : readLocaleTag(body?.locale);
    if (body?.locale !== null && locale === undefined) return json(400, { error: 'invalid-locale' }, headers);
    await context.accounts.setLocale(account.id, locale);

    return json(200, { account: { ...account, locale } }, headers);
  }

  // The name on the notes of the person (FRU-249). Their own account only. The notes already sent
  // keep the name they were sent with; their extensions sign the new one from their next access token.
  if (pathname === '/console/me/name') {
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
    const name = readPersonName((await readBody(request))?.name);
    if (name === undefined) return json(400, { error: 'invalid-name' }, headers);
    await context.accounts.setName(account.id, name);
    await context.sessions.renameSessionsOf(account.id, name, context.now ?? Date.now());

    return json(200, { account: { ...account, name } }, headers);
  }

  if (pathname === '/console/workspaces') {
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
    const name = workspaceName((await readBody(request))?.name);
    if (name === undefined) return json(400, { error: 'invalid-name' }, headers);
    // By the organization plugin (FRU-149): its hooks see the workspace and its first member.
    const workspace =
      context.createWorkspace === undefined
        ? await context.accounts.createWorkspace(name, account.id)
        : await context.createWorkspace(request, name);

    return json(201, { ...workspace, role: 'owner' }, headers);
  }

  const [, workspaceId, rest = ''] = WORKSPACE_PATH.exec(pathname) as RegExpExecArray;
  const role = await context.accounts.role(workspaceId as string, account.id);
  // Not a member answers like a workspace that does not exist: a caller must not learn which ids are real.
  if (role === undefined) return json(404, { error: 'not-found' }, headers);
  const allowed = (action: Action): boolean => can(role, action);
  const forbidden = (): Response => json(403, { error: 'forbidden', role }, headers);

  // The notes of the workspace, and « Send again » (FRU-244): `console-notes.ts`.
  const notes = await handleNotes(rest, request, {
    workspace: workspaceId as string,
    account: account.id,
    allowed,
    noteIndex: context.noteIndex,
    accounts: context.accounts,
    now: context.now ?? Date.now(),
    headers,
  });
  if (notes !== undefined) return notes;

  if (rest === '/sites') {
    if (request.method === 'GET') {
      if (!allowed('read-feedback')) return forbidden();

      const seesTracker = allowed('see-tracker');
      const sites = await context.accounts.sites(workspaceId as string);
      // FRU-237: the notes of each site, from the index. What did not arrive is about the tracker.
      // An index that does not answer costs the counts, never the list of the sites.
      const [notes, undelivered] = await Promise.all([
        counted(() => context.noteIndex?.summary(workspaceId as string)),
        seesTracker ? counted(() => context.noteIndex?.undelivered(workspaceId as string)) : undefined,
      ]);

      return json(
        200,
        {
          sites: sites.map((site) => ({
            ...siteView(site, seesTracker),
            ...(notes === undefined ? {} : (notes.get(site.id) ?? noNotes())),
            ...(undelivered === undefined ? {} : { undelivered: undelivered.get(site.id) ?? 0 }),
          })),
        },
        headers,
      );
    }
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
    if (!allowed('manage-sites')) return forbidden();

    const body = await readBody(request);
    const origin = typeof body?.url === 'string' ? siteOrigin(body.url) : undefined;
    if (origin === undefined) return json(400, { error: 'invalid-url' }, headers);
    const visibility = visibilityOf(body?.visibility ?? 'members');
    if (visibility === undefined) return json(400, { error: 'invalid-visibility' }, headers);

    const site = await context.accounts.addSite(workspaceId as string, { origin, visibility });

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
    const current = (await context.accounts.sites(workspaceId as string)).find((site) => site.id === destination[1]);
    if (current !== undefined && current.destinations.length > 1) {
      return json(409, { error: 'site-has-destinations', count: current.destinations.length }, headers);
    }

    const body = await readBody(request);
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

    const body = await readBody(request);
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

  // The domains a workspace proves it owns, to cover the previews of a site (FRU-103). An admin's
  // business, like the sites: a domain is what lends a session to every page under it.
  if (rest === '/domains' || rest.startsWith('/domains/')) {
    if (!allowed('manage-sites')) return forbidden();
    return domainRoute(request, rest, workspaceId as string, context, headers);
  }

  if (rest === '/connectors') {
    if (request.method === 'GET') {
      if (!allowed('see-tracker')) return forbidden();
      const connectors = await context.accounts.connectors(workspaceId as string);

      return json(
        200,
        {
          connectors: connectors.map(connectorView),
          available: context.secretsKey !== undefined,
          // The console offers « Connect with Linear » only where the worker can do it.
          linearOAuth: linearOAuthReady(context),
        },
        headers,
      );
    }
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
    if (!allowed('manage-workspace')) return forbidden();
    if (context.secretsKey === undefined) return json(404, CONNECTORS_UNAVAILABLE, headers);

    const body = await readBody(request);
    if (body?.kind === 'rest') {
      // FRU-122: an address that receives each note. Nothing is asked of it now: it is called when a
      // note is written, and the console shows a delivery that did not arrive.
      const url = parseTargetUrl(body.url);
      if (url === undefined) return json(400, { error: 'invalid-address' }, headers);
      const given = typeof body.secret === 'string' && body.secret !== '' ? body.secret : undefined;
      if (given !== undefined && !isAcceptableSecret(given)) return json(400, { error: 'invalid-secret' }, headers);
      const secret = given ?? newSecret();
      const connector = await context.accounts.addConnector(workspaceId as string, {
        kind: 'rest',
        label: targetLabel(url),
        sealed: sealTarget({ url, secret }, context.secretsKey),
      });

      // A secret the worker made is answered here, once. No route answers it again.
      return json(201, { ...connectorView(connector), ...(given === undefined ? { secret } : {}) }, headers);
    }
    const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
    if (body?.kind !== 'linear' || apiKey === '') return json(400, { error: 'invalid-connector' }, headers);

    // Asked before anything is kept: a key the tracker refuses is never stored.
    let viewer: string;
    try {
      viewer = (await listLinearTeams(apiKey)).viewer;
    } catch (error) {
      // Only a refusal of the key is the person's to fix. A Linear that is down answers `502`, and
      // the key is not kept either way.
      if (error instanceof LinearKeyRefused) return json(400, { error: 'key-refused' }, headers);
      if (error instanceof LinearKeyForbidden) return json(400, { error: 'key-lacks-access' }, headers);
      if (error instanceof StoreError) return json(502, { error: 'store-unavailable' }, headers);
      throw error;
    }
    const connector = await context.accounts.addConnector(workspaceId as string, {
      kind: 'linear',
      label: viewer === '' ? 'Linear' : `Linear · ${viewer}`,
      sealed: seal(apiKey, context.secretsKey),
    });

    return json(201, connectorView(connector), headers);
  }

  // FRU-134: where the browser goes to connect Linear with OAuth. The console sends it there.
  if (rest === '/connectors/linear/oauth') {
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
    if (!allowed('manage-workspace')) return forbidden();
    if (!linearOAuthReady(context) || context.kv === undefined || context.publicUrl === undefined) {
      return json(404, CONNECTORS_UNAVAILABLE, headers);
    }
    const url = await linearTicket(
      { kv: context.kv, publicUrl: context.publicUrl },
      { workspace: workspaceId as string, account: account.id },
    );

    return json(201, { url }, headers);
  }

  // The deliveries of a receiving connector that did not arrive, and a new attempt (FRU-122).
  const late = /^\/connectors\/([A-Za-z0-9_-]+)\/deliveries(?:\/([A-Za-z0-9_-]+)\/retry)?$/.exec(rest);
  if (late !== null) {
    const id = late[1] as string;
    if (late[2] === undefined) {
      if (request.method !== 'GET') return json(405, { error: 'method-not-allowed' }, headers);
      if (!allowed('see-tracker')) return forbidden();
      const kept = await context.accounts.sealedKey(id);
      if (kept === undefined || kept.workspaceId !== workspaceId) return json(404, { error: 'not-found' }, headers);

      return json(200, { deliveries: await context.accounts.deliveries(workspaceId as string, id) }, headers);
    }
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
    if (!allowed('manage-sites')) return forbidden();
    const due = await context.accounts.retryDelivery(workspaceId as string, id, late[2], context.now ?? Date.now());

    return due ? new Response(null, { status: 204, headers }) : json(404, { error: 'not-found' }, headers);
  }

  // What a workspace sets on a tracker (FRU-102): the replies, and the exceptions to the stages.
  const tuned = /^\/connectors\/([A-Za-z0-9_-]+)\/(settings|states)$/.exec(rest);
  if (tuned !== null) {
    const id = tuned[1] as string;
    const writes = tuned[2] === 'settings';
    if (request.method !== (writes ? 'POST' : 'GET')) return json(405, { error: 'method-not-allowed' }, headers);
    if (!allowed('manage-workspace')) return forbidden();
    const kept = await context.accounts.sealedKey(id);
    // A connector of another workspace answers like one that does not exist, and so does an address
    // that only receives: it has no replies and no states.
    if (kept === undefined || kept.workspaceId !== workspaceId || kept.kind !== 'linear') {
      return json(404, { error: 'not-found' }, headers);
    }

    if (writes) {
      const settings = readConnectorSettings(await readBody(request));
      if (settings === undefined) return json(400, { error: 'invalid-settings' }, headers);
      const set = await context.accounts.setConnectorSettings(workspaceId as string, id, settings);

      return set ? json(200, { settings }, headers) : json(404, { error: 'not-found' }, headers);
    }

    // The states of the teams the sites of this workspace send to through this connector: those are
    // the states a pin can have. A team nobody sends to is not asked.
    if (context.secretsKey === undefined) return json(404, CONNECTORS_UNAVAILABLE, headers);
    const teams = [
      ...new Set(
        (await context.accounts.sites(workspaceId as string)).flatMap((site) =>
          site.destinations.flatMap((place) =>
            place.connector === id && place.teamId !== undefined ? [place.teamId] : [],
          ),
        ),
      ),
    ];
    const states = await askLinear(context, id, kept.sealed, (authorization) => listLinearStates(authorization, teams));

    return json(200, { states, settings: kept.settings }, headers);
  }

  const connector = /^\/connectors\/([A-Za-z0-9_-]+)(\/teams)?$/.exec(rest);
  if (connector !== null) {
    const id = connector[1] as string;
    if (connector[2] === undefined) {
      if (request.method !== 'DELETE') return json(405, { error: 'method-not-allowed' }, headers);
      if (!allowed('manage-workspace')) return forbidden();
      // A token of OAuth is revoked at Linear before the connector goes. Linear's answer changes
      // nothing: the connector goes, and a token nobody holds ends in a day.
      const leaving = await context.accounts.sealedKey(id);
      const removed = await context.accounts.removeConnector(workspaceId as string, id);
      if (removed && leaving?.kind === 'linear' && leaving.workspaceId === workspaceId) {
        await revokeLinear(leaving.sealed, context.secretsKey);
      }

      return removed ? new Response(null, { status: 204, headers }) : json(404, { error: 'not-found' }, headers);
    }

    // The teams the key reaches, for the person who chooses a destination.
    if (request.method !== 'GET') return json(405, { error: 'method-not-allowed' }, headers);
    if (!allowed('manage-sites')) return forbidden();
    if (context.secretsKey === undefined) return json(404, CONNECTORS_UNAVAILABLE, headers);
    const kept = await context.accounts.sealedKey(id);
    // A connector of another workspace answers like one that does not exist.
    if (kept === undefined || kept.workspaceId !== workspaceId) return json(404, { error: 'not-found' }, headers);
    // An address that only receives has no team to choose.
    if (kept.kind !== 'linear') return json(404, { error: 'not-found' }, headers);
    // This read is a call to the tracker like a note is, so what Linear answers is noted too
    // (FRU-102): somebody who opens the panel of a connector that Linear refuses sees it at once.
    const { teams } = await askLinear(context, id, kept.sealed, listLinearTeams);

    return json(200, { teams }, headers);
  }

  if (rest === '/connect') {
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
    const name = workspaceName((await readBody(request))?.name);
    if (name === undefined) return json(400, { error: 'invalid-name' }, headers);
    if (context.renameWorkspace === undefined) return json(404, { error: 'not-found' }, headers);
    const renamed = await context.renameWorkspace(request, workspaceId as string, name);

    return json(200, { ...renamed, role }, headers);
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
    const domain = readDomain((await readBody(request))?.domain);
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
  const body = await readBody(request);
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
