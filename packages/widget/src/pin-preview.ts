import type { Direction } from './messages.ts';

/**
 * The preview of a note on the hover or the keyboard focus of its pin (FRU-422), in place of the
 * `title` of the browser: the drop and the state, the identifier in the tracker, the first two lines
 * of the note, and how to open it.
 *
 * It is `aria-hidden`: the name of the pin already says the number, the stage and the note, and a
 * screen reader must not read them twice. It takes no pointer, so it never covers what it is about.
 */

/** The box of something on the page, in document coordinates. */
export type PreviewBox = { left: number; top: number; width: number; height: number };

/** 8 px between the preview and the drop, and between the preview and the edge of the window. */
export const PREVIEW_GAP = 8;

/** Kept next to the `width` of the stylesheet, for a document with no layout. */
export const PREVIEW_WIDTH = 240;

export type PreviewContent = {
  /** The colour of the drop, the same token as the pin. */
  color: string;
  state: string;
  /** The identifier in the tracker, only for a note that has a link there. */
  identifier: string | undefined;
  note: string;
  hint: string;
};

export function buildPreview(document: Document, content: PreviewContent): HTMLElement {
  const node = document.createElement('div');
  node.className = 'fruitback-preview';
  node.setAttribute('aria-hidden', 'true');
  node.style.setProperty('--fruitback-pin-color', content.color);

  const drop = document.createElement('span');
  drop.className = 'fruitback-thread-drop';
  const state = document.createElement('span');
  state.className = 'fruitback-preview-state';
  state.textContent = content.state;
  const head = document.createElement('div');
  head.className = 'fruitback-preview-head';
  head.append(drop, state);
  if (content.identifier !== undefined) {
    const identifier = document.createElement('span');
    identifier.className = 'fruitback-preview-identifier';
    identifier.textContent = content.identifier;
    head.append(identifier);
  }

  const note = document.createElement('p');
  note.className = 'fruitback-preview-note';
  note.textContent = content.note;
  const hint = document.createElement('p');
  hint.className = 'fruitback-preview-hint';
  hint.textContent = content.hint;

  node.append(head, note, hint);

  return node;
}

function overlaps(a: PreviewBox, b: PreviewBox): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}

/**
 * Where the preview goes: on the end side of the drop, then the start side, then above, then below.
 * It takes the first side that stays in the window and covers no other drop, else the first side in
 * the window, else the end side pushed back into the window.
 */
export function previewPlace(
  drop: PreviewBox,
  size: { width: number; height: number },
  window: PreviewBox,
  others: readonly PreviewBox[],
  direction: Direction,
): { left: number; top: number } {
  const after = { left: drop.left + drop.width + PREVIEW_GAP, top: drop.top };
  const before = { left: drop.left - PREVIEW_GAP - size.width, top: drop.top };
  const middle = drop.left + drop.width / 2 - size.width / 2;
  const above = { left: middle, top: drop.top - PREVIEW_GAP - size.height };
  const below = { left: middle, top: drop.top + drop.height + PREVIEW_GAP };
  const sides = direction === 'rtl' ? [before, after, above, below] : [after, before, above, below];

  const inWindow = (side: { left: number; top: number }) =>
    side.left >= window.left + PREVIEW_GAP &&
    side.left + size.width <= window.left + window.width - PREVIEW_GAP &&
    side.top >= window.top + PREVIEW_GAP &&
    side.top + size.height <= window.top + window.height - PREVIEW_GAP;
  const free = (side: { left: number; top: number }) => others.every((other) => !overlaps({ ...side, ...size }, other));

  const chosen = sides.find((side) => inWindow(side) && free(side)) ?? sides.find(inWindow);
  if (chosen !== undefined) return chosen;

  const first = sides[0] ?? after;
  const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));

  return {
    left: clamp(first.left, window.left + PREVIEW_GAP, window.left + window.width - size.width - PREVIEW_GAP),
    top: clamp(first.top, window.top + PREVIEW_GAP, window.top + window.height - size.height - PREVIEW_GAP),
  };
}

export const PREVIEW_STYLES = `
.fruitback-preview {
  position: absolute;
  /*
    Above the frame of a capture and its label (2147483100), which stay on the element for a moment
    after a note is sent, and under the dock of the widget (2147483200).
  */
  z-index: 2147483150;
  width: min(240px, calc(100vw - 16px));
  padding: 10px 12px;
  pointer-events: none;
  border: 1px solid var(--fruitback-color-border);
  border-radius: var(--fruitback-radius-md);
  background: var(--fruitback-color-surface);
  color: var(--fruitback-color-text);
  font: 13px/1.45 var(--fruitback-font-sans);
  box-shadow: var(--fruitback-shadow-lg);
}
.fruitback-preview-head { display: flex; align-items: center; gap: 6px; font-weight: 600; }
.fruitback-preview-identifier { margin-inline-start: auto; color: var(--fruitback-color-text-muted); font-weight: 500; }
.fruitback-preview-note {
  margin: 4px 0 0;
  overflow: hidden;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow-wrap: anywhere;
}
.fruitback-preview-hint { margin: 6px 0 0; color: var(--fruitback-color-text-muted); font-size: 12px; }
@media (forced-colors: active) {
  .fruitback-preview { outline: 1px solid CanvasText; }
}
`;
