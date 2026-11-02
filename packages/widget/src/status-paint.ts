import {
  type NoteIssue,
  type NoteStatus,
  type StatusPaint,
  paintOfStatus,
  statusLabel as labelOfState,
} from '@fruitback/shared';
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
 * The ink of the theme, `--fruitback-color-ink`: what `readableTextColor` measures first. Written once in
 * `@fruitback/shared`, for the extension and the worker too (FRU-512). `status-paint.test.ts` compares it
 * with `theme.ts`.
 */
export { STATUS_INK, type StatusPaint } from '@fruitback/shared';

/**
 * The fill and the ink of a note in this status. `undefined`: the stage.
 *
 * **A colour reaches `style.setProperty` only as `#rrggbb`.** `offeredStatuses` already drops any other,
 * and this checks again, so no caller can pass `var(…)` or `url(…)` into a style.
 */
export function statusPaint(issue: Pick<NoteIssue, 'stage'>, status: NoteStatus | undefined): StatusPaint {
  // A text colour that the team chose was measured at 4.5:1 by the worker on save. Else, computed.
  return (
    paintOfStatus(status?.color, status?.textColor) ?? { fill: stageToken(issue.stage), ink: onStageToken(issue.stage) }
  );
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
  return labelOfState(status?.name, issue.stateName, t.stage(issue.stage));
}
