import { deepActiveElement } from './focus.ts';
import type { Translator } from './messages.ts';
import { adoptStyles } from './stylesheet.ts';
import { STYLES } from './area.styles.ts';

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
  // FRU-609: the visible part of the page, whole, in one click.
  const visible = document.createElement('button');
  visible.type = 'button';
  visible.className = 'fruitback-area-cancel fruitback-area-visible';
  visible.dataset.fruitbackAreaVisible = '';
  visible.textContent = t.text('area.visible');
  // FRU-609: the size of the area as it is drawn, in CSS pixels, on its corner.
  const size = document.createElement('span');
  size.className = 'fruitback-area-size';
  size.dataset.fruitbackAreaSize = '';
  size.setAttribute('aria-hidden', 'true');
  const bar = document.createElement('div');
  bar.className = 'fruitback-area-bar';
  bar.append(help, cancel, visible, take);
  overlay.append(box, size, bar);
  const style = adoptStyles(host, STYLES);
  host.append(overlay);

  // In the Shadow root of the widget, `document.activeElement` is the host: the button that opened the
  // area is the active element of the root (FRU-353). Esc and Enter give the focus back to it.
  const previous = deepActiveElement(document) as HTMLElement | null;
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
    visible.addEventListener('click', () => finish({ left: 0, top: 0, width, height }));
    cancel.addEventListener('click', () => finish(undefined));
  });

  function draw(): void {
    box.style.left = `${area.left}px`;
    box.style.top = `${area.top}px`;
    box.style.width = `${area.width}px`;
    box.style.height = `${area.height}px`;
    size.textContent = `${Math.round(area.width)} × ${Math.round(area.height)}`;
    size.style.left = `${area.left + area.width}px`;
    size.style.top = `${area.top + area.height}px`;
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
