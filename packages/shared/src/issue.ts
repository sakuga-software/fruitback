import { type Seed, seedSchema } from './seed.ts';
import { z } from 'zod';

/**
 * An issue as the two ends exchange it: its labels, its stage, and the envelope of a read.
 *
 * Nothing here names a provider. This file was `linear.ts` until SKG-523; see
 * docs/decisions/worker.md for what left it and when.
 */

/** Every issue Fruitback creates carries this label. It is the read filter. */
export const FRUITBACK_LABEL = 'fruitback';

/** Per-client label, so one workspace can serve every client site. */
export function clientLabelName(clientId: string): string {
  return `${FRUITBACK_LABEL}:${clientId}`;
}

/** Labels to apply when creating the issue (M3 / SKG-497). */
export function buildIssueLabels(seed: Seed): string[] {
  return seed.client ? [FRUITBACK_LABEL, clientLabelName(seed.client.id)] : [FRUITBACK_LABEL];
}

/**
 * How ripe a pin looks. The widget stores no status of its own; it renders what the store reports.
 *
 * The vocabulary belongs here, the projection onto it does not. Linear has workflow state types,
 * GitHub has open/closed, a SQL store has its own column, so each connector owns its own mapping.
 * A provider's states named here make every consumer of this package depend on that provider
 * (SKG-516).
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
 * A reply from the team, as the widget shows it (SKG-502).
 *
 * Part of the read envelope, not of the seed. Comments live in whichever store answers — Linear, and
 * `sqlite.ts` in its own table — and are fetched from it. Nothing here changes the round trip, so
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
 * What the worker sends back to the widget for one planted seed (M4 / SKG-499). Kept here because
 * both ends validate against it.
 */
export const seedIssueSchema = z.object({
  id: z.string().min(1),
  /** Human handle, e.g. `SKG-491` from Linear, `FB-12` from a store that numbers its own. */
  identifier: z.string().min(1),
  /**
   * Where a human can open this note in the store's own interface, when the store has one (SKG-524).
   *
   * Optional because SQLite has no web interface. Keeping it required meant inventing a URL that
   * goes nowhere, and a link back to the current page reads as a lost note. The widget renders the
   * link only when this is present. Read-envelope field, so `SEED_VERSION` does not move.
   */
  url: z.string().min(1).optional(),
  title: z.string(),
  stage: z.enum(SEED_STAGES),
  stateName: z.string(),
  updatedAt: z.string(),
  /**
   * Oldest first, so the thread reads as a conversation. Absent means the worker did not ask for
   * them; empty means it did and there were none — the widget says something different for each.
   */
  comments: z.array(seedCommentSchema).optional(),
  seed: seedSchema,
});

export type SeedIssue = z.infer<typeof seedIssueSchema>;
