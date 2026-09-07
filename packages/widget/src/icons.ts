import { ICON_DATA, type IconShape } from './icon-data.ts';

/**
 * The widget's glyphs, as inline SVG (SKG-529).
 *
 * They used to be emoji — a sprout on the launch button, a gear, a fallen leaf on the detached-notes
 * chip, a strawberry on the confirmation. An emoji is drawn by the system's own font, so the same
 * character is flat on Windows, glossy on macOS and something else again on Android. It takes no
 * colour, sits on no typographic grid, and carries a casual register that cannot be dialled down.
 * A review tool laid over a client's site is seen by that client.
 *
 * **Two of them come from Phosphor and two are ours, and the split is the point.** `gear` and `close`
 * are generic affordances that a maintained icon set draws better than we do — the first hand-drawn
 * gear here took two attempts and still read as a blob at 14px. `drop` and `dropDashed` are not
 * affordances: `drop` is the pin's own silhouette, three round corners and one sharp, so the launch
 * button plants the thing the page then shows, and `dropDashed` is that shape drawn the way the
 * overlay draws a pin it could not re-anchor. No set has those, and no set should — they are the
 * product, not its furniture.
 *
 * **Iconify is a source here, never a runtime.** `iconify-icon` and `@iconify/iconify` fetch their
 * paths from Iconify's API on first render, which is a network call to a third party made from a
 * client's site. `build-icons.ts` reads the `@iconify-json/ph` devDependency at authoring time and
 * writes `icon-data.ts`; nothing about Iconify reaches `dist` but the geometry, and that geometry
 * costs about 900 bytes.
 *
 * **Paint travels as path attributes rather than as CSS**, which is how Phosphor ships its own and
 * therefore how ours ship too. A `.fruitback-icon { fill: … }` rule would be a class selector beating
 * their `fill="currentColor"` presentation attribute, and every imported icon would render as a
 * silhouette of the wrong colour. The stylesheet sizes them and nothing else.
 *
 * **Built with `createElementNS`, never `innerHTML`.** An SVG element parsed into the HTML namespace
 * renders nothing at all, and nothing reports it.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

export type IconName = 'gear' | 'close' | 'drop' | 'dropDashed';

/** The pin's silhouette, rotated so the sharp corner points down. */
const DROP = 'M8.00 14.51 L4.75 11.25 A4.6 4.6 0 0 1 4.75 4.75 A4.6 4.6 0 0 1 11.25 4.75 A4.6 4.6 0 0 1 11.25 11.25 Z';

const ICONS: Record<IconName, IconShape> = {
  gear: ICON_DATA.gear,
  close: ICON_DATA.close,
  drop: { viewBox: '0 0 16 16', paths: [{ fill: 'currentColor', d: DROP }] },
  // Dashed, because that is how the overlay draws a pin it could not re-anchor. The chip and the pin
  // then say the same thing in the same language, which an emoji could not do.
  dropDashed: {
    viewBox: '0 0 16 16',
    paths: [
      {
        d: DROP,
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '1.4',
        'stroke-linecap': 'round',
        'stroke-dasharray': '2.6 2.2',
      },
    ],
  },
};

export function createIcon(document: Document, name: IconName): SVGSVGElement {
  const spec = ICONS[name];
  const svg = document.createElementNS(SVG_NS, 'svg');

  svg.setAttribute('viewBox', spec.viewBox);
  svg.setAttribute('class', 'fruitback-icon');
  // Decorative in every case: each one sits beside a label, or inside a button that names itself.
  svg.setAttribute('aria-hidden', 'true');
  // Not just aria-hidden: an SVG is focusable in some engines, which would put a tab stop on nothing.
  svg.setAttribute('focusable', 'false');

  for (const attributes of spec.paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    for (const [key, value] of Object.entries(attributes)) path.setAttribute(key, value);
    svg.append(path);
  }

  return svg;
}
