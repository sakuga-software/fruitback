/**
 * The widget's glyphs, as inline SVG (SKG-529).
 *
 * They used to be emoji — a sprout on the launch button, a gear, a fallen leaf on the detached-notes
 * chip, a strawberry on the confirmation. An emoji is drawn by the system's own font, so the same
 * character is flat on Windows, glossy on macOS and something else again on Android. It takes no
 * colour, sits on no typographic grid, and carries a casual register that cannot be dialled down.
 * A review tool laid over a client's site is seen by that client.
 *
 * **The fruit did not leave, it moved.** `drop` is the pin's own shape — three round corners and one
 * sharp — so the launch button plants the thing the page then shows, and `dropDashed` is that same
 * shape drawn the way a detached pin is drawn. The identity is carried by geometry, which we control,
 * rather than by a codepoint, which we do not.
 *
 * **Sized in `em` and painted in `currentColor`**, so an icon is whatever size and colour the text
 * beside it is, and `aria-hidden` because every one of them sits next to a label or inside a button
 * that already has an accessible name.
 *
 * **Built with `createElementNS`, never `innerHTML`.** An SVG element parsed into the HTML namespace
 * renders nothing at all, and nothing reports it.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

export type IconName = 'gear' | 'close' | 'drop' | 'dropDashed';

/** The pin's silhouette, rotated so the sharp corner points down. */
const DROP = 'M8.00 14.51 L4.75 11.25 A4.6 4.6 0 0 1 4.75 4.75 A4.6 4.6 0 0 1 11.25 4.75 A4.6 4.6 0 0 1 11.25 11.25 Z';

/**
 * One 16×16 viewBox for all of them, so they align on the same optical centre when they sit side by
 * side. `filled` picks between the two paint rules `host.ts` declares.
 */
const ICONS: Record<IconName, { paths: string[]; filled?: boolean; className?: string }> = {
  // Six teeth, generated rather than drawn, and filled rather than stroked: a stroked gear at 14px
  // reads as a flower. The hole is a second subpath in the same `d`, cut out by `fill-rule: evenodd`
  // — two paths would have filled it back in.
  gear: {
    paths: [
      'M6.40 1.08 L9.60 1.08 L9.51 3.34 L11.28 4.36 L13.19 3.16 L14.79 5.92 L12.79 6.98 L12.79 9.02 ' +
        'L14.79 10.08 L13.19 12.84 L11.28 11.64 L9.51 12.66 L9.60 14.92 L6.40 14.92 L6.49 12.66 ' +
        'L4.72 11.64 L2.81 12.84 L1.21 10.08 L3.21 9.02 L3.21 6.98 L1.21 5.92 L2.81 3.16 L4.72 4.36 ' +
        'L6.49 3.34 Z M8 5.75 A2.25 2.25 0 1 0 8 10.25 A2.25 2.25 0 1 0 8 5.75 Z',
    ],
    filled: true,
  },
  close: { paths: ['M4.2 4.2 L11.8 11.8', 'M11.8 4.2 L4.2 11.8'] },
  drop: { paths: [DROP], filled: true },
  // Dashed, because that is how the overlay draws a pin it could not re-anchor. The chip and the pin
  // say the same thing in the same language.
  dropDashed: { paths: [DROP], className: 'fruitback-icon-dashed' },
};

export function createIcon(document: Document, name: IconName): SVGSVGElement {
  const spec = ICONS[name];
  const svg = document.createElementNS(SVG_NS, 'svg');

  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute(
    'class',
    ['fruitback-icon', spec.filled === true ? 'fruitback-icon-filled' : '', spec.className ?? '']
      .filter((value) => value.length > 0)
      .join(' '),
  );
  // Decorative in every case: each one sits beside a label, or inside a button that names itself.
  svg.setAttribute('aria-hidden', 'true');
  // Not just aria-hidden: an SVG is focusable in some engines, which would put a tab stop on nothing.
  svg.setAttribute('focusable', 'false');

  for (const d of spec.paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }

  return svg;
}
