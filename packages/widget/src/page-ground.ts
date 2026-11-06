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

/** `#rrggbb` of a computed `rgb()` or `rgba()` that is fully opaque, else `undefined`. */
export function opaqueHex(computed: string): string | undefined {
  const match = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(computed.trim());
  if (match === null) return undefined;
  const alpha = match[4];
  if (alpha !== undefined && (alpha.endsWith('%') ? Number.parseFloat(alpha) < 100 : Number(alpha) < 1)) {
    return undefined;
  }

  return `#${[match[1], match[2], match[3]]
    .map((channel) => Math.min(255, Number(channel)).toString(16).padStart(2, '0'))
    .join('')}`;
}

/** What the ground of a page of this colour asks of the widget. */
export function groundOf(hex: string): PageGround {
  return { dark: luminance(hex) < DARK_LUMINANCE, faint: contrastRatio(hex, FRUITBACK_RED) < 3 };
}

/** The ground of this document, as its body or its root paints it. */
export function readGround(document: Document): PageGround {
  const view = document.defaultView;
  const painted = [document.body, document.documentElement]
    .map((element) =>
      element === null || view === null ? undefined : opaqueHex(view.getComputedStyle(element).backgroundColor),
    )
    .find((hex) => hex !== undefined);

  return groundOf(painted ?? '#ffffff');
}

/** Writes the ground on the host element of the widget, where its stylesheets read it. */
export function markGround(element: HTMLElement, ground: PageGround): void {
  if (ground.dark) element.dataset.fruitbackGround = 'dark';
  else delete element.dataset.fruitbackGround;
  if (ground.faint) element.dataset.fruitbackFaint = '';
  else delete element.dataset.fruitbackFaint;
}
