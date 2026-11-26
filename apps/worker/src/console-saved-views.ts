import { readJsonObject } from './bounded-body.ts';
import { queryOf } from './console-notes.ts';
import { json } from './http.ts';
import type { AccountStore, Action, Reach, SavedView, SavedViewFilters } from './accounts.ts';

/**
 * The views of a person (FRU-723): filters of the Notes screen of the console that a person names and
 * keeps, so that they follow them from one browser to another. Each person reads and changes their own
 * views only, in a workspace they read the notes of.
 *
 * - `GET …/views`: `{ views: [{ id, name, filters, createdAt }] }`, oldest first.
 * - `POST …/views`, `{ name, filters }`: keeps a view, `201 { view }`.
 * - `POST …/views/<id>`, `{ name }`: renames it, `200 { view }`.
 * - `DELETE …/views/<id>`: deletes it, `204`.
 *
 * `filters` are the names and values of the address of the Notes screen (`FILTERS` of the console),
 * which the list reads (`queryOf` of `console-notes.ts`): a value the list refuses is refused here, as
 * `400 invalid-filters` with the field. **A person keeps only filters they can read**: `place` and
 * `undelivered` need `see-tracker`, as on the list, and a guest names only a site shared with them
 * (FRU-250), or `403`. The views are read again with the same check: a view that the role of the
 * person no longer reads (a member who became a guest, a site no longer shared) is not answered.
 *
 * A view of another person, or of another workspace, answers `404`, as a view that does not exist.
 */

/** The filters of the address of the Notes screen, as `FILTERS` of `apps/console/app/parts/notes-model.ts`. */
export const VIEW_FILTERS = [
  'place',
  'site',
  'stage',
  'mine',
  'archived',
  'unresolved',
  'assignee',
  'priority',
  'label',
  'due',
  'created',
  'undelivered',
  'q',
] as const;

/** The longest name of a view, in characters: the bar shows one line of it. */
export const VIEW_NAME_MAX = 60;

export type SavedViewsContext = {
  workspace: string;
  account: string;
  allowed: (action: Action) => boolean;
  /** The role and the sites of the caller (FRU-250). */
  reach: () => Promise<Reach | undefined>;
  accounts: Pick<AccountStore, 'savedViews' | 'addSavedView' | 'renameSavedView' | 'removeSavedView'>;
  now: number;
  headers: Record<string, string>;
};

const ONE = /^\/views\/([A-Za-z0-9_-]+)$/;

/** The routes, or `undefined` for another path. */
export async function handleSavedViews(
  rest: string,
  request: Request,
  context: SavedViewsContext,
): Promise<Response | undefined> {
  const one = ONE.exec(rest);
  if (rest !== '/views' && one === null) return undefined;
  const { headers } = context;
  if (!context.allowed('read-feedback')) return json(403, { error: 'forbidden' }, headers);
  const reach = await context.reach();
  if (reach === undefined) return json(404, { error: 'not-found' }, headers);

  if (one === null) {
    if (request.method === 'GET') {
      const views = await context.accounts.savedViews(context.workspace, context.account);

      return json(
        200,
        { views: views.filter((view) => checked(view.filters, context, reach) === 'ok').map(viewOf) },
        headers,
      );
    }
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
    const body = await readJsonObject(request);
    const name = nameOf(body?.name);
    if (name === undefined) return json(400, { error: 'invalid-name' }, headers);
    const filters = filtersOf(body?.filters);
    if (filters === undefined) return json(400, { error: 'invalid-filters' }, headers);
    const check = checked(filters, context, reach);
    if (check === 'forbidden') return json(403, { error: 'forbidden' }, headers);
    if (check !== 'ok') return json(400, { error: 'invalid-filters', field: check.invalid }, headers);
    const added = await context.accounts.addSavedView(
      context.workspace,
      context.account,
      { name, filters },
      context.now,
    );
    if (added.added) return json(201, { view: viewOf(added.view) }, headers);

    return added.reason === 'too-many'
      ? json(409, { error: 'too-many-views' }, headers)
      : json(404, { error: 'not-found' }, headers);
  }

  const id = one[1] as string;
  if (request.method === 'DELETE') {
    return (await context.accounts.removeSavedView(context.workspace, context.account, id))
      ? new Response(null, { status: 204, headers })
      : json(404, { error: 'not-found' }, headers);
  }
  if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
  const name = nameOf((await readJsonObject(request))?.name);
  if (name === undefined) return json(400, { error: 'invalid-name' }, headers);
  const renamed = await context.accounts.renameSavedView(context.workspace, context.account, id, name);

  return renamed === undefined
    ? json(404, { error: 'not-found' }, headers)
    : json(200, { view: viewOf(renamed) }, headers);
}

/** A view as the console reads it. */
function viewOf(view: SavedView) {
  return { id: view.id, name: view.name, filters: view.filters, createdAt: view.createdAt };
}

/** A name of one line, trimmed, of 1 to `VIEW_NAME_MAX` characters; `undefined` otherwise. */
function nameOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim();
  if (name === '' || [...name].length > VIEW_NAME_MAX || /\p{Cc}/u.test(name)) return undefined;

  return name;
}

/**
 * The filters of a body: an object of at least one filter of `VIEW_FILTERS`, each a text that is not
 * empty. A view with no filter is the whole list, which « Notes » already is. `undefined` otherwise.
 */
function filtersOf(value: unknown): SavedViewFilters | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length === 0) return undefined;
  const filters: Record<string, string> = {};
  for (const [name, each] of entries) {
    if (!(VIEW_FILTERS as readonly string[]).includes(name) || typeof each !== 'string' || each === '') {
      return undefined;
    }
    filters[name] = each;
  }

  return filters;
}

/**
 * Whether the caller reads the list of these filters: `ok`, `forbidden`, or the field the list refuses.
 * The list reads `created=week` as an instant (`since`), and « Overdue » and « Due this week » with the
 * day of the person (`today`): the check gives it both, as the console does.
 */
function checked(
  filters: SavedViewFilters,
  context: Pick<SavedViewsContext, 'account' | 'allowed'>,
  reach: Reach,
): 'ok' | 'forbidden' | { invalid: string } {
  const params = new URLSearchParams();
  for (const name of VIEW_FILTERS) {
    const value = filters[name];
    if (value === undefined || name === 'created') continue;
    params.set(name, value);
  }
  if (filters.created !== undefined) {
    if (filters.created !== 'week') return { invalid: 'invalid-created' };
    params.set('since', '0');
  }
  if (filters.due === 'overdue' || filters.due === 'week') params.set('today', '2026-01-01');
  const query = queryOf(params, context.account, { console: true });
  if (!query.ok) return { invalid: query.error };
  if ((query.query.place !== undefined || query.query.undelivered === true) && !context.allowed('see-tracker')) {
    return 'forbidden';
  }
  if (query.query.site !== undefined && reach.sites !== 'every' && !reach.sites.includes(query.query.site)) {
    return 'forbidden';
  }

  return 'ok';
}
