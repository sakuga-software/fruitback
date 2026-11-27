/**
 * « Deleted notes » of the card « Safeguards » (FRU-704): what becomes of a note its visitor deleted
 * (FRU-702, `removed_at` of the index). The site keeps it `deletedNotesKeepDays` days (7, 30 or 90,
 * 30 by default); meanwhile a member restores it, and after them the worker erases it for good.
 *
 * - **Kept**: the note stays in its store, closed as withdrawn, and out of its page for every reader.
 *   The page of the note in the console says when it goes, to a role that sees the tracker.
 * - **Restored** (`restore`): the mark of the deletion goes, and the pin shows on its page again, with
 *   the stage the note has now (closed, as the withdrawal left it). A member then opens it again with
 *   its status, as any note.
 * - **Erased** (`sweep`, on the timer of the worker): a note the worker keeps (its own store, or sent
 *   on to an address) goes whole: its row in `notes` with its replies and labels, and its row in the
 *   index with its versions and the address of a visitor that waited for it to be done. A note of a
 *   tracker lives in the tracker, the team's: the worker erases what it keeps of it (the excerpt, the
 *   digest of the browser key, the element, the versions) and keeps the row, marked `erased_at`, so
 *   that the issue never shows on its page again. The lists of the console leave it out.
 * - A visitor sends no file (`takeFiles` needs a session): a deleted note has no file to erase.
 */
export type DeletedNote = {
  /** When its visitor deleted it. */
  removedAt: number;
  /** When it is erased for good, unless a member restores it before. */
  until: number;
};

export type DeletedNotes = {
  /** The note, when its visitor deleted it and it is not erased yet. `undefined` for any other note. */
  of(workspace: string, site: string, note: string, now: number): Promise<DeletedNote | undefined>;
  /**
   * Restores the note: its page, to read again. `undefined`: no such note of the workspace that its
   * visitor deleted, or its days ran out.
   */
  restore(workspace: string, site: string, note: string, now: number): Promise<{ page: string } | undefined>;
  /** Erases the deleted notes whose days ran out, `DELETED_SWEEP_BATCH` at most. Answers how many. */
  sweep(now: number): Promise<number>;
};

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The most notes one sweep erases. The sweep runs on the timer of `sweepDoneNotices`, so a backlog
 * goes in a few passes, and one pass never holds the database long.
 */
export const DELETED_SWEEP_BATCH = 500;
