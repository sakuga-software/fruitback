import { readableTextColor } from '@fruitback/shared';
import type { PanelNote } from './protocol.ts';

/**
 * The status of a note in the side panel (FRU-370), as the widget draws it on the page.
 *
 * See docs/decisions/statuses.md. A status with a colour fills the drop; its text colour is the one
 * the team chose, or the one `readableTextColor` computes on the ink. A status with no colour, and a
 * note with no status, keep the class of their stage.
 */

/** The ink of the kit, `--ink` of popup/style.css: what `readableTextColor` measures first. */
export const STATUS_INK = '#18181b';

/**
 * The fill and the ink of the drop of a note, or nothing for its stage. The colours were checked as
 * `#rrggbb` by `parsePanelNotes`: nothing else reaches a style.
 */
export function notePaint(note: Pick<PanelNote, 'status'>): { fill: string; ink: string } | undefined {
  const color = note.status?.color;
  if (color === undefined) return undefined;

  // A colour that `parsePanelNotes` kept is `#rrggbb`, so it answers one.
  return { fill: color, ink: note.status?.textColor ?? (readableTextColor(color, STATUS_INK) as string) };
}

/** The word of the state of a note: the name of its status, the word of its store, or of its stage. */
export function stateWord(note: Pick<PanelNote, 'status' | 'stateName'>, stageWord: string): string {
  return note.status?.name || note.stateName || stageWord;
}
