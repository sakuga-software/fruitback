import { createHash } from 'node:crypto';
import { SEED_STAGES, type SeedStage } from '@fruitback/shared';
import type { ClientMap } from './clients.ts';

/**
 * People, teams and the sites a team reviews (FRU-96).
 *
 * Until here the worker knew clients, from its environment, and sessions, from a pairing code. With
 * `FRUITBACK_DATABASE_URL` it also knows who signed in, which workspaces they belong to, and which
 * sites each workspace reviews. The console writes those sites, and the worker reads them as its
 * client map: a site is a client whose workspace is its own.
 *
 * **The pairing code stays the only thing that opens a session.** Signing in by e-mail or by GitHub
 * ends with the worker minting a code for the account, in its workspace. Nothing here mints a token.
 */

/** An account is a person, known by an address a provider or a link proved they read. */
/** `locale` is the language the person reads: their e-mails are written in it (FRU-119). */
export type Account = { id: string; email: string; name?: string; locale?: string };

/**
 * A language tag as `Intl` writes it, or `undefined` for a value that is not one.
 *
 * The value comes from a browser. It is stored and later chooses the words of an e-mail, so it is
 * parsed here and never kept as typed.
 */
export function readLocaleTag(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 35) return undefined;
  try {
    return new Intl.Locale(value.trim()).toString();
  } catch {
    return undefined;
  }
}

export type Workspace = { id: string; name: string };

/**
 * The four roles of the design (board « My account »).
 *
 * - `owner`: everything, and the only one who can delete the workspace.
 * - `admin`: sites, sources and members.
 * - `member`: every site of the workspace, and the links to the tracker.
 * - `guest`: leaves and reads notes, never sees the tracker, and does not read who the members are
 *   (FRU-149). Sharing a site with one guest is FRU-104.
 */
export const ROLES = ['owner', 'admin', 'member', 'guest'] as const;
export type Role = (typeof ROLES)[number];

/** What a person can do in a workspace. Each one is a route of the console. */
export const ACTIONS = [
  'read-feedback',
  'see-tracker',
  'read-members',
  'manage-sites',
  'manage-members',
  'manage-workspace',
  'delete-workspace',
] as const;
export type Action = (typeof ACTIONS)[number];

const RIGHTS: Record<Role, readonly Action[]> = {
  owner: ACTIONS,
  admin: ['read-feedback', 'see-tracker', 'read-members', 'manage-sites', 'manage-members', 'manage-workspace'],
  member: ['read-feedback', 'see-tracker', 'read-members'],
  guest: ['read-feedback'],
};

/** Whether this role may do this. The one table, so a route cannot hold its own copy of the rule. */
export function can(role: Role, action: Action): boolean {
  return RIGHTS[role].includes(action);
}

/**
 * Who reads the notes of a site: the two words of the design (P2) in place of the three modes.
 *
 * `members` is `read: 'authenticated'`, with a session of the workspace. `everyone` is `public`.
 */
export const VISIBILITIES = ['members', 'everyone'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

/**
 * Where the notes of a site go: a connector of its workspace, and the place inside it. A tracker has
 * teams, so `teamId` is required for one. An address that only receives has none (FRU-122).
 */
export type Destination = {
  connector: string;
  teamId?: string;
  projectId?: string;
  /** How a member reads this place when they choose it (FRU-123): « Linear · Design ». */
  label?: string;
};

/**
 * How many places a site can send to (FRU-123). A read asks each one, so the number is the cost of
 * a page that opens: it stays small.
 */
export const MAX_DESTINATIONS = 5;

export type Site = {
  id: string;
  workspaceId: string;
  origin: string;
  visibility: Visibility;
  /**
   * Where the notes of this site can go, in the order an admin gave (FRU-123). The first one is
   * where a note goes when nobody chose. Empty: the notes stay in the worker's own store.
   */
  destinations: Destination[];
};

/**
 * A domain a workspace says it owns (FRU-103), and what the DNS said of it. `domain-proof.ts` says
 * what the proof is, and `proofState` reads the two instants.
 *
 * - `verifiedAt`: the last time the DNS showed the record. Absent: never.
 * - `lostAt`: the first time the DNS answered without it, after it had shown it. Absent: not lost.
 * - `checkedAt`: the last time the DNS was asked, whatever it said.
 * - `previewsSite`: the site whose previews are the subdomains of this domain. One site at most: a
 *   page under the domain must belong to one site. It says what an admin asked, and holds only
 *   while the proof does.
 */
export type Domain = {
  id: string;
  workspaceId: string;
  domain: string;
  createdAt: number;
  verifiedAt?: number;
  lostAt?: number;
  checkedAt?: number;
  previewsSite?: string;
};

/** How many domains a workspace can hold. Each one is a question to the DNS, again and again. */
export const MAX_DOMAINS = 20;

/**
 * The name of a destination outside the worker (FRU-123): the widget of a member holds it, and sends
 * it back to choose. It says nothing of the connector or of the team, whose ids stay in the worker.
 * It is the same for as long as the site sends to that place.
 */
export function destinationId(site: string, destination: Destination): string {
  const named = [site, destination.connector, destination.teamId ?? '', destination.projectId ?? ''].join('\n');

  return `dst_${createHash('sha256').update(named).digest('hex').slice(0, 20)}`;
}

/**
 * What a workspace can connect. `linear` is a tracker: the notes live there. `rest` is an address
 * that receives each note, while the notes stay in the worker (FRU-122).
 */
export const CONNECTOR_KINDS = ['linear', 'rest'] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

export type DueDelivery = { id: string; connectorId: string; body: string; attempts: number };

export type DeliveryOutcome =
  | { delivered: true }
  /** `attempts` is the count the attempt started from: see `settleDelivery`. */
  | { delivered: false; attempts: number; at: number; status?: number; error?: string; nextAt?: number };

/** A delivery as the console reads it. The body is not here: it holds a note. */
export type PendingDelivery = {
  id: string;
  createdAt: string;
  attempts: number;
  /** Absent: the worker gave up, and somebody must ask for a new attempt. */
  nextAt?: string;
  lastStatus?: number;
  lastError?: string;
};

/**
 * Why a connector cannot be used until somebody acts (FRU-102). Each one is a refusal of the tracker,
 * never a tracker that is down: an outage is nobody's fault, and it ends with nothing to do.
 *
 * - `key-refused`: the tracker does not accept the key or the token.
 * - `key-lacks-access`: the tracker knows the key, and the key may not do what the worker asks.
 * - `connection-ended`: the tracker refused to refresh the token of an OAuth connection.
 */
export const CONNECTOR_TROUBLES = ['key-refused', 'key-lacks-access', 'connection-ended'] as const;
export type ConnectorTrouble = (typeof CONNECTOR_TROUBLES)[number];

/** `since` is the first refusal of this kind, so the console says how long the notes did not leave. */
export type ConnectorAttention = { reason: ConnectorTrouble; since: string };

/**
 * What a workspace sets on a connector (FRU-102), in the panel of the connector.
 *
 * - `showComments`: the replies of the tracker come back to the widget as replies. It can only take
 *   them away: a worker that hides them everywhere (`FRUITBACK_HIDE_COMMENTS=1`) still hides them.
 * - `stages`: the exceptions to the projection by type, by **id** of the state of the tracker, never
 *   by its name. A state that is renamed keeps its colour. A state with no entry takes the stage of
 *   its type, as before.
 */
export type ConnectorSettings = { showComments: boolean; stages: Readonly<Record<string, SeedStage>> };

export const DEFAULT_CONNECTOR_SETTINGS: ConnectorSettings = { showComments: true, stages: {} };

/** A Linear team has some ten states. This bounds what one connector keeps, whatever a request sends. */
export const MAX_STAGE_EXCEPTIONS = 200;

/** An id of a state of a tracker, as a key of `stages`. */
const STATE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The settings of a connector from what a row or a request holds, or `undefined` for a value that is
 * not settings. Nothing is folded: a stage this build does not know, or one entry too many, refuses
 * the whole value.
 */
export function readConnectorSettings(value: unknown): ConnectorSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { showComments = true, stages = {} } = value as Record<string, unknown>;
  if (typeof showComments !== 'boolean') return undefined;
  if (typeof stages !== 'object' || stages === null || Array.isArray(stages)) return undefined;
  const entries = Object.entries(stages);
  if (entries.length > MAX_STAGE_EXCEPTIONS) return undefined;
  const kept: Record<string, SeedStage> = {};
  for (const [state, stage] of entries) {
    if (!STATE_ID.test(state) || !(SEED_STAGES as readonly unknown[]).includes(stage)) return undefined;
    kept[state] = stage as SeedStage;
  }

  return { showComments, stages: kept };
}

/**
 * A connector as the console reads it. The key is not here, and no route answers it.
 *
 * `attention` absent: the last call the tracker answered was not a refusal.
 */
export type Connector = {
  id: string;
  workspaceId: string;
  kind: ConnectorKind;
  label: string;
  createdAt: string;
  attention?: ConnectorAttention;
  settings: ConnectorSettings;
};

/** How a sign-in method names the person. `email` is the link, and its subject is the address. */
export const PROVIDERS = ['email', 'github', 'google', 'linear'] as const;
export type Provider = (typeof PROVIDERS)[number];

export type AccountStore = {
  /**
   * The account behind this sign-in, created on the first one.
   *
   * **Two providers that prove the same address are one account.** A provider that did not verify
   * the address must not call this: an unverified address would join the account of its owner.
   */
  signIn(login: {
    provider: Provider;
    subject: string;
    email: string;
    name?: string;
    /** Kept only for an account that has no language yet: a sign-in from another browser changes nothing. */
    locale?: string;
  }): Promise<Account>;
  account(id: string): Promise<Account | undefined>;
  /** The language the person chose. `undefined` removes the choice. */
  setLocale(account: string, locale: string | undefined): Promise<void>;
  /** The language of the account behind this address, if there is one and it has one. */
  localeOf(email: string): Promise<string | undefined>;
  createWorkspace(name: string, owner: string): Promise<Workspace>;
  /** Every workspace this account belongs to, with its role there, oldest first. */
  memberships(account: string): Promise<{ workspace: Workspace; role: Role }[]>;
  role(workspace: string, account: string): Promise<Role | undefined>;
  addSite(workspace: string, site: { origin: string; visibility: Visibility }): Promise<Site>;
  sites(workspace: string): Promise<Site[]>;
  removeSite(workspace: string, site: string): Promise<boolean>;
  /** `sealed` is the key as `secrets.ts` encrypts it: the store never sees the plain value. */
  addConnector(
    workspace: string,
    connector: { kind: ConnectorKind; label: string; sealed: string },
  ): Promise<Connector>;
  connectors(workspace: string): Promise<Connector[]>;
  /** Removes the connector. Its sites lose their destination, and their notes stay in the worker again. */
  removeConnector(workspace: string, connector: string): Promise<boolean>;
  /** Replaces what a connector keeps sealed: a refreshed token takes the place of the one it spent. */
  resealConnector(connector: string, sealed: string): Promise<void>;
  /**
   * What the tracker last said of a connector (FRU-102): a refusal, or `undefined` for a call it
   * answered. A refusal of the same kind keeps its first moment. A connector that is gone is ignored.
   */
  noteConnector(connector: string, trouble: ConnectorTrouble | undefined, now: number): Promise<void>;
  /**
   * What a workspace set on its connector (FRU-102). `false` when the connector is not of this
   * workspace, and then nothing changes.
   */
  setConnectorSettings(workspace: string, connector: string, settings: ConnectorSettings): Promise<boolean>;
  /** The encrypted key of a connector and its settings, for the worker's own calls. */
  sealedKey(
    connector: string,
  ): Promise<{ kind: ConnectorKind; sealed: string; workspaceId: string; settings: ConnectorSettings } | undefined>;
  /**
   * Where the notes of a site go. `false` when the site or the connector is not of this workspace:
   * a site must not write through the key of another team.
   */
  setDestination(workspace: string, site: string, destination: Destination | undefined): Promise<boolean>;
  /**
   * Every place a site can send to, in order (FRU-123). `false` when the site or one connector is
   * not of this workspace, and then nothing changes. The caller bounds the list.
   */
  setDestinations(workspace: string, site: string, destinations: readonly Destination[]): Promise<boolean>;
  /**
   * Keeps a note to send to the address of a connector (FRU-122). `body` is the request body, kept
   * as it is sent, so each attempt sends the same bytes.
   */
  enqueueDelivery(connector: string, body: string, now: number): Promise<string>;
  /** The deliveries to attempt now, oldest first. */
  dueDeliveries(now: number, limit: number): Promise<DueDelivery[]>;
  /**
   * What an attempt answered. A delivery that arrived is removed: its body holds a note, and nothing
   * reads it again. `nextAt` absent on a failure: no more attempt, and the console shows it. A failure
   * is written only while the count is the one the attempt started from: somebody who asked for a
   * new attempt in that time set it to zero, and their request must not be written over.
   */
  settleDelivery(id: string, outcome: DeliveryOutcome): Promise<void>;
  /** The deliveries of a connector that did not arrive yet, newest first. */
  deliveries(workspace: string, connector: string): Promise<PendingDelivery[]>;
  /**
   * Makes a delivery due now, with its whole series of attempts again. `false` when it is not of this
   * workspace and connector.
   */
  retryDelivery(workspace: string, connector: string, delivery: string, now: number): Promise<boolean>;
  /** Removes the deliveries that were given up before `before`. Answers how many. */
  dropAbandonedDeliveries(before: number): Promise<number>;
  /**
   * Keeps a domain for a workspace (FRU-103), not proven yet. The same domain twice is the same row,
   * as it stands. The caller gives the domain as `readDomain` wrote it, and bounds the count.
   */
  addDomain(workspace: string, domain: string, now: number): Promise<Domain>;
  /** The domains of a workspace, oldest first. */
  domains(workspace: string): Promise<Domain[]>;
  /** Removes a domain, and with it the previews it covered. `false` when it is not of this workspace. */
  removeDomain(workspace: string, domain: string): Promise<boolean>;
  /**
   * What the DNS answered for a domain. `found` sets `verifiedAt` and clears `lostAt`. `missing`
   * sets `lostAt` when the domain was proven and is not lost yet: the first moment stays. `unknown`
   * changes neither. Each one sets `checkedAt`. A domain that is gone is ignored.
   */
  noteDomainCheck(domain: string, answer: 'found' | 'missing' | 'unknown', now: number): Promise<void>;
  /**
   * The domains to ask the DNS again: the ones it showed once, and that were not asked since
   * `before`, longest ago first. A domain that was never proven is asked when somebody asks.
   */
  domainsToCheck(before: number, limit: number): Promise<Domain[]>;
  /**
   * Names the site whose previews a domain covers, or none. `false` when the domain or the site is
   * not of this workspace, and then nothing changes. A site that goes takes its previews with it.
   */
  setPreviews(workspace: string, domain: string, site: string | undefined): Promise<boolean>;
  /** Removes the workspace, its members and its sites. Notes already in a tracker stay there. */
  deleteWorkspace(workspace: string): Promise<void>;
  /** Every site, as the client map the routing reads. */
  clientMap(): Promise<ClientMap>;
};

/**
 * A site as a client of the routing (FRU-95): its workspace, its one origin, and who reads it.
 *
 * Exported because this projection is the whole contract between the accounts and the read path.
 */
export function clientOf(site: Site): ClientMap[string] {
  const places = site.destinations.map((destination) => ({
    id: destinationId(site.id, destination),
    connector: destination.connector,
    ...(destination.teamId === undefined ? {} : { teamId: destination.teamId }),
    ...(destination.projectId === undefined ? {} : { projectId: destination.projectId }),
    ...(destination.label === undefined ? {} : { label: destination.label }),
  }));
  const first = places[0];

  return {
    workspace: site.workspaceId,
    origins: [site.origin],
    read: site.visibility === 'members' ? 'authenticated' : 'public',
    // The first place is where the client routes, as when a site had one destination.
    ...(first === undefined
      ? {}
      : {
          connector: first.connector,
          ...(first.teamId === undefined ? {} : { teamId: first.teamId }),
          ...(first.projectId === undefined ? {} : { projectId: first.projectId }),
          destinations: places,
        }),
  };
}

/**
 * The origin of an address a person pasted, or `undefined` when it is not a site.
 *
 * The design says « adding a site is pasting its URL » (P3). A path or a query is what people paste,
 * and the origin is what the browser sends, so that is what is kept.
 */
export function siteOrigin(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    if (url.username !== '' || url.password !== '') return undefined;

    return url.origin;
  } catch {
    return undefined;
  }
}

/** An address as an account stores it: trimmed, lower case. A provider can answer either case. */
export function normalizeEmail(value: string): string | undefined {
  const email = value.trim().toLowerCase();

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : undefined;
}
