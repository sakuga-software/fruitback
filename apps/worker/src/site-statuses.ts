import {
  MIN_TEXT_CONTRAST,
  SEED_STAGES,
  STATUS_COLOR,
  type SeedStage,
  type SeedStatus,
  contrastRatio,
  readableTextColor,
} from '@fruitback/shared';

/**
 * A status of a site, as the table `statuses` keeps it (FRU-365), and what a write must hold.
 *
 * `docs/decisions/statuses.md` is the model. The console API of FRU-366 calls `readSiteStatus` on
 * every write, so the refusals are here, next to the table, rather than in a route.
 */

/** The source of a status kept by the worker, rather than read from a connector. */
export const OWN_SOURCE = 'own';

/** An id of a connector, or `own`. */
const SOURCE = /^[A-Za-z0-9_-]{1,64}$/;

/** An id of a state at a tracker, a fixed key such as GitHub's `closed:completed`, or a slug. */
const KEY = /^[A-Za-z0-9_:-]{1,64}$/;

/** What the read envelope lets a name be (`seedStatusSchema` of `shared`). */
export const MAX_STATUS_NAME = 200;

export const STATUS_ORIGINS = ['tracker', 'team'] as const;
export type StatusOrigin = (typeof STATUS_ORIGINS)[number];

export type SiteStatus = {
  source: string;
  key: string;
  /** `null`: the name of the tracker, or the word of the widget for the stage. */
  name: string | null;
  stage: SeedStage;
  /** `null`: the colour of the stage (FRU-334), which a host can still set. */
  color: string | null;
  /** `null`: computed from `color` with `readableTextColor`, or the foreground of the stage. */
  textColor: string | null;
  position: number;
  origin: StatusOrigin;
  hidden: boolean;
};

export type StatusRefusal =
  | 'not-a-status'
  | 'invalid-source'
  | 'invalid-key'
  | 'invalid-name'
  | 'invalid-stage'
  | 'invalid-color'
  | 'text-without-color'
  | 'text-under-contrast'
  | 'invalid-position'
  | 'invalid-origin'
  | 'invalid-hidden';

/**
 * A status from what a request holds, or the first reason to refuse it. Nothing is folded: a value
 * that is not exactly what the table keeps is refused, like `readConnectorSettings`.
 *
 * - A colour is `#rrggbb` and nothing else: it is written into a style (statuses.md, « Risks »).
 * - A text colour needs a background colour, and reaches 4.5:1 on it. A text the team chose under
 *   that is refused, never corrected: the console shows the ratio and lets the team choose « Auto ».
 * - An empty name is `null`, the name of the tracker.
 */
export function readSiteStatus(
  value: unknown,
): { ok: true; status: SiteStatus } | { ok: false; refusal: StatusRefusal } {
  const refuse = (refusal: StatusRefusal) => ({ ok: false as const, refusal });
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return refuse('not-a-status');
  const {
    source,
    key,
    name = null,
    stage,
    color = null,
    textColor = null,
    position = 0,
    origin = 'tracker',
    hidden = false,
  } = value as Record<string, unknown>;

  if (typeof source !== 'string' || !SOURCE.test(source)) return refuse('invalid-source');
  if (typeof key !== 'string' || !KEY.test(key)) return refuse('invalid-key');
  if (name !== null && (typeof name !== 'string' || name.length > MAX_STATUS_NAME)) return refuse('invalid-name');
  if (!(SEED_STAGES as readonly unknown[]).includes(stage)) return refuse('invalid-stage');
  for (const one of [color, textColor]) {
    if (one !== null && (typeof one !== 'string' || !STATUS_COLOR.test(one))) return refuse('invalid-color');
  }
  if (textColor !== null && color === null) return refuse('text-without-color');
  if (textColor !== null && (contrastRatio(color as string, textColor as string) as number) < MIN_TEXT_CONTRAST) {
    return refuse('text-under-contrast');
  }
  if (!Number.isSafeInteger(position) || (position as number) < 0) return refuse('invalid-position');
  if (!(STATUS_ORIGINS as readonly unknown[]).includes(origin)) return refuse('invalid-origin');
  if (typeof hidden !== 'boolean') return refuse('invalid-hidden');

  return {
    ok: true,
    status: {
      source,
      key,
      name: name === '' ? null : (name as string | null),
      stage: stage as SeedStage,
      color: color as string | null,
      textColor: textColor as string | null,
      position: position as number,
      origin: origin as StatusOrigin,
      hidden,
    },
  };
}

/**
 * A built-in status of the worker's store: `own`, and a key that is one of the five stages (FRU-366).
 * Its stage is its key and does not change: a note with no `status_key` is in the built-in status of
 * its stage, so a built-in moved to another stage would draw that note with a stage it does not have.
 */
export function isBuiltIn(source: string, key: string): boolean {
  return source === OWN_SOURCE && (SEED_STAGES as readonly string[]).includes(key);
}

/**
 * Where a status comes from, as the worker decides it rather than the request: a state of a tracker
 * or a built-in status is `tracker`, a status the team added to the worker's store is `team`.
 */
export function originOf(source: string, key: string): StatusOrigin {
  return source === OWN_SOURCE && !isBuiltIn(source, key) ? 'team' : 'tracker';
}

/**
 * The ink of the widget's theme (`--fruitback-color-text` of packages/widget/src/theme.ts): the dark
 * text that `readableTextColor` tries first. The worker names it to compute the text of a status
 * whose team chose a background and no text; `theme.ts` stays the one source of the palette.
 */
export const STATUS_INK = '#18181b';

/**
 * The `statuses` of a read for one site (FRU-366): every row of the site, and the five built-in
 * statuses of the worker's store that no row changed. A row's key becomes `<source>:<key>`, unique in
 * the read. A colour with no text colour gets the one `readableTextColor` computes, so the text of a
 * pin reaches 4.5:1 whatever the widget.
 */
export function envelopeStatuses(rows: readonly SiteStatus[]): SeedStatus[] {
  const listed = rows.map((row) => {
    const textColor = row.textColor ?? (row.color === null ? undefined : readableTextColor(row.color, STATUS_INK));

    return {
      key: `${row.source}:${row.key}`,
      name: row.name ?? '',
      stage: row.stage,
      ...(row.color === null ? {} : { color: row.color }),
      ...(textColor === undefined ? {} : { textColor }),
    };
  });
  const changed = new Set(listed.map((status) => status.key));
  const builtIn = SEED_STAGES.filter((stage) => !changed.has(`${OWN_SOURCE}:${stage}`)).map((stage) => ({
    key: `${OWN_SOURCE}:${stage}`,
    name: '',
    stage,
  }));

  return [...listed, ...builtIn];
}
