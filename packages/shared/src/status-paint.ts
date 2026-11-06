import { readableTextColor } from './contrast.ts';
import { STATUS_COLOR } from './issue.ts';

/**
 * How a note is painted and named, written once for the widget, the extension and the worker
 * (FRU-512). See docs/decisions/statuses.md, « The colours ».
 */

/**
 * The ink of the theme: the dark text that `readableTextColor` tries first on the colour of a
 * status. It is `--fruitback-color-ink` of the widget, `--ink` of the extension's kit, and the ink the
 * worker computes the text colour of a status with. `status-paint.test.ts` of the widget compares it
 * with `theme.ts`.
 */
export const STATUS_INK = '#18181b';

/** What a pin, a drop or a mark of a note is filled with, and what is written on it. */
export type StatusPaint = { fill: string; ink: string };

/**
 * The fill and the ink of a status of this colour, or `undefined` when the colour is not `#rrggbb`:
 * the caller then draws its stage, and nothing else reaches a style. A text colour the team chose is
 * kept when it is `#rrggbb`; else the text is computed on the fill, the ink first.
 */
export function paintOfStatus(color: string, textColor: string | undefined): StatusPaint | undefined {
  // `undefined` exactly when `color` is not `#rrggbb`: the ink is.
  const computed = readableTextColor(color, STATUS_INK);
  if (computed === undefined) return undefined;

  return { fill: color, ink: textColor !== undefined && STATUS_COLOR.test(textColor) ? textColor : computed };
}

/**
 * The word of a note's state: the name of its status, else the name of its state in its tracker,
 * else the word of its stage. `||` and not `??`: an empty name means the next word (FRU-114, FRU-364).
 */
export function statusLabel(statusName: string | undefined, stateName: string | undefined, stageWord: string): string {
  return statusName || stateName || stageWord;
}

/** The trackers `trackerOf` names: a reader of a page keeps one of these, or none. */
export const TRACKER_NAMES = ['Linear', 'GitHub'] as const;
export type TrackerName = (typeof TRACKER_NAMES)[number];

/**
 * The tracker an issue lives in, by the address of the issue (FRU-606): « Linear », « GitHub », or
 * `undefined` for any other address, for none, and for an address that does not parse. A product name,
 * the same in every language.
 */
export function trackerOf(url: string | undefined): TrackerName | undefined {
  if (url === undefined) return undefined;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }
  if (host === 'linear.app' || host.endsWith('.linear.app')) return 'Linear';
  if (host === 'github.com') return 'GitHub';

  return undefined;
}

/**
 * The state of a note in a list, the Fruitback stage first and the tracker second (FRU-606):
 * « In progress · Linear: In Review ». `name` is the name of its status, or the word of its tracker.
 * The stage alone when there is no name, or when the name says the stage again (« Done · Done »).
 */
export function stageFirstLabel(stageWord: string, name: string | undefined, tracker: string | undefined): string {
  const said = name?.trim() ?? '';
  if (said === '' || said.toLocaleLowerCase() === stageWord.toLocaleLowerCase()) return stageWord;

  return `${stageWord} · ${tracker === undefined ? '' : `${tracker}: `}${said}`;
}
