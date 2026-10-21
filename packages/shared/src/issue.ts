import { type Seed, seedSchema } from './seed.ts';
import { seedAttachmentSchema } from './attachments.ts';
import { z } from 'zod';

/**
 * An issue as the two ends exchange it: its labels, its stage, and the envelope of a read.
 *
 * Nothing here names a provider. This file was `linear.ts` until FRU-30; see
 * docs/decisions/worker.md for what left it and when.
 */

/** Every issue Fruitback creates carries this label. It is the read filter. */
export const FRUITBACK_LABEL = 'fruitback';

/** Per-client label, so one workspace can serve every client site. */
export function clientLabelName(clientId: string): string {
  return `${FRUITBACK_LABEL}:${clientId}`;
}

/** Labels to apply when creating the issue (M3 / FRU-8). */
export function buildIssueLabels(seed: Seed): string[] {
  return seed.client ? [FRUITBACK_LABEL, clientLabelName(seed.client.id)] : [FRUITBACK_LABEL];
}

/**
 * How ripe a pin looks. The widget stores no status of its own; it renders what the store reports.
 *
 * The vocabulary belongs here, the projection onto it does not. Linear has workflow state types,
 * GitHub has open/closed, a SQL store has its own column, so each connector owns its own mapping.
 * A provider's states named here make every consumer of this package depend on that provider
 * (FRU-23).
 */
export const SEED_STAGES = ['seeded', 'green', 'ripening', 'ripe', 'composted'] as const;
export type SeedStage = (typeof SEED_STAGES)[number];

/**
 * What a connector reports for a state it does not recognise.
 *
 * The tolerance is the contract's, not the connector's. A provider gains a state, or a team renames
 * one, and the pin must still be drawn. Drop it and a note disappears from the page because someone
 * added a workflow column.
 */
export const DEFAULT_SEED_STAGE: SeedStage = 'seeded';

/**
 * The stages a store can report, read from the `stages` field of the read envelope (FRU-32).
 *
 * A store can report only some of `SEED_STAGES`. GitHub has two issue states, not five state types.
 * The settings panel offers a filter only for the stages in this list.
 *
 * Tolerant, like `parseSeed*`. If the value is absent, malformed or empty, the result is every stage:
 * a worker from before FRU-32 sends no field, and its panel must not change. The result keeps the
 * order of `SEED_STAGES`.
 */
export function offeredStages(value: unknown): SeedStage[] {
  if (!Array.isArray(value)) return [...SEED_STAGES];

  const offered = SEED_STAGES.filter((stage) => value.includes(stage));

  return offered.length > 0 ? offered : [...SEED_STAGES];
}

/**
 * A colour of a status: `#` and six hexadecimal digits, nothing else (FRU-364).
 *
 * The value is written into a style. `var(…)`, `url(…)` or a named colour would be read there too, so
 * the worker refuses them on save and every reader drops them.
 */
export const STATUS_COLOR = /^#[0-9a-fA-F]{6}$/;

/** At most this many statuses in one read. A reader keeps the first ones and drops the rest. */
export const MAX_STATUSES = 200;

/** The key of a status: unique in one read, never shown. */
const statusKeySchema = z.string().min(1).max(200);

/**
 * A status of a site, as the read envelope lists it (FRU-352, FRU-364).
 *
 * Data that a team configured, never a constant of this package: the contract holds the shape and no
 * value. A status always belongs to one of the five stages. The stage keeps the lifecycle — the
 * filters, the counts, the fallback — and an old widget reads nothing else.
 */
export const seedStatusSchema = z.object({
  key: statusKeySchema,
  /** What the team or the tracker calls it. Empty means the word of the widget for the stage. */
  name: z.string().max(200),
  stage: z.enum(SEED_STAGES),
  /** Absent means the colour of the stage, which a host can still set. */
  color: z.string().regex(STATUS_COLOR).optional(),
  /** Absent means the foreground of the stage, or one computed from `color`. Only with `color`. */
  textColor: z.string().regex(STATUS_COLOR).optional(),
});

export type SeedStatus = z.infer<typeof seedStatusSchema>;

const statusCoreSchema = seedStatusSchema.pick({ key: true, name: true, stage: true });

function isStatusColor(value: unknown): value is string {
  return typeof value === 'string' && STATUS_COLOR.test(value);
}

/**
 * The statuses of a read, from its `statuses` field (FRU-364). Tolerant, like `offeredStages`.
 *
 * - Absent or not a list: no status. A worker from before sends nothing, and every pin keeps the
 *   colour of its stage.
 * - An entry with no key, a stage outside the five, or a key already seen: dropped. The first wins.
 * - A colour that is not `#rrggbb`: dropped from its entry, which keeps the colour of its stage.
 * - A text colour with no background colour: dropped. Its contrast was measured against a background
 *   that this entry no longer has.
 *
 * Never throws: the list comes from another process, and a bad entry must not hide a pin.
 */
export function offeredStatuses(value: unknown): SeedStatus[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const kept: SeedStatus[] = [];
  for (const entry of value.slice(0, MAX_STATUSES)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { color, textColor } = entry as Record<string, unknown>;
    const core = statusCoreSchema.safeParse(entry);
    if (!core.success || seen.has(core.data.key)) continue;
    seen.add(core.data.key);
    const colored = isStatusColor(color);
    kept.push({
      ...core.data,
      ...(colored ? { color } : {}),
      ...(colored && isStatusColor(textColor) ? { textColor } : {}),
    });
  }

  return kept;
}

/**
 * The status of an issue in a list from `offeredStatuses`, or `undefined` to draw its stage.
 *
 * `undefined` too when the status belongs to another stage than the issue. `stage` is what an old
 * widget draws, so a new widget follows it: two readers of the same answer never disagree on a stage.
 */
export function statusOf(
  issue: Pick<SeedIssue, 'stage' | 'status'>,
  statuses: readonly SeedStatus[],
): SeedStatus | undefined {
  if (issue.status === undefined) return undefined;
  const status = statuses.find((candidate) => candidate.key === issue.status);

  return status?.stage === issue.stage ? status : undefined;
}

/**
 * A reply from the team, as the widget shows it (FRU-13).
 *
 * Part of the read envelope, not of the seed. Comments live in whichever store answers — Linear, and
 * `seeds-postgres.ts` in its own table — and are fetched from it. Nothing here changes the round trip, so
 * `SEED_VERSION` does not move.
 */
export const seedCommentSchema = z.object({
  id: z.string().min(1),
  body: z.string(),
  createdAt: z.string(),
  /** Absent when the store returns a comment with no user — an integration, or a deleted account. */
  author: z.string().optional(),
});

export type SeedComment = z.infer<typeof seedCommentSchema>;

/**
 * What the worker sends back to the widget for one planted seed (M4 / FRU-10). Kept here because
 * both ends validate against it.
 */
export const seedIssueSchema = z.object({
  id: z.string().min(1),
  /** Human handle, e.g. `FRU-2` from Linear, `FB-12` from a store that numbers its own. */
  identifier: z.string().min(1),
  /**
   * Where a human can open this note in the store's own interface, when the store has one (FRU-31).
   *
   * Optional because SQLite has no web interface. Keeping it required meant inventing a URL that
   * goes nowhere, and a link back to the current page reads as a lost note. The widget renders the
   * link only when this is present. Read-envelope field, so `SEED_VERSION` does not move.
   */
  url: z.string().min(1).optional(),
  title: z.string(),
  stage: z.enum(SEED_STAGES),
  stateName: z.string(),
  /**
   * The key of its status in the `statuses` of the same read (FRU-364). Absent: the note is drawn by
   * its stage, as before. `stage` and `stateName` stay filled, for a widget that reads only them.
   * Read-envelope field, so `SEED_VERSION` does not move.
   */
  status: statusKeySchema.optional(),
  updatedAt: z.string(),
  /**
   * Oldest first, so the thread reads as a conversation. Absent means the worker did not ask for
   * them; empty means it did and there were none — the widget says something different for each.
   */
  comments: z.array(seedCommentSchema).optional(),
  /**
   * Who said that a note marked done looks fixed, and when (FRU-294). Read from its replies, in the
   * store: present only on a `ripe` note whose newest verdict is « fixed ». Read-envelope field.
   */
  checked: z.object({ by: z.string(), at: z.string() }).optional(),
  /**
   * `true` on a note that the reader left, with the session of their account (FRU-294). Absent for
   * every other note and every other reader: the worker says it only to the person it names.
   */
  mine: z.literal(true).optional(),
  /**
   * The files of the note, as its tracker keeps them (FRU-331): a name, and the address of the
   * tracker. Absent when the store says nothing of them. Read-envelope field.
   */
  attachments: z.array(seedAttachmentSchema).optional(),
  seed: seedSchema,
});

export type SeedIssue = z.infer<typeof seedIssueSchema>;
