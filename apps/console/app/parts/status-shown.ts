import { readableTextColor } from '@fruitback/shared';
import { STAGE_NAMES, type Stage } from '../stages';
import { locale, msg, t } from '../i18n';
import { MIN_TEXT_CONTRAST, OWN, type ScreenStatus, colourOf, ratioOf } from '../site-statuses';

// How the Statuses screen draws a status (FRU-371, FRU-614): its colours, their ratio, its name, its notes,
// and the sentences of a write that did not go through.

/** The four states of a GitHub issue, in GitHub's words. */
export const GITHUB_NAMES: Readonly<Record<string, string>> = {
  open: msg('Open'),
  'closed:completed': msg('Closed as completed'),
  'closed:not_planned': msg('Closed as not planned'),
  'closed:duplicate': msg('Closed as duplicate'),
};

export const NOT_CHANGED = msg('This status did not change. Try again.');

/**
 * What `writeOne` answers when another write holds the lock: nothing was sent. It is never a success:
 * an editor stays open with what was typed, and nothing is said as done.
 */
export const BUSY = Symbol('busy');

/** What the worker refuses when the statuses of a site change. A note's own status: `note-status.ts`. */
export const STATUS_LIST_PROBLEMS: Readonly<Record<string, string>> = {
  forbidden: msg('Only an owner or an admin of the workspace sets the statuses of a site.'),
  'too-many-statuses': msg('A site holds {count} statuses at most.'),
};

/** The value of a token of `app.css`, as `#rrggbb`. */
function token(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;

  return colourOf(getComputedStyle(document.documentElement).getPropertyValue(name));
}

/** The colours of a status as it is drawn: the team's, or its default (the tracker's, or its stage's). */
export function drawnOf(status: ScreenStatus) {
  return coloursOf(
    status.stage,
    status.color ?? status.defaultColor ?? null,
    status.color === null ? null : status.textColor,
  );
}

/** The colours a status is drawn with: what the style takes, and the `#rrggbb` its contrast is measured on. */
export function coloursOf(stage: Stage, color: string | null, textColor: string | null) {
  const background = color ?? token(`--color-status-${stage}`);
  const ink = token('--color-ink');
  const text =
    textColor ?? (background === undefined || ink === undefined ? undefined : readableTextColor(background, ink));

  return {
    style: { background: color ?? `var(--color-status-${stage})`, ...(text === undefined ? {} : { color: text }) },
    ratio: ratioOf(background, text),
  };
}

/** A ratio as the language writes a number: « 9.90:1 », « 9,90:1 ». */
export function ratioText(ratio: number): string {
  const number = new Intl.NumberFormat(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // Rounded as the board writes it, except that a text under 4.5:1 never reads « 4.50:1 ».
  const shown = ratio < MIN_TEXT_CONTRAST ? Math.floor(ratio * 100) / 100 : ratio;

  return `${number.format(shown)}:1`;
}

/** The name a status shows: the one the team gave, or the tracker's, or the word of its stage. */
export function nameOf(status: ScreenStatus): string {
  if (status.name !== null && status.name !== '') return status.name;
  if (status.trackerName !== undefined) return status.trackerName;
  const github = GITHUB_NAMES[status.key];
  if (status.source !== OWN && github !== undefined) return t(github);

  return t(STAGE_NAMES[status.defaultStage]);
}

/** How many notes are in a status, in words. */
export function notesText(notes: number): string {
  if (notes === 0) return t('No notes');

  return notes === 1 ? t('1 note') : t('{count} notes', { count: notes });
}

/** The notes of each status as the worker says them, or `undefined` for anything that is not such a map. */
export function notesOf(value: unknown): Record<string, number> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, number] => Number.isInteger(entry[1]) && (entry[1] as number) >= 0,
  );

  return Object.fromEntries(entries);
}

/** A status drawn in the colour of its stage: no colour of the team, and none of a tracker. */
export function stageColoured(status: ScreenStatus): boolean {
  return status.color === null && status.defaultColor === undefined;
}

/** The words of the colour a status has when the team chose none: the tracker's, or its stage's. */
export function defaultColourOf(status: ScreenStatus): string {
  return status.defaultColor === undefined ? msg('Colour of the stage') : msg("Linear's colour");
}

/** What an empty name gives, said under the field: the word of a built-in stage, or the tracker's name. */
export function nameHintOf(status: ScreenStatus): string | undefined {
  if (status.builtIn)
    return t('Empty: « {name} », in the language of each person.', { name: t(STAGE_NAMES[status.defaultStage]) });
  if (status.trackerName !== undefined)
    return t('Empty: the name in Linear, « {name} ».', { name: status.trackerName });

  return undefined;
}
