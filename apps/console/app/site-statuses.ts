import { MAX_STATUSES, MIN_TEXT_CONTRAST, SEED_STAGES, STATUS_COLOR, contrastRatio } from '@fruitback/shared';
import type { Stage } from './api';

/**
 * The statuses of a site (FRU-371), as the screen holds them: what the worker keeps for the site
 * (FRU-366), merged with what is there with no row. No React, no network, no word: `site-statuses.test.ts`.
 *
 * A status with no row is what the tracker, or the worker, says by default. The worker keeps a row only
 * once the team changed something, so the screen draws the defaults itself: the five built-in statuses
 * of the worker's store, and the four fixed states of GitHub. docs/decisions/statuses.md is the model.
 */

/** The source of the statuses kept by the worker, rather than read from a connector. */
export const OWN = 'own';

export { MAX_STATUSES, MIN_TEXT_CONTRAST };

/** A status as `GET …/statuses` answers it, and as `POST …/statuses` takes it. */
export type StatusRow = {
  source: string;
  key: string;
  /** `null`: the name of the tracker, or the word of the stage. */
  name: string | null;
  stage: Stage;
  /** `null`: the colour of the stage. */
  color: string | null;
  /** `null`: computed from the colour. */
  textColor: string | null;
  position: number;
  origin: 'tracker' | 'team';
  hidden: boolean;
};

/** A status of the screen: its row, or the default it stands for. */
export type ScreenStatus = StatusRow & {
  /** The stage it has with no row. A built-in status keeps it; a status the team added has its own. */
  defaultStage: Stage;
  /** One of the five of the worker's store: renamed and recoloured, never moved to another stage or deleted. */
  builtIn: boolean;
  /** The worker keeps a row for it. */
  kept: boolean;
  /** Where it is in the list when nobody ordered it. */
  rank: number;
};

/** The four states of a GitHub issue (FRU-369), and the stage of each (FRU-32). */
export const GITHUB_STATES: readonly { key: string; stage: Stage }[] = [
  { key: 'open', stage: 'new' },
  { key: 'closed:completed', stage: 'done' },
  { key: 'closed:not_planned', stage: 'closed' },
  { key: 'closed:duplicate', stage: 'closed' },
];

/** What a source of statuses is: the worker's store, or a GitHub connector. */
export type ListKind = 'own' | 'github';

function blank(source: string, key: string, stage: Stage, rank: number, builtIn: boolean): ScreenStatus {
  return {
    source,
    key,
    name: null,
    stage,
    color: null,
    textColor: null,
    position: rank,
    origin: builtIn || source !== OWN ? 'tracker' : 'team',
    hidden: false,
    defaultStage: stage,
    builtIn,
    kept: false,
    rank,
  };
}

/**
 * The statuses of one source of a site, in their order: the defaults of that source, each replaced by
 * its row when the worker keeps one, then the statuses the team added (the worker's store only).
 *
 * The order is the position of a row, and the rank of a default with no row: the screen writes a
 * status at the place it shows it, so both count from the top of the same list. A tie keeps the
 * order of the defaults.
 */
export function statusesOf(kind: ListKind, source: string, rows: readonly StatusRow[]): ScreenStatus[] {
  const defaults =
    kind === 'own'
      ? SEED_STAGES.map((stage, rank) => blank(source, stage, stage, rank, true))
      : GITHUB_STATES.map((state, rank) => blank(source, state.key, state.stage, rank, false));
  const mine = rows.filter((row) => row.source === source);
  const known = new Set(defaults.map((each) => each.key));
  const merged = defaults.map((each) => {
    const row = mine.find((one) => one.key === each.key);

    return row === undefined ? each : { ...each, ...row, kept: true };
  });
  const added =
    kind === 'own'
      ? mine
          .filter((row) => !known.has(row.key))
          .map((row, index) => ({
            ...row,
            defaultStage: row.stage,
            builtIn: false,
            kept: true,
            rank: defaults.length + index,
          }))
      : [];

  return [...merged, ...added].sort(
    (one, other) =>
      (one.kept ? one.position : one.rank) - (other.kept ? other.position : other.rank) || one.rank - other.rank,
  );
}

/** Whether a status differs from its default, so « Reset » gives something back. Never for one the team added. */
export function isChanged(status: ScreenStatus): boolean {
  if (status.source === OWN && !status.builtIn) return false;

  return (
    status.name !== null || status.color !== null || status.textColor !== null || status.stage !== status.defaultStage
  );
}

/** Whether the team can delete it: only a status the team added to the worker's store holds notes of its own. */
export function isDeletable(status: ScreenStatus): boolean {
  return status.source === OWN && !status.builtIn;
}

/** What `POST …/statuses` takes for a status. The worker decides `origin` itself. */
export function rowOf(status: ScreenStatus): StatusRow {
  return {
    source: status.source,
    key: status.key,
    name: status.name,
    stage: status.stage,
    color: status.color,
    textColor: status.textColor,
    position: status.position,
    origin: status.origin,
    hidden: status.hidden,
  };
}

/** A status as it was before the team changed it, at the same place. */
export function resetOf(status: ScreenStatus): ScreenStatus {
  return { ...status, name: null, color: null, textColor: null, stage: status.defaultStage };
}

/** The list with the status at `index` moved by `step` places, each at its new position. `undefined` past an end. */
export function moved(list: readonly ScreenStatus[], index: number, step: -1 | 1): ScreenStatus[] | undefined {
  const target = index + step;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return undefined;
  const next = [...list];
  [next[index], next[target]] = [next[target] as ScreenStatus, next[index] as ScreenStatus];

  return next.map((each, position) => ({ ...each, position }));
}

/** The pattern of a key at the worker (`site-statuses.ts`). */
const KEY = /^[A-Za-z0-9_:-]{1,64}$/;

/**
 * A key for a status the team adds, from its name: lowercase letters, digits and hyphens, unique among
 * `taken`, never the key of a built-in status. A name with no such letter gets a key of its own.
 */
export function keyFor(name: string, taken: Iterable<string>, random: () => number = Math.random): string {
  const used = new Set([...taken, ...SEED_STAGES]);
  const base =
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/, '') || `status-${Math.floor(random() * 36 ** 6).toString(36)}`;
  let key = base;
  for (let suffix = 2; used.has(key); suffix += 1) key = `${base}-${suffix}`;

  return KEY.test(key) ? key : `status-${Math.floor(random() * 36 ** 6).toString(36)}`;
}

/** Whether `value` is a colour the worker keeps: `#rrggbb`. */
export function isColour(value: string): boolean {
  return STATUS_COLOR.test(value);
}

/** `#rrggbb` from what somebody typed: the `#` is added, the letters lowered. `undefined` for anything else. */
export function colourOf(typed: string): string | undefined {
  const trimmed = typed.trim();
  const value = (trimmed.startsWith('#') ? trimmed : `#${trimmed}`).toLowerCase();

  return isColour(value) ? value : undefined;
}

/** The contrast of a text on a background, both `#rrggbb`, or `undefined` while one is not. */
export function ratioOf(background: string | undefined, text: string | undefined): number | undefined {
  if (background === undefined || text === undefined) return undefined;

  return contrastRatio(background, text);
}

/** Whether a text reads on its background: 4.5:1 at the least (SC 1.4.3). */
export function reads(ratio: number | undefined): boolean {
  return ratio !== undefined && ratio >= MIN_TEXT_CONTRAST;
}
