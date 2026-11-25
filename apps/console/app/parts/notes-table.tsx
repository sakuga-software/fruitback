import { type ReactNode, type RefObject, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { STAGE_NAMES, type Stage } from '../stages';
import { type Answer, type Connector, call } from '../api';
import { ago, agoShort } from '../ago';
import { IconButton, IconLink, Problem, SelectBox, StatusDot, TextButton } from '../ui';
import { t } from '../i18n';
import { failureOf, writeProblemOf } from '../problems';
import { useLocale } from '../use-locale';
import { hostOf } from '../site-address';
import { NoteIcon } from '../note-icons';
import { type StatusChoice } from '../note-status';
import { type IndexedNote, type NotesAnswer, groupsOf } from './notes-model';
import { Author, NoteStatus, PlaceCell, excerptOf } from './note-parts';
import { TaskMarks } from './task-marks';
import { TaskMenuContext, useTaskMenu } from './task-menu';
import { SelectTask, TaskSelectionContext, ownsKeys, useSelectRow } from './task-selection';

/**
 * The columns of the list (FRU-685), by the width of the list (a container query): what a row loses
 * first where the list is narrow. No cell ever goes on a second line: a column that has no room goes.
 * The head of each column is for a screen reader; its width is the width of the column.
 */
const COLUMNS = {
  lead: 'w-[64px]',
  note: '',
  path: 'w-[132px] @max-[960px]:w-0',
  site: 'w-[162px] @max-[800px]:w-0',
  place: 'w-[124px] @max-[600px]:w-0',
  author: 'w-[36px] @max-[440px]:w-0',
  when: 'w-[48px]',
  actions: 'w-[68px]',
} as const;

/**
 * A cell of a column that has no room: empty, its column 0 px wide. Not `display: none`, which takes a
 * column out of the table: the head of a group still spans every column, and the room of a column
 * taken out would go to no cell.
 */
const GONE = {
  lead: '',
  note: '',
  path: '@max-[960px]:[&>*]:hidden',
  site: '@max-[800px]:[&>*]:hidden',
  place: '@max-[600px]:[&>*]:hidden',
  author: '@max-[440px]:[&>*]:hidden',
  when: '',
  actions: '',
} as const;

/** A cell of a row: one line of 36 px, its border counted. What is longer is cut with « … ». */
const LINE = 'flex h-[35px] min-w-0 items-center';

/**
 * The actions of a row (the page, the menu): shown under the pointer and the keyboard, on a touch
 * screen, and on the row of the panel. They keep their room, so nothing moves when they show.
 */
const REVEALED =
  'opacity-0 [tr:hover_&]:opacity-100 [tr:focus-within_&]:opacity-100 [tr[data-selected=true]_&]:opacity-100 pointer-coarse:opacity-100';

export function NoteRow({
  note,
  seesTracker,
  origin,
  source,
  manages,
  retry,
  onSent,
  onStatusSaved,
  statuses,
  choose,
}: {
  note: IndexedNote;
  /** The column « Went to » is there: the worker tells a guest nothing of where a note went (FRU-244). */
  seesTracker: boolean;
  /** The origin of the site of the note, when the sites were read. */
  origin: string | undefined;
  /** The connector the note went to, when the connectors were read: it may have a name (FRU-404). */
  source: Connector | undefined;
  manages: boolean;
  retry: () => Promise<{ ok: true } | { ok: false; status: number; error: string }>;
  onSent: () => void;
  /** A status saved from the drop: the list is read again, and the focus follows the row. */
  onStatusSaved: () => void;
  statuses: readonly StatusChoice[] | undefined;
  choose: (status: string) => Promise<Answer<{ status: string; stage: Stage }>>;
}) {
  useLocale();
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState<string | undefined>();
  // A status the worker did not save (FRU-551): said under the note, the select keeps the choice.
  const [statusRefused, setStatusRefused] = useState<string | undefined>();
  // FRU-654: the menu of the task, on its button and on a right click of the row.
  const taskMenu = useTaskMenu(note);
  // FRU-656: its box, and Shift and a click on the row for a range.
  const selectRow = useSelectRow(note);
  // The link of the widget opens the note by the id it gave it, or by its issue (FRU-253).
  const opened = note.note ?? note.ref;
  const show = opened === undefined ? note.page.url : `${note.page.url}#fruitback-note=${encodeURIComponent(opened)}`;
  // FRU-685: the site is its host, after its tile.
  const host = hostOf(origin ?? note.page.host);

  async function send() {
    setSending(true);
    setRefused(undefined);
    const sent = await retry();
    setSending(false);
    if (!sent.ok) return setRefused(writeProblemOf(sent, failureOf(sent)));
    onSent();
  }

  // What a row says under its line: a refusal, or « Delete… » asked again. Only then is a row taller.
  const under: ReactNode[] = [];
  if (statusRefused !== undefined) under.push(<Problem key="status">{t(statusRefused)}</Problem>);
  if (taskMenu.problem !== undefined) under.push(<Problem key="menu">{t(taskMenu.problem)}</Problem>);
  if (refused !== undefined) under.push(<Problem key="sent">{t(refused)}</Problem>);
  if (taskMenu.confirm !== null) under.push(<span key="confirm">{taskMenu.confirm}</span>);

  return (
    <tr data-note={note.id} onContextMenu={taskMenu.onContextMenu} onKeyDown={taskMenu.onKeyDown} {...selectRow}>
      <td className={GONE.lead}>
        {/* FRU-551: the status is its drop before the note, a list of the statuses for whoever may
          change it; the group above says it in words. */}
        <span className={`${LINE} gap-[2px] pl-[6px]`}>
          <SelectTask note={note} room />
          <span className="flex size-[28px] flex-none items-center justify-center">
            <NoteStatus
              note={note}
              statuses={statuses}
              choose={choose}
              onSaved={onStatusSaved}
              onRefused={setStatusRefused}
              bare
            />
          </span>
        </span>
      </td>
      <td className={GONE.note}>
        <span className={`${LINE} gap-[10px]`}>
          <NoteTitle note={note}>{excerptOf(note.excerpt)}</NoteTitle>
          <TaskMarks task={note.task} line />
        </span>
        {under.length === 0 ? null : <span className="flex flex-col gap-[6px] pr-[12px] pb-[10px]">{under}</span>}
      </td>
      <td className={GONE.path}>
        <span className={`${LINE} justify-end text-muted`}>
          <span className="truncate" title={note.page.path}>
            {note.page.path}
          </span>
        </span>
      </td>
      <td className={GONE.site}>
        <span className={`${LINE} gap-[6px] pl-[12px] text-ink-soft`}>
          <SiteTile host={host} />
          <span className="truncate">{host}</span>
        </span>
      </td>
      {seesTracker ? (
        <td className={GONE.place}>
          <span className={`${LINE} pl-[12px]`}>
            {note.place === undefined ? null : (
              <PlaceCell
                place={note.place}
                source={source}
                reference={note.ref}
                address={note.url}
                delivery={note.delivery?.state}
                sending={sending}
                onSend={manages ? () => void send() : undefined}
              />
            )}
          </span>
        </td>
      ) : null}
      <td className={GONE.author}>
        <span className={`${LINE} justify-center`}>
          <Author author={note.author} site={host} />
        </span>
      </td>
      <td className={GONE.when}>
        <span className={`${LINE} justify-end text-hint text-muted tabular-nums`}>
          <span aria-hidden="true" title={ago(note.createdAt)}>
            {agoShort(note.createdAt)}
          </span>
          <span className="sr-only">{ago(note.createdAt)}</span>
        </span>
      </td>
      <td className={GONE.actions}>
        <span className={`${LINE} justify-end gap-[2px] pr-[8px] ${REVEALED}`}>
          {/* FRU-546: the page of the note, in a new tab, its address in the tooltip. */}
          {/* FRU-657: a task written by hand has no page to show. */}
          {note.page.url === '' ? null : (
            <IconLink label={t('Show on the page')} href={show} tip={note.page.url}>
              <NoteIcon name="open" />
            </IconLink>
          )}
          {taskMenu.menu}
        </span>
      </td>
    </tr>
  );
}

/**
 * The text of a note (FRU-685): at 500, on one line, cut with « … ». A press opens its page in the
 * panel (FRU-653), as the key Enter does once j or k gave it the focus.
 */
function NoteTitle({ note, children }: { note: IndexedNote; children: string }) {
  const seam = useContext(TaskMenuContext);
  const words = 'block min-w-0 truncate font-medium text-ink';
  if (seam?.openTask === undefined) return <span className={words}>{children}</span>;
  const open = seam.openTask;

  return (
    // The text it shows is its name: a name of its own would not be the words a person sees (WCAG 2.5.3).
    <TextButton
      onClick={() => open(note)}
      data={{ 'data-note-title': '' }}
      className={`${words} block min-w-[80px] shrink [&:hover]:underline [&:hover]:decoration-1 [&:hover]:underline-offset-[3px]`}
    >
      {children}
    </TextButton>
  );
}

/** The tile of a site: the first letter of its host, as the icon of a site with none (FRU-354). */
function SiteTile({ host }: { host: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-[14px] flex-none items-center justify-center rounded-inner bg-avatar text-[8px] leading-none font-bold text-page"
    >
      {host
        .replace(/^www\./, '')
        .charAt(0)
        .toUpperCase() || '?'}
    </span>
  );
}

/** The groups a person folded on the list, by account and workspace, in this browser (FRU-685). */
export function useFoldedGroups(account: string, workspace: string) {
  const key = `fruitback:notes-folded:${account}:${workspace}`;
  const [folded, setFolded] = useState<ReadonlySet<Stage>>(() => readFolded(key));
  useEffect(() => setFolded(readFolded(key)), [key]);
  const fold = useCallback(
    (stage: Stage, shut: boolean) =>
      setFolded((was) => {
        const next = new Set(was);
        if (shut) next.add(stage);
        else next.delete(stage);
        try {
          globalThis.localStorage?.setItem(key, JSON.stringify([...next]));
        } catch {
          // A browser that keeps nothing (a private window, storage refused): the fold lasts the visit.
        }

        return next;
      }),
    [key],
  );

  return { folded, fold };
}

function readFolded(key: string): ReadonlySet<Stage> {
  try {
    const kept: unknown = JSON.parse(globalThis.localStorage?.getItem(key) ?? '[]');

    return new Set(Array.isArray(kept) ? (kept.filter((each) => typeof each === 'string') as Stage[]) : []);
  } catch {
    return new Set();
  }
}

/**
 * j and k give the focus to the text of the next and of the note before (FRU-685), as in Linear;
 * Enter then opens it. A field, a menu and a dialog keep their keys.
 */
function useRowKeys(list: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== 'j' && event.key !== 'k') return;
      if (ownsKeys(event.target)) return;
      const titles = [...(list.current?.querySelectorAll<HTMLElement>('tr[data-note] [data-note-title]') ?? [])];
      if (titles.length === 0) return;
      const row = document.activeElement?.closest('tr[data-note]');
      const at = titles.findIndex((title) => title.closest('tr') === row);
      let next = event.key === 'j' ? at + 1 : at - 1;
      if (at < 0) next = 0;
      const title = titles[Math.min(Math.max(next, 0), titles.length - 1)];
      event.preventDefault();
      title?.focus();
    };
    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [list]);
}

/**
 * The list of the notes (FRU-245, FRU-685): a group per status (FRU-551), each under a head of
 * 32 px that folds it, and a line of 36 px per note. The head of a group stays under the filters
 * while one of its notes is on screen.
 */
export function NotesTable({
  notes,
  counts,
  statuses,
  seesTracker,
  manages,
  reading,
  base,
  originOf,
  sourceOf,
  choose,
  onSent,
  onStatusSaved,
  folded,
  onFold,
  onAdd,
}: {
  notes: readonly IndexedNote[];
  counts: NotesAnswer['counts'];
  statuses: NotesAnswer['statuses'];
  seesTracker: boolean;
  manages: boolean;
  /** A read again is on its way: the rows stay, and say they are busy. */
  reading: boolean;
  /** `/console/workspaces/<id>`. */
  base: string;
  originOf: (site: string) => string | undefined;
  sourceOf: (note: IndexedNote) => Connector | undefined;
  choose: (note: IndexedNote, status: string) => Promise<Answer<{ status: string; stage: Stage }>>;
  /** A note sent again to its address: the list is read again. */
  onSent: () => void;
  /** A status saved from the drop of a row, by the id of its note: the focus follows the row. */
  onStatusSaved: (note: string) => void;
  /** The groups folded: their head only. */
  folded: ReadonlySet<Stage>;
  onFold: (stage: Stage, folded: boolean) => void;
  /** « + » at the end of the head of a group: a new task of its status. None: no button. */
  onAdd?: ((stage: Stage) => void) | undefined;
}) {
  useLocale();
  const list = useRef<HTMLDivElement>(null);
  useRowKeys(list);
  const columns = seesTracker ? 8 : 7;

  return (
    // The list goes from one edge of the screen to the other, as the mockup draws it.
    <div aria-busy={reading} className="@container -mx-[clamp(16px,4vw,48px)]">
      <div
        ref={list}
        role="region"
        aria-label={t('Notes')}
        tabIndex={-1}
        className="kit-notes-list border-t border-line outline-none"
      >
        <table
          className={[
            'w-full table-fixed border-separate border-spacing-0 text-table',
            '[&_td]:p-0 [&_td]:align-top [&_td]:border-b [&_td]:border-line/60',
            '[&_tbody_tr[data-note]:hover]:bg-hover [&_tbody_tr[data-note]:focus-within]:bg-hover',
            '[&_tr[data-selected=true]]:bg-selected [&_tr[data-selected=true]:hover]:bg-selected',
            '[&_tr[data-selected=true]>td:first-child]:shadow-[inset_2px_0_0_var(--color-accent)]',
            // What takes the focus is scrolled to under the heads, never behind them (FRU-586).
            '[&_:is(a,button,input,[tabindex])]:scroll-mt-[calc(var(--kit-pinned-top,0px)+80px)]',
          ].join(' ')}
        >
          {/* The heads of the columns are for a screen reader: their width is the one of the column. */}
          <thead>
            <tr>
              {(
                [
                  ['lead', t('Status')],
                  ['note', t('Note')],
                  ['path', t('Page')],
                  ['site', t('Site')],
                  ...(seesTracker ? [['place', t('Went to')] as const] : []),
                  ['author', t('Left by')],
                  ['when', t('When')],
                  ['actions', t('Actions')],
                ] as const
              ).map(([column, words]) => (
                <th key={column} scope="col" className={`h-0 overflow-hidden p-0 ${COLUMNS[column]}`}>
                  <span className="sr-only">{words}</span>
                </th>
              ))}
            </tr>
          </thead>
          {/* FRU-551: a group per status, its head the drop, the name and the notes of the
            whole list in it. A group that goes on to the next page has its head there too. */}
          {groupsOf(notes).map((group) => {
            const shut = folded.has(group.stage);

            return (
              <tbody key={group.stage} data-group={group.stage} data-folded={shut}>
                <tr className="kit-table-group">
                  <th
                    scope="colgroup"
                    colSpan={columns}
                    className="sticky top-[var(--kit-pinned-top,0px)] z-1 border-b border-line bg-subtle p-0 text-left font-normal"
                  >
                    <GroupHead
                      stage={group.stage}
                      notes={group.notes}
                      count={counts.byStage?.[group.stage]}
                      shut={shut}
                      onFold={(next) => onFold(group.stage, next)}
                      onAdd={onAdd === undefined ? undefined : () => onAdd(group.stage)}
                    />
                  </th>
                </tr>
                {shut
                  ? null
                  : group.notes.map((note) => (
                      <NoteRow
                        key={`${note.id} ${note.status ?? note.stage}`}
                        note={note}
                        seesTracker={seesTracker}
                        origin={originOf(note.site.id)}
                        source={sourceOf(note)}
                        manages={manages}
                        retry={() => call('POST', `${base}/notes/${encodeURIComponent(note.id)}/retry`)}
                        statuses={statuses?.[note.site.id]}
                        choose={(status) => choose(note, status)}
                        onSent={onSent}
                        onStatusSaved={() => onStatusSaved(note.id)}
                      />
                    ))}
              </tbody>
            );
          })}
        </table>
      </div>
    </div>
  );
}

/**
 * The head of a group (FRU-685): the box of its tasks, the chevron that folds it, its drop, its name
 * and the notes of the whole list in it, then « + » at the end.
 */
function GroupHead({
  stage,
  notes,
  count,
  shut,
  onFold,
  onAdd,
}: {
  stage: Stage;
  notes: readonly IndexedNote[];
  /** The notes of the whole list in the group: a worker that does not count them gets no number. */
  count: number | undefined;
  shut: boolean;
  onFold: (shut: boolean) => void;
  onAdd: (() => void) | undefined;
}) {
  useLocale();
  const name = t(STAGE_NAMES[stage]);

  return (
    <span className="flex h-[31px] items-center gap-[2px] pr-[12px] pl-[6px] text-small text-ink">
      <SelectGroup notes={notes} name={name} />
      <TextButton
        expanded={!shut}
        onClick={() => onFold(!shut)}
        className="flex h-control-sm items-center gap-[8px] rounded-control px-[6px] [&:hover]:bg-hover data-[hovered=true]:bg-hover"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className={`size-[12px] flex-none text-muted ${shut ? '-rotate-90' : ''}`}
          data-chevron=""
        >
          <path
            d="M6 9l6 6 6-6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <StatusDot status={stage} size={10} />
        <span className="font-semibold">{name}</span>
        {count === undefined ? null : <span className="text-muted tabular-nums">{count}</span>}
      </TextButton>
      {onAdd === undefined ? null : (
        <span className="ml-auto">
          <IconButton label={t('New task in {column}', { column: name })} onClick={onAdd} size="small">
            <NoteIcon name="add" />
          </IconButton>
        </span>
      )}
    </span>
  );
}

/**
 * The box of the tasks of a group (FRU-685): the head of the columns that held « every task of the
 * page » is gone, so each group selects its own, as Linear does. Shown as the box of a row is.
 */
function SelectGroup({ notes, name }: { notes: readonly IndexedNote[]; name: string }) {
  useLocale();
  const selection = useContext(TaskSelectionContext);
  if (selection === undefined) return null;
  const choosable = notes.filter((note) => selection.canSelect(note));
  if (choosable.length === 0)
    return <span aria-hidden="true" className="kit-select-room inline-block w-[28px] flex-none" />;
  const chosen = choosable.filter((note) => selection.has(note.id)).length;

  return (
    <SelectBox
      className="kit-select-reveal [[data-selecting=false]_&]:opacity-0 [[data-selecting=false]_tr:hover_&]:opacity-100 [[data-selecting=false]_&:focus-within]:opacity-100 pointer-coarse:[[data-selecting=false]_&]:opacity-100"
      label={t('Select every task of {status}', { status: name })}
      checked={chosen === choosable.length}
      mixed={chosen > 0 && chosen < choosable.length}
      onToggle={(checked) => selection.some(choosable, checked)}
    />
  );
}
