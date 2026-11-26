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
export function viewAddress(workspace: string, view: SavedView): string {
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
