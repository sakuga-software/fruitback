import {
  type AccountStore,
  type Destination,
  MAX_DESTINATIONS,
  VISIBILITIES,
  type Visibility,
  can,
} from './accounts.ts';
import { readBoundedBytes } from './bounded-body.ts';
import { type TrackerContext, UnknownPlace, offerOf, placeOf } from './console-api.ts';
import { isExtensionOrigin } from './cors.ts';
import { StoreError } from './store.ts';

/**
 * `POST /session/sites/settings`: the popup changes who sees the notes of a site and where they go,
 * on the screen that turns the site on (FRU-453). `GET /session/sites/places`: what a source of the
 * workspace offers to choose there, a provider, then a team, then a project (review of Mathieu).
 *
 * The second and third routes where the token of an extension is read for a write. They ask what
 * `POST /session/sites` asks, and read all of it at this call, never from the token:
 *
 * - a session of an **account**, read again in the store (in `session-routes.ts`);
 * - an `Origin` that is an extension's, or none;
 * - the **role** in the workspace named, read now: `manage-sites`, the role that changes the same
 *   two fields in the console. Not a member, or a suspended workspace, answers `404`;
 * - a site of that workspace, or `404`.
 *
 * **A place is checked as the console checks it** (`placeOf` of `console-api.ts`): a connector of the
 * workspace, a team or a repository its key reaches, and the label the tracker answers, never the
 * words of the body. The keys of the connectors are opened in the worker and never leave it: the
 * popup gets names and ids.
 *
 * The chosen place replaces the first, the default of the site; the other places stay after it.
 * `null` is « Fruitback »: no place. A site with two places or more is not emptied from here
 * (`409`), as the console's `/destination` refuses it.
 */
export const SESSION_SITE_SETTINGS_PATH = '/session/sites/settings';
export const SESSION_SITE_PLACES_PATH = '/session/sites/places';

/** A body of this route is two ids, a word and one place. */
const MAX_BODY_BYTES = 2 * 1_024;

type Answer = { status: number; body: unknown };

export type SiteSettingsContext = {
  accounts: AccountStore;
  /** The account the access token names, already read again as a session of an account. */
  account: string;
  /** What reads a tracker with the key of a connector, as the console does. */
  tracker: TrackerContext;
};

/** The key of a place, whatever site it is of. */
function keyOf(place: { connector: string; teamId?: string; projectId?: string }): string {
  return [place.connector, place.teamId ?? '', place.projectId ?? ''].join('\n');
}

/** An id of a body: a short string, or absent. `null` when it is something else. */
function idOf(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;

  return typeof value === 'string' && value !== '' && value.length <= 200 ? value : null;
}

/** The workspace named by a request, with the role read now: `manage-sites`, or an answer. */
async function managed(
  context: SiteSettingsContext,
  workspace: unknown,
): Promise<{ ok: true; workspace: string } | { ok: false; answer: Answer }> {
  if (typeof workspace !== 'string' || workspace === '' || workspace.length > 100) {
    return { ok: false, answer: { status: 400, body: { error: 'invalid-body' } } };
  }
  const role = await context.accounts.role(workspace, context.account);
  // A suspended workspace (FRU-282) answers as one that does not exist, as `POST /session/sites` does.
  if (role === undefined || (await context.accounts.suspension(workspace)) !== undefined) {
    return { ok: false, answer: { status: 404, body: { error: 'not-found' } } };
  }
  if (!can(role, 'manage-sites')) return { ok: false, answer: { status: 403, body: { error: 'forbidden', role } } };

  return { ok: true, workspace };
}

/**
 * `GET /session/sites/places?workspace=…&connector=…`: the teams of a Linear with their projects, the
 * repositories of a GitHub, or nothing to choose for an address (FRU-453). A tracker that does not
 * answer is `502`: the popup says so, and keeps what is chosen.
 */
export async function sourceOffer(request: Request, context: SiteSettingsContext): Promise<Answer> {
  const origin = request.headers.get('Origin');
  if (origin !== null && !isExtensionOrigin(origin)) return { status: 403, body: { error: 'origin-not-allowed' } };
  const query = new URL(request.url).searchParams;
  const allowed = await managed(context, query.get('workspace') ?? undefined);
  if (!allowed.ok) return allowed.answer;
  const connector = idOf(query.get('connector') ?? undefined);
  if (connector === undefined || connector === null) return { status: 400, body: { error: 'invalid-body' } };

  try {
    const offer = await offerOf(context.tracker, allowed.workspace, connector);

    return offer === undefined ? { status: 404, body: { error: 'not-found' } } : { status: 200, body: offer };
  } catch (error) {
    if (!(error instanceof StoreError)) throw error;

    return { status: 502, body: { error: 'tracker-unavailable' } };
  }
}

export async function setSessionSite(request: Request, context: SiteSettingsContext): Promise<Answer> {
  const origin = request.headers.get('Origin');
  if (origin !== null && !isExtensionOrigin(origin)) return { status: 403, body: { error: 'origin-not-allowed' } };

  const body = await bodyOf(request);
  if (body === undefined) return { status: 400, body: { error: 'invalid-body' } };
  const { site: siteId, visibility: askedVisibility, place: askedPlace } = body;
  if (typeof siteId !== 'string' || siteId === '' || siteId.length > 100) {
    return { status: 400, body: { error: 'invalid-body' } };
  }
  if (askedVisibility !== undefined && !(VISIBILITIES as readonly unknown[]).includes(askedVisibility)) {
    return { status: 400, body: { error: 'invalid-visibility' } };
  }
  const visibility = askedVisibility as Visibility | undefined;
  let asked: { connector: string; teamId?: string; projectId?: string } | null | undefined;
  if (askedPlace === null) asked = null;
  else if (askedPlace !== undefined) {
    if (typeof askedPlace !== 'object' || Array.isArray(askedPlace))
      return { status: 400, body: { error: 'invalid-place' } };
    const fields = askedPlace as Record<string, unknown>;
    const [connector, teamId, projectId] = [idOf(fields.connector), idOf(fields.teamId), idOf(fields.projectId)];
    if (connector === undefined || connector === null || teamId === null || projectId === null) {
      return { status: 400, body: { error: 'invalid-place' } };
    }
    asked = {
      connector,
      ...(teamId === undefined ? {} : { teamId }),
      ...(projectId === undefined ? {} : { projectId }),
    };
  }
  if (visibility === undefined && asked === undefined) return { status: 400, body: { error: 'invalid-body' } };

  const allowed = await managed(context, body.workspace);
  if (!allowed.ok) return allowed.answer;
  const { workspace } = allowed;

  const sites = await context.accounts.sites(workspace);
  const site = sites.find((each) => each.id === siteId);
  if (site === undefined) return { status: 404, body: { error: 'not-found' } };

  // Both are read before anything is written: a bad place changes no visibility.
  let places: Destination[] | undefined;
  if (asked === null) {
    if (site.destinations.length > 1) {
      return { status: 409, body: { error: 'site-has-destinations', count: site.destinations.length } };
    }
    places = [];
  } else if (asked !== undefined) {
    let chosen: Destination | undefined;
    try {
      chosen = await placeOf(context.tracker, workspace, asked);
    } catch (error) {
      if (error instanceof UnknownPlace) return { status: 400, body: { error: 'invalid-place' } };
      if (error instanceof StoreError) return { status: 502, body: { error: 'tracker-unavailable' } };
      throw error;
    }
    // A connector of another workspace answers like a place that does not exist.
    if (chosen === undefined) return { status: 400, body: { error: 'invalid-place' } };
    const picked = chosen;
    // The default place is replaced, and the other places of the site stay after it: flipping the
    // list in the popup does not pile places up.
    const others = site.destinations.slice(1).filter((each) => keyOf(each) !== keyOf(picked));
    places = [picked, ...others].slice(0, MAX_DESTINATIONS);
  }

  // On the site read above only: a site removed since is not made again (raised in review).
  if (visibility !== undefined && !(await context.accounts.setSiteVisibility(workspace, site.id, visibility))) {
    return { status: 404, body: { error: 'not-found' } };
  }
  if (places !== undefined && !(await context.accounts.setDestinations(workspace, site.id, places))) {
    return { status: 404, body: { error: 'not-found' } };
  }

  const [first] = places ?? site.destinations;
  const label = first === undefined ? 'Fruitback' : first.label;

  return {
    status: 200,
    body: {
      site: {
        id: site.id,
        origin: site.origin,
        visibility: visibility ?? site.visibility,
        workspace,
        ...(label === undefined || label === '' ? {} : { destination: { label } }),
      },
    },
  };
}

async function bodyOf(request: Request): Promise<Record<string, unknown> | undefined> {
  const bytes = await readBoundedBytes(request, MAX_BODY_BYTES);
  if (bytes === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));

    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
