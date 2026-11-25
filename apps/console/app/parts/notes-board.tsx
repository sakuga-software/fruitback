import { type DragEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { type BoardColumn, type BoardNote, takesNotes } from '../board-columns';
import { t } from '../i18n';
import { statusName } from '../note-status';
import { IconButton, Problem, StatusDot } from '../ui';
import { NoteIcon } from '../note-icons';
import { useLocale } from '../use-locale';
import { STAGE_NAMES } from '../stages';

/** A selected card (FRU-656) takes the border of ink, over the line of a drop. */
const SELECTED_CARD =
  '[[data-selecting]_&:has(>[data-selected=true])]:border-ink [[data-selecting]_&:has(>[data-selected=true])]:[box-shadow:inset_0_0_0_1px_var(--color-ink)]';

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
  reorder,
  onAdd,
}: {
  columns: readonly BoardColumn<Note>[];
  /** A read is on its way: the board stays as it is until its answer. */
  busy: boolean;
  /**
   * What a card shows of its note. `moved`: the card's own select saved a status, so the card goes to
   * another column, and its select gets the focus back there.
   */
  card: (note: Note, moved: () => void) => ReactNode;
  movable: (note: Note) => boolean;
  /** Saves the status of a note; answers the sentence of a refusal, or `undefined` once saved. */
  move: (note: Note, status: string) => Promise<string | undefined>;
  /**
   * FRU-665: puts a note of a column between two others of it, by a drag inside the column. Absent:
   * the board does not order its columns. Answers the sentence of a refusal, or `undefined`.
   */
  reorder?: (note: Note, before: Note | undefined, after: Note | undefined) => Promise<string | undefined>;
  /** FRU-657: « New task » at the head of each column, in its status. Absent: no button. */
  onAdd?: (column: BoardColumn<Note>) => void;
}) {
  useLocale();
  const id = useId();
  const [dragged, setDragged] = useState<Note | undefined>();
  const [over, setOver] = useState<string | undefined>();
  const [moving, setMoving] = useState<string | undefined>();
  const [refused, setRefused] = useState<string | undefined>();
  // FRU-665: where a drag inside its own column would put the note: before the note of this index.
  const [insert, setInsert] = useState<{ column: string; index: number } | undefined>();
  const frame = useRef<HTMLDivElement>(null);
  // The note whose select moved it. Its card is drawn again in another column, and the focus of the
  // keyboard went back to the page: it is given back to the select once the list is read again. A
  // filter can keep the note off the board after the read: the focus then goes to the board, never
  // to the page.
  const [follow, setFollow] = useState<string | undefined>();
  useEffect(() => {
    if (follow === undefined || busy) return;
    const moved = [...(frame.current?.querySelectorAll<HTMLElement>('li[data-note]') ?? [])].find(
      (each) => each.dataset.note === follow,
    );
    const target = moved?.querySelector<HTMLElement>('button[aria-haspopup]') ?? frame.current;
    if (target !== null && document.activeElement !== target) target.focus();
    setFollow(undefined);
  }, [follow, busy, columns]);

  const accepts = (column: BoardColumn<Note>) =>
    dragged !== undefined && takesNotes(column) && !column.notes.some((note) => note.id === dragged.id);

  /** A drag inside the column of the note: it goes between two notes of it. */
  const ordering = (column: BoardColumn<Note>) =>
    reorder !== undefined && dragged !== undefined && column.notes.some((note) => note.id === dragged.id);

  async function place(column: BoardColumn<Note>, index: number) {
    const note = dragged;
    setDragged(undefined);
    setInsert(undefined);
    if (note === undefined || reorder === undefined) return;
    const others = column.notes.filter((each) => each.id !== note.id);
    const at = Math.min(index - (column.notes.findIndex((each) => each.id === note.id) < index ? 1 : 0), others.length);
    const before = others[at - 1];
    const after = others[at];
    // Dropped where it was: nothing to save.
    if (
      column.notes[column.notes.indexOf(note) - 1] === before &&
      column.notes[column.notes.indexOf(note) + 1] === after
    ) {
      return;
    }
    setMoving(note.id);
    setRefused(undefined);
    const problem = await reorder(note, before, after);
    setMoving(undefined);
    if (problem !== undefined) setRefused(problem);
  }

  async function drop(column: BoardColumn<Note>) {
    if (ordering(column)) return place(column, insert?.column === column.key ? insert.index : column.notes.length);
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
        ref={frame}
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
                if (ordering(column)) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';

                  return;
                }
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
              <div className="mb-[10px] flex items-center gap-[4px]">
                <h2
                  id={heading}
                  className="flex min-w-0 flex-1 items-center gap-[8px] px-[4px] text-small leading-auto font-semibold"
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
                {onAdd === undefined || (column.status !== undefined && !takesNotes(column)) ? null : (
                  <IconButton
                    size="small"
                    label={t('New task in {column}', { column: name(column) })}
                    onClick={() => onAdd(column)}
                  >
                    <NoteIcon name="add" />
                  </IconButton>
                )}
              </div>
              {column.notes.length === 0 ? (
                <p className="px-[4px] py-[8px] text-hint text-muted">{t('No note here.')}</p>
              ) : (
                <ul className="flex flex-col gap-[8px]">
                  {column.notes.map((note, index) => {
                    const draggable = movable(note) && moving === undefined;
                    const here = insert?.column === column.key;
                    let inserted: 'before' | 'after' | undefined;
                    if (here && insert.index === index) inserted = 'before';
                    else if (here && insert.index === column.notes.length && index === column.notes.length - 1) {
                      inserted = 'after';
                    }

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
                          setInsert(undefined);
                        }}
                        onDragOver={(event: DragEvent) => {
                          if (!ordering(column)) return;
                          // Over the upper half of a note, the drag goes before it; over the lower half, after it.
                          const box = event.currentTarget.getBoundingClientRect();
                          const below = event.clientY > box.top + box.height / 2;
                          setInsert({ column: column.key, index: below ? index + 1 : index });
                        }}
                        data-note={note.id}
                        data-insert={inserted}
                        className={`box-border rounded-box border border-line bg-page p-[12px] text-small data-[insert=before]:shadow-[0_-3px_0_0_var(--color-ink)] data-[insert=after]:shadow-[0_3px_0_0_var(--color-ink)] ${SELECTED_CARD} ${
                          draggable ? 'cursor-grab active:cursor-grabbing' : ''
                        } ${moving === note.id || dragged?.id === note.id ? 'opacity-60' : ''}`}
                      >
                        {card(note, () => setFollow(note.id))}
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
