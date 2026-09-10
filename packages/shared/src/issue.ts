import { type Seed, seedSchema } from './seed.ts';
import { z } from 'zod';

/**
 * An issue as the two ends exchange it: its labels, its stage, and the envelope of a read.
 *
 * This file was `linear.ts`, and the name outlived what it described (SKG-523). SKG-516 took
 * Linear's workflow states out of it and SKG-517 took the words a human reads; the markdown codec
 * left for `markdown-description.ts`. What is here now names no provider at all — a label, a
 * ripeness, and the shape of what the worker answers — so it is named for the thing rather than for
 * the first store that stored it.
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
 * How ripe a pin looks on the page. This is the whole status story: the widget never stores a status
 * of its own, it renders the one the store reports.
 *
 * The vocabulary belongs here. The **projection** onto it does not: Linear has workflow state types,
 * GitHub has open/closed and some labels, a SQL store has whatever it chose. Each connector owns its
 * own, so naming one provider's states in the contract made every consumer of this package depend on
 * that provider (SKG-516).
 */
export const SEED_STAGES = ['seeded', 'green', 'ripening', 'ripe', 'composted'] as const;
export type SeedStage = (typeof SEED_STAGES)[number];

/**
 * What a connector reports for a state it does not recognise.
 *
 * The tolerance is the contract's, not the connector's. A provider gains a state, or a team renames
 * one, and the pin still has to be drawn — dropping it would make someone's note vanish from the page
 * because a workflow column was added.
 */
export const DEFAULT_SEED_STAGE: SeedStage = 'seeded';

/*
 * `SEED_STAGE_STYLES` used to live here, carrying an `emoji`, a `label` and a `color` per stage. All
 * three are gone (SKG-517), and each for its own reason:
 *
 * - **`color`** was already dead. SKG-528 moved every colour into the widget's `theme.ts` as a
 *   `--fruitback-stage-*` token, so a host can repaint the stages; nothing had read this field since.
 * - **`emoji`** was a rendering decision travelling in a published type. A consumer of this package
 *   could not change it, and the widget could not drop it without a major version. It is the widget's
 *   business now, and by default there is no glyph at all — the pin's shape and colour carry the
 *   stage (SKG-529).
 * - **`label`** was an English string in a contract, which is untranslatable by anyone downstream.
 *   The vocabulary is `SEED_STAGES`; the *words* belong to whoever renders them. The widget keeps its
 *   own map (`stages.ts`), ready for SKG-530 to make it locale-aware, and each store names its own
 *   states in `stateName`.
 *
 * The pattern is SKG-516's, one level further in: the contract holds the vocabulary, and every
 * projection onto something a human sees belongs to the side doing the showing.
 */

/**
 * A reply from the team, as the widget shows it (SKG-502).
 *
 * Part of the **read envelope**, not of the seed: comments live in whichever store answers and are
 * fetched from it, never carried in the seed. Linear has them, and so does `sqlite.ts`, which keeps
 * its own table. Nothing here affects the round trip, so `SEED_VERSION` does not move.
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
   * Where a human can open this note in the store's own interface — **when the store has one**
   * (SKG-524).
   *
   * Optional because SQLite has no web interface at all, and the only way to keep this required was
   * to invent a URL that goes nowhere. A pin whose link leads back to the page it is already on is
   * worse than a pin with no link: it looks like the store lost the note. The widget renders the
   * link only when this is present.
   *
   * Read-envelope field, like `comments`: nothing here is stored in a seed, so `SEED_VERSION` does
   * not move.
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
