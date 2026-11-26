import { type Answer, call } from './api.ts';
import { FILTERS, type Filter } from './parts/notes-model.ts';

/**
 * The views of the bar (FRU-697): a filter of the Notes screen, with a name. A view is a link to the
 * address of that filter, so a reload, the Back button and a shared link keep it.
 *
 * A view exists only for a filter that the worker reads: a view that it does not filter would show a
 * list it did not filter. The three of the mockup are: « New this week » (`created=week`, which the
 * worker reads as `since`, FRU-722), « Assigned to me » (`assignee=me`) and « Not delivered »
 * (`undelivered`, FRU-722).
 */
export type ViewId = 'new' | 'assigned' | 'undelivered';

export type SavedView = {
  id: ViewId;
  /** The filters of the view, as the address of the Notes screen writes them. */
  filters: Readonly<Partial<Record<Filter, string>>>;
  /**
   * Whether a guest has it. A guest is never given a task (FRU-673), and does not see where a note
   * went (FRU-250): the views of the tasks and of the deliveries are not theirs.
   */
  guests: boolean;
  /** A count of it is something that failed: drawn in red when it is more than zero. */
  alert?: true;
};

/** The views, in the order of the mockup. */
export const VIEWS: readonly SavedView[] = [
  { id: 'new', filters: { created: 'week' }, guests: true },
  { id: 'assigned', filters: { assignee: 'me' }, guests: false },
  { id: 'undelivered', filters: { undelivered: '1' }, guests: false, alert: true },
];

/** The views of a person of this role. */
export function viewsFor(role: string): readonly SavedView[] {
  return VIEWS.filter((view) => view.guests || role !== 'guest');
}

/** The address of a view: the Notes screen of the workspace, with the filters of the view. */
export function viewAddress(workspace: string, view: Pick<SavedView, 'filters'>): string {
  const query = new URLSearchParams();
  for (const name of FILTERS) {
    const value = view.filters[name];
    if (value !== undefined) query.set(name, value);
  }

  return `/w/${workspace}/notes?${query.toString()}`;
}

/**
 * The view whose filters are exactly the filters of `params`, the address of the Notes screen. A filter
 * more or less is another list, so no view. What is not a filter (the page, the table or the board, a
 * task opened) does not change the list.
 */
export function viewOf(params: URLSearchParams | Readonly<Partial<Record<Filter, string>>>): SavedView | undefined {
  const valueOf = (name: Filter) => (params instanceof URLSearchParams ? params.get(name) : params[name]) ?? '';

  return VIEWS.find((view) => FILTERS.every((name) => valueOf(name) === (view.filters[name] ?? '')));
}

/**
 * A view of the person (FRU-723): a name they chose and the filters of the Notes screen, kept by the
 * worker with their membership, so that it follows them from one browser to another. Nothing of it is
 * kept in the browser.
 */
export type PersonalView = { id: string; name: string; filters: Readonly<Partial<Record<Filter, string>>> };

/** The views a person keeps in a workspace: the bar shows them all. As `MAX_SAVED_VIEWS` of the worker. */
export const MAX_PERSONAL_VIEWS = 20;

/** The longest name of a view, as `VIEW_NAME_MAX` of the worker. */
export const VIEW_NAME_MAX = 60;

/** The filters that are on in `filters`, the filters of the Notes screen: a filter at `''` is off. */
export function filtersSet(filters: Readonly<Partial<Record<Filter, string>>>): Partial<Record<Filter, string>> {
  return Object.fromEntries(FILTERS.flatMap((name) => (filters[name] ? [[name, filters[name]]] : [])));
}

/** Whether two sets of filters make the same list: the same filters on, with the same values. */
export function sameFilters(
  one: Readonly<Partial<Record<Filter, string>>>,
  other: Readonly<Partial<Record<Filter, string>>>,
): boolean {
  return FILTERS.every((name) => (one[name] ?? '') === (other[name] ?? ''));
}

/** A view of the person as the worker answers it, or `undefined`: a filter it does not know is no view. */
function personalViewOf(value: unknown): PersonalView | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { id, name, filters } = value as Record<string, unknown>;
  if (typeof id !== 'string' || typeof name !== 'string' || typeof filters !== 'object' || filters === null) {
    return undefined;
  }
  const entries = Object.entries(filters);
  if (!entries.every(([key, each]) => (FILTERS as readonly string[]).includes(key) && typeof each === 'string')) {
    return undefined;
  }

  return { id, name, filters: Object.fromEntries(entries) as Partial<Record<Filter, string>> };
}

/**
 * The views of the person in a workspace, oldest first. Quiet, as the read of the bar: a read that
 * fails is `undefined`, and the bar shows no view of the person and offers no « Save view ».
 */
export async function readPersonalViews(workspace: string): Promise<PersonalView[] | undefined> {
  const answer = await call<{ views?: unknown }>('GET', `/console/workspaces/${workspace}/views`, undefined, {
    quiet: true,
  });
  if (!answer.ok || !Array.isArray(answer.data?.views)) return undefined;

  return answer.data.views.flatMap((each) => personalViewOf(each) ?? []);
}

/** Keeps a view of the person, with the filters that are on. */
export async function saveView(
  workspace: string,
  name: string,
  filters: Readonly<Partial<Record<Filter, string>>>,
): Promise<Answer<PersonalView>> {
  return viewAnswer(
    await call<{ view?: unknown }>('POST', `/console/workspaces/${workspace}/views`, {
      name,
      filters: filtersSet(filters),
    }),
  );
}

/** Gives a view of the person another name. */
export async function renameView(workspace: string, view: string, name: string): Promise<Answer<PersonalView>> {
  return viewAnswer(await call<{ view?: unknown }>('POST', `/console/workspaces/${workspace}/views/${view}`, { name }));
}

/** Deletes a view of the person. A view already gone is deleted too: the bar no longer shows it. */
export async function deleteView(workspace: string, view: string): Promise<boolean> {
  const answer = await call('DELETE', `/console/workspaces/${workspace}/views/${view}`);

  return answer.ok || answer.status === 404;
}

function viewAnswer(answer: Answer<{ view?: unknown }>): Answer<PersonalView> {
  if (!answer.ok) return answer;
  const view = personalViewOf(answer.data?.view);

  return view === undefined ? { ok: false, status: 502, error: 'invalid-answer' } : { ok: true, data: view };
}
