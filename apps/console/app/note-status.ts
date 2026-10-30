import type { Stage } from './api';
import { msg } from './i18n.ts';
import { failureOf, writeProblemOf } from './problems.ts';

/**
 * The status of a note the worker keeps, chosen in the list of the notes (FRU-384).
 *
 * The list gives each such note its `status` (`own:<key>`) and `canSetStatus`, and, per site, the
 * statuses of the worker's store: a built-in one has no name of its own unless the team renamed it,
 * and a hidden one names the notes in it but is never offered. A note of a tracker has none of these:
 * its status is the tracker's, and the list shows its stage.
 */

/** A status of a site as `GET …/notes` gives it. */
export type StatusChoice = {
  key: string;
  name: string;
  stage: Stage;
  color?: string;
  textColor?: string;
  hidden?: true;
};

/**
 * The name a status is shown with: the one the team gave it, or, for a built-in status the team did
 * not rename, the name of its stage (through `stageName`, so that it is said in the reader's language).
 */
export function statusName(status: StatusChoice, stageName: (stage: Stage) => string): string {
  return status.name === '' ? stageName(status.stage) : status.name;
}

/**
 * The statuses the select offers for a note in `current`: the site's, without the hidden ones, but
 * with the one the note is in, even hidden, so that the select still names it.
 */
export function offeredFor(statuses: readonly StatusChoice[], current: string): StatusChoice[] {
  return statuses.filter((status) => status.hidden !== true || status.key === current);
}

/** The sentence for a status the worker did not save. The select keeps what the person chose. */
export const STATUS_PROBLEMS: Readonly<Record<string, string>> = {
  'status-changed': msg('This status was removed from the site since the list was read. Reload the page.'),
  'status-hidden': msg('This status is hidden now, so no note goes in it. Choose another one.'),
  'not-allowed': msg('Only the person who left this note, or an owner or an admin, changes its status.'),
  'statuses-not-taken': msg('The status of this note changes in its tracker.'),
  'not-found': msg('This note is no longer in Fruitback. Reload the page.'),
};
export const STATUS_NOT_SAVED = msg('The status was not saved. Try again.');

export function statusProblemOf(failed: { status: number; error: string }): string {
  if (Object.hasOwn(STATUS_PROBLEMS, failed.error)) return STATUS_PROBLEMS[failed.error] as string;
  if (failed.status === 0 || failed.status >= 500) return failureOf(failed);

  return writeProblemOf(failed, STATUS_NOT_SAVED);
}
