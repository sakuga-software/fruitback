import { FILTERS, type Filter } from './parts/notes-model.ts';

/**
 * The views of the bar (FRU-697): a filter of the Notes screen, with a name. A view is a link to the
 * address of that filter, so a reload, the Back button and a shared link keep it.
 *
 * A view exists only for a filter that the worker reads. The mockup draws three: « New this week »
 * needs a filter on the day a note was left, and « Not delivered » a filter on the deliveries. The
 * worker reads neither (FRU-722): a view that it does not filter would show a list it did not filter.
 */
export type ViewId = 'assigned';

export type SavedView = {
  id: ViewId;
  /** The filters of the view, as the address of the Notes screen writes them. */
  filters: Readonly<Partial<Record<Filter, string>>>;
  /** A guest is never given a task (FRU-673): a view of the tasks is not theirs. */
  guests: boolean;
};

/** The views, in the order of the mockup. */
export const VIEWS: readonly SavedView[] = [{ id: 'assigned', filters: { assignee: 'me' }, guests: false }];

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
