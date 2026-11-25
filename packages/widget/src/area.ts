import { deepActiveElement } from './focus.ts';
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

/** The buttons of the bar: « Cancel », « Visible part » and « Take this area ». */
const BUTTON =
  'fruitback:min-h-11 fruitback:px-3.5 fruitback:py-0 fruitback:border-0 fruitback:rounded-md fruitback:font-sans fruitback:font-semibold fruitback:text-hint fruitback:leading-none fruitback:cursor-pointer ' +
  'fruitback:focus-visible:outline-2 fruitback:focus-visible:outline-accent fruitback:focus-visible:outline-offset-2 ' +
  'fruitback:forced-colors:outline-1 fruitback:forced-colors:outline-button-text';
const CANCEL = 'fruitback:bg-transparent fruitback:text-text-muted fruitback:hover:bg-surface-sunken';

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
  overlay.className = [
    'fruitback-area',
    'fruitback:fixed fruitback:inset-0 fruitback:z-2147483600 fruitback:cursor-crosshair fruitback:outline-none fruitback:touch-none fruitback:group',
  ].join(' ');
  overlay.dataset.fruitbackArea = '';
  overlay.tabIndex = -1;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', t.text('area.dialog'));
  const box = document.createElement('div');
  box.className = [
    'fruitback-area-box',
    'fruitback:fixed fruitback:box-border fruitback:border-2 fruitback:border-accent fruitback:rounded-sm fruitback:shadow-dim fruitback:pointer-events-none',
    'fruitback:group-focus-visible:outline-2 fruitback:group-focus-visible:outline-on-accent fruitback:group-focus-visible:outline-offset-2',
    'fruitback:forced-colors:border-highlight fruitback:forced-colors:shadow-none',
  ].join(' ');
  box.dataset.fruitbackAreaBox = '';
  const help = document.createElement('p');
  help.className = [
    'fruitback-area-help',
    'fruitback:grow fruitback:shrink fruitback:basis-50 fruitback:m-0 fruitback:text-text-muted',
  ].join(' ');
  help.id = 'fruitback-area-help';
  help.textContent = t.text('area.help');
  overlay.setAttribute('aria-describedby', help.id);
  const take = document.createElement('button');
  take.type = 'button';
  take.className = [
    'fruitback-area-take',
    BUTTON,
    'fruitback:bg-accent fruitback:text-on-accent fruitback:hover:bg-accent-strong',
  ].join(' ');
  take.textContent = t.text('area.take');
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = ['fruitback-area-cancel', BUTTON, CANCEL].join(' ');
  cancel.textContent = t.text('area.cancel');
  // FRU-609: the visible part of the page, whole, in one click.
  const visible = document.createElement('button');
  visible.type = 'button';
  visible.className = ['fruitback-area-cancel fruitback-area-visible', BUTTON, CANCEL].join(' ');
  visible.dataset.fruitbackAreaVisible = '';
  visible.textContent = t.text('area.visible');
  // FRU-609: the size of the area as it is drawn, in CSS pixels, on its corner.
  const size = document.createElement('span');
  size.className = [
    'fruitback-area-size',
    'fruitback:fixed fruitback:-translate-x-full fruitback:translate-y-1.5 fruitback:px-1.5 fruitback:py-0.5 fruitback:rounded-sm fruitback:bg-ink fruitback:text-on-ink',
    'fruitback:font-mono fruitback:font-semibold fruitback:text-caption fruitback:pointer-events-none fruitback:whitespace-nowrap',
  ].join(' ');
  size.dataset.fruitbackAreaSize = '';
  size.setAttribute('aria-hidden', 'true');
  const bar = document.createElement('div');
  bar.className = [
    'fruitback-area-bar',
    'fruitback:fixed fruitback:inset-x-3 fruitback:bottom-3 fruitback:flex fruitback:flex-wrap fruitback:items-center fruitback:gap-2 fruitback:px-3 fruitback:py-2.5',
    'fruitback:border fruitback:border-border fruitback:rounded-lg fruitback:bg-surface fruitback:text-text fruitback:font-sans fruitback:text-hint fruitback:shadow-lg fruitback:cursor-default',
  ].join(' ');
  bar.append(help, cancel, visible, take);
  overlay.append(box, size, bar);
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
