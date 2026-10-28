import {
  type AccountStore,
  type Destination,
  MAX_DESTINATIONS,
  type Site,
  VISIBILITIES,
  type Visibility,
  can,
} from './accounts.ts';
import { readBoundedBytes } from './bounded-body.ts';
import { isExtensionOrigin } from './cors.ts';

/**
 * `POST /session/sites/settings`: the popup changes who sees the notes of a site and where they go,
 * on the screen that turns the site on (FRU-453).
 *
 * The second route that lets the token of an extension write. It asks what `POST /session/sites`
 * asks, and reads all of it at this call, never from the token:
 *
 * - a session of an **account**, read again in the store (in `session-sites.ts`);
 * - an `Origin` that is an extension's, or none;
 * - the **role** in the workspace named, read now: `manage-sites`, the role that changes the same
 *   two fields in the console. Not a member, or a suspended workspace, answers `404`;
 * - a site of that workspace, or `404`.
 *
 * **A place is one that a site of the workspace already sends to.** The popup chooses among those, as
 * `GET /session/sites` lists them (`placesOf`). A new place, which asks the tracker for its teams or
 * its repositories, is chosen in the console: that read needs the keys of the connectors, and the
 * routes of a session hold none. The place is written with the label and the privacy the worker
 * stored, never with what the body says.
 *
 * The chosen place goes first, the default of the site; the other places of the site stay after it.
 * `null` is « Fruitback »: no place. A site with two places or more is not emptied from here
 * (`409`), as the console's `/destination` refuses it.
 */
export const SESSION_SITE_SETTINGS_PATH = '/session/sites/settings';

/** A body of this route is two ids, a word and one place. */
const MAX_BODY_BYTES = 2 * 1_024;

type Answer = { status: number; body: unknown };

export type SiteSettingsContext = {
  accounts: AccountStore;
  /** The account the access token names, already read again as a session of an account. */
  account: string;
};

/** A place offered in the popup: what names it, and the words the worker wrote for it. */
export type Place = { connector: string; teamId?: string; projectId?: string; label: string };

/** The key of a place, whatever site it is of. */
function keyOf(place: { connector: string; teamId?: string; projectId?: string }): string {
  return [place.connector, place.teamId ?? '', place.projectId ?? ''].join('\n');
}

/**
 * The places the sites of a workspace send to, once each, in the order of the sites. A place with
 * no label is left out: the popup names a place by its label, and has none to show.
 */
export function placesOf(sites: readonly Site[]): Place[] {
  const seen = new Map<string, Place>();
  for (const site of sites) {
    for (const each of site.destinations) {
      if (each.label === undefined || each.label === '' || seen.has(keyOf(each))) continue;
      seen.set(keyOf(each), {
        connector: each.connector,
        ...(each.teamId === undefined ? {} : { teamId: each.teamId }),
        ...(each.projectId === undefined ? {} : { projectId: each.projectId }),
        label: each.label,
      });
    }
  }

  return [...seen.values()];
}

/** The stored destination of the workspace that a place of the body names, with its label and privacy. */
function storedPlace(sites: readonly Site[], asked: Record<string, unknown>): Destination | undefined {
  const { connector, teamId, projectId } = asked;
  if (typeof connector !== 'string') return undefined;
  if (teamId !== undefined && typeof teamId !== 'string') return undefined;
  if (projectId !== undefined && typeof projectId !== 'string') return undefined;
  const key = keyOf({
    connector,
    ...(teamId === undefined ? {} : { teamId }),
    ...(projectId === undefined ? {} : { projectId }),
  });

  return sites
    .flatMap((site) => site.destinations)
    .find((each) => keyOf(each) === key && each.label !== undefined && each.label !== '');
}

export async function setSessionSite(request: Request, context: SiteSettingsContext): Promise<Answer> {
  const origin = request.headers.get('Origin');
  if (origin !== null && !isExtensionOrigin(origin)) return { status: 403, body: { error: 'origin-not-allowed' } };

  const body = await bodyOf(request);
  if (body === undefined) return { status: 400, body: { error: 'invalid-body' } };
  const { workspace, site: siteId, visibility: askedVisibility, place: askedPlace } = body;
  if (typeof workspace !== 'string' || workspace === '' || workspace.length > 100) {
    return { status: 400, body: { error: 'invalid-body' } };
  }
  if (typeof siteId !== 'string' || siteId === '' || siteId.length > 100) {
    return { status: 400, body: { error: 'invalid-body' } };
  }
  if (askedVisibility !== undefined && !(VISIBILITIES as readonly unknown[]).includes(askedVisibility)) {
    return { status: 400, body: { error: 'invalid-visibility' } };
  }
  const visibility = askedVisibility as Visibility | undefined;
  const placeAsked: unknown = askedPlace;
  if (
    placeAsked !== undefined &&
    placeAsked !== null &&
    (typeof placeAsked !== 'object' || Array.isArray(placeAsked))
  ) {
    return { status: 400, body: { error: 'invalid-place' } };
  }
  if (visibility === undefined && placeAsked === undefined) return { status: 400, body: { error: 'invalid-body' } };

  const role = await context.accounts.role(workspace, context.account);
  // A suspended workspace (FRU-282) answers as one that does not exist, as `POST /session/sites` does.
  if (role === undefined || (await context.accounts.suspension(workspace)) !== undefined) {
    return { status: 404, body: { error: 'not-found' } };
  }
  if (!can(role, 'manage-sites')) return { status: 403, body: { error: 'forbidden', role } };

  const sites = await context.accounts.sites(workspace);
  const site = sites.find((each) => each.id === siteId);
  if (site === undefined) return { status: 404, body: { error: 'not-found' } };

  // Both are read before anything is written: a bad place changes no visibility.
  let places: Destination[] | undefined;
  if (placeAsked === null) {
    if (site.destinations.length > 1) {
      return { status: 409, body: { error: 'site-has-destinations', count: site.destinations.length } };
    }
    places = [];
  } else if (placeAsked !== undefined) {
    const chosen = storedPlace(sites, placeAsked as Record<string, unknown>);
    if (chosen === undefined) return { status: 400, body: { error: 'invalid-place' } };
    const others = site.destinations.filter((each) => keyOf(each) !== keyOf(chosen));
    places = [chosen, ...others].slice(0, MAX_DESTINATIONS);
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
