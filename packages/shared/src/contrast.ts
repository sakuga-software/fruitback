import { STATUS_COLOR } from './issue.ts';

/**
 * The contrast of a text on a status, as WCAG 2.2 measures it (FRU-365).
 *
 * The worker refuses a text colour under `MIN_TEXT_CONTRAST` on save, the console shows the ratio, and
 * the widget computes the text of a status that has none. All three must compute the same number, so
 * the function is here. It holds the algorithm and no palette: the ink of the theme is an argument.
 * See docs/decisions/statuses.md, « The colours ».
 */

/** The text of a pin is small: SC 1.4.3 asks 4.5:1, not the 3:1 of large text. */
export const MIN_TEXT_CONTRAST = 4.5;

const WHITE = '#ffffff';
const BLACK = '#000000';

/** The relative luminance of a `#rrggbb` colour, with the threshold of WCAG 2.2 (0.04045). */
function luminance(color: string): number {
  const [red, green, blue] = [1, 3, 5].map((start) => {
    const channel = Number.parseInt(color.slice(start, start + 2), 16) / 255;

    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/**
 * The contrast ratio of two `#rrggbb` colours, from 1 to 21. `undefined` when either is not one: a
 * caller that refuses on this number must not read a missing colour as a low ratio, or as a high one.
 */
export function contrastRatio(first: string, second: string): number | undefined {
  if (!STATUS_COLOR.test(first) || !STATUS_COLOR.test(second)) return undefined;
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a) as [number, number];

  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * The text colour to write on `background`: `ink` or white, whichever contrasts more, when it reaches
 * `MIN_TEXT_CONTRAST`; otherwise black.
 *
 * Measured on every 7th of the 16.7 million colours with the ink of the widget (#18181b): ink and white
 * alone fall to 4.21:1 (#547bc2). The better of black and white never falls under 4.58:1 (#38860a),
 * so where white is under 4.5:1, black is over 4.58:1: the answer always reaches 4.5:1. On the five
 * colours of FRU-334 it is what the widget writes today: ink on the three light ones, white on the
 * two dark ones. `undefined` for a background or an ink that is not `#rrggbb`.
 */
export function readableTextColor(background: string, ink: string): string | undefined {
  const onInk = contrastRatio(background, ink);
  // Measured whenever the background is a colour, which `onInk` has just said.
  const onWhite = contrastRatio(background, WHITE) as number;
  if (onInk === undefined) return undefined;
  if (Math.max(onInk, onWhite) >= MIN_TEXT_CONTRAST) return onInk > onWhite ? ink : WHITE;

  return BLACK;
}
