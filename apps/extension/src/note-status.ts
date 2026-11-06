import { paintOfStatus, stageFirstLabel, statusLabel } from '@fruitback/shared';
import type { PanelNote } from './protocol.ts';

/**
 * The status of a note in the side panel (FRU-370), as the widget draws it on the page.
 *
 * See docs/decisions/statuses.md. A status with a colour fills the drop; its text colour is the one
 * the team chose, or the one `readableTextColor` computes on the ink. A status with no colour, and a
 * note with no status, keep the class of their stage.
 */

/** The ink of the kit, `--ink` of popup/style.css: what `readableTextColor` measures first (FRU-512). */
export { STATUS_INK } from '@fruitback/shared';

/**
 * The fill and the ink of the drop of a note, or nothing for its stage. The colours were checked as
 * `#rrggbb` by `parsePanelNotes`: nothing else reaches a style.
 */
export function notePaint(note: Pick<PanelNote, 'status'>): { fill: string; ink: string } | undefined {
  const color = note.status?.color;

  return color === undefined ? undefined : paintOfStatus(color, note.status?.textColor);
}

/** The word of the state of a note: the name of its status, the word of its store, or of its stage. */
export function stateWord(note: Pick<PanelNote, 'status' | 'stateName'>, stageWord: string): string {
  return statusLabel(note.status?.name, note.stateName, stageWord);
}

/**
 * The state of a note in a list, the stage of Fruitback first and the tracker second (FRU-606), as the
 * list of the widget writes it: « In progress · Linear: In Review ». The word of the store follows only
 * when the widget named the tracker of the issue; the name a team gave a status follows always.
 */
export function listWord(note: Pick<PanelNote, 'status' | 'stateName' | 'tracker'>, stageWord: string): string {
  const name = note.status?.name || (note.tracker === undefined ? undefined : note.stateName);

  return stageFirstLabel(stageWord, name, note.tracker);
}
