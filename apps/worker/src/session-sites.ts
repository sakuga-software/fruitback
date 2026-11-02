import { json } from './http.ts';
import {
  type AccountStore,
  type ConnectorKind,
  type Destination,
  type Role,
  type Site,
  can,
  readableSites,
} from './accounts.ts';
import type { Kv } from './kv.ts';
import { addSessionSite } from './session-site-add.ts';
import { previewPattern, proofState } from './domain-proof.ts';
import { readBearerToken, verifyIdentityToken } from './identity.ts';
import { type NoteIndex, noNotes } from './notes-index.ts';
import type { SessionIdentity } from './session.ts';

/**
 * The sites of the workspace a session belongs to (FRU-101, the first step of it).
 *
 * The extension asks this with the access token of its session, and offers to turn on, in one click,
 * a tab whose origin is one of these sites. Nothing is typed: the worker is the one the session
 * belongs to, and the client id is the site's.
 *
 * Only a session that names a workspace gets an answer, and only while its person is still a member
 * of it: the role is read here, as the console's routes read it. A guest reads the sites shared with
 * them and no other (FRU-250): the extension offers no site it could not write on.
 *
 * A suspended workspace (FRU-282) is not here: the extension reads it as a workspace that the person
 * is not a member of, and its sites as sites that do not exist.
 */
export const SESSION_SITES_PATH = '/session/sites';

/** What `POST /session/sites` needs beside the read: the `Kv` of its count, and the session read again. */
export type SiteWrites = {
  kv: Kv;
  /** `sessionWrites` of `app.ts`, bound to this request: the person of the session, now. */
  session: () => Promise<SessionIdentity | undefined>;
};

export async function handleSessionSites(
  request: Request,
  accounts: AccountStore,
  secret: string,
  headers: Record<string, string>,
  now?: number,
  noteIndex?: NoteIndex,
  writes?: SiteWrites,
): Promise<Response> {
  if (request.method !== 'GET' && !(request.method === 'POST' && writes !== undefined)) {
    return json(405, { error: 'method-not-allowed' }, headers);
  }

  const token = readBearerToken(request.headers.get('Authorization'));
  if (token === undefined) return json(401, { error: 'identity-required' }, headers);
  // FRU-255: a site added from the popup. **A write reads the session again in the store** (decided
  // on 2026-10-14): a session that ended, a browser disconnected in « My account », or an account that
  // is gone writes nothing, whatever its token still says. A session of an account only.
  if (request.method === 'POST' && writes !== undefined) {
    const session = await writes.session();
    if (session === undefined) return json(401, { error: 'identity-required' }, headers);
    if (session.account !== true) return json(403, { error: 'account-required' }, headers);
    const added = await addSessionSite(request, { accounts, kv: writes.kv, account: session.subject });

    return json(added.status, added.body, headers);
  }

  const verified = await verifyIdentityToken(token, secret, now);
  if (!verified.ok) return json(401, { error: 'identity-required', reason: verified.reason }, headers);
  // FRU-498: `?origin=` asks for the sites of one tab. With no such parameter, the whole list, as an
  // extension of before asks it.
  const asked = new URL(request.url).searchParams.get('origin');
  const origin = asked === null ? undefined : originOf(asked);
  if (asked !== null && origin === undefined) return json(400, { error: 'invalid-origin' }, headers);

  const subject = verified.reporter.id;
  // A session of an account (FRU-238): the sites of every workspace it is a member of today. A
  // suspended account (FRU-281) reads nothing: its session gets `401`, as a session that ended.
  if (verified.account === true && subject !== undefined) {
    if ((await accounts.account(subject))?.suspended === true) {
      return json(401, { error: 'identity-required', reason: 'no-account' }, headers);
    }
    return json(200, await sitesOfAccount(accounts, subject, now ?? Date.now(), noteIndex, origin), headers);
  }
  const workspaceId = verified.workspace;
  if (subject === undefined || workspaceId === undefined) {
    return json(401, { error: 'identity-required', reason: 'no-workspace' }, headers);
  }

  const reach = await accounts.reach(workspaceId, subject);
  const membership = (await accounts.memberships(subject)).find((each) => each.workspace.id === workspaceId);
  if (reach === undefined || membership?.suspension !== undefined) {
    return json(401, { error: 'identity-required', reason: 'not-a-member' }, headers);
  }

  const workspace = membership?.workspace;
  const previewsOf = await previewsIn(accounts, workspaceId, now ?? Date.now());
  const readable = readableSites(await accounts.sites(workspaceId), reach);
  const sites = readable.filter((site) => origin === undefined || covers(site, previewsOf(site.id), origin));
  // The language the person reads (FRU-119), so the extension and its widget speak it too (FRU-131).
  const locale = (await accounts.account(subject))?.locale;
  // FRU-237: what the popup counts on a site (06, 07). What did not arrive stays in the console.
  // FRU-498: not read for a tab that is no site of the workspace.
  const notes = sites.length === 0 ? undefined : await notesIn(noteIndex, workspaceId);
  const kinds = can(reach.role, 'see-tracker') && sites.length > 0 ? await kindsIn(accounts, workspaceId) : new Map();

  return json(
    200,
    {
      workspace: { id: workspaceId, name: workspace?.name ?? '' },
      ...(locale === undefined ? {} : { locale }),
      ...(origin === undefined ? {} : { origin }),
      sites: sites.map((site) => {
        const previews = previewsOf(site.id);

        return {
          id: site.id,
          origin: site.origin,
          visibility: site.visibility,
          ...(previews.length === 0 ? {} : { previews }),
          ...destinationFor(site, reach.role, kinds),
          ...(notes === undefined ? {} : (notes.get(site.id) ?? noNotes())),
        };
      }),
    },
    headers,
  );
}

/**
 * The previews a site covers (FRU-103): the wildcard of each domain of the workspace that is proven
 * now and names this site. A proof that is lost or that nobody confirmed is not here.
 */
async function previewsIn(accounts: AccountStore, workspace: string, now: number): Promise<(site: string) => string[]> {
  const proven = (await accounts.domains(workspace)).filter(
    (domain) => domain.previewsSite !== undefined && proofState(domain, now) === 'proven',
  );

  return (site) =>
    proven.filter((domain) => domain.previewsSite === site).map((domain) => previewPattern(domain.domain));
}

/**
 * What a session of an account reads (FRU-238): every workspace the account is a member of now, with
 * the role it has there, and the sites of each, each naming its workspace. The memberships are read
 * at this call: a workspace the account left is not here, and an account in none reads an empty list.
 *
 * No `workspace` in the singular: the extension of before reads this answer as « no list », and asks
 * nothing of a session it does not know.
 */
async function sitesOfAccount(
  accounts: AccountStore,
  account: string,
  now: number,
  noteIndex?: NoteIndex,
  origin?: string,
) {
  const memberships = (await accounts.memberships(account)).filter((each) => each.suspension === undefined);
  const locale = (await accounts.account(account))?.locale;
  // FRU-498: the workspaces are read a few at a time, not one after the other: an account of an agency
  // is a member of tens of them. The order of the answer stays the order of the memberships.
  const read = await inBatches(memberships, WORKSPACES_AT_ONCE, async ({ workspace, role }) => {
    // Read again, with the sites of a guest (FRU-250). A membership that ended since reads none.
    const reach = await accounts.reach(workspace.id, account);
    if (reach === undefined) return undefined;
    const previewsOf = await previewsIn(accounts, workspace.id, now);
    const all = readableSites(await accounts.sites(workspace.id), reach);
    const readable = all.filter((site) => origin === undefined || covers(site, previewsOf(site.id), origin));
    // FRU-498: a workspace with no site of the tab costs no count and no connector.
    if (origin !== undefined && readable.length === 0) return { workspace: workspace.id, sites: [] };
    const notes = await notesIn(noteIndex, workspace.id);
    const toCheck = await toCheckIn(noteIndex, workspace.id, account);
    const manages = can(role, 'manage-sites');
    const connectors = can(reach.role, 'see-tracker') ? await accounts.connectors(workspace.id) : [];
    const kinds = new Map(connectors.map((each) => [each.id, each.kind]));
    // FRU-453: the sources the popup offers, for a role that changes the place of a site.
    const sources = manages
      ? connectors.map((each) => ({ id: each.id, kind: each.kind, label: each.name ?? each.label }))
      : undefined;
    const sites = readable.map((site) => {
      const previews = previewsOf(site.id);

      return {
        id: site.id,
        origin: site.origin,
        visibility: site.visibility,
        workspace: workspace.id,
        ...(previews.length === 0 ? {} : { previews }),
        ...destinationFor(site, reach.role, kinds),
        // FRU-453: the ids of where its notes go now, so the lists of the popup start there.
        ...(manages ? placeIdsOf(site) : {}),
        ...(notes === undefined ? {} : (notes.get(site.id) ?? noNotes())),
        // FRU-295: the notes of this person that the team marked done and that they did not confirm.
        ...(toCheck === undefined ? {} : { toCheck: toCheck.get(site.id) ?? 0 }),
      };
    });

    return { workspace: workspace.id, sites, ...(sources === undefined ? {} : { sources }) };
  });
  const sourcesIn = new Map<string, { id: string; kind: string; label: string }[]>();
  for (const each of read) if (each?.sources !== undefined) sourcesIn.set(each.workspace, each.sources);
  const sites = read.flatMap((each) => each?.sites ?? []);

  return {
    account: true,
    ...(locale === undefined ? {} : { locale }),
    // FRU-498: the origin this list was read for. An extension reads a list without it as the whole.
    ...(origin === undefined ? {} : { origin }),
    // FRU-255: whether the popup may offer to add a site there, from the role read now.
    workspaces: memberships.map(({ workspace, role }) => ({
      id: workspace.id,
      name: workspace.name,
      role,
      canAddSite: can(role, 'manage-sites'),
      ...(sourcesIn.has(workspace.id) ? { sources: sourcesIn.get(workspace.id) } : {}),
    })),
    sites,
  };
}

/** The ids of the first place of a site (FRU-453), or `null` for « Fruitback ». */
function placeIdsOf(site: Site): { place: { connector: string; teamId?: string; projectId?: string } | null } {
  const [first] = site.destinations;
  if (first === undefined) return { place: null };

  return {
    place: {
      connector: first.connector,
      ...(first.teamId === undefined ? {} : { teamId: first.teamId }),
      ...(first.projectId === undefined ? {} : { projectId: first.projectId }),
    },
  };
}

/**
 * Where the notes of a site go, for a role that sees the tracker (FRU-295), as the console names it:
 * the label of its first destination (« Linear · Northwind »), or « Fruitback » for a site that keeps
 * its notes in the worker. A guest, and any role without `see-tracker`, gets nothing, as for the
 * places of `GET /feedback` (FRU-123). A destination with no label is not named: absent, not a guess.
 */
function destinationFor(site: Site, role: Role, kinds: ReadonlyMap<string, ConnectorKind>): DestinationField {
  return can(role, 'see-tracker') ? destinationField(site.destinations[0], kinds) : {};
}

/** The kind of each connector of a workspace, by its id: what `destinationField` names. */
async function kindsIn(accounts: AccountStore, workspace: string): Promise<Map<string, ConnectorKind>> {
  return new Map((await accounts.connectors(workspace)).map((each) => [each.id, each.kind]));
}

/** The kind of provider of a destination (FRU-554): a kind of connector, or the worker's own store. */
export type DestinationKind = ConnectorKind | 'fruitback';
export type DestinationField = { destination?: { label: string; kind?: DestinationKind } };

/**
 * `destination` of a site in `GET /session/sites` and `POST /session/sites/settings`: the label of
 * the first place, or « Fruitback » when there is none.
 *
 * `kind` (FRU-554) names the provider, so the popup draws its mark without reading the label. It is
 * added beside `label`, which stays as it was: an extension of before reads the label alone. A
 * connector removed since the place was written has no kind: `kind` is absent, not a guess.
 */
export function destinationField(
  first: Destination | undefined,
  kinds: ReadonlyMap<string, ConnectorKind>,
): DestinationField {
  if (first === undefined) return { destination: { label: 'Fruitback', kind: 'fruitback' } };
  if (first.label === undefined || first.label === '') return {};
  const kind = kinds.get(first.connector);

  return { destination: { label: first.label, ...(kind === undefined ? {} : { kind }) } };
}

/**
 * The fixes to check of one account in a workspace (FRU-295), or `undefined` when the index does not
 * answer: the extension then reads « unknown », never « nothing to check ».
 */
async function toCheckIn(noteIndex: NoteIndex | undefined, workspace: string, account: string) {
  return noteIndex?.toCheck(workspace, account).catch((error: unknown) => {
    console.error(
      `[fruitback] the index of the notes did not answer: ${error instanceof Error ? error.message : String(error)}`,
    );

    return undefined;
  });
}

/**
 * The counts of the notes of the sites of a workspace (FRU-237), or `undefined`: an index that does
 * not answer costs the counts, never the sites.
 */
async function notesIn(noteIndex: NoteIndex | undefined, workspace: string) {
  return noteIndex?.summary(workspace).catch((error: unknown) => {
    console.error(
      `[fruitback] the index of the notes did not answer: ${error instanceof Error ? error.message : String(error)}`,
    );

    return undefined;
  });
}

/** How many workspaces of an account are read at once (FRU-498). */
const WORKSPACES_AT_ONCE = 4;

/** `run` over `items`, `size` at a time, in their order. */
async function inBatches<T, R>(items: readonly T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let start = 0; start < items.length; start += size) {
    out.push(...(await Promise.all(items.slice(start, start + size).map(run))));
  }

  return out;
}

/** The origin of a tab as `?origin=` gives it (FRU-498): an `http` or `https` origin, spelled as one, or `undefined`. */
function originOf(value: string): string | undefined {
  try {
    const url = new URL(value);

    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a site is one the extension offers on a tab of `origin` (FRU-498), as `offerFor` reads the
 * whole list: the site of that origin, or a site whose workspace proved a preview that covers it
 * (`https://*.domain`, FRU-103, read as `coversOrigin` of the extension reads it).
 */
function covers(site: Site, previews: readonly string[], origin: string): boolean {
  return site.origin === origin || previews.some((pattern) => previewCovers(pattern, origin));
}

function previewCovers(pattern: string, origin: string): boolean {
  if (!pattern.includes('://*.')) return false;
  const [scheme = '', base = ''] = pattern.split('://*.');
  const url = new URL(origin);

  return (
    url.protocol === `${scheme}:` && url.port === '' && (url.hostname === base || url.hostname.endsWith(`.${base}`))
  );
}
