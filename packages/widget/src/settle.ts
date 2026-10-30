/**
 * Watch the box of an element for a short time after it was chosen, and say when it changes (FRU-489).
 *
 * The element is chosen at a click, so during the press. A page can draw a pressed element smaller:
 * a HeroUI button is at `scale(0.97)` while `[data-pressed]` is on it, and React Aria takes the press
 * off up to 80 ms after the click. A transition can then grow it back over some frames. Scroll and
 * resize do not fire for any of this, and a ResizeObserver does not see a transform. So the box is
 * read again at each frame, until it stays the same for `STILL_MS`, and never after `MOST_MS`.
 *
 * The cost is one read of the box per frame, for 200 ms to 1 s after a choice. Nothing runs after that.
 */

/** Longer than the 80 ms that React Aria waits before it takes off a press whose click it did not see. */
export const STILL_MS = 200;
/** A transition of a press is shorter. A box that still moves after this moves for another reason. */
export const MOST_MS = 1_000;

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** What `settle` needs of the window. Each part is a parameter, so a test can give the frames itself. */
export interface Frames {
  request(callback: () => void): number;
  cancel(handle: number): void;
  now(): number;
}

/** The frames of a window, or `undefined` when it has none to give (no window, or no `requestAnimationFrame`). */
export function framesOf(view: Window | null): Frames | undefined {
  if (view === null || typeof view.requestAnimationFrame !== 'function') return undefined;

  return {
    request: (callback) => view.requestAnimationFrame(() => callback()),
    cancel: (handle) => view.cancelAnimationFrame(handle),
    now: () => view.performance.now(),
  };
}

/**
 * Call `onChange` at each frame where `measure` gives another box than at the frame before. The first
 * box is read now. Return a function that stops the watch; the watch also stops by itself.
 */
export function settle(frames: Frames | undefined, measure: () => Box, onChange: () => void): () => void {
  if (frames === undefined) return () => {};

  const started = frames.now();
  let changed = started;
  // Copied: a box is compared with the next one, and a measure may give the same object back.
  const read = (): Box => {
    const { left, top, right, bottom } = measure();

    return { left, top, right, bottom };
  };
  let last = read();
  let handle = frames.request(step);

  function step(): void {
    const now = frames!.now();
    const box = read();
    if (box.left !== last.left || box.top !== last.top || box.right !== last.right || box.bottom !== last.bottom) {
      last = box;
      changed = now;
      onChange();
    }
    handle = now - changed >= STILL_MS || now - started >= MOST_MS ? 0 : frames!.request(step);
  }

  return () => {
    if (handle !== 0) frames.cancel(handle);
    handle = 0;
  };
}
