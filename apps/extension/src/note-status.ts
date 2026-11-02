import { paintOfStatus, statusLabel } from '@fruitback/shared';
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
  return paintOfStatus(note.status?.color, note.status?.textColor);
}

/** The word of the state of a note: the name of its status, the word of its store, or of its stage. */
export function stateWord(note: Pick<PanelNote, 'status' | 'stateName'>, stageWord: string): string {
  return statusLabel(note.status?.name, note.stateName, stageWord);
}
