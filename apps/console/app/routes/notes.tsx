import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { type Stage } from '../stages';
import { type Connector, type SiteChoice, call, siteChoices } from '../api';
import { type Fetched, type Listed, listedOf } from '../listed';
import { LinkButton, PageHead } from '../ui';
import { useWorkspace } from './workspace';
import { t } from '../i18n';
import { problemOf } from '../problems';
import { useTypedSearch } from '../typed-search';
import { useLocale } from '../use-locale';
import { STATUS_NOT_SAVED, STATUS_PROBLEMS } from '../note-status';
import { boardColumns } from '../board-columns';
import { NotesBoard } from '../parts/notes-board';
import { FILTERS, type IndexedNote, NOTES_PER_PAGE, type NotesAnswer, type View, pageOf } from '../parts/notes-model';
import { NotesFailed } from '../parts/note-parts';
import { NotePages } from '../parts/note-pages';
import { NotesFilters, Pinned, ViewChoice } from '../parts/notes-filters';
import { NotesTable } from '../parts/notes-table';
import { NoteCard } from '../parts/note-card';

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
  const { workspace } = useWorkspace();
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
  const [connectors, setConnectors] = useState<Connector[]>([]);
  useEffect(() => {
    void siteChoices(workspace.id).then((answer) => setSites(listedOf(answer, (data) => data.sites)));
    if (seesTracker)
      void call<{ connectors: Connector[] }>('GET', `${base}/connectors`).then((answer) => {
        if (answer.ok) setConnectors(answer.data.connectors);
      });
  }, [base, seesTracker, workspace.id]);

  const filters = useMemo(
    () =>
      Object.fromEntries(FILTERS.map((name) => [name, params.get(name) ?? ''])) as Record<
        (typeof FILTERS)[number],
        string
      >,
    [params],
  );
  const cursor = params.get('cursor') ?? '';
  const view: View = params.get('view') === 'board' ? 'board' : 'table';
  const from = Math.max(1, Number(params.get('from')) || 1);

  // The answer that is shown, and whether a read is on its way. A read again keeps the rows on the
  // screen until its answer comes: only the first read says « Loading… ».
  const [shown, setShown] = useState<Fetched<NotesAnswer>>('loading');
  const [reading, setReading] = useState(false);
  // The cursor of each page shown, by its number (FRU-587): « Previous » and the numbers of the
  // pages take them back. Kept by number, not as a pile, so that the buttons of the browser, which
  // change the address and not this list, leave each page with its own cursor; and for one list only,
  // the filters and the view of the address, so that a Back across a filter finds none of another
  // list. A reload starts it again: « Previous » then goes to the first page.
  const list = JSON.stringify([view, ...FILTERS.map((name) => filters[name])]);
  const at = pageOf(from);
  const [kept, setKept] = useState<{ list: string; pages: Readonly<Record<number, string>> }>({ list, pages: {} });
  const known: Readonly<Record<number, string>> = kept.list === list ? kept.pages : {};
  useEffect(
    () =>
      setKept((was) => {
        const pages = was.list === list ? was.pages : {};

        return was.list === list && pages[at] === cursor ? was : { list, pages: { ...pages, [at]: cursor } };
      }),
    [list, at, cursor],
  );
  const asked = useRef(0);
  // The counts of the last filter that the worker counted, and whether the next read is a press of
  // « Next » or « Previous » (FRU-502).
  const counted = useRef<{ filter: string; total: number; counts: NotesAnswer['counts'] } | undefined>(undefined);
  const paging = useRef(false);
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

  const read = useCallback(async () => {
    const mine = (asked.current += 1);
    setReading(true);
    const query = new URLSearchParams();
    for (const name of FILTERS) if (filters[name] !== '') query.set(name, filters[name]);
    // The table groups the notes by status (FRU-551): the worker reads them in that order, so that a
    // group goes on from one page to the next. The board draws a page by date in its columns.
    if (view === 'table') query.set('order', 'status');
    // The size of a page is asked, not left to the worker: the numbers of the pages count on it (FRU-587).
    query.set('limit', String(NOTES_PER_PAGE));
    // FRU-502: the counts read the whole filter. « Next » and « Previous » keep the ones of the
    // filter, so the worker reads the page alone. Any other read counts again: a reload, a filter, a
    // status that a person changed.
    const filter = query.toString();
    const kept = paging.current && cursor !== '' && counted.current?.filter === filter ? counted.current : undefined;
    paging.current = false;
    if (cursor !== '') query.set('cursor', cursor);
    if (kept !== undefined) query.set('counts', 'none');
    const answer = await call<Partial<NotesAnswer>>('GET', `${base}/notes?${query.toString()}`);
    // An answer to a question that is no longer asked is dropped: the filters moved on.
    if (mine !== asked.current) return;
    setReading(false);
    if (!answer.ok || !Array.isArray(answer.data?.notes)) return setShown('failed');
    const { total, counts } = answer.data;
    if (total !== undefined && counts !== undefined) counted.current = { filter, total, counts };
    const whole = total !== undefined && counts !== undefined ? { total, counts } : kept;
    setShown(whole === undefined ? 'failed' : { ...answer.data, notes: answer.data.notes, ...whole });
  }, [base, filters, cursor, view]);
  useEffect(() => void read(), [read]);
  // Only the read that follows the move: once it is drawn, a list emptied later takes no focus.
  useEffect(() => {
    if (movedOut && !reading) setMovedOut(false);
  }, [movedOut, reading, shown]);

  /** Sets filters, and goes back to the first page: a page of another list means nothing. */
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
    next.delete('cursor');
    next.delete('from');
    latest.current = next;
    setParams(next, { replace });
  }

  function page(to: 'next' | 'previous', answer: NotesAnswer) {
    paging.current = true;
    const next = new URLSearchParams(params);
    if (to === 'next' && answer.next !== undefined) {
      next.set('cursor', answer.next);
      next.set('from', String(from + answer.notes.length));
      setParams(next);
    } else {
      // The page before by its cursor and its number; the first page when its cursor is not known.
      // Never `from` less the notes of this page: the last page holds fewer than the others.
      go(known[at - 1] === undefined ? 1 : at - 1, answer);
    }
  }

  /** Whether a page has a known cursor: the first, the next one, and the pages shown since the filter. */
  const reach = (to: number, answer: NotesAnswer) =>
    to === 1 || (to === at + 1 && answer.next !== undefined) || known[to] !== undefined;

  /**
   * Goes to a page by its number (FRU-587): the next one by its cursor, another by the cursor it was
   * shown with, the first one with none. `reach` offers no other.
   */
  function go(to: number, answer: NotesAnswer) {
    // A page with no known cursor is not offered; a press that comes anyway reads nothing.
    if (!reach(to, answer)) return;
    if (to === at + 1) return page('next', answer);
    paging.current = true;
    const back = to === 1 ? '' : (known[to] ?? '');
    const next = new URLSearchParams(params);
    if (back === '') next.delete('cursor');
    else next.set('cursor', back);
    if (back === '' || to <= 1) next.delete('from');
    else next.set('from', String((to - 1) * NOTES_PER_PAGE + 1));
    setParams(next);
  }

  /**
   * Shows the table or the board. The filters stay; the list starts again on its first page, as the
   * table reads by status and the board by date (FRU-551): a cursor of one is no place in the other.
   */
  function show(next: View) {
    const changed = new URLSearchParams(latest.current);
    if (next === 'board') changed.set('view', 'board');
    else changed.delete('view');
    changed.delete('cursor');
    changed.delete('from');
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
  const sourceOf = (note: IndexedNote) => connectors.find((each) => each.id === note.place?.connector);

  return (
    <>
      <PageHead
        title={t('Notes')}
        lead={t('Every note left on the sites of {workspace}, and where it went.', { workspace: workspace.name })}
        className="mb-[24px]"
        {...(listed ? { action: <ViewChoice view={view} onChoose={show} /> } : {})}
      />

      {shown === 'loading' ? <p className="text-small text-muted">{t('Loading…')}</p> : null}

      {shown === 'failed' ? <NotesFailed onRetry={() => void read()} /> : null}

      {typeof shown === 'object' && shown.counts.all === 0 && !filtered ? (
        <p className="max-w-[640px] text-body text-muted">
          {t('No note yet. Notes show here as soon as someone leaves one on a site of {workspace}.', {
            workspace: workspace.name,
          })}
        </p>
      ) : null}

      {typeof shown === 'object' && (shown.counts.all > 0 || filtered) ? (
        <Pinned
          bar={
            <NotesFilters
              counts={shown.counts}
              connectors={connectors}
              sites={sites}
              seesTracker={seesTracker}
              filters={filters}
              onFilter={filter}
              typed={typed}
              onType={setTyped}
            />
          }
        >
          {shown.notes.length === 0 ? (
            <div className="flex flex-wrap items-center gap-x-[12px] text-body text-muted">
              <p>{t('No note matches.')}</p>
              <LinkButton
                autoFocus={movedOut}
                onClick={() => {
                  setTyped('');
                  filter({ place: '', site: '', stage: '', mine: '', q: '' });
                }}
              >
                {t('Clear the filters')}
              </LinkButton>
            </div>
          ) : (
            <>
              {view === 'board' ? (
                <NotesBoard
                  columns={boardColumns(
                    shown.notes,
                    siteInView === undefined ? undefined : shown.statuses?.[siteInView],
                  )}
                  busy={reading}
                  movable={(note) =>
                    note.canSetStatus === true && siteInView !== undefined && shown.statuses?.[siteInView] !== undefined
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
                />
              )}
              <NotePages
                from={from}
                shown={shown.notes.length}
                total={shown.total}
                first={cursor === ''}
                last={shown.next === undefined}
                onPage={(to) => page(to, shown)}
                // Opened from a link past the second page, the page before has no known cursor.
                previousIsFirst={at > 2 && known[at - 1] === undefined}
                numbers={{
                  at,
                  count: Math.ceil(shown.total / NOTES_PER_PAGE),
                  reach: (to) => reach(to, shown),
                  onGo: (to) => go(to, shown),
                }}
              />
            </>
          )}
        </Pinned>
      ) : null}
    </>
  );
}
