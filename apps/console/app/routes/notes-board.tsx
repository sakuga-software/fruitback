import { type DragEvent, type ReactNode, useId, useState } from 'react';
import { type BoardColumn, type BoardNote, takesNotes } from '../board-columns';
import { t } from '../i18n';
import { statusName } from '../note-status';
import { Problem, StatusDot } from '../ui';
import { useLocale } from '../use-locale';
import { STAGE_NAMES } from './connector-parts';

/**
 * The board of the notes (FRU-436): a column per status of the site in view, or per stage, beside
 * the table of the same notes (`board-columns.ts` decides the columns). The filters, the page and the
 * address are the table's: the board draws the notes of this page.
 *
 * A note that the person may move (`movable`) is dragged to the column of another status. The
 * keyboard does the same with the select of its card: a drag is never the only way. The card moves
 * once the worker has saved its status; a refusal is said above the board, and nothing moves.
 *
 * The columns keep their width and the board scrolls in its frame, which takes focus so that a
 * keyboard scrolls it: the page never scrolls sideways, at 390 px either.
 */
export function NotesBoard<Note extends BoardNote>({
  columns,
  busy,
  card,
  movable,
  move,
}: {
  columns: readonly BoardColumn<Note>[];
  /** A read is on its way: the board stays as it is until its answer. */
  busy: boolean;
  /** What a card shows of its note. */
  card: (note: Note) => ReactNode;
  movable: (note: Note) => boolean;
  /** Saves the status of a note; answers the sentence of a refusal, or `undefined` once saved. */
  move: (note: Note, status: string) => Promise<string | undefined>;
}) {
  useLocale();
  const id = useId();
  const [dragged, setDragged] = useState<Note | undefined>();
  const [over, setOver] = useState<string | undefined>();
  const [moving, setMoving] = useState<string | undefined>();
  const [refused, setRefused] = useState<string | undefined>();

  const accepts = (column: BoardColumn<Note>) =>
    dragged !== undefined && takesNotes(column) && !column.notes.some((note) => note.id === dragged.id);

  async function drop(column: BoardColumn<Note>) {
    const note = dragged;
    setDragged(undefined);
    setOver(undefined);
    if (note === undefined || column.status === undefined || !accepts(column)) return;
    setMoving(note.id);
    setRefused(undefined);
    const problem = await move(note, column.status.key);
    setMoving(undefined);
    if (problem !== undefined) setRefused(problem);
  }

  const name = (column: BoardColumn<Note>) => {
    const stageName = t(STAGE_NAMES[column.stage]);

    return column.status === undefined ? stageName : statusName(column.status, (stage) => t(STAGE_NAMES[stage]));
  };

  return (
    <div aria-busy={busy || moving !== undefined}>
      {refused === undefined ? null : (
        <div className="mb-[12px]">
          <Problem>{t(refused)}</Problem>
        </div>
      )}
      <div
        role="region"
        aria-label={t('Notes by status')}
        tabIndex={0}
        className="relative flex items-start gap-[12px] overflow-x-auto pb-[8px] [scrollbar-width:thin]"
      >
        {columns.map((column, index) => {
          const heading = `${id}-column-${index}`;
          const dropping = over === column.key && accepts(column);

          return (
            <section
              key={column.key}
              aria-labelledby={heading}
              data-column={column.key}
              data-drop={dropping}
              onDragOver={(event: DragEvent) => {
                if (!accepts(column)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setOver(column.key);
              }}
              onDragLeave={() => setOver((current) => (current === column.key ? undefined : current))}
              onDrop={(event: DragEvent) => {
                event.preventDefault();
                void drop(column);
              }}
              className="box-border flex w-[272px] flex-none flex-col rounded-frame border border-line bg-subtle p-[12px] data-[drop=true]:border-ink data-[drop=true]:bg-chip"
            >
              <h2
                id={heading}
                className="mb-[10px] flex items-center gap-[8px] px-[4px] text-small leading-auto font-semibold"
              >
                <StatusDot
                  status={column.stage}
                  size={10}
                  {...(column.status?.color === undefined ? {} : { color: column.status.color })}
                />
                <span className="min-w-0 flex-1 truncate">{name(column)}</span>
                <span className="font-normal text-muted tabular-nums">
                  <span className="sr-only">{t('Notes in this column:')} </span>
                  {column.notes.length}
                </span>
              </h2>
              {column.notes.length === 0 ? (
                <p className="px-[4px] py-[8px] text-hint text-muted">{t('No note here.')}</p>
              ) : (
                <ul className="flex flex-col gap-[8px]">
                  {column.notes.map((note) => {
                    const draggable = movable(note) && moving === undefined;

                    return (
                      <li
                        key={note.id}
                        draggable={draggable}
                        aria-busy={moving === note.id}
                        onDragStart={(event: DragEvent) => {
                          event.dataTransfer.effectAllowed = 'move';
                          event.dataTransfer.setData('text/plain', note.id);
                          setDragged(note);
                        }}
                        onDragEnd={() => {
                          setDragged(undefined);
                          setOver(undefined);
                        }}
                        data-note={note.id}
                        className={`box-border rounded-box border border-line bg-page p-[12px] text-small ${
                          draggable ? 'cursor-grab active:cursor-grabbing' : ''
                        } ${moving === note.id || dragged?.id === note.id ? 'opacity-60' : ''}`}
                      >
                        {card(note)}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
