/**
 * The corner of the window the dock stands in (FRU-443). `bottom-right` is where it always stood.
 *
 * Left out, the dock follows the reading direction: at the end of the line, so at the bottom left of
 * a page written right to left (FRU-38). A position that is given is the corner of the window itself,
 * whatever the direction: the person who chose « top left » sees it at the top left.
 */
export const DOCK_POSITIONS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'] as const;

export type DockPosition = (typeof DOCK_POSITIONS)[number];

export const DEFAULT_DOCK_POSITION: DockPosition = 'bottom-right';

/** A corner, or `undefined` for anything else: an option that is not one changes nothing. */
export function parseDockPosition(value: unknown): DockPosition | undefined {
  return typeof value === 'string' && (DOCK_POSITIONS as readonly string[]).includes(value)
    ? (value as DockPosition)
    : undefined;
}
