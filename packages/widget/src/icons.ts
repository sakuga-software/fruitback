import { ICON_DATA, type IconShape } from './icon-data.ts';

/**
 * The widget's glyphs, as inline SVG (FRU-36).
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

export type IconName =
  | 'gear'
  | 'close'
  | 'search'
  | 'grip'
  | 'drop'
  | 'dropDashed'
  | 'list'
  | 'mark'
  | 'markDashed'
  | 'chevron';

/**
 * The drop of the mark, as the mock-up of 2026-10-13 draws it on the launch button (FRU-252): a
 * circle and a point, taller than wide, on its own grid. Not the pin: a pin is a rotated corner.
 */
const MARK = 'M 64 121.9 L 30.1 87.9 A 48 48 0 1 1 97.9 87.9 Z';

/** The pin's silhouette, rotated so the sharp corner points down. */
const DROP = 'M8.00 14.51 L4.75 11.25 A4.6 4.6 0 0 1 4.75 4.75 A4.6 4.6 0 0 1 11.25 4.75 A4.6 4.6 0 0 1 11.25 11.25 Z';

const ICONS: Record<IconName, IconShape> = {
  gear: ICON_DATA.gear,
  close: ICON_DATA.close,
  // The search of the list (FRU-308): an action, so from the set, like the gear and the cross.
  search: ICON_DATA.search,
  // The handle that moves the bubble of a note (FRU-420): an action, so from the set.
  grip: ICON_DATA.grip,
  drop: { viewBox: '0 0 16 16', paths: [{ fill: 'currentColor', d: DROP }] },
  mark: { viewBox: '16 6 96 116', paths: [{ fill: 'currentColor', d: MARK }] },
  // The mark in a dashed outline, for the notes that could not be placed (FRU-259): the stroke and
  // the dashes of the mock-up, on the grid of the mark.
  markDashed: {
    viewBox: '16 6 96 116',
    paths: [{ d: MARK, fill: 'none', stroke: 'currentColor', 'stroke-width': '11', 'stroke-dasharray': '18 12' }],
  },
  // Dashed, because that is how the overlay draws a pin it could not re-anchor. The chip and the pin
  // then say the same thing in the same language, which an emoji could not do.
  // A panel beside the page, as the mock-up of 2026-10-20 draws the button of the list (FRU-303):
  // a rounded frame and its divider. Drawn here: no path of somebody else, so no notice to carry.
  list: {
    viewBox: '0 0 16 16',
    paths: [
      {
        d: 'M3.75 2.75 H12.25 A1.75 1.75 0 0 1 14 4.5 V11.5 A1.75 1.75 0 0 1 12.25 13.25 H3.75 A1.75 1.75 0 0 1 2 11.5 V4.5 A1.75 1.75 0 0 1 3.75 2.75 Z M6.25 2.75 V13.25',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '1.5',
        'stroke-linecap': 'round',
      },
    ],
  },
  // The fold of « Attach », that opens a menu (FRU-351). Drawn here: no path of somebody else.
  chevron: {
    viewBox: '0 0 16 16',
    paths: [
      {
        d: 'M4 6 L8 10 L12 6',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '1.5',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      },
    ],
  },
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
