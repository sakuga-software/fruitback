import type { GuideCaptured } from './guide-steps.ts';

/**
 * The version of the extension that took the captures of the guide (FRU-486). Written by
 * `e2e/first-note.spec.ts` when a capture changed, never by hand: see `guide-steps.ts`.
 */
export const GUIDE_CAPTURED: GuideCaptured = { extension: '0.4.0' };
