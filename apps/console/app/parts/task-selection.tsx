import { type MouseEvent, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { composes, ownsKeys } from '../keys';
import { t } from '../i18n';
import { SelectBox } from '../ui';
import { useLocale } from '../use-locale';
import { type IndexedNote } from './notes-model';
import { excerptOf } from './note-parts';

/**
 * The tasks selected on the screen of the notes (FRU-656), and how a person selects them: a box, Shift
 * and a click for a range, Cmd or Ctrl and A for the page, Escape to clear. What acts on them (the bar,
 * the menu of a task on a selection, a copy) reads `TaskSelectionContext`.
 */
export type TaskSelection = {
  /** The selected tasks, in the order of the screen. */
  notes: readonly IndexedNote[];
  /** Every task of the screen that can be selected, in its order: the page shown, under the filters. */
  selectable: readonly IndexedNote[];
  has: (id: string) => boolean;
  canSelect: (note: IndexedNote) => boolean;
  /**
   * A box set to `checked`. `range` (Shift): every task between the box pressed before and this one,
   * in the order of the screen, takes the same state.
   */
  toggle: (note: IndexedNote, checked: boolean, range: boolean) => void;
  /** Every task of the screen, or none. */
  all: (checked: boolean) => void;
  /** These tasks, all set to `checked`: the box of a group of the list (FRU-685). */
  some: (notes: readonly IndexedNote[], checked: boolean) => void;
  clear: () => void;
  /** What the line of status of the selection says after a change: « 3 notes changed. » */
  said: string | undefined;
  say: (said: string | undefined) => void;
};

export const TaskSelectionContext = createContext<TaskSelection | undefined>(undefined);

/** A task Fruitback keeps: a note of a tracker changes in its tracker, and is not selected here. */
export const isTask = (note: IndexedNote): boolean => note.task !== undefined;

/** Whether this person may change a task: the same rule as its menu (FRU-654). */
export const isEditable = (note: IndexedNote): boolean => note.canSetStatus === true && note.task !== undefined;

/**
 * The selection of the notes `shown`, in the order of the screen. A task that leaves the screen (a
 * filter, a page, an archive, a deletion) leaves the selection. `selectable` says which notes have a
 * box: the tasks Fruitback keeps.
 */
export function useTaskSelection(
  shown: readonly IndexedNote[],
  selectable: (note: IndexedNote) => boolean = isTask,
): TaskSelection {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());
  const [said, say] = useState<string | undefined>();
  // The box pressed last without Shift: where a range starts.
  const anchor = useRef<string | undefined>(undefined);
  const choosable = useMemo(() => shown.filter(selectable), [shown, selectable]);

  // What a change said holds for the list it was said over: the list read after that change. A list
  // read again later (a filter, a page, the board) makes it stale, and it goes.
  const saidOver = useRef<readonly IndexedNote[] | undefined>(undefined);
  useEffect(() => {
    if (said === undefined) saidOver.current = undefined;
    else if (saidOver.current === undefined) saidOver.current = choosable;
    else if (saidOver.current !== choosable) say(undefined);
  }, [said, choosable]);

  // A task no longer shown is no longer selected: a change of the bar never reaches a task off screen.
  useEffect(() => {
    setIds((was) => {
      const kept = new Set(choosable.filter((note) => was.has(note.id)).map((note) => note.id));

      return kept.size === was.size ? was : kept;
    });
  }, [choosable]);

  const toggle = useCallback(
    (note: IndexedNote, checked: boolean, range: boolean) => {
      say(undefined);
      const from = range && anchor.current !== undefined ? choosable.findIndex((one) => one.id === anchor.current) : -1;
      const to = choosable.findIndex((one) => one.id === note.id);
      const span = from < 0 || to < 0 ? [note] : choosable.slice(Math.min(from, to), Math.max(from, to) + 1);
      if (!range || from < 0) anchor.current = note.id;
      setIds((was) => {
        const next = new Set(was);
        for (const one of span) {
          if (checked) next.add(one.id);
          else next.delete(one.id);
        }

        return next;
      });
    },
    [choosable],
  );

  const all = useCallback(
    (checked: boolean) => {
      say(undefined);
      anchor.current = undefined;
      setIds(checked ? new Set(choosable.map((note) => note.id)) : new Set());
    },
    [choosable],
  );

  const some = useCallback((notes: readonly IndexedNote[], checked: boolean) => {
    say(undefined);
    anchor.current = undefined;
    setIds((was) => {
      const next = new Set(was);
      for (const note of notes) {
        if (checked) next.add(note.id);
        else next.delete(note.id);
      }

      return next;
    });
  }, []);

  return useMemo(
    () => ({
      notes: choosable.filter((note) => ids.has(note.id)),
      selectable: choosable,
      has: (id: string) => ids.has(id),
      canSelect: selectable,
      toggle,
      all,
      some,
      clear: () => all(false),
      said,
      say,
    }),
    [choosable, ids, selectable, toggle, all, some, said],
  );
}

/**
 * The keys of a selection on the screen of the notes (FRU-656): Cmd or Ctrl and A selects every task
 * of the page, unless the focus is in a field, a menu or a dialog, which keep the key for their text;
 * Escape clears the selection, unless something of the screen took it first (a menu, a dialog, the
 * panel of a task, a question asked again).
 */
export function useSelectionKeys(selection: TaskSelection): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || composes(event) || ownsKeys(event)) return;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'a') {
        if (selection.selectable.length === 0) return;
        event.preventDefault();
        selection.all(true);
      } else if (event.key === 'Escape' && selection.notes.length > 0) {
        selection.clear();
      }
    };
    // On the window, past the root of React (the document, in this console): a handler of the screen
    // that stops the key (a question asked again) stops it before it reaches here.
    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [selection]);
}

/**
 * Out of a selection, the box of a row or a card shows under the pointer, under the keyboard, and
 * always on a touch screen. Once a task is selected, every box shows.
 */
const REVEAL =
  'kit-select-reveal [[data-selecting=false]_&]:opacity-0 [[data-selecting=false]_:is(tr,li):hover_&]:opacity-100 [[data-selecting=false]_&:focus-within]:opacity-100 pointer-coarse:[[data-selecting=false]_&]:opacity-100';

/**
 * The box of a row or a card (FRU-656), named after the text of its note. A note that cannot be
 * selected has none; in the table it keeps the room of one (`room`), so every text starts at one edge.
 */
export function SelectTask({
  note,
  room = false,
  className = '',
}: {
  note: IndexedNote;
  room?: boolean;
  className?: string;
}) {
  useLocale();
  const selection = useContext(TaskSelectionContext);
  if (selection === undefined) return null;
  if (!selection.canSelect(note))
    return room ? (
      <span aria-hidden="true" className={`kit-select-room inline-block flex-none w-[28px] ${className}`} />
    ) : null;

  return (
    <SelectBox
      className={`${REVEAL} ${className}`}
      label={t('Select: {note}', { note: excerptOf(note.excerpt) })}
      checked={selection.has(note.id)}
      onToggle={(checked, range) => selection.toggle(note, checked, range)}
    />
  );
}

/** The box of the head of the table: every task of the page, or none; half ticked when some are. */
export function SelectPage() {
  useLocale();
  const selection = useContext(TaskSelectionContext);
  if (selection === undefined || selection.selectable.length === 0) return null;
  const count = selection.notes.length;

  return (
    <SelectBox
      label={t('Select every task of this page')}
      checked={count > 0 && count === selection.selectable.length}
      mixed={count > 0 && count < selection.selectable.length}
      onToggle={(checked) => selection.all(checked)}
    />
  );
}

/**
 * What a row or a card gives the selection (FRU-656): Shift and a click out of its links, buttons and
 * fields selects the range up to it, and the press does not select its text. `data-selected` draws it.
 */
export function useSelectRow(note: IndexedNote): {
  onClick: (event: MouseEvent) => void;
  onMouseDown: (event: MouseEvent) => void;
  'data-selected': boolean;
} {
  const selection = useContext(TaskSelectionContext);
  const plain = (event: MouseEvent) =>
    selection !== undefined &&
    event.shiftKey &&
    selection.canSelect(note) &&
    event.target instanceof Element &&
    event.target.closest('a, button, input, label, select, textarea, [role="button"]') === null;

  return {
    onMouseDown: (event) => {
      if (plain(event)) event.preventDefault();
    },
    onClick: (event) => {
      if (selection === undefined || !plain(event)) return;
      selection.toggle(note, !selection.has(note.id), true);
    },
    'data-selected': selection?.has(note.id) === true,
  };
}

/**
 * The line of status of the selection (FRU-656), for a screen reader: how many notes are selected,
 * or what the last change did. Always in the page, so that its first words are said too.
 */
export function SelectionStatus() {
  useLocale();
  const selection = useContext(TaskSelectionContext);
  let words = '';
  if (selection?.said !== undefined) words = selection.said;
  else if (selection !== undefined && selection.notes.length > 0) words = selectedWords(selection.notes.length);

  return (
    <p role="status" className="sr-only">
      {words}
    </p>
  );
}

/** « 1 note selected », « 3 notes selected ». */
export function selectedWords(count: number): string {
  return count === 1 ? t('1 note selected') : t('{count} notes selected', { count });
}
