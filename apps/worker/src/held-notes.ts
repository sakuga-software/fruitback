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

/** What a member reads of the queue « To approve »: newest first, `HELD_NOTE_LIST` at most. A note being sent is not in it. */
export type HeldNotes = {
  /** Keeps a note. `false`: the site holds a note of this id already, and nothing is written. */
  hold(held: HeldNote): Promise<boolean>;
  /** The notes of these sites of the workspace (every site when `sites` is absent), newest first. */
  list(workspace: string, sites: readonly string[] | undefined, now: number): Promise<HeldNote[]>;
  /** How many wait on these sites of the workspace. */
  count(workspace: string, sites: readonly string[] | undefined, now: number): Promise<number>;
  /**
   * Claims the note until `now + HELD_CLAIM_MS`, and answers it: `undefined` when it is not there,
   * another call holds a claim that has not run out, or it waited longer than `HELD_NOTE_KEEP_MS`. Two
   * members who answer at once send it once. The row stays until `done`: a process that stops while it
   * sends loses nothing, and the claim runs out.
   */
  take(workspace: string, site: string, note: string, now: number): Promise<HeldNote | undefined>;
  /** The note went to its place, or was rejected: its row goes. */
  done(site: string, note: string): Promise<void>;
  /** The note did not go: its claim goes, and it waits in the queue again. */
  release(site: string, note: string): Promise<void>;
  /** Removes the notes that waited longer than `HELD_NOTE_KEEP_MS`. Answers how many went. */
  sweep(now: number): Promise<number>;
};

/** How long a held note waits for a member: 30 days, then it goes, as a note nobody approved. */
export const HELD_NOTE_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long an approval holds the note it is sending: 5 minutes, well above the time a tracker takes to
 * answer. An approval that stopped meanwhile leaves the note to the next one.
 */
export const HELD_CLAIM_MS = 5 * 60 * 1000;

/** The most notes one read of the queue answers. */
export const HELD_NOTE_LIST = 200;
