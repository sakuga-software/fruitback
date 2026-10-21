/** The width a wide preview lays the site out at, then scales down: the site looks as on a laptop (FRU-354). */
export const DESK = 1280;
/** Under this width, the site lays out at the width of the frame, as on a phone. */
export const NARROW = 600;

/**
 * The scale of the site in a frame `width` px wide: 1 under `NARROW` (the site lays out at the
 * frame's width), `width / DESK` above it, and never more than 1: a frame wider than `DESK` lays the
 * site out at the frame's width, as a phone does, and never enlarges it.
 */
export function scaleOf(width: number): number {
  if (width < NARROW || width <= 0) return 1;

  return Math.min(1, width / DESK);
}
