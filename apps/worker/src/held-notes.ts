import type { Note } from '@fruitback/shared';

/**
 * The notes of visitors that wait for a member (FRU-704): « Hold new visitor notes » of the card
 * « Safeguards ». On a site that holds them, a note sent with no token is not sent to its place: the
 * worker keeps it here, and a member approves it (it then goes to its place as it would have gone) or
 * rejects it (it goes).
 *
 * - The note is kept as the route would have sent it: the reporter the worker attributed, the text,
 *   the page, the anchor. A visitor sends no file (`takeFiles` needs a session), so none waits.
 * - `visitor` is the digest of the key of the browser (`visitorDigestOf`), so an approved note is the
 *   visitor's own in the index, as if it had gone at once. Never the key.
 * - A note waits `HELD_NOTE_KEEP_MS` at most: nobody answered, it goes (`sweep`).
 */
export type HeldNote = {
  site: string;
  workspace: string;
  note: Note;
  visitor?: string;
  heldAt: number;
};

/** What a member reads of the queue « To approve »: newest first, `HELD_NOTE_LIST` at most. */
export type HeldNotes = {
  /** Keeps a note. `false`: the site holds a note of this id already, and nothing is written. */
  hold(held: HeldNote): Promise<boolean>;
  /** The notes of these sites of the workspace (every site when `sites` is absent), newest first. */
  list(workspace: string, sites: readonly string[] | undefined, now: number): Promise<HeldNote[]>;
  /** How many wait on these sites of the workspace. */
  count(workspace: string, sites: readonly string[] | undefined, now: number): Promise<number>;
  /**
   * Takes the note out of the queue, and answers it: `undefined` when it is not there, or another call
   * took it first. Two members who approve at once send it once. A note that waited longer than
   * `HELD_NOTE_KEEP_MS` is not taken: it is gone, though the sweep did not pass yet.
   */
  take(workspace: string, site: string, note: string, now: number): Promise<HeldNote | undefined>;
  /** Removes the notes that waited longer than `HELD_NOTE_KEEP_MS`. Answers how many went. */
  sweep(now: number): Promise<number>;
};

/** How long a held note waits for a member: 30 days, then it goes, as a note nobody approved. */
export const HELD_NOTE_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/** The most notes one read of the queue answers. */
export const HELD_NOTE_LIST = 200;
