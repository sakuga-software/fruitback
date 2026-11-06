/**
 * The colour of the action « Send » (FRU-601): a host gives it with `actionColor` at `init`, or later
 * with `setActionColor`. The extension gives the colour that its person chose in « Appearance ».
 *
 * Only « Send » takes it. The pins, the stages and the other uses of the accent do not change: a
 * colour chosen by one person must not change what the pins of a team say.
 *
 * The label of « Send » is white on this colour. A colour under 4.5:1 with white is refused, and the
 * button keeps the accent of the widget: an unreadable « Send » is worse than the default red.
 */

/** The ratio of WCAG 2.2 (1.4.3) for the label of the button. */
export const ACTION_COLOR_MINIMUM_CONTRAST = 4.5;

/** The red of Fruitback, the accent of the widget. With this colour, the drop of « Send » is drawn white. */
export const FRUITBACK_RED = '#dd2c27';

/**
 * A colour as `#rrggbb` in lower case, from `#rrggbb` or `#rgb`. Anything else is `undefined`: an
 * option that is not a colour changes nothing.
 */
export function parseHexColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  if (/^#[0-9a-f]{3}$/.test(text)) return `#${[...text.slice(1)].map((digit) => digit + digit).join('')}`;

  return undefined;
}

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)) as [number, number, number];
}

/** The relative luminance of a `#rrggbb` colour (WCAG 2.2). */
export function luminance(hex: string): number {
  const [red, green, blue] = channels(hex).map((value) => {
    const unit = value / 255;

    return unit <= 0.040_45 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** The contrast ratio of two `#rrggbb` colours (WCAG 2.2), from 1 to 21. */
export function contrastRatio(first: string, second: string): number {
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a) as [number, number];

  return (light + 0.05) / (dark + 0.05);
}

/** A colour that « Send » can take: valid, and at 4.5:1 or more with white text. Otherwise `undefined`. */
export function parseActionColor(value: unknown): string | undefined {
  const color = parseHexColor(value);

  return color !== undefined && contrastRatio(color, '#ffffff') >= ACTION_COLOR_MINIMUM_CONTRAST ? color : undefined;
}

/** The colour under the pointer: 15 % darker, so its contrast with white only grows. */
export function strongerColor(hex: string): string {
  return `#${channels(hex)
    .map((value) =>
      Math.round(value * 0.85)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/**
 * The colour of the drop of « Send »: white, as the label, or the red of Fruitback when the red stands
 * out on the colour at 3:1 (WCAG 1.4.11), as on a near black.
 */
export function actionMarkColor(hex: string): string {
  return contrastRatio(hex, FRUITBACK_RED) >= 3 ? FRUITBACK_RED : '#ffffff';
}

/** The custom properties « Send » reads, written on the host element of the widget. */
const PROPERTIES = [
  '--fruitback-color-action',
  '--fruitback-color-action-strong',
  '--fruitback-color-on-action',
  '--fruitback-color-action-mark',
] as const;

/**
 * Writes the colour of « Send » on the host element, or removes it. A colour that is refused removes
 * it too: « Send » takes the accent again.
 */
export function paintActionColor(element: HTMLElement, value: unknown): void {
  const color = parseActionColor(value);
  if (color === undefined) {
    for (const property of PROPERTIES) element.style.removeProperty(property);

    return;
  }
  element.style.setProperty('--fruitback-color-action', color);
  element.style.setProperty('--fruitback-color-action-strong', strongerColor(color));
  element.style.setProperty('--fruitback-color-on-action', '#ffffff');
  element.style.setProperty('--fruitback-color-action-mark', actionMarkColor(color));
}
