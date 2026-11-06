/**
 * The colour of the note button (FRU-601): « Leave a note » in the popup and in the side panel, and
 * « Send » of a widget the extension mounts. The person chooses it in « Appearance » of the page of
 * the extension. It is kept in the local area of this browser (`actionColor`) and it changes nothing
 * for the team or on the site.
 *
 * The rules of the colour are those of `packages/widget/src/action-color.ts`, written again here so
 * that the bridge and the pages do not import the widget. `action-color.test.ts` holds the two
 * equal. No words here: the bridge and the page script carry this module, and the words of
 * « Appearance » are `appearance-page.ts`'s.
 */

/** The storage key, in the local area. Absent: the red of Fruitback. */
export const ACTION_COLOR_KEY = 'actionColor';

/** The ratio of WCAG 2.2 (1.4.3): the label of the button is white. */
export const MINIMUM_CONTRAST = 4.5;

export const FRUITBACK_RED = '#dd2c27';

/** The four colours of « Appearance ». The first is the default, and is stored as no key. */
export const PRESETS = [
  { id: 'fruitback', label: 'Fruitback', color: FRUITBACK_RED },
  { id: 'deep-red', label: 'Deep red', color: '#b91c1c' },
  { id: 'orange', label: 'Orange', color: '#c2410c' },
  { id: 'ink', label: 'Ink', color: '#1c1917' },
] as const;

/** A colour as `#rrggbb` in lower case, from `#rrggbb` or `#rgb`. Anything else: `undefined`. */
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

function luminance(hex: string): number {
  const [red, green, blue] = channels(hex).map((value) => {
    const unit = value / 255;

    return unit <= 0.040_45 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** The contrast ratio of two `#rrggbb` colours (WCAG 2.2). */
export function contrastRatio(first: string, second: string): number {
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a) as [number, number];

  return (light + 0.05) / (dark + 0.05);
}

/** The contrast of a colour with white text. */
export function contrastWithWhite(hex: string): number {
  return contrastRatio(hex, '#ffffff');
}

/** A colour the note button can take: valid, and 4.5:1 or more with white. Otherwise `undefined`. */
export function parseActionColor(value: unknown): string | undefined {
  const color = parseHexColor(value);

  return color !== undefined && contrastWithWhite(color) >= MINIMUM_CONTRAST ? color : undefined;
}

/** The colour under the pointer: 15 % darker. */
export function strongerColor(hex: string): string {
  return `#${channels(hex)
    .map((value) =>
      Math.round(value * 0.85)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** The drop of the button: white as the label, or red where the red stands out at 3:1 (Ink). */
export function actionMarkColor(hex: string): string {
  return contrastRatio(hex, FRUITBACK_RED) >= 3 ? FRUITBACK_RED : '#ffffff';
}

/** The custom properties the note button reads, in the popup, the side panel and the page. */
export function actionProperties(value: unknown): Record<string, string> | undefined {
  const color = parseActionColor(value);
  if (color === undefined) return undefined;

  return {
    '--action': color,
    '--action-strong': strongerColor(color),
    '--on-action': '#fff',
    '--action-mark': actionMarkColor(color),
  };
}

/** Writes the colour on an element, or takes it away for no colour, or one refused. */
export function paintAction(element: HTMLElement, value: unknown): void {
  const properties = actionProperties(value);
  for (const name of ['--action', '--action-strong', '--on-action', '--action-mark']) {
    const set = properties?.[name];
    if (set === undefined) element.style.removeProperty(name);
    else element.style.setProperty(name, set);
  }
}
