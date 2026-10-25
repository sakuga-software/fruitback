import { STATUS_COLOR, readableTextColor, type NoteIssue, type NoteStatus } from '@fruitback/shared';
import type { Translator } from './messages.ts';
import { onStageToken, stageToken } from './theme.ts';

/**
 * How a note is painted: the colour of its status, or the token of its stage (FRU-370).
 *
 * See docs/decisions/statuses.md, « The colours ». A status with a colour that the team chose wins over
 * the token of its stage, which a host may have set. A status with no colour, or a note with no status,
 * keeps the token: a site with no statuses draws what it drew before.
 */

/**
 * The ink of the theme, `--fruitback-color-ink`: what `readableTextColor` measures first. The worker
 * computes the same text colour on the same ink (`STATUS_INK` of `apps/worker/src/site-statuses.ts`).
 * `status-paint.test.ts` compares it with `theme.ts`.
 */
export const STATUS_INK = '#18181b';

/** What a pin, a drop or a mark of a note is filled with, and what is written on it. */
export type StatusPaint = { fill: string; ink: string };

/**
 * The fill and the ink of a note in this status. `undefined`: the stage.
 *
 * **A colour reaches `style.setProperty` only as `#rrggbb`.** `offeredStatuses` already drops any other,
 * and this checks again, so no caller can pass `var(…)` or `url(…)` into a style.
 */
export function statusPaint(issue: Pick<NoteIssue, 'stage'>, status: NoteStatus | undefined): StatusPaint {
  const color = status?.color;
  if (color === undefined || !STATUS_COLOR.test(color)) {
    return { fill: stageToken(issue.stage), ink: onStageToken(issue.stage) };
  }
  const chosen = status?.textColor;
  // A text colour that the team chose was measured at 4.5:1 by the worker on save. Else, computed.
  // Computed on a colour checked above, so it answers one.
  const ink =
    chosen !== undefined && STATUS_COLOR.test(chosen) ? chosen : (readableTextColor(color, STATUS_INK) as string);

  return { fill: color, ink };
}

/**
 * The word of a note's state: the name of its status, the word of its store, or the word of the
 * catalog for its stage. `||` and not `??`: an empty name means the catalog word (FRU-114, FRU-364).
 */
export function statusLabel(
  issue: Pick<NoteIssue, 'stage' | 'stateName'>,
  status: NoteStatus | undefined,
  t: Translator,
): string {
  return status?.name || issue.stateName || t.stage(issue.stage);
}
