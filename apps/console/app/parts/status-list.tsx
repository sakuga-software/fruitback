import { type ReactNode, useEffect, useRef, useState } from 'react';
import { STAGE_NAMES } from '../stages';
import { call } from '../api';
import { Confirmation } from '../confirm';
import { msg, t } from '../i18n';
import { problemOf } from '../problems';
import {
  type ListKind,
  MAX_STATUSES,
  OWN,
  type ScreenStatus,
  type StatusRow,
  type TrackerState,
  isChanged,
  isDeletable,
  keyFor,
  moved,
  resetOf,
  rowOf,
  statusesOf,
} from '../site-statuses';
import { Button, IconButton, Problem, StatusDot, Toggle } from '../ui';
import { useLocale } from '../use-locale';
import { MoveNotes, Ratio, StatusEditor } from './status-editor';
import {
  BUSY,
  GITHUB_NAMES,
  NOT_CHANGED,
  STATUS_LIST_PROBLEMS,
  coloursOf,
  defaultColourOf,
  drawnOf,
  nameOf,
  notesText,
  stageColoured,
} from './status-shown';

// A list of statuses of the Statuses screen (FRU-371, FRU-614): its rows, their order, their colours.

/** What is open under a status: its editor, the first and the second time of its deletion. */
export type Open = { key: string; what: 'edit' | 'delete' } | { key: string; what: 'move'; notes: number };

type StatusListProps = {
  /** The id of its heading, unique on the page. */
  id: string;
  kind: ListKind;
  source: string;
  /** The words of the destination, as the worker wrote them: « GitHub · acme/website ». */
  label: string | undefined;
  /** The states of the tracker, for a Linear list (FRU-368). */
  states: readonly TrackerState[];
  /** The site draws its tracker's states in the tracker's colours. */
  trackerColours: boolean;
  /** Turns that switch: the list that shows it. The sentence of a refusal, or `undefined`. */
  onTrackerColours?: (on: boolean) => Promise<string | undefined>;
  rows: readonly StatusRow[];
  /** The notes in each status, for the list of the worker's store when the worker says them (FRU-386). */
  notes: Readonly<Record<string, number>> | undefined;
  onRows: (change: (rows: readonly StatusRow[]) => readonly StatusRow[]) => void;
  /** The status `key` was deleted, and `moved` of its notes went to the status `to`. */
  onDeleted: (key: string, moved: number, to: string | undefined) => void;
  path: string;
  writing: boolean;
  /** Runs one write, or nothing while another is running: one write at a time for the whole page. */
  writeOne: <T>(write: () => Promise<T>) => Promise<T | typeof BUSY>;
  onSay: (words: string) => void;
};

/** The statuses of one source of the site, in their order, and what can be done to each. */
export function StatusList({
  id,
  kind,
  source,
  label,
  states,
  trackerColours,
  onTrackerColours,
  rows,
  notes,
  onRows,
  onDeleted,
  path,
  writing,
  writeOne,
  onSay,
}: StatusListProps) {
  useLocale();
  const statuses = statusesOf(kind, source, rows, states).map((status) =>
    trackerColours && status.trackerColor !== undefined ? { ...status, defaultColor: status.trackerColor } : status,
  );
  const [open, setOpen] = useState<Open | undefined>();
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const list = useRef<HTMLDivElement>(null);
  // Where focus goes once the list is drawn again: a button of a row, by the key of its status.
  const [focus, setFocus] = useState<{ key: string; control: string } | undefined>();
  const heading = id;

  useEffect(() => {
    if (focus === undefined || writing) return;
    const row = list.current?.querySelector(`[data-status-key="${CSS.escape(focus.key)}"]`);
    const wanted = row?.querySelector<HTMLElement>(`[data-control="${focus.control}"] button:not([disabled])`);
    // A move to an end disables the button that made it: the other one of the row takes focus.
    (wanted ?? row?.querySelector<HTMLElement>('[data-control^="move"] button:not([disabled])'))?.focus();
    setFocus(undefined);
  }, [focus, writing, rows]);

  /** Adds or changes a status at the worker. The sentence of the refusal, or `undefined` once it is kept. */
  async function save(status: ScreenStatus): Promise<string | undefined> {
    const answer = await call<{ status: StatusRow }>('POST', path, rowOf(status));
    if (!answer.ok) return problemOf(answer, STATUS_LIST_PROBLEMS, NOT_CHANGED);
    const kept = answer.data.status;
    onRows((current) => [...current.filter((row) => row.source !== kept.source || row.key !== kept.key), kept]);

    return undefined;
  }

  async function move(index: number, step: -1 | 1) {
    const next = moved(statuses, index, step);
    const status = statuses[index];
    if (next === undefined || status === undefined) return;
    setProblem(undefined);
    setOpen(undefined);
    await writeOne(async () => {
      // The worker orders the statuses it keeps: a default with no row gets one first, at its new place.
      for (const each of next.filter((one) => !one.kept)) {
        const refused = await save(each);
        if (refused !== undefined) return setProblem(msg('The order did not change. Try again.'));
      }
      const order = next.map((each) => ({ source: each.source, key: each.key }));
      const ordered = await call('POST', `${path}/order`, { order });
      if (!ordered.ok)
        return setProblem(problemOf(ordered, STATUS_LIST_PROBLEMS, msg('The order did not change. Try again.')));
      onRows((current) =>
        current.map((row) => {
          const position = next.findIndex((each) => each.source === row.source && each.key === row.key);

          return position === -1 ? row : { ...row, position };
        }),
      );
      onSay(
        t('{name} is now {position} of {total}.', {
          name: nameOf(status),
          position: index + step + 1,
          total: next.length,
        }),
      );
    });
    setFocus({ key: status.key, control: step === -1 ? 'move-up' : 'move-down' });
  }

  async function reset(status: ScreenStatus) {
    setProblem(undefined);
    const refused = await writeOne(() => save(resetOf(status)));
    if (refused === BUSY) return;
    if (refused !== undefined) setProblem(refused);
    else onSay(t('{name} is back to what it was.', { name: nameOf(resetOf(status)) }));
    setFocus({ key: status.key, control: 'edit' });
  }

  async function remove(status: ScreenStatus, moveTo?: ScreenStatus) {
    setProblem(undefined);
    const query = moveTo === undefined ? '' : `?moveTo=${encodeURIComponent(moveTo.key)}`;
    const removed = await writeOne(() =>
      call<{ moved: number }>(
        'DELETE',
        `${path}/${encodeURIComponent(source)}/${encodeURIComponent(status.key)}${query}`,
      ),
    );
    if (removed === BUSY) return;
    if (!removed.ok && removed.error === 'status-in-use' && removed.notes !== undefined && moveTo === undefined)
      return setOpen({ key: status.key, what: 'move', notes: removed.notes });
    if (!removed.ok)
      return setProblem(problemOf(removed, STATUS_LIST_PROBLEMS, msg('This status is still here. Try again.')));
    setOpen(undefined);
    onRows((current) => current.filter((row) => row.source !== status.source || row.key !== status.key));
    // A worker that answers with no body (204) says no number: the target takes the notes the list
    // counted in the status deleted (lite reviews of PR 541).
    const moved = removed.data?.moved;
    onDeleted(status.key, typeof moved === 'number' ? moved : (notes?.[status.key] ?? 0), moveTo?.key);
    onSay(
      moveTo === undefined
        ? t('« {name} » was deleted.', { name: nameOf(status) })
        : t('« {name} » was deleted, and its notes are in « {target} ».', {
            name: nameOf(status),
            target: nameOf(moveTo),
          }),
    );
    document.getElementById(heading)?.focus();
  }

  const close = (key: string, control: string) => {
    setOpen(undefined);
    setFocus({ key, control });
  };

  return (
    <section aria-labelledby={heading}>
      <div className="mb-[12px] flex flex-wrap items-end justify-between gap-x-[24px] gap-y-[12px]">
        <div className="min-w-0 max-w-[720px]">
          <h2 id={heading} tabIndex={-1} className="text-section font-semibold [overflow-wrap:anywhere]">
            {kind === 'own' ? t('Notes kept in Fruitback') : (label ?? (kind === 'linear' ? t('Linear') : t('GitHub')))}
          </h2>
          <p className="mt-[4px] text-small text-muted">{leadOf(kind)}</p>
        </div>
        {kind === 'own' ? (
          <Button
            disabled={writing || adding || statuses.length >= MAX_STATUSES}
            onClick={() => {
              setOpen(undefined);
              setAdding(true);
            }}
          >
            {t('Add a status')}
          </Button>
        ) : null}
      </div>

      {onTrackerColours === undefined ? null : (
        <TrackerColours value={trackerColours} disabled={writing} onChange={onTrackerColours} />
      )}
      <div ref={list} className="@container">
        <div
          aria-hidden="true"
          className="hidden px-[20px] pb-[8px] text-label font-semibold text-muted @min-[860px]:flex @min-[860px]:gap-x-[12px]"
        >
          <span className="w-[84px] flex-none">{t('Order')}</span>
          <span className="grid flex-1 grid-cols-[minmax(200px,1.6fr)_140px_minmax(150px,1fr)_120px_minmax(150px,auto)] gap-x-[12px]">
            <span>{t('Status')}</span>
            <span>{t('Stage')}</span>
            <span>{t('Colour')}</span>
            <span>{t('Text')}</span>
            <span />
          </span>
        </div>
        <ol aria-labelledby={heading} className="overflow-hidden rounded-frame border border-line">
          {statuses.map((status, index) => (
            <StatusItem
              key={status.key}
              status={status}
              first={index === 0}
              last={index === statuses.length - 1}
              writing={writing}
              open={open?.key === status.key ? open : undefined}
              onMove={(step) => void move(index, step)}
              onEdit={() => {
                setAdding(false);
                setProblem(undefined);
                setOpen({ key: status.key, what: 'edit' });
              }}
              onReset={() => void reset(status)}
              {...(notes === undefined ? {} : { notes: notes[status.key] ?? 0 })}
              onDelete={() => {
                setAdding(false);
                setProblem(undefined);
                // FRU-386: notes are in it, so the first step is where they go. The `409` of the
                // worker stays the net for a note written since the list was read.
                const held = notes?.[status.key] ?? 0;
                setOpen(
                  held > 0 ? { key: status.key, what: 'move', notes: held } : { key: status.key, what: 'delete' },
                );
              }}
            >
              {open?.key === status.key && open.what === 'edit' ? (
                <StatusEditor
                  status={status}
                  disabled={writing}
                  onSave={async (next) => {
                    const refused = await writeOne(() => save(next));
                    // Another write held the lock: nothing was sent, and the editor keeps what was typed.
                    if (refused === BUSY) return NOT_CHANGED;
                    if (refused === undefined) close(status.key, 'edit');

                    return refused;
                  }}
                  onCancel={() => close(status.key, 'edit')}
                />
              ) : null}
              {open?.key === status.key && open.what === 'delete' ? (
                <Confirmation
                  confirmLabel={t('Delete {name}', { name: nameOf(status) })}
                  consequence={t(
                    '« {name} » goes from this site. If notes are in it, you choose where they go first.',
                    { name: nameOf(status) },
                  )}
                  onConfirm={() => void remove(status)}
                  onKeep={() => close(status.key, 'delete')}
                />
              ) : null}
              {open?.key === status.key && open.what === 'move' ? (
                <MoveNotes
                  status={status}
                  notes={open.notes}
                  targets={statuses.filter((each) => each.key !== status.key)}
                  disabled={writing}
                  onMove={(target) => void remove(status, target)}
                  onKeep={() => close(status.key, 'delete')}
                />
              ) : null}
            </StatusItem>
          ))}
        </ol>
      </div>
      {/* FRU-538: the « 3 » of each pin is a sample, and the list says so once. */}
      <p className="mt-[8px] text-hint text-muted">
        {t('Each pin shows how a note in that status looks on the page. The 3 is an example number.')}
      </p>
      {statuses.some(stageColoured) ? (
        <p className="mt-[4px] text-hint text-muted">
          {t('A swatch with no code is the colour of the stage of its status.')}
        </p>
      ) : null}
      {problem === undefined ? null : (
        <div className="mt-[12px]">
          <Problem>{t(problem, { count: MAX_STATUSES })}</Problem>
        </div>
      )}
      {adding ? (
        <div className="mt-[16px]">
          <StatusEditor
            status={{
              source: OWN,
              key: '',
              name: '',
              stage: 'todo',
              color: null,
              textColor: null,
              position: statuses.length,
              origin: 'team',
              hidden: false,
              defaultStage: 'todo',
              builtIn: false,
              kept: false,
              rank: statuses.length,
            }}
            adding
            disabled={writing}
            onSave={async (next) => {
              const status = {
                ...next,
                key: keyFor(
                  next.name ?? '',
                  statuses.map((each) => each.key),
                ),
              };
              const refused = await writeOne(() => save(status));
              if (refused === BUSY) return NOT_CHANGED;
              if (refused === undefined) {
                setAdding(false);
                setFocus({ key: status.key, control: 'edit' });
                onSay(t('« {name} » was added.', { name: nameOf(status) }));
              }

              return refused;
            }}
            onCancel={() => setAdding(false)}
          />
        </div>
      ) : null}
    </section>
  );
}

/** What a list says under its title. */
function leadOf(kind: ListKind): string {
  if (kind === 'own')
    return t('Five statuses are built in, one for each stage. Rename them, recolour them, or add your own.');
  if (kind === 'github') return t('A GitHub issue has four states. Rename them, recolour them, or change their stage.');

  return t(
    'The states of the Linear team this site sends to. Rename them, recolour them, or change their stage. A state added in Linear appears here.',
  );
}

/**
 * « Use Linear's colours » (FRU-368): a switch of the site, off by default, written at once. A refusal
 * puts it back and says why.
 */
export function TrackerColours({
  value,
  disabled,
  onChange,
}: {
  value: boolean;
  disabled: boolean;
  onChange: (on: boolean) => Promise<string | undefined>;
}) {
  useLocale();
  const [problem, setProblem] = useState<string | undefined>();

  return (
    <div className="mb-[20px] max-w-[760px] rounded-frame border border-line px-[20px] py-[16px]">
      <Toggle
        strong
        label={t("Use Linear's colours")}
        hint={t('A status with no colour chosen here takes its colour in Linear. Off: the colours of Fruitback.')}
        value={value}
        disabled={disabled}
        onChange={(on) => {
          setProblem(undefined);
          void onChange(on).then(setProblem);
        }}
      />
      {problem === undefined ? null : (
        <div className="mt-[12px]">
          <Problem>{t(problem)}</Problem>
        </div>
      )}
    </div>
  );
}

/** The drop of a pin and the chip of a name, in the colours of a status, as the widget draws them. */
export function StatusMark({ name, style }: { name: string; style: ReturnType<typeof coloursOf>['style'] }) {
  return (
    <span className="flex min-w-0 items-center gap-[14px]">
      <span aria-hidden="true" className="kit-pin" style={style}>
        <span>3</span>
      </span>
      <span className="kit-status-chip [overflow-wrap:anywhere]" style={style}>
        {name}
      </span>
    </span>
  );
}

const ARROW_UP = 'M6 15l6-6 6 6';

const ARROW_DOWN = 'M6 9l6 6 6-6';

type StatusItemProps = {
  status: ScreenStatus;
  first: boolean;
  last: boolean;
  writing: boolean;
  open: Open | undefined;
  /** How many notes are in it: the worker's store only, and a worker that says it (FRU-386). */
  notes?: number;
  onMove: (step: -1 | 1) => void;
  onEdit: () => void;
  onReset: () => void;
  onDelete: () => void;
  /** What is open under the row. */
  children: ReactNode;
};

/** The row of a status: its order, the status as a pin draws it, its stage, its colour, its text, its actions. */
function StatusItem({
  status,
  first,
  last,
  writing,
  open,
  notes,
  onMove,
  onEdit,
  onReset,
  onDelete,
  children,
}: StatusItemProps) {
  useLocale();
  const name = nameOf(status);
  const { style, ratio } = drawnOf(status);
  const arrow = (path: string) => (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d={path} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
  let from = t('Added by your team');
  if (status.builtIn) from = t('Built in');
  else if (status.trackerName !== undefined) from = t('In Linear: {name}', { name: status.trackerName });
  else if (status.source !== OWN) from = t('In GitHub: {name}', { name: t(GITHUB_NAMES[status.key] ?? status.key) });
  const label = 'shrink-0 text-hint text-muted @min-[860px]:sr-only';

  return (
    <li
      data-status-key={status.key}
      className={`flex flex-wrap items-start gap-x-[12px] gap-y-[8px] border-b border-line px-[20px] py-[12px] text-table last:border-b-0 max-[480px]:px-[12px] ${open === undefined ? '' : 'bg-subtle'}`}
    >
      {/* Ordering is two buttons, for a keyboard and a pointer alike: no drag only. */}
      <span className="flex w-[84px] flex-none items-center gap-[4px] @max-[859px]:w-[36px] @max-[859px]:flex-col">
        <span data-control="move-up" className="contents">
          <IconButton label={t('Move {name} up', { name })} disabled={first || writing} onClick={() => onMove(-1)}>
            {arrow(ARROW_UP)}
          </IconButton>
        </span>
        <span data-control="move-down" className="contents">
          <IconButton label={t('Move {name} down', { name })} disabled={last || writing} onClick={() => onMove(1)}>
            {arrow(ARROW_DOWN)}
          </IconButton>
        </span>
      </span>
      <span className="grid min-w-0 flex-1 grid-cols-1 items-center gap-x-[12px] gap-y-[6px] @min-[860px]:grid-cols-[minmax(200px,1.6fr)_140px_minmax(150px,1fr)_120px_minmax(150px,auto)]">
        <span className="flex min-w-0 flex-col gap-[3px]">
          <StatusMark name={name} style={style} />
          <span className="pl-[42px] text-hint text-muted">
            {from}
            {notes === undefined ? null : ` · ${notesText(notes)}`}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-[8px]">
          <span className={`${label} w-[64px]`}>{t('Stage')}</span>
          <StatusDot status={status.stage} size={10} />
          {t(STAGE_NAMES[status.stage])}
        </span>
        <span className="flex min-w-0 items-center gap-[8px]">
          <span className={`${label} w-[64px]`}>{t('Colour')}</span>
          <span aria-hidden="true" className="kit-swatch" style={{ background: style.background }} />
          {/* FRU-504: the colour of the stage is said once, under the list; a screen reader hears it here. */}
          {status.color === null ? (
            <span className={stageColoured(status) ? 'sr-only' : ''}>{t(defaultColourOf(status))}</span>
          ) : (
            <code className="font-mono">{status.color}</code>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-[8px]">
          <span className={`${label} w-[64px]`}>{t('Text')}</span>
          <Ratio ratio={ratio} auto={status.textColor === null} />
        </span>
        <span className="flex flex-wrap items-center gap-[6px] @min-[860px]:justify-end">
          <span data-control="edit" className="contents">
            <Button tone="outline" size="small" label={t('Edit {name}', { name })} disabled={writing} onClick={onEdit}>
              {t('Edit')}
            </Button>
          </span>
          {isDeletable(status) ? (
            <span data-control="delete" className="contents">
              <Button
                tone="quiet"
                size="small"
                label={t('Delete {name}', { name })}
                disabled={writing}
                onClick={onDelete}
              >
                {t('Delete')}
              </Button>
            </span>
          ) : null}
          {isChanged(status) ? (
            <span data-control="reset" className="contents">
              <Button
                tone="quiet"
                size="small"
                label={t('Reset {name}', { name })}
                disabled={writing}
                onClick={onReset}
              >
                {t('Reset')}
              </Button>
            </span>
          ) : null}
        </span>
      </span>
      {open === undefined ? null : <div className="w-full basis-full">{children}</div>}
    </li>
  );
}
