/**
 * The handle that moves the bubble of a note (FRU-420), and the arithmetic of the move.
 *
 * The bubble keeps an offset from its place beside the pin, never a fixed position: when the page
 * scrolls or the window changes size, the overlay places the bubble beside its pin again and adds
 * the offset, so the bubble follows its pin. The overlay forgets the offset when the bubble closes.
 *
 * Only the handle moves the bubble: the text of the note and of the replies stays selectable.
 */

/** The gap the bubble keeps from each edge of the window while it moves. */
export const DRAG_MARGIN = 8;
/** One press of an arrow key. */
export const KEY_STEP = 16;
/** One press of Shift and an arrow key. */
export const KEY_STEP_LARGE = 48;

export type Offset = { x: number; y: number };
/** A box in document coordinates. */
export type Box = { left: number; top: number; width: number; height: number };

export const NO_OFFSET: Offset = { x: 0, y: 0 };

export function moved(offset: Offset): boolean {
  return offset.x !== 0 || offset.y !== 0;
}

/**
 * The offset that keeps the bubble, at `place` plus the offset, inside `view` with `DRAG_MARGIN` on
 * each side. A bubble larger than the window keeps its top and its start edge in the window.
 */
export function clampOffset(offset: Offset, place: Box, view: Box): Offset {
  const clamp = (value: number, first: number, last: number) => Math.max(first, Math.min(value, Math.max(first, last)));
  const left = clamp(
    place.left + offset.x,
    view.left + DRAG_MARGIN,
    view.left + view.width - place.width - DRAG_MARGIN,
  );
  const top = clamp(place.top + offset.y, view.top + DRAG_MARGIN, view.top + view.height - place.height - DRAG_MARGIN);

  return { x: left - place.left, y: top - place.top };
}

/** What a key does on the handle: a step, back to its place, or nothing. */
export function keyMove(key: string, shift: boolean): Offset | 'home' | undefined {
  const step = shift ? KEY_STEP_LARGE : KEY_STEP;
  switch (key) {
    case 'ArrowLeft':
      return { x: -step, y: 0 };
    case 'ArrowRight':
      return { x: step, y: 0 };
    case 'ArrowUp':
      return { x: 0, y: -step };
    case 'ArrowDown':
      return { x: 0, y: step };
    case 'Home':
      return 'home';
    default:
      return undefined;
  }
}

/**
 * The dashed line from the point of the pin to the nearest point of the bubble: where it starts, its
 * length and its angle in radians. `undefined` when the point is under the bubble: there is no line
 * to draw.
 */
export function tether(
  bubble: Box,
  tip: { x: number; y: number },
): { x: number; y: number; length: number; angle: number } | undefined {
  const x = Math.max(bubble.left, Math.min(tip.x, bubble.left + bubble.width));
  const y = Math.max(bubble.top, Math.min(tip.y, bubble.top + bubble.height));
  const dx = x - tip.x;
  const dy = y - tip.y;
  const length = Math.hypot(dx, dy);
  if (length < 1) return undefined;

  return { x: tip.x, y: tip.y, length, angle: Math.atan2(dy, dx) };
}

export type HandleMoves = {
  /** The offset when a move starts. */
  current(): Offset;
  /** Asks for this offset. The overlay keeps the bubble in the window. */
  move(offset: Offset): void;
  /** Puts the bubble back in its place beside the pin. */
  home(): void;
};

/**
 * Makes `handle` move the bubble: a pointer (mouse, pen or finger, with `setPointerCapture`), the
 * arrow keys, Home, and a double click. `touch-action: none` on the handle is the stylesheet's.
 */
export function attachHandle(handle: HTMLElement, moves: HandleMoves): void {
  let drag: { pointer: number; x: number; y: number; from: Offset } | undefined;

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !event.isPrimary) return;
    // No text selection, and no scroll of the page under a finger.
    event.preventDefault();
    handle.focus();
    drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, from: moves.current() };
    handle.setPointerCapture?.(event.pointerId);
    handle.dataset.fruitbackDragging = '';
  });
  handle.addEventListener('pointermove', (event) => {
    if (drag === undefined || event.pointerId !== drag.pointer) return;
    moves.move({ x: drag.from.x + event.clientX - drag.x, y: drag.from.y + event.clientY - drag.y });
  });
  const end = (event: PointerEvent) => {
    if (drag === undefined || event.pointerId !== drag.pointer) return;
    drag = undefined;
    delete handle.dataset.fruitbackDragging;
    if (handle.hasPointerCapture?.(event.pointerId) === true) handle.releasePointerCapture(event.pointerId);
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('lostpointercapture', end);
  handle.addEventListener('dblclick', () => moves.home());
  handle.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const step = keyMove(event.key, event.shiftKey);
    if (step === undefined) return;
    // The arrows would scroll the page.
    event.preventDefault();
    if (step === 'home') moves.home();
    else {
      const from = moves.current();
      moves.move({ x: from.x + step.x, y: from.y + step.y });
    }
  });
}
