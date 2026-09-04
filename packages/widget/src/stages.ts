import { type SeedStage } from '@fruitback/shared';

/**
 * The widget's words for the contract's vocabulary (SKG-517).
 *
 * These used to be `SEED_STAGE_STYLES[stage].label`, in `packages/shared` — which is to say in the
 * **published contract**, as English strings. Two things were wrong with that. A consumer of the
 * package could not translate them, because a string baked into a type is not a string anyone
 * downstream can reach. And the contract had no business holding words at all: `SEED_STAGES` is the
 * vocabulary, and turning a stage into something a human reads is a decision for whoever renders it
 * — the same split SKG-516 made between the stage names and each store's own states.
 *
 * **Not in `theme.ts`**, which owns how the widget looks. A label is copy, not a colour, and the two
 * change for different reasons.
 *
 * A flat record and not a function, because SKG-530 is what makes this locale-aware and it should
 * find one place to change rather than a call site per module.
 */
export const STAGE_LABELS: Record<SeedStage, string> = {
  seeded: 'Seeded',
  green: 'Green',
  ripening: 'Ripening',
  ripe: 'Ripe',
  composted: 'Composted',
};
