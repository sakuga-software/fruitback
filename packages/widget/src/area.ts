import type { Translator } from './messages.ts';

/**
 * The area of the page that a capture takes (FRU-332): the person draws a rectangle, or moves the one
 * that is already drawn, and Esc cancels.
 *
 * **The keyboard is enough.** A rectangle is drawn at once, in the middle of the window, so a person
 * with no pointer starts from something: the arrows move it, Shift and the arrows change its size,
 * Enter takes it, Esc cancels. With a pointer, a drag draws a new one, and its release takes it. The
 * two buttons do the same for a touch screen.
 *
 * The overlay is gone before the capture is taken: `pickArea` answers once it is removed.
 */

/** An area in CSS pixels of the viewport. */
export type Area = { left: number; top: number; width: number; height: number };

/** The smallest side of an area, in CSS pixels. A click with no drag draws nothing. */
export const MIN_SIDE = 8;
/** How far an arrow moves the area, or changes its size. */
export const STEP = 10;

export function pickArea(options: {
  document: Document;
  /** Where the overlay goes: the Shadow root of the widget. */
  host: ShadowRoot | Element;
  translator: Translator;
}): Promise<Area | undefined> {
  const { document, host, translator: t } = options;
  const view = document.defaultView;
  const width = view?.innerWidth ?? 0;
  const height = view?.innerHeight ?? 0;
  let area: Area = clamp(
    { left: width * 0.25, top: height * 0.3, width: width * 0.5, height: height * 0.4 },
    width,
    height,
  );

  const style = document.createElement('style');
  style.textContent = STYLES;
  const overlay = document.createElement('div');
  overlay.className = 'fruitback-area';
  overlay.dataset.fruitbackArea = '';
  overlay.tabIndex = -1;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', t.text('area.dialog'));
  const box = document.createElement('div');
  box.className = 'fruitback-area-box';
  box.dataset.fruitbackAreaBox = '';
  const help = document.createElement('p');
  help.className = 'fruitback-area-help';
  help.id = 'fruitback-area-help';
  help.textContent = t.text('area.help');
  overlay.setAttribute('aria-describedby', help.id);
  const take = document.createElement('button');
  take.type = 'button';
  take.className = 'fruitback-area-take';
  take.textContent = t.text('area.take');
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'fruitback-area-cancel';
  cancel.textContent = t.text('area.cancel');
  const bar = document.createElement('div');
  bar.className = 'fruitback-area-bar';
  bar.append(help, cancel, take);
  overlay.append(box, bar);
  host.append(style, overlay);

  const previous = document.activeElement as HTMLElement | null;
  draw();
  overlay.focus();

  return new Promise((resolve) => {
    let drawing: { x: number; y: number } | undefined;

    const finish = (chosen: Area | undefined): void => {
      overlay.remove();
      style.remove();
      previous?.focus?.();
      resolve(chosen);
    };

    overlay.addEventListener('keydown', (event) => {
      const key = event as KeyboardEvent;
      if (key.key === 'Escape') {
        key.preventDefault();
        key.stopPropagation();
        finish(undefined);

        return;
      }
      if (key.key === 'Enter' && key.target === overlay) {
        key.preventDefault();
        finish(area);

        return;
      }
      const moves: Record<string, [number, number]> = {
        ArrowLeft: [-STEP, 0],
        ArrowRight: [STEP, 0],
        ArrowUp: [0, -STEP],
        ArrowDown: [0, STEP],
      };
      const move = moves[key.key];
      if (move === undefined) return;
      key.preventDefault();
      const [dx, dy] = move;
      area = clamp(
        key.shiftKey
          ? { ...area, width: area.width + dx, height: area.height + dy }
          : { ...area, left: area.left + dx, top: area.top + dy },
        width,
        height,
      );
      draw();
    });

    overlay.addEventListener('pointerdown', (event) => {
      const pointer = event as PointerEvent;
      if (pointer.target !== overlay && pointer.target !== box) return;
      drawing = { x: pointer.clientX, y: pointer.clientY };
      overlay.setPointerCapture?.(pointer.pointerId);
    });
    overlay.addEventListener('pointermove', (event) => {
      if (drawing === undefined) return;
      const pointer = event as PointerEvent;
      area = clamp(between(drawing, { x: pointer.clientX, y: pointer.clientY }), width, height);
      draw();
    });
    overlay.addEventListener('pointerup', (event) => {
      if (drawing === undefined) return;
      const pointer = event as PointerEvent;
      const drawn = between(drawing, { x: pointer.clientX, y: pointer.clientY });
      drawing = undefined;
      // A click with no drag keeps the area that was there.
      if (drawn.width >= MIN_SIDE && drawn.height >= MIN_SIDE) finish(clamp(drawn, width, height));
    });
    take.addEventListener('click', () => finish(area));
    cancel.addEventListener('click', () => finish(undefined));
  });

  function draw(): void {
    box.style.left = `${area.left}px`;
    box.style.top = `${area.top}px`;
    box.style.width = `${area.width}px`;
    box.style.height = `${area.height}px`;
  }
}

function between(from: { x: number; y: number }, to: { x: number; y: number }): Area {
  return {
    left: Math.min(from.x, to.x),
    top: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  };
}

/** An area inside the window, and never smaller than `MIN_SIDE`. */
export function clamp(area: Area, width: number, height: number): Area {
  const w = Math.max(MIN_SIDE, Math.min(area.width, width));
  const h = Math.max(MIN_SIDE, Math.min(area.height, height));

  return {
    left: Math.max(0, Math.min(area.left, width - w)),
    top: Math.max(0, Math.min(area.top, height - h)),
    width: w,
    height: h,
  };
}

const STYLES = `
.fruitback-area {
  position: fixed;
  inset: 0;
  z-index: 2147483600;
  cursor: crosshair;
  outline: 0;
  touch-action: none;
}
.fruitback-area-box {
  position: fixed;
  box-sizing: border-box;
  border: 2px solid var(--fruitback-color-accent);
  border-radius: var(--fruitback-radius-sm);
  /* The page outside the area, dimmed: the shadow is the rest of the window. */
  box-shadow: 0 0 0 100vmax color-mix(in srgb, var(--fruitback-color-ink) 45%, transparent);
  pointer-events: none;
}
.fruitback-area:focus-visible .fruitback-area-box { outline: 2px solid var(--fruitback-color-on-accent); outline-offset: 2px; }
.fruitback-area-bar {
  position: fixed;
  inset-inline: 12px;
  bottom: 12px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--fruitback-color-border);
  border-radius: var(--fruitback-radius-lg);
  background: var(--fruitback-color-surface);
  color: var(--fruitback-color-text);
  font: 13px/1.5 var(--fruitback-font-sans);
  box-shadow: var(--fruitback-shadow-lg);
  cursor: default;
}
.fruitback-area-help { flex: 1 1 200px; margin: 0; color: var(--fruitback-color-text-muted); }
.fruitback-area-take, .fruitback-area-cancel {
  min-height: 44px;
  padding: 0 14px;
  border: 0;
  border-radius: var(--fruitback-radius-pill);
  font: 600 13px/1 var(--fruitback-font-sans);
  cursor: pointer;
}
.fruitback-area-cancel { background: transparent; color: var(--fruitback-color-text-muted); }
.fruitback-area-cancel:hover { background: var(--fruitback-color-surface-sunken); }
.fruitback-area-take { background: var(--fruitback-color-accent); color: var(--fruitback-color-on-accent); }
.fruitback-area-take:hover { background: var(--fruitback-color-accent-strong); }
.fruitback-area-take:focus-visible, .fruitback-area-cancel:focus-visible {
  outline: 2px solid var(--fruitback-color-accent);
  outline-offset: 2px;
}
@media (forced-colors: active) {
  .fruitback-area-box { border-color: Highlight; box-shadow: none; }
  .fruitback-area-take, .fruitback-area-cancel { outline: 1px solid ButtonText; }
}
`;
