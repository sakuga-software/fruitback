import { createHash } from 'node:crypto';
import type { SiteStatus } from './site-statuses.ts';
import { NOTE_STAGES, type NoteStage } from '@fruitback/shared';
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
/** `suspended`: an administrator of the instance suspended the account (FRU-281). It acts nowhere. */
export type Account = { id: string; email: string; name?: string; locale?: string; suspended?: true };

/**
 * An address of an account beside its primary one (FRU-450). `providers`: the linked providers that
 * give it, verified. `verified`: Fruitback proved it itself.
 */
export type AccountAddress = { email: string; providers: string[]; verified: boolean; createdAt: number };

/** The longest name a person gives themself (FRU-249): the same bound as a workspace name. */
export const MAX_PERSON_NAME = 80;

/**
 * The name a person chose for their notes (FRU-249), or `undefined` for a value that is not one.
 *
 * One line: every run of white space, a separator of lines included, is one space, and the edges
 * go. No control character, no format character, no character of private use and none that is
 * unassigned: a direction mark or a character of no width would draw one name and hold another, in
 * a tracker that shows it as the author of a note. 1 to `MAX_PERSON_NAME` characters, counted as
 * JavaScript counts them, like a workspace name. NFC, so one name has one form.
 */
export function readPersonName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (name === '' || name.length > MAX_PERSON_NAME) return undefined;

  return /[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/u.test(name) ? undefined : name;
}

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
 * A workspace that an administrator of the instance suspended (FRU-282): since when, in milliseconds,
 * and the reason they wrote, if any. `workspace-suspension.ts` says what it does.
 */
export type WorkspaceSuspension = { since: number; reason?: string };

/**
 * The logo of a workspace (FRU-428), as `workspace-logo.ts` checked it: its type, its bytes, and the
 * instant it was sent, which is the version of its address.
 */
export type WorkspaceLogo = { type: string; content: Uint8Array; updatedAt: number };

/**
 * The four roles of the design (board « My account »).
 *
 * - `owner`: everything, and the only one who can delete the workspace.
 * - `admin`: sites, sources and members.
 * - `member`: every site of the workspace, and the links to the tracker.
 * - `guest`: leaves and reads notes on the sites shared with them and no other (FRU-250), never sees
 *   the tracker, and does not read who the members are (FRU-149).
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
 * The sites of a workspace a person reads (FRU-250): every one for a role other than `guest`, and for
 * a guest the ones shared with them, by id. A guest with none is a member who reads no site.
 */
export type Reach = { role: Role; sites: 'every' | readonly string[] };

/**
 * How many sites one invitation of a guest names. The console names one; the model takes a few,
 * and the bound is what one request may write.
 */
export const MAX_GUEST_SITES = 10;

/**
 * Whether this reach reads this site. `undefined` reach: not a member, nothing. `undefined` site: a
 * thing of the workspace that names no site (a picture sent before FRU-250), which a guest does not read.
 */
export function readsSite(reach: Reach | undefined, site: string | undefined): boolean {
  if (reach === undefined) return false;
  if (reach.sites === 'every') return true;

  return site !== undefined && reach.sites.includes(site);
}

/** The ones of `sites` this reach reads, in their order. */
export function readableSites<T extends { id: string }>(sites: readonly T[], reach: Reach): T[] {
  return sites.filter((site) => readsSite(reach, site.id));
}

/** A site as the invitations and the members name it (FRU-250): its id and its address. */
export type SharedSite = { id: string; origin: string };

/** How many agent keys one workspace holds (FRU-461). */
export const MAX_AGENT_KEYS = 20;

/**
 * An agent key of a workspace (FRU-461), as the store reads it: never the key, which the worker does
 * not keep. `write`: the key may reply and set a status, beside the reads. `agent-keys.ts` says what
 * a key reaches.
 */
export type AgentKey = {
  id: string;
  workspaceId: string;
  name: string;
  sites: SharedSite[];
  write: boolean;
  /** The account of the member who made the key. */
  createdBy: string;
  createdAt: number;
  expiresAt: number;
};

/** A key to write: its digest, never the key. */
export type NewAgentKey = Omit<AgentKey, 'id' | 'workspaceId' | 'sites'> & {
  keyHash: string;
  sites: readonly string[];
};

/**
 * Who reads the notes of a site: the two words of the design (P2) in place of the three modes.
 *
 * `members` is `read: 'authenticated'`, with a session of the workspace. `everyone` is `public`.
 */
export const VISIBILITIES = ['members', 'everyone'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

/**
 * Who may leave a note on a site (FRU-330, the decision of Mathieu of 2026-10-20 on FRU-286).
 *
 * - `members`, « Members only »: on a site that its members read, a note, a reply and a picture need
 *   a session of somebody who reads the site. The default of a new site.
 * - `anyone`, « Anyone on the page »: a note with no session is kept, as a claim. Every site made
 *   before FRU-330 has this value: the migration `0021` gives it.
 *
 * It decides nothing on a site that everyone reads: such a site takes a note from anybody.
 */
export const WRITERS = ['members', 'anyone'] as const;
export type Writers = (typeof WRITERS)[number];

/** What a new site takes when nobody chose (FRU-330): closed. */
export const DEFAULT_WRITERS: Writers = 'members';

/**
 * Where the notes of a site go: a connector of its workspace, and the place inside it. A tracker has
 * places, so `teamId` is required for one. An address that only receives has none (FRU-122).
 *
 * `teamId` is a team of Linear, or the repository `owner/name` of a `github` connector (FRU-359).
 */
export type Destination = {
  connector: string;
  teamId?: string;
  projectId?: string;
  /** How a member reads this place when they choose it (FRU-123): « Linear · Design ». */
  label?: string;
  /**
   * FRU-382: whether the repository of a `github` destination is private, as GitHub last said it.
   * The worker learns it when the destination is written and when a note goes there, never from a
   * request. Absent: not known (another kind of connector, or GitHub did not answer).
   */
  private?: boolean;
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
  /** Who may leave a note (FRU-330). It decides only on a site that `members` read. */
  writers: Writers;
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
 * What a workspace can connect. `linear` and `github` are trackers: the notes live there. `rest` is
 * an address that receives each note, while the notes stay in the worker (FRU-122).
 *
 * A `github` connector keeps the id of an installation of the GitHub App of the worker (FRU-359),
 * and nothing more. The key of the App is in the environment of the worker.
 */
export const CONNECTOR_KINDS = ['linear', 'rest', 'github'] as const;
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
export type ConnectorSettings = { showComments: boolean; stages: Readonly<Record<string, NoteStage>> };

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
  const kept: Record<string, NoteStage> = {};
  for (const [state, stage] of entries) {
    if (!STATE_ID.test(state) || !(NOTE_STAGES as readonly unknown[]).includes(stage)) return undefined;
    kept[state] = stage as NoteStage;
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
  /**
   * The name a workspace gave the connector (FRU-404), so that two connectors of one kind read apart.
   * Absent: none was given. `label` stays the worker's own words, which the console reads.
   */
  name?: string;
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
  /**
   * The addresses of an account that something proved, beside `user.email` (FRU-450): see
   * `account-emails.ts`. The primary address is there only when a provider brought it.
   */
  addresses(account: string): Promise<AccountAddress[]>;
  /** The account that has this address, as its primary address or as another one. */
  ownerOfAddress(email: string): Promise<string | undefined>;
  /**
   * The address a provider gives the account now, at a link or a sign-in (FRU-450). `undefined`: it
   * gave none, or none that it verified. The provider leaves the address it gave before; an address
   * of another account is not taken, and nothing says so.
   */
  noteProviderAddress(account: string, provider: string, email: string | undefined, now: number): Promise<void>;
  /** Fruitback proved this address for the account (its link was opened). `taken`: another account has it. */
  verifyAddress(account: string, email: string, now: number): Promise<'added' | 'taken'>;
  /** Takes an address away by hand. Never the primary one, nor one that a linked provider gives. */
  removeAddress(account: string, email: string): Promise<'removed' | 'not-found' | 'primary' | 'provider'>;
  /** Whether this provider alone proves the primary address: unlinking it would leave it unproved. */
  providerHoldsPrimary(account: string, provider: string): Promise<boolean>;
  /**
   * Makes an address of the account its primary one. The one of before stays, as proved by Fruitback.
   * `undefined`: the address is not one of the account.
   */
  makePrimary(account: string, email: string, now: number): Promise<{ before: string } | undefined>;
  /**
   * Whether this account is the administrator of the instance (FRU-261), read in the database at each
   * call: `role` of `user` is `admin`, and the account is not banned. `instance-admin.ts` says why.
   */
  isInstanceAdmin(account: string): Promise<boolean>;
  /** The language the person chose. `undefined` removes the choice. */
  setLocale(account: string, locale: string | undefined): Promise<void>;
  /**
   * The name the person chose for their notes (FRU-249), read by `readPersonName`. A later sign-in
   * does not write over it: a provider gives a name only to an account that has none.
   */
  setName(account: string, name: string): Promise<void>;
  /** The language of the account behind this address, if there is one and it has one. */
  localeOf(email: string): Promise<string | undefined>;
  createWorkspace(name: string, owner: string): Promise<Workspace>;
  /**
   * Every workspace this account belongs to, with its role there, oldest first. `suspension`: an
   * administrator of the instance suspended the workspace (FRU-282). `logoAt`: the instant its logo
   * was sent (FRU-428), absent when it has none.
   */
  memberships(
    account: string,
  ): Promise<{ workspace: Workspace; role: Role; suspension?: WorkspaceSuspension; logoAt?: number }[]>;
  /** The logo of a workspace (FRU-428), or `undefined` when it has none. */
  logo(workspace: string): Promise<WorkspaceLogo | undefined>;
  /** Writes the logo of a workspace over the one it had. The caller checked it: `checkLogo`. */
  setLogo(workspace: string, logo: WorkspaceLogo): Promise<void>;
  /** Removes the logo of a workspace. `false` when it had none. */
  removeLogo(workspace: string): Promise<boolean>;
  /** The suspension of a workspace (FRU-282), or `undefined` for one that is not suspended or does not exist. */
  suspension(workspace: string): Promise<WorkspaceSuspension | undefined>;
  /**
   * The role of `account` in `workspace`, or `undefined` for somebody who is not a member. A suspended
   * account (FRU-281) has no role: every caller asks it of the account that acts.
   */
  role(workspace: string, account: string): Promise<Role | undefined>;
  /**
   * The role of `account` in `workspace` and the sites it reads there (FRU-250), in one read, or
   * `undefined` for somebody who is not a member, and for a suspended account (FRU-281). Every route
   * that answers a thing of one site asks this, and `readsSite` reads it.
   */
  reach(workspace: string, account: string): Promise<Reach | undefined>;
  /**
   * The sites an invitation of `workspace` names (FRU-250). `false` when one of them is not a site of
   * this workspace, and then nothing is written.
   */
  shareByInvitation(workspace: string, invitation: string, sites: readonly string[]): Promise<boolean>;
  /** The sites each of these invitations names, by invitation id. An invitation that names none is absent. */
  sitesOfInvitations(invitations: readonly string[]): Promise<Map<string, SharedSite[]>>;
  /**
   * What `account` reads in the workspace of `invitation` once it accepts it (FRU-250), written before
   * the acceptance: the sites of the invitation, in place of any share the person had there. An
   * invitation that names none leaves none. Nothing for an invitation that does not exist.
   */
  shareOnAcceptance(account: string, invitation: string): Promise<void>;
  /** The sites shared with each guest of a workspace, by account id. */
  sharedIn(workspace: string): Promise<Map<string, SharedSite[]>>;
  /** Removes what was shared with `account` in `workspace`: they left, or were removed. */
  unshare(workspace: string, account: string): Promise<void>;
  /**
   * A new agent key of `workspace` (FRU-461), with the sites it names. Nothing is written when:
   *
   * - `unknown-site`: one of the sites is not a site of this workspace;
   * - `too-many`: the workspace holds `MAX_AGENT_KEYS` keys.
   */
  createAgentKey(workspace: string, key: NewAgentKey): Promise<AgentKey | 'unknown-site' | 'too-many'>;
  /** The agent keys of a workspace, oldest first. A key that expired is still there. */
  agentKeys(workspace: string): Promise<AgentKey[]>;
  /** Deletes an agent key. `false` when it is not a key of this workspace. */
  revokeAgentKey(workspace: string, key: string): Promise<boolean>;
  /**
   * The agent key of this digest and the reach of the member who made it, read now in one
   * statement. `undefined`: no key has this digest, or its member left, was removed or is suspended.
   * An expired key is answered: `agent-keys.ts` refuses it.
   */
  agentKeyOf(keyHash: string): Promise<{ key: AgentKey; reach: Reach } | undefined>;
  /**
   * The address of every person who owns a workspace, each once (FRU-221). Empty: the instance has
   * no owner yet. A role that is not one of the four is no role, as for `role`.
   */
  owners(): Promise<string[]>;
  /**
   * That `account` was seen in `workspace` on `day`, a day of UTC as `YYYY-MM-DD` (FRU-249). Nothing
   * for somebody who is not a member, and nothing for a day before the one kept.
   */
  markSeen(workspace: string, account: string, day: string): Promise<void>;
  /** The day each member of a workspace was last seen there, by account id. A member never seen is not in it. */
  lastSeen(workspace: string): Promise<Record<string, string>>;
  /**
   * A new site, or the site of that address again with the visibility asked for last. `writers`
   * absent: `DEFAULT_WRITERS` for a new site, and what it was for a site that exists (FRU-330), so a
   * caller that does not know the field opens nothing and closes nothing.
   */
  addSite(workspace: string, site: { origin: string; visibility: Visibility; writers?: Writers }): Promise<Site>;
  sites(workspace: string): Promise<Site[]>;
  removeSite(workspace: string, site: string): Promise<boolean>;
  /**
   * The statuses of a site (FRU-366), ordered by `position`, then source and key. `undefined` when the
   * site is not of this workspace.
   */
  siteStatuses(workspace: string, site: string): Promise<SiteStatus[] | undefined>;
  /**
   * How many notes the worker keeps in each status of its store for a site (FRU-386), by key: a note
   * with no status of its own counts in the built-in status of its stage. A key with no note is absent.
   * One aggregate over the notes of the site. `undefined` when the site is not of this workspace.
   */
  siteStatusNotes(workspace: string, site: string): Promise<Record<string, number> | undefined>;
  /**
   * Whether a site draws the states of its tracker in the tracker's colours (FRU-368), a switch of the
   * site that is off by default. `undefined` when the site is not of this workspace.
   */
  siteTrackerColours(workspace: string, site: string): Promise<boolean | undefined>;
  /** Turns that switch. `false` when the site is not of this workspace. */
  setSiteTrackerColours(workspace: string, site: string, on: boolean): Promise<boolean>;
  /**
   * Adds a status to a site, or changes the one of that source and key: its name, stage, colours,
   * position and whether it is hidden. Its `origin` is written once, when it is added. A status the
   * team added to the worker's store that changes stage takes its notes to that stage, in the same
   * transaction. `pages`: the pages of the notes it moved, whose cached reads are now wrong.
   * `too-many`: the site holds `MAX_STATUSES` already, and nothing changes.
   */
  putSiteStatus(
    workspace: string,
    site: string,
    status: SiteStatus,
  ): Promise<{ saved: true; pages: string[] } | { saved: false; reason: 'not-found' | 'too-many' }>;
  /**
   * The order of the statuses of a site: each one named takes its place in the list as its
   * `position`. `unknown-status`: one of them is no status of the site, and nothing changes.
   */
  orderSiteStatuses(
    workspace: string,
    site: string,
    order: readonly { source: string; key: string }[],
  ): Promise<'saved' | 'not-found' | 'unknown-status'>;
  /**
   * Removes a status of a site. The notes that the worker keeps in it move first to `moveTo`, a key of
   * the worker's store (a built-in status, or another the team added), and take its stage. `pages`:
   * the pages of the notes it moved, whose cached reads are now wrong.
   *
   * - `in-use`: notes are in it and no `moveTo` says where they go. Nothing changes.
   * - `invalid-target`: `moveTo` is no status of the worker's store for this site, or the one removed,
   *   or it is given for a status that holds no note of its own.
   *
   * A state of a tracker, or a built-in status, holds no note of its own: removing its row brings back
   * what the tracker or the worker says of it.
   */
  removeSiteStatus(
    workspace: string,
    site: string,
    status: { source: string; key: string },
    moveTo: string | undefined,
  ): Promise<
    | { removed: true; moved: number; pages: string[] }
    | { removed: false; reason: 'not-found' | 'invalid-target' }
    | { removed: false; reason: 'in-use'; notes: number }
  >;
  /**
   * Puts a note the worker keeps in a status of its site, from the console (FRU-384): `key` is a key
   * of the worker's store, a built-in status or one the team added, and the note takes its stage. In
   * one transaction, with the site held: the note of the index, its author, the status and the note.
   * `who.manages`: the caller holds `manage-sites` here; otherwise only the note's author may.
   *
   * - `not-found`: no such note in this site of this workspace.
   * - `not-kept`: the note is in a tracker, whose status changes there.
   * - `not-allowed`: the caller neither wrote it nor manages the sites.
   * - `unknown-status`: no such status for this site. `status-hidden`: it is hidden.
   *
   * `page`: the page of the note, whose cached reads are now wrong.
   */
  setNoteStatus(
    workspace: string,
    site: string,
    note: string,
    key: string,
    who: { account: string; manages: boolean },
  ): Promise<
    | { set: true; stage: NoteStage; page: string }
    | { set: false; reason: 'not-found' | 'not-kept' | 'not-allowed' | 'unknown-status' | 'status-hidden' }
  >;
  /**
   * What GitHub said of a repository when a note went there (FRU-382): every destination of
   * `connector` to `repository` takes it, so that a repository that turned public is said at once.
   */
  noteRepositoryPrivacy(connector: string, repository: string, isPrivate: boolean): Promise<void>;
  /** `sealed` is the key as `secrets.ts` encrypts it: the store never sees the plain value. */
  addConnector(
    workspace: string,
    connector: { kind: ConnectorKind; label: string; sealed: string },
  ): Promise<Connector>;
  connectors(workspace: string): Promise<Connector[]>;
  /**
   * The `github` connector of an installation for this workspace (FRU-360). `installation` is its
   * fingerprint. A new installation makes a connector. An installation that this workspace holds
   * already keeps its connector and its id, and takes `label` and `sealed`.
   *
   * `undefined`: a connector of another workspace holds the installation, and nothing changes.
   */
  attachInstallation(
    workspace: string,
    connector: { label: string; sealed: string; installation: string },
  ): Promise<{ connector: Connector; created: boolean } | undefined>;
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
  /**
   * The name a workspace gives its connector (FRU-404), or `undefined` to take it away. `false` when
   * the connector is not of this workspace, and then nothing changes.
   */
  renameConnector(workspace: string, connector: string, name: string | undefined): Promise<boolean>;
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
  /**
   * The deliveries to attempt now, oldest first. A delivery of a suspended workspace (FRU-282) is not
   * one: it waits, with its count, until the workspace is restored.
   */
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
  /**
   * Every site, as the client map the routing reads. A site of a suspended workspace (FRU-282) is not
   * in it: the widget and the extension find it as a site that does not exist.
   */
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
    // FRU-330: « Members only » closes the writes of a site that its members read, and only there.
    write: site.visibility === 'members' && site.writers === 'members' ? 'authenticated' : 'public',
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

/**
 * The mailbox a window of messages counts (FRU-209): the address without its `+suffix`.
 * `carol+0@…` to `carol+5@…` are six addresses and one mailbox for most providers, so a window by
 * address let six messages into it. Only the count reads this: an account, an invitation and a
 * message keep the address as it was written.
 */
export function mailboxOf(email: string): string {
  const at = email.lastIndexOf('@');
  const plus = email.indexOf('+');

  return plus > 0 && plus < at ? `${email.slice(0, plus)}${email.slice(at)}` : email;
}

/** An address as an account stores it: trimmed, lower case. A provider can answer either case. */
export function normalizeEmail(value: string): string | undefined {
  const email = value.trim().toLowerCase();

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : undefined;
}

/** The longest name of a workspace, in characters. */
const MAX_NAME = 80;

/**
 * The name of a workspace as a person typed it: one line, its spaces made one, 80 characters at
 * most. `undefined` for a value that is not one. The console API and the administrator of the
 * instance (FRU-283) read a name with this.
 */
export function workspaceName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.replace(/\s+/g, ' ').trim();

  return name === '' || name.length > MAX_NAME ? undefined : name;
}
