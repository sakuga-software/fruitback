import type { NoteStage } from './issue.ts';

/**
 * The three tabs of the list of the notes (FRU-606), in the order of the loop: what the reader must
 * check, what is left to do, what is done. The widget and the side panel of the extension sort a note
 * the same way, with `noteTab`. See docs/decisions/statuses.md, « One list of the notes ».
 */
export const NOTE_TABS = ['check', 'open', 'done'] as const;
export type NoteTab = (typeof NOTE_TABS)[number];

/** What `noteTab` reads of a note: its stage, and what the worker says to this reader (FRU-294). */
export type TabbedNote = { stage: NoteStage; mine?: true; checked?: unknown };

/**
 * The tab of a note. `check`: the reader left it, the team marked it done, and nobody confirmed it
 * (FRU-300). `open`: new, to do or in progress. `done`: done and checked, done by somebody else, or
 * closed. A note is in one tab only.
 */
export function noteTab(note: TabbedNote): NoteTab {
  if (note.stage === 'done' && note.mine === true && note.checked === undefined) return 'check';

  return note.stage === 'done' || note.stage === 'closed' ? 'done' : 'open';
}

/**
 * The tab a list opens on while the reader chose none: « To check » while a note waits for their
 * verdict, else « Open ».
 */
export function firstTab(notes: readonly TabbedNote[]): NoteTab {
  return notes.some((note) => noteTab(note) === 'check') ? 'check' : 'open';
}

/**
 * A count as a list writes it (FRU-611, P7): « 99+ » above 99, so a tab or a chip keeps its width. The
 * count of the notes to check is never shortened: it is what the reader has to do, and it is exact.
 */
export function shortCount(count: number): string {
  return count > 99 ? '99+' : String(count);
}
