import type { NotesAnswer } from './parts/notes-model.ts';

// The list of the notes of a workspace, read in chunks as it scrolls (FRU-724).

/** The notes a read of the next notes asks: the default of the worker, asked for by name. */
export const NOTES_PER_READ = 25;

/** The most notes the worker reads at once (`PAGE_SIZES.max` of the worker). */
export const NOTES_PER_READ_AGAIN = 50;

/**
 * The most notes the screen keeps. Past them, no next notes are read: a filter or the search finds
 * the others. A read again after a write reads them all again, so this bounds it too: 10 reads of 50.
 */
export const NOTES_KEPT = 500;

/** What a read of the next notes adds to the list. */
export type Chunk = Pick<NotesAnswer, 'notes' | 'next' | 'statuses'>;

/**
 * The list once a chunk read after it is added: its notes at the end, its cursor in place of the one
 * of the list, and the statuses of its sites with those of the list.
 *
 * A note already in the list is taken from the chunk, and leaves its place: its status changed
 * between the two reads, and moved it in the order of the worker (FRU-551). One note is one row.
 */
export function appended(list: NotesAnswer, chunk: Chunk): NotesAnswer {
  const read = new Set(chunk.notes.map((note) => note.id));
  const { next: _next, statuses: _statuses, ...rest } = list;
  const statuses =
    list.statuses === undefined && chunk.statuses === undefined ? undefined : { ...list.statuses, ...chunk.statuses };

  return {
    ...rest,
    notes: [...list.notes.filter((note) => !read.has(note.id)), ...chunk.notes],
    ...(chunk.next === undefined ? {} : { next: chunk.next }),
    ...(statuses === undefined ? {} : { statuses }),
  };
}

/** Whether the list has next notes the screen may read: a cursor, and fewer notes than it keeps. */
export function hasMore(list: NotesAnswer): boolean {
  return list.next !== undefined && list.notes.length < NOTES_KEPT;
}

/**
 * The notes a read again asks next, when the list holds `have` of the `want` it showed before: what is
 * left, at least a chunk, and at most what the worker reads at once.
 */
export function againLimit(have: number, want: number): number {
  return Math.min(NOTES_PER_READ_AGAIN, Math.max(NOTES_PER_READ, want - have));
}

/** The notes a read again reads back: those the list shows, at least a chunk, and no more than it keeps. */
export function wanted(shown: number): number {
  return Math.min(NOTES_KEPT, Math.max(NOTES_PER_READ, shown));
}
