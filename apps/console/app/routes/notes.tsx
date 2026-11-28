import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { type Stage } from '../stages';
import { type Connector, type SiteChoice, call, siteChoices } from '../api';
import { type Fetched, type Listed, listedOf } from '../listed';
import { Button, LinkButton, Problem } from '../ui';
import { ReadProblem } from '../read-problem';
import { useWorkspace } from './workspace';
import { t } from '../i18n';
import { problemOf } from '../problems';
import { useTypedSearch } from '../typed-search';
import { useLocale } from '../use-locale';
import { STATUS_NOT_SAVED, STATUS_PROBLEMS } from '../note-status';
import { boardColumns } from '../board-columns';
import { NotesBoard } from '../parts/notes-board';
import {
  FILTERS,
  weekStart,
  type IndexedNote,
  type NotesAnswer,
  type View,
  byRank,
  groupsOf,
  placeBetween,
} from '../parts/notes-model';
import { NotesFailed } from '../parts/note-parts';
import { NotesMore, moreStore } from '../parts/notes-more';
import { NOTES_PER_READ, againLimit, appended, hasMore, wanted } from '../notes-chunks';
import { NotesHead, NotesToolbar, Pinned, Places } from '../parts/notes-filters';
import { NotesTable, useFoldedGroups } from '../parts/notes-table';
import { NoteCard } from '../parts/note-card';
import { dayFromToday } from '../parts/task-menu';
import { TASK_NOT_SAVED, TASK_PROBLEMS, useTaskSeam } from '../parts/task-seam';
import { TaskPanel } from '../parts/task-panel';
import { isNewTaskKey, useTaskCreate } from '../parts/task-create';
import { copyShortcutOf, useTaskCopy } from '../parts/task-copy';
import { siteOfId } from '../note-id';
import { SelectionStatus, useSelectionKeys, useTaskSelection } from '../parts/task-selection';
import { TaskBulkBar, TaskContexts } from '../parts/task-bulk-bar';
import { VIEWS, filtersSet, sameFilters, saveView, viewOf, viewsFor } from '../saved-views';
import { ViewNameDialog, viewProblem } from '../parts/view-dialogs';

/** FRU-655: the filters on the fields of the tasks Fruitback keeps. */
const TASK_FILTERS = ['assignee', 'priority', 'label', 'due'] as const;

/**
 * Every note left on the sites of a workspace, and where it went: screen 10 of the mockup of
 * 2026-10-13 (FRU-245), read from the index of the notes (FRU-244). The page shows the first 64
 * characters of a note, which is all that Fruitback keeps of its text (Q6); the whole note is read in
 * the tracker, or on the page.
 *
 * **Nothing that a pointer can reach moves when the list is read again**: the rows that are shown stay
 * until the answer replaces them, and the chips and the filters are above them (the rule of FRU-271).
 */
export default function Notes() {
  useLocale();
  const { workspace, me, viewCounted, personalViews, viewSaved } = useWorkspace();
  // FRU-697: the bar counts a view from the read of its filter. A ref: a new function each render of
  // the frame must not read the list again.
  const reportView = useRef(viewCounted);
  reportView.current = viewCounted;
  // FRU-685: the groups folded, by person and workspace.
  const { folded, fold } = useFoldedGroups(me.account.id, workspace.id);
  const [params, setParams] = useSearchParams();
  // The address as the last change wrote it. A render can still carry the address of before a
  // navigation lands: it is taken only when the address of React Router changes.
  const latest = useRef(params);
  useEffect(() => {
    latest.current = params;
  }, [params]);
  const seesTracker = workspace.role !== 'guest';
  const manages = workspace.role === 'owner' || workspace.role === 'admin';
  const base = `/console/workspaces/${workspace.id}`;

  // The sites name the filter « Site » and the site of a verified author; the connectors name the
  // chips. Both are read once, with the first page.
  // Their id and address only, by address (FRU-497): no count of the notes of every site.
  const [sites, setSites] = useState<Listed<SiteChoice>>('loading');
  // FRU-682: a read that failed is no empty list. The screen says it, with « Try again ».
  const [connectors, setConnectors] = useState<Listed<Connector>>('loading');
  // The read asked last: the answer of a read of before is dropped, as the address can go to the
  // notes of another workspace while it is on its way.
  const connectorsAsked = useRef(0);
  const readConnectors = useCallback(async () => {
    const mine = (connectorsAsked.current += 1);
    setConnectors('loading');
    const answer = await call<{ connectors: Connector[] }>('GET', `${base}/connectors`);
    if (mine !== connectorsAsked.current) return;
    setConnectors(listedOf(answer, (data) => data.connectors));
  }, [base]);
  useEffect(() => {
    void siteChoices(workspace.id).then((answer) => setSites(listedOf(answer, (data) => data.sites)));
    if (seesTracker) void readConnectors();
  }, [readConnectors, seesTracker, workspace.id]);

  // Where a note went is about the tracker (FRU-722): a guest's link with `place` or `undelivered`,
  // which the worker refuses them, reads as the list without that filter, and shows no chip of it.
  const filters = useMemo(
    () =>
      Object.fromEntries(
        FILTERS.map((name) => [
          name,
          !seesTracker && (name === 'place' || name === 'undelivered') ? '' : (params.get(name) ?? ''),
        ]),
      ) as Record<(typeof FILTERS)[number], string>,
    [params, seesTracker],
  );
  const view: View = params.get('view') === 'board' ? 'board' : 'table';
  // FRU-723: « Save view » once a filter is on, and the filters are not a view of the bar already.
  // A failed read of the views of the person offers none: a view saved twice would show twice.
  const [naming, setNaming] = useState(false);
  const fixed = viewOf(filters);
  const savable =
    personalViews !== undefined &&
    Object.keys(filtersSet(filters)).length > 0 &&
    (fixed === undefined || !viewsFor(workspace.role).includes(fixed)) &&
    !personalViews.some((kept) => sameFilters(kept.filters, filters));
  // FRU-724: the list, as one key: the workspace, the view and the filters. A new list starts again
  // from its first notes; anything else in the address (the task opened) reads nothing.
  const list = JSON.stringify([base, view, ...FILTERS.map((name) => filters[name])]);

  // The answer that is shown, and whether a read is on its way. A read again keeps the rows on the
  // screen until its answer comes: only the first read says « Loading… ».
  const [shown, setShown] = useState<Fetched<NotesAnswer>>('loading');
  const [reading, setReading] = useState(false);
  // FRU-724: the notes after the list are read as it scrolls, by the cursor of the last answer. Their
  // read is apart: it adds to the list, and one that failed leaves the list on the screen.
  const [more] = useState(moreStore);
  // What the screen shows now, for a read that started before it: a read again reads back as many
  // notes, and the next notes go on from its cursor. Set with the state, not at the next render: a
  // read can start between the two (raised in review).
  const now = useRef(shown);
  const draw = (next: Fetched<NotesAnswer>) => {
    now.current = next;
    setShown(next);
  };
  // Whether the list is read, from the moment its read starts: a render can come after it.
  const busy = useRef(false);
  // Each read of the list takes a number; the answer of a read of before is dropped, and the read of
  // the next notes that it began with too. `moreFrom` is the cursor of the next notes on their way:
  // a press, or the observer, while they are read asks nothing again (FRU-709).
  const asked = useRef(0);
  const moreFrom = useRef<string | undefined>(undefined);
  // FRU-697: the read asked by a change of the list. Any other read is a read again, after a write (a
  // status, a task, « Send again ») or « Try again ».
  const asNew = useRef(false);
  // A new list is drawn from its top: the filters stay pinned, and its first notes are under them.
  const toTop = useRef(false);
  // A select of the board moved a note (FRU-436). If the read after it leaves no note under the
  // filters, the board is gone with the select that had the focus: « Clear the filters » takes it.
  const [movedOut, setMovedOut] = useState(false);
  // A status saved in the table (FRU-551): the row goes to the group of its status once the list is
  // read again, and the keyboard finds its select there, where it left it.
  const [refocus, setRefocus] = useState<string | undefined>();
  useEffect(() => {
    if (refocus === undefined || reading) return;
    setRefocus(undefined);
    const moved = [...document.querySelectorAll<HTMLElement>('tr[data-note]')].find(
      (row) => row.dataset.note === refocus,
    );
    moved?.querySelector<HTMLElement>('.select__trigger')?.focus();
  }, [refocus, reading, shown]);

  /** The query of the list: its filters and its order, with no cursor and no size. */
  const queryOf = useCallback(() => {
    const query = new URLSearchParams();
    for (const name of FILTERS) if (filters[name] !== '' && name !== 'created') query.set(name, filters[name]);
    // FRU-722: « This week » starts on a day of the person, which the worker cannot know: an instant.
    if (filters.created === 'week') query.set('since', String(weekStart()));
    // FRU-655: « Overdue » and « Due this week » count from the day of the person, which the worker
    // cannot know.
    if (filters.due === 'overdue' || filters.due === 'week') query.set('today', dayFromToday(0));
    // The table groups the notes by status (FRU-551): the worker reads them in that order, so that a
    // group goes on from one read to the next. The board draws its notes by date in its columns.
    if (view === 'table') query.set('order', 'status');

    return query;
    // `list` is made of the workspace, the view and the filters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list]);

  /**
   * Reads the list from its first notes. A read again (after a write, or « Try again ») reads back as
   * many notes as the screen shows, so that the person stays where they were in it.
   */
  const read = useCallback(async () => {
    const mine = (asked.current += 1);
    const fresh = asNew.current;
    // FRU-697: a read again follows a write, which can change what a view counts. The counts of the
    // views go when it starts, not when it is answered: its answer can be dropped (raised in review).
    // A view read again says its new count with its answer.
    if (!fresh) for (const each of VIEWS) reportView.current(each.id, undefined);
    asNew.current = false;
    more.set({ state: 'idle' });
    busy.current = true;
    setReading(true);
    // The next notes on their way count too: this read drops their answer, so it reads them back.
    const was = now.current;
    const coming = moreFrom.current === undefined ? 0 : NOTES_PER_READ;
    const want = fresh ? NOTES_PER_READ : wanted((typeof was === 'object' ? was.notes.length : 0) + coming);
    moreFrom.current = undefined;
    let got: NotesAnswer | undefined;
    let failed = false;
    do {
      const query = queryOf();
      // The size of a read is asked, not left to the worker.
      query.set('limit', String(againLimit(got?.notes.length ?? 0, want)));
      // FRU-502: the counts read the whole filter, once, with the first notes. The next ones are read alone.
      if (got?.next !== undefined) {
        query.set('cursor', got.next);
        query.set('counts', 'none');
      }
      const answer = await call<Partial<NotesAnswer>>('GET', `${base}/notes?${query.toString()}`);
      // An answer to a question that is no longer asked is dropped: the filters moved on.
      if (mine !== asked.current) return;
      if (!answer.ok || !Array.isArray(answer.data?.notes)) {
        // The first notes did not load: the alert. Later ones: the notes read stay, with « Try again ».
        failed = got !== undefined;
        break;
      }
      if (got === undefined) {
        const { total, counts } = answer.data;
        if (total === undefined || counts === undefined) break;
        // The filters of a view and no other: the total is the count of that view (FRU-697).
        const counted = viewOf(filters);
        if (counted !== undefined) reportView.current(counted.id, total);
        got = { ...answer.data, notes: answer.data.notes, total, counts };
      } else got = appended(got, { ...answer.data, notes: answer.data.notes });
    } while (got.next !== undefined && got.notes.length < want);
    busy.current = false;
    setReading(false);
    if (got === undefined) return draw('failed');
    if (fresh) toTop.current = true;
    more.set({ state: failed ? 'failed' : 'idle', arrived: undefined });
    draw(got);
    // `list` is made of the workspace, the view and the filters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list]);
  useEffect(() => {
    asNew.current = true;
    void read();
  }, [read]);
  // Only the read that follows the move: once it is drawn, a list emptied later takes no focus.
  useEffect(() => {
    if (movedOut && !reading) setMovedOut(false);
  }, [movedOut, reading, shown]);

  /**
   * Reads the notes after the list, by the cursor of its last answer (FRU-724): from the observer at
   * the end of the list, « Load more » and « Try again ». One read at a time: a press while the next
   * notes are on their way asks nothing, and the list goes on from them once they are drawn.
   */
  const readMore = useCallback(async () => {
    const list = now.current;
    // While the list is read, its cursor is the one of the list of before.
    if (busy.current || typeof list !== 'object' || !hasMore(list) || moreFrom.current !== undefined) return;
    const mine = asked.current;
    const from = list.next as string;
    moreFrom.current = from;
    more.set({ state: 'reading' });
    const query = queryOf();
    query.set('limit', String(NOTES_PER_READ));
    query.set('cursor', from);
    query.set('counts', 'none');
    const answer = await call<Partial<NotesAnswer>>('GET', `${base}/notes?${query.toString()}`);
    // The list was read again, or another list chosen, meanwhile: this read is of none of them.
    if (mine !== asked.current || moreFrom.current !== from) return;
    moreFrom.current = undefined;
    if (!answer.ok || !Array.isArray(answer.data?.notes)) return more.set({ state: 'failed' });
    const chunk = { ...answer.data, notes: answer.data.notes };
    more.set({ state: 'idle', arrived: chunk.notes.length });
    const before = now.current;
    if (typeof before === 'object') draw(appended(before, chunk));
    // `list` is made of the workspace, the view and the filters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list]);

  // A new list is drawn from its top, under the filters, whatever was scrolled in the list of before.
  useLayoutEffect(() => {
    if (!toTop.current || typeof shown !== 'object') return;
    toTop.current = false;
    const top = document.querySelector('[data-pinned-filters]')?.parentElement?.getBoundingClientRect().top;
    if (top !== undefined && top < 0) window.scrollBy(0, top);
  }, [shown]);

  /** Sets filters: a new list, read from its first notes. */
  function filter(changes: Partial<Record<(typeof FILTERS)[number], string>>, replace = false) {
    setMovedOut(false);
    // From the address as it is when the change lands, not as it was when it was asked: the search
    // writes 300 ms after its key, and a list chosen meanwhile must not be undone by it. The setter of
    // React Router reads the address of the render that made it, so the latest one is kept here.
    const next = new URLSearchParams(latest.current);
    for (const [name, value] of Object.entries(changes)) {
      if (value === '' || value === undefined) next.delete(name);
      else next.set(name, value);
    }
    latest.current = next;
    setParams(next, { replace });
  }

  /**
   * Shows the table or the board. The filters stay; the list starts again from its first notes, as
   * the table reads by status and the board by date (FRU-551): a cursor of one is no place in the other.
   */
  function show(next: View) {
    const changed = new URLSearchParams(latest.current);
    if (next === 'board') changed.set('view', 'board');
    else changed.delete('view');
    latest.current = changed;
    setParams(changed);
  }

  const [typed, setTyped] = useTypedSearch(filters.q, (q) => filter({ q }, true));

  const originOf = (id: string) =>
    typeof sites === 'string' ? undefined : sites.find((site) => site.id === id)?.origin;
  const filtered = FILTERS.some((name) => filters[name] !== '');
  const listed = typeof shown === 'object' && (shown.counts.all > 0 || filtered);
  // The site whose statuses make the columns of the board: the one chosen, or the only one there is.
  let siteInView: string | undefined = filters.site === '' ? undefined : filters.site;
  if (siteInView === undefined && typeof sites === 'object' && sites.length === 1) siteInView = sites[0]?.id;
  const choose = (note: IndexedNote, status: string) =>
    call<{ status: string; stage: Stage }>('POST', `${base}/notes/${encodeURIComponent(note.id)}/status`, { status });
  const sourceOf = (note: IndexedNote) =>
    typeof connectors === 'string' ? undefined : connectors.find((each) => each.id === note.place?.connector);
  // FRU-665: the columns of the board, each in the order of its tasks.
  const columns = useMemo(
    () =>
      typeof shown === 'object'
        ? boardColumns(byRank(shown.notes), siteInView === undefined ? undefined : shown.statuses?.[siteInView])
        : [],
    [shown, siteInView],
  );
  // FRU-656: the tasks selected, in the order of the screen: the groups of the table, the columns of the board.
  const ordered = useMemo(() => {
    if (typeof shown !== 'object') return [];

    return view === 'board'
      ? columns.flatMap((column) => column.notes)
      : groupsOf(shown.notes).flatMap((group) => group.notes);
  }, [shown, view, columns]);
  const selection = useTaskSelection(ordered);
  useSelectionKeys(selection);
  // A selection emptied with the focus in its bar (« Clear », a deletion): the focus goes to the list.
  const selected = selection.notes.length;
  const wasSelected = useRef(0);
  useEffect(() => {
    if (
      wasSelected.current > 0 &&
      selected === 0 &&
      (document.activeElement === null || document.activeElement === document.body)
    ) {
      document.querySelector<HTMLElement>('[data-notes-list] [role="region"]')?.focus();
    }
    wasSelected.current = selected;
  }, [selected]);
  // FRU-731: a row of the table is drawn again only when what it shows changes, and keeps the writes of
  // its menu from the render that drew it. They read the list again through the latest `read`: the one
  // of the list now, never the one of the filters of before.
  const readNow = useRef(read);
  readNow.current = read;
  const readLatest = useCallback(() => readNow.current(), []);
  const columnOf = (note: IndexedNote) =>
    view === 'board' ? columns.find((column) => column.notes.some((each) => each.id === note.id))?.notes : undefined;
  // FRU-654: the menu of each task, its members, its labels and its writes.
  const tasks = useTaskSeam({
    columnOf,
    workspace: workspace.id,
    base,
    manages,
    statusesOf: (note) => (typeof shown === 'object' ? shown.statuses?.[note.site.id] : undefined),
    choose,
    read: readLatest,
  });

  // FRU-653: the page of a task, in the address: a link opens it, Escape and « Back » close it.
  // FRU-724: opening, stepping and closing keep the scroll of the list. A navigation of React Router
  // goes to the top of the window, unless it is asked not to (`ScrollRestoration` of the root).
  const opened = params.get('task') ?? undefined;
  const openTask = (note: IndexedNote) => {
    const next = new URLSearchParams(params);
    next.set('task', note.id);
    setParams(next, { preventScrollReset: true });
  };
  const closeTask = () => {
    // The address as it is now: a key can come after a press opened another note, and before React
    // drew it (FRU-687). The address of this render would close the note of before.
    const now = new URLSearchParams(window.location.search);
    const shut = now.get('task');
    now.delete('task');
    setParams(now, { preventScrollReset: true });
    // FRU-687: the focus goes back to the row of the note, where the person was in the list.
    const row = [...document.querySelectorAll<HTMLElement>('tr[data-note]')].find((each) => each.dataset.note === shut);
    row?.querySelector<HTMLElement>('[data-note-title]')?.focus();
  };
  // FRU-687: the arrows of the panel go to the note above or under it, as the list shows them.
  const shownInOrder = view === 'board' ? ordered : ordered.filter((note) => !folded.has(note.stage));
  const openAt = opened === undefined ? -1 : shownInOrder.findIndex((note) => note.id === opened);
  const stepTo = (note: IndexedNote) => {
    const next = new URLSearchParams(latest.current);
    next.set('task', note.id);
    latest.current = next;
    setParams(next, { replace: true, preventScrollReset: true });
    const row = [...document.querySelectorAll<HTMLElement>('tr[data-note]')].find(
      (each) => each.dataset.note === note.id,
    );
    row?.scrollIntoView({ block: 'nearest' });
  };
  const openedNote = typeof shown === 'object' ? shown.notes.find((note) => note.id === opened) : undefined;

  // FRU-657: « New task », at the head of the list and of each column of the board, and the key « C ».
  const create = useTaskCreate({
    base,
    sites: typeof sites === 'object' ? sites : [],
    // FRU-672: a member writes a task of the workspace, with no site; a guest reads none.
    workspaceTasks: seesTracker,
    siteInView,
    statusesOf: (site) => (typeof shown === 'object' ? shown.statuses?.[site] : undefined),
    people: tasks.seam.people,
    labels: tasks.seam.labels,
    onCreated: (id) => {
      void read();
      const next = new URLSearchParams(latest.current);
      next.set('task', id);
      latest.current = next;
      setParams(next, { preventScrollReset: true });
    },
  });
  const openCreate = create.open;

  // FRU-658: the link, the ID and the Markdown of a task, from its menu, its panel and the keyboard.
  const taskCopy = useTaskCopy({
    base,
    workspace: workspace.id,
    statusesOf: (site) => (typeof shown === 'object' ? shown.statuses?.[site] : undefined),
  });
  const copyRef = useRef<{ copy: typeof taskCopy.copy; noteOf: (id: string) => IndexedNote | undefined }>(undefined);
  copyRef.current = {
    copy: taskCopy.copy,
    noteOf: (id) => (typeof shown === 'object' ? shown.notes.find((note) => note.id === id) : undefined),
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const kind = copyShortcutOf(event);
      const current = copyRef.current;
      if (kind === undefined || current === undefined) return;
      // The row or the card that holds the focus, else the task of the panel. The address is read as
      // it is now: a panel closed a moment ago is out of it already, whatever React drew.
      const focused = document.activeElement?.closest<HTMLElement>('[data-note]')?.dataset.note;
      const id = focused ?? new URLSearchParams(window.location.search).get('task') ?? undefined;
      if (id === undefined) return;
      const note = current.noteOf(id) ?? { id, site: { id: siteOfId(id) }, unlisted: true as const };
      event.preventDefault();
      if (kind === 'link') current.copy.link([note]);
      else current.copy.identifier([note]);
    };
    document.addEventListener('keydown', onKey);

    return () => document.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isNewTaskKey(event)) return;
      event.preventDefault();
      openCreate();
    };
    document.addEventListener('keydown', onKey);

    return () => document.removeEventListener('keydown', onKey);
  }, [openCreate]);
  const newTask = (
    <Button
      tone="primary"
      size="panel"
      onClick={() => create.open()}
      // FRU-672: a member with no site yet writes a task of the workspace.
      disabled={typeof sites !== 'object' || (sites.length === 0 && !seesTracker)}
    >
      {t('New task')}
      {/* The key, in a box of its own: the glyph alone was cut by the end of the button. */}
      <kbd
        className="ml-[6px] inline-flex h-[18px] min-w-[18px] flex-none items-center justify-center rounded-inner border border-page/50 px-[4px] font-sans text-tiny leading-none font-semibold text-page"
        aria-hidden="true"
      >
        C
      </kbd>
    </Button>
  );

  return (
    <TaskContexts seam={{ ...tasks.seam, openTask, copy: taskCopy.copy }} selection={selection}>
      {taskCopy.status}
      {tasks.dialog}
      {create.dialog}
      <SelectionStatus />
      <TaskPanel
        id={opened}
        listed={openedNote}
        base={base}
        source={openedNote === undefined ? undefined : sourceOf(openedNote)}
        origin={openedNote === undefined ? undefined : originOf(openedNote.site.id)}
        previous={openAt > 0 ? shownInOrder[openAt - 1] : undefined}
        next={openAt >= 0 ? shownInOrder[openAt + 1] : undefined}
        onStep={stepTo}
        onClose={closeTask}
      />
      {/* FRU-687: beside the panel, from 1024 px, the screen keeps the room the panel takes. */}
      <div className={opened === undefined ? '' : 'min-[1024px]:mr-[440px]'}>
        {/* FRU-686: the head of 48 px, « Notes » and a tab per place, then « New task ». */}
        <NotesHead
          tabs={
            typeof shown === 'object' && listed && seesTracker ? (
              <Places
                counts={shown.counts}
                connectors={connectors}
                chosen={filters.place}
                onChoose={(place) => filter({ place })}
              />
            ) : null
          }
          action={newTask}
        />

        {/* FRU-682: the connectors name the places and the tracker of a note. A read that failed says so. */}
        {seesTracker && connectors === 'failed' ? (
          <div className="mt-[16px] flex flex-col items-start gap-[8px]" data-connectors-failed="">
            <Problem>
              {t('The connectors of this workspace did not load.')} <ReadProblem />
            </Problem>
            <Button tone="outline" onClick={() => void readConnectors()}>
              {t('Try again')}
            </Button>
          </div>
        ) : null}

        {shown === 'loading' ? <p className="mt-[24px] text-small text-muted">{t('Loading…')}</p> : null}

        {shown === 'failed' ? (
          <div className="mt-[24px]">
            <NotesFailed onRetry={() => void read()} />
          </div>
        ) : null}

        <ViewNameDialog
          open={naming}
          title={t('Save view')}
          saveLabel={t('Save view')}
          onClose={() => setNaming(false)}
          onSave={async (name) => {
            const saved = await saveView(workspace.id, name, filters);
            if (!saved.ok) return viewProblem(saved);
            viewSaved(saved.data);

            return undefined;
          }}
        />

        {typeof shown === 'object' && shown.counts.all === 0 && !filtered ? (
          <p className="mt-[24px] max-w-[640px] text-body text-muted">
            {t('No note yet. Notes show here as soon as someone leaves one on a site of {workspace}.', {
              workspace: workspace.name,
            })}
          </p>
        ) : null}

        {typeof shown === 'object' && (shown.counts.all > 0 || filtered) ? (
          <Pinned
            bar={
              <NotesToolbar
                total={shown.total}
                sites={sites}
                filters={filters}
                onFilter={filter}
                typed={typed}
                onType={setTyped}
                view={view}
                onView={show}
                seesTracker={seesTracker}
                {...(savable ? { onSaveView: () => setNaming(true) } : {})}
                // FRU-655: the filters on the tasks, once the list holds one Fruitback keeps, or one is set.
                {...(shown.notes.some((note) => note.task !== undefined) ||
                TASK_FILTERS.some((name) => filters[name] !== '')
                  ? {
                      tasks: {
                        people: tasks.seam.people,
                        peopleRead: tasks.seam.peopleRead,
                        readPeople: tasks.seam.readPeople,
                        labels: tasks.seam.labels,
                        labelsRead: tasks.seam.labelsRead,
                        readLabels: tasks.seam.readLabels,
                      },
                    }
                  : {})}
              />
            }
          >
            {shown.notes.length === 0 ? (
              <div className="flex flex-wrap items-center gap-x-[12px] pt-[16px] text-body text-muted">
                <p>{t('No note matches.')}</p>
                <LinkButton
                  autoFocus={movedOut}
                  onClick={() => {
                    setTyped('');
                    // Every filter of the address, so that a filter added later is cleared too (FRU-722).
                    filter(Object.fromEntries(FILTERS.map((name) => [name, ''])));
                  }}
                >
                  {t('Clear the filters')}
                </LinkButton>
              </div>
            ) : (
              <div data-notes-list="" data-selecting={selected > 0}>
                {view === 'board' ? (
                  <NotesBoard
                    columns={columns}
                    onAdd={(column) =>
                      create.open({
                        ...(siteInView === undefined ? {} : { site: siteInView }),
                        status: column.status?.key ?? `own:${column.stage}`,
                      })
                    }
                    reorder={async (note, before, after) => {
                      if (note.task === undefined || note.canSetStatus !== true) return undefined;
                      const answer = await call('POST', `${base}/notes/${encodeURIComponent(note.id)}/task`, {
                        position: placeBetween(before, after),
                      });
                      if (!answer.ok) return problemOf(answer, TASK_PROBLEMS, TASK_NOT_SAVED);
                      await read();

                      return undefined;
                    }}
                    busy={reading}
                    movable={(note) =>
                      note.canSetStatus === true &&
                      siteInView !== undefined &&
                      shown.statuses?.[siteInView] !== undefined
                    }
                    move={async (note, status) => {
                      const answer = await choose(note, status);
                      if (!answer.ok) return problemOf(answer, STATUS_PROBLEMS, STATUS_NOT_SAVED);
                      await read();

                      return undefined;
                    }}
                    card={(note, moved) => (
                      <NoteCard
                        note={note}
                        source={sourceOf(note)}
                        seesTracker={seesTracker}
                        statuses={shown.statuses?.[note.site.id]}
                        choose={(status) => choose(note, status)}
                        onSaved={() => {
                          moved();
                          setMovedOut(true);
                          void read();
                        }}
                      />
                    )}
                  />
                ) : (
                  <NotesTable
                    notes={shown.notes}
                    counts={shown.counts}
                    statuses={shown.statuses}
                    seesTracker={seesTracker}
                    manages={manages}
                    reading={reading}
                    base={base}
                    originOf={originOf}
                    sourceOf={sourceOf}
                    choose={choose}
                    onSent={() => void read()}
                    onStatusSaved={(note) => {
                      setRefocus(note);
                      void read();
                    }}
                    folded={folded}
                    onFold={fold}
                    opened={opened}
                    // FRU-685: « + » in the head of a group, a new task of its stage. FRU-672: a member
                    // with no site yet writes a task of the workspace, as with « New task ».
                    onAdd={
                      typeof sites === 'object' && (sites.length > 0 || seesTracker)
                        ? (stage) =>
                            create.open({
                              ...(siteInView === undefined ? {} : { site: siteInView }),
                              status: `own:${stage}`,
                            })
                        : undefined
                    }
                  />
                )}
                <NotesMore
                  shown={shown.notes.length}
                  total={shown.total}
                  more={hasMore(shown)}
                  store={more}
                  onMore={() => void readMore()}
                />
                <TaskBulkBar />
              </div>
            )}
          </Pinned>
        ) : null}
      </div>
    </TaskContexts>
  );
}
