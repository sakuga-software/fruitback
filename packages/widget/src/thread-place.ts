import type { Direction } from './messages.ts';

/**
 * Where the bubble of a note opens (FRU-421): under its element, above it, or beside it, where the
 * window has the room, so that it never covers what the note is about. An arrow on the edge that faces
 * the element points at the pin.
 *
 * An element that leaves the room on no side (a whole section) gets no side: the caller then opens the
 * bubble beside the pin, as before (FRU-304), and draws no arrow.
 */

/** A box in document coordinates. */
export type PlaceBox = { left: number; top: number; width: number; height: number };

export type ThreadSide = 'below' | 'above' | 'end' | 'start';

export type ThreadPlace = {
  left: number;
  top: number;
  side: ThreadSide;
  /** The edge of the bubble that faces the element, and so holds the arrow. Physical, like the pin. */
  edge: 'top' | 'bottom' | 'left' | 'right';
  /** Where the arrow sits on that edge, from its top or left end, in px. */
  arrow: number;
};

/** The room between the bubble and its element: the arrow sits in it. */
export const THREAD_SPACE = 14;
/** The room between the bubble and the edge of the window. */
export const WINDOW_SPACE = 8;
/** The arrow keeps out of the rounded corners of the bubble. */
const ARROW_INSET = 20;

function overlaps(a: PlaceBox, b: PlaceBox): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}

function clamp(value: number, low: number, high: number): number {
  return high < low ? low : Math.max(low, Math.min(value, high));
}

/**
 * The first side, in the order below, above, end, start, that keeps the whole bubble in the window and
 * covers no other drop; else the first one in the window; else `undefined`.
 *
 * - `element`: the frame of the pin, around its element.
 * - `drop`: the box of the drop of the pin, which stands on the top edge of the element. The side above
 *   clears it.
 * - `tip`: the point of the drop, which the arrow faces.
 */
export function besideElement(
  element: PlaceBox,
  drop: PlaceBox,
  tip: { x: number; y: number },
  size: { width: number; height: number },
  window: PlaceBox,
  others: readonly PlaceBox[],
  direction: Direction,
): ThreadPlace | undefined {
  const first = window.left + WINDOW_SPACE;
  const last = window.left + window.width - WINDOW_SPACE - size.width;
  const highest = window.top + WINDOW_SPACE;
  const lowest = window.top + window.height - WINDOW_SPACE - size.height;
  // Along the element, the bubble starts near the pin and stays in the window.
  const across = clamp(tip.x - ARROW_INSET, first, last);
  const along = clamp(tip.y - ARROW_INSET, highest, lowest);
  const top = Math.min(element.top, drop.top);

  const right = { left: element.left + element.width + THREAD_SPACE, top: along };
  const left = { left: element.left - THREAD_SPACE - size.width, top: along };
  const sides: { side: ThreadSide; left: number; top: number }[] = [
    { side: 'below', left: across, top: element.top + element.height + THREAD_SPACE },
    { side: 'above', left: across, top: top - THREAD_SPACE - size.height },
    { side: 'end', ...(direction === 'rtl' ? left : right) },
    { side: 'start', ...(direction === 'rtl' ? right : left) },
  ];

  const inWindow = (place: { left: number; top: number }) =>
    place.left >= first - 0.5 && place.left <= last + 0.5 && place.top >= highest - 0.5 && place.top <= lowest + 0.5;
  const free = (place: { left: number; top: number }) =>
    others.every((other) => !overlaps({ ...place, ...size }, other));

  const chosen = sides.find((place) => inWindow(place) && free(place)) ?? sides.find(inWindow);
  if (chosen === undefined) return undefined;

  const vertical = chosen.side === 'below' || chosen.side === 'above';
  const arrow = vertical
    ? clamp(tip.x - chosen.left, ARROW_INSET, size.width - ARROW_INSET)
    : clamp(tip.y - chosen.top, ARROW_INSET, size.height - ARROW_INSET);

  return { ...chosen, edge: edgeOf(chosen, element), arrow };
}

/** The edge of the bubble that faces its element. */
function edgeOf(place: { side: ThreadSide; left: number }, element: PlaceBox): ThreadPlace['edge'] {
  if (place.side === 'below') return 'top';
  if (place.side === 'above') return 'bottom';

  return place.left >= element.left + element.width ? 'left' : 'right';
}
