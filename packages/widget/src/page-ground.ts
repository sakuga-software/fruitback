import { FRUITBACK_RED, contrastRatio, luminance } from './action-color.ts';

/**
 * The ground of the page the widget lies on (FRU-611, P7): dark, and the red of Fruitback hard to
 * see on it. Read off the computed background of `<body>`, then of `<html>`, the first one that is
 * not transparent; white when both are, as a browser paints them.
 *
 * - **dark**: the ground is darker than a mid grey (relative luminance under 0.2). The widget stays as
 *   its scheme draws it, with a white line at 16 % and a denser shadow around its surfaces, and the
 *   frame of an element takes a light halo.
 * - **faint**: the red of Fruitback is under 3:1 on the ground (WCAG 1.4.11), a red site. The frame
 *   of an element, its name, the tether of the composer and the edge of a pin take the ink of the theme
 *   with a white contour.
 *
 * Read again at each start of a capture: a site may change its ground (a dark mode switched on).
 */
export type PageGround = { dark: boolean; faint: boolean };

/**
 * The ink a frame and a pin take on a red ground: the ink of the theme, `--fruitback-color-ink`. The
 * board writes `#1c1917`, a stone grey that FRU-334 took out of the widget (`design-tokens.test.ts`
 * of the extension refuses it); the zinc ink is the same near black, 1.01:1 from it.
 */
export const GROUND_INK = '#18181b';

/** Under this relative luminance, a ground is dark: #767676 and darker. */
const DARK_LUMINANCE = 0.2;

/** A colour as its red, green, blue (0 to 255) and its alpha (0 to 1). */
export type Rgba = [number, number, number, number];

/** A computed `rgb()` or `rgba()`, the notation every browser computes an sRGB colour to. */
export function parseRgb(computed: string): Rgba | undefined {
  const match = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(computed.trim());
  if (match === null) return undefined;
  const alpha = match[4] ?? '1';
  const a = alpha.endsWith('%') ? Number.parseFloat(alpha) / 100 : Number(alpha);

  return [Number(match[1]), Number(match[2]), Number(match[3]), Math.min(1, Math.max(0, a))];
}

/**
 * Any colour a browser computes, `oklch()` and `color(srgb …)` too (Tailwind 4 writes oklch): read as
 * `rgb()` first, else drawn on a canvas of one pixel and read back. `undefined` with no canvas.
 */
function readColor(computed: string, document: Document): Rgba | undefined {
  const rgb = parseRgb(computed);
  if (rgb !== undefined) return rgb;
  const context = document.createElement('canvas').getContext?.('2d', { willReadFrequently: true });
  if (context === null || context === undefined) return undefined;
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = computed;
  context.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;

  return [r, g, b, a / 255];
}

/** The layers, the top one first, laid on white as a browser paints them: `#rrggbb`. */
export function composeOnWhite(layers: readonly Rgba[]): string {
  let under: [number, number, number] = [255, 255, 255];
  for (const [r, g, b, a] of [...layers].reverse()) {
    under = [r * a + under[0] * (1 - a), g * a + under[1] * (1 - a), b * a + under[2] * (1 - a)];
  }

  return `#${under
    .map((channel) =>
      Math.round(Math.min(255, channel) + 1e-9)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** What the ground of a page of this colour asks of the widget. */
export function groundOf(hex: string): PageGround {
  return { dark: luminance(hex) < DARK_LUMINANCE, faint: contrastRatio(hex, FRUITBACK_RED) < 3 };
}

/**
 * The ground of this document: the background of `<body>` laid on the one of `<html>`, laid on white
 * (review of #859: a ground with alpha, or in a notation a regular expression does not read, was
 * taken for white).
 */
export function readGround(document: Document): PageGround {
  const view = document.defaultView;
  const layers = [document.body, document.documentElement]
    .map((element) =>
      element === null || view === null
        ? undefined
        : readColor(view.getComputedStyle(element).backgroundColor, document),
    )
    .filter((layer): layer is Rgba => layer !== undefined);

  return groundOf(composeOnWhite(layers));
}

/** Writes the ground on the host element of the widget, where its stylesheets read it. */
export function markGround(element: HTMLElement, ground: PageGround): void {
  if (ground.dark) element.dataset.fruitbackGround = 'dark';
  else delete element.dataset.fruitbackGround;
  if (ground.faint) element.dataset.fruitbackFaint = '';
  else delete element.dataset.fruitbackFaint;
}
