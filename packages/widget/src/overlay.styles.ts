import { GROUND_INK } from './page-ground.ts';
/**
 * How far apart the badges of one spot sit (FRU-155). The stylesheet multiplies it by
 * `--fruitback-pin-slot`: a 28 px drop and a 2 px gap.
 */
const BADGE_STEP = 30;

/**
 * The drop of a pin (FRU-304): 28 px, turned by 45 degrees, its point on the anchor of the note.
 * Its box is 34 px above the point and 14 px on each side of it, as the mock-up places it.
 */
export const BADGE_HALF = 14;
export const BADGE_RISE = 34;

/** The line of the frame of a pin. The drop is placed from inside it, and `place` counts from outside it. */
const FRAME_BORDER = 2;

/**
 * Kept in one string rather than set per element: when the host becomes a Shadow root (FRU-3) this
 * whole sheet moves inside it untouched, and the class names stop mattering.
 */
export const STYLES = `
.fruitback-overlay { position: absolute; top: 0; left: 0; }
.fruitback-pin {
  position: absolute;
  /*
    Above the dock (2147483200) and the settings of the widget (FRU-666): a note under the dock is a
    note the reporter cannot see. The badge then takes the pointer over the dock where they meet.
  */
  z-index: 2147483210;
  /* Clicks go through to the client's page: the pin is an annotation, not a lid. */
  pointer-events: none;
  /*
    The frame of the mock-up of 2026-10-20 (FRU-304): a line of 2 px, 3 px off the element, in the
    colour of the status. Transparent at rest: the mock-up draws the drop alone.
  */
  border: 2px solid transparent;
  border-radius: var(--fruitback-radius-sm);
}
/*
  The frame only while its note is pointed at, focused or open (FRU-158). Left on, it lined every
  annotated element of the page, and the more a page was annotated, the less it could be read.

  Two rules and not one list: a browser with no :has() drops the whole rule that names it, and the
  frame of an open thread must not go with it.
*/
.fruitback-pin[data-fruitback-open] {
  z-index: 2147483211;
  border-color: var(--fruitback-pin-color);
  outline: 1px var(--fruitback-pin-frame-style, solid) var(--fruitback-color-stage-edge);
}
/*
  The frame has the edge of the drop outside it (FRU-334): the grey of « to do » is 1.39:1 on a white
  page, and the frame of its note would be lost there.
*/
.fruitback-pin:has(.fruitback-pin-badge:hover),
.fruitback-pin:has(.fruitback-pin-badge:focus-visible) {
  border-color: var(--fruitback-pin-color);
  outline: 1px var(--fruitback-pin-frame-style, solid) var(--fruitback-color-stage-edge);
}
/* Dashed, and its edge too. A custom property, so that the outline stays off at rest. */
.fruitback-pin-uncertain { border-style: dashed; --fruitback-pin-frame-style: dashed; }
/* Detached: listed in the dock, not on the page (FRU-304). A draft keeps its pin where it was planted. */
.fruitback-pin-orphan:not([data-fruitback-draft]) { display: none; }
/*
  The pin of the row a list outside the page has open (FRU-299): above the others, a fifth bigger.
  Its z-index counts against the one of every pin, 2147483210, not against 0 (FRU-326).
*/
/*
  A note chosen in the list of the page (FRU-308): its frame is the ring of the board, 12 px round with
  a halo, and the other pins step back. Not the forced palette: there the frame alone says it.
*/
.fruitback-overlay[data-fruitback-choosing] .fruitback-pin[data-fruitback-open] {
  border-radius: 12px;
  box-shadow: 0 0 0 6px rgba(255, 255, 255, 0.6);
}
.fruitback-overlay[data-fruitback-choosing] .fruitback-pin:not([data-fruitback-open]) { opacity: 0.55; }
/*
  « Show pins on the page » off (FRU-308): no pin but the open one, so a thread open on the page keeps
  its pin, and the note chosen in the list keeps its ring and its drop.
*/
.fruitback-overlay[data-fruitback-pins-hidden] .fruitback-pin:not([data-fruitback-open]) { display: none; }
.fruitback-pin[data-fruitback-marked] { z-index: 2147483211; }
.fruitback-pin[data-fruitback-marked] .fruitback-pin-badge { scale: 1.2; }
.fruitback-pin-orphan { border-style: dotted; }
.fruitback-pin-badge {
  position: absolute;
  /*
    The point of the drop is on the anchor of the note (FRU-304), which place() writes in the box of
    the pin. A child is placed from inside the border of the frame, so the border comes off. One step
    to the right for each note before this one on the same spot (FRU-155).
  */
  left: calc(var(--fruitback-pin-tip-x, 0px) - ${BADGE_HALF + FRAME_BORDER}px + var(--fruitback-pin-slot, 0) * ${BADGE_STEP}px);
  top: calc(var(--fruitback-pin-tip-y, 0px) - ${BADGE_RISE + FRAME_BORDER}px);
  /* …except this, which is the one thing you can click. */
  pointer-events: auto;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  /* A ring of the foreground of the stages, so the drop reads on any page. */
  border: 2px solid var(--fruitback-color-on-stage);
  /* Three round corners and one sharp: a drop, pointing down at its spot. */
  border-radius: 50% 50% 50% 0;
  transform: rotate(-45deg);
  background: var(--fruitback-pin-color);
  color: var(--fruitback-pin-on-color, var(--fruitback-color-on-stage));
  font: 700 12px/1 var(--fruitback-font-sans);
  cursor: pointer;
  /* The edge outside the white ring (FRU-334): a light pin holds on a white page too. */
  box-shadow: 0 0 0 1px var(--fruitback-color-stage-edge), var(--fruitback-shadow-sm);
  transition: transform var(--fruitback-duration-fast) var(--fruitback-ease-out);
  /* Squash and stretch: the drop lands, flattens, and settles. */
  animation: fruitback-pin-drop var(--fruitback-duration-slow) cubic-bezier(0.2, 1.4, 0.35, 1);
}
/* Found by position, not by identity: the same drop, its ring dashed. The number stays. */
.fruitback-pin-uncertain .fruitback-pin-badge { border-style: dashed; }
/*
  A red site (FRU-611, P7): the drop keeps the colour of its status, and its edge takes the ink with a
  white contour, so a red drop on a red page still has a shape.
*/
:host([data-fruitback-faint]) .fruitback-pin-badge { border-color: ${GROUND_INK}; box-shadow: 0 0 0 2px #ffffff; }
/* Open: the drop grows, above the others. */
.fruitback-pin[data-fruitback-open] .fruitback-pin-badge { transform: rotate(-45deg) scale(1.15); }
.fruitback-pin-glyph {
  transform: rotate(45deg);
  font-size: 12px;
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.fruitback-pin-badge:hover { filter: brightness(1.06); }
.fruitback-pin-badge:focus-visible { outline: 2px solid var(--fruitback-color-text); outline-offset: 2px; }
/* A forced palette drops the fill: the drop is then its ring. */
@media (forced-colors: active) {
  .fruitback-pin-badge { border-color: ButtonText; }
  .fruitback-pin[data-fruitback-open],
  .fruitback-pin:has(.fruitback-pin-badge:hover) { border-color: Highlight; }
}

@keyframes fruitback-pin-drop {
  0% { opacity: 0; transform: translate(0, -7px) rotate(-45deg) scale(0.7, 1.25); }
  55% { opacity: 1; transform: translate(0, 0) rotate(-45deg) scale(1.18, 0.82); }
  100% { opacity: 1; transform: rotate(-45deg) scale(1, 1); }
}

@media (prefers-reduced-motion: reduce) {
  .fruitback-pin-badge { animation: none; transition: none; }
}
/* FRU-471: a thread fades in where it opens. Opacity only: the placement measures its box. */
@keyframes fruitback-thread-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.fruitback-thread {
  position: absolute;
  /* Above every pin (2147483210), so that the pin of another note never cuts into an open thread. */
  z-index: 2147483230;
  /*
    360 px and the corner of 10 of a modal of the console (FRU-696), and what a narrower window leaves:
    8 px on each side, the gap the placement keeps.
  */
  width: min(360px, calc(100vw - 16px));
  pointer-events: auto;
  border: 1px solid var(--fruitback-color-border);
  border-radius: var(--fruitback-radius-md);
  background: var(--fruitback-color-surface);
  color: var(--fruitback-color-text);
  font: 13px/1.4 var(--fruitback-font-sans);
  box-shadow: var(--fruitback-shadow-lg);
  animation: fruitback-thread-in var(--fruitback-duration-fast) var(--fruitback-ease-out);
}
@media (prefers-reduced-motion: reduce) {
  .fruitback-thread { animation: none; }
}
/*
  In a panel of the widget (FRU-312): the column of the list holds it, so it has no place of its own,
  no edge and no shadow.
*/
.fruitback-thread[data-fruitback-home] {
  position: static;
  width: auto;
  border: 0;
  border-radius: 0;
  box-shadow: none;
}
/*
  The arrow from the edge that faces the element to its pin (FRU-421): a square of 12 px turned by 45
  degrees, half out of the bubble, with the two lines of its outer corner. Gone once the thread is moved
  by its handle, where the dashed line takes its place, and in a panel of the widget.
*/
.fruitback-thread[data-fruitback-arrow]::before {
  content: '';
  position: absolute;
  width: 12px;
  height: 12px;
  box-sizing: border-box;
  border: 1px solid var(--fruitback-color-border);
  background: var(--fruitback-color-surface);
  transform: rotate(45deg);
  pointer-events: none;
}
.fruitback-thread[data-fruitback-arrow='top']::before {
  top: -7px;
  left: calc(var(--fruitback-arrow-at) - 6px);
  border-right: 0;
  border-bottom: 0;
}
.fruitback-thread[data-fruitback-arrow='bottom']::before {
  bottom: -7px;
  left: calc(var(--fruitback-arrow-at) - 6px);
  border-top: 0;
  border-left: 0;
}
.fruitback-thread[data-fruitback-arrow='left']::before {
  left: -7px;
  top: calc(var(--fruitback-arrow-at) - 6px);
  border-top: 0;
  border-right: 0;
}
.fruitback-thread[data-fruitback-arrow='right']::before {
  right: -7px;
  top: calc(var(--fruitback-arrow-at) - 6px);
  border-bottom: 0;
  border-left: 0;
}
.fruitback-thread[data-fruitback-moved]::before,
.fruitback-thread[data-fruitback-home]::before { display: none; }
/* A shadow is not drawn in forced colours: the bubble then needs an edge of its own. */
@media (forced-colors: active) {
  .fruitback-thread { outline: 1px solid CanvasText; }
  .fruitback-thread[data-fruitback-home] { outline: 0; }
}
/*
  Two columns (FRU-419): what the head says, and the cross. The cross keeps its column and the top of
  it, so a long head wraps under the state and never pushes the cross to a line of its own. 40 px on
  one line (FRU-696): 7 px above and below a control of 26.
*/
.fruitback-thread-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  column-gap: 6px;
  box-sizing: border-box;
  min-height: 40px;
  padding-block: 7px;
  /* 9 px at the end: the target of the cross reaches 9 px past its drawn square, and stays inside. */
  padding-inline: 12px 9px;
  border-bottom: 1px solid var(--fruitback-color-border);
}
/* With the handle that moves it (FRU-420), first, in a column of its own. */
.fruitback-thread-head[data-fruitback-movable] { grid-template-columns: auto minmax(0, 1fr) auto; }
/*
  The handle (FRU-420): 28 px drawn, 44 px to press, like the cross. Only the handle moves the thread,
  so the text stays selectable everywhere else. No scroll of the page under a finger on it.
*/
.fruitback-thread-handle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  margin: -8px;
  border: 8px solid transparent;
  border-radius: calc(var(--fruitback-radius-sm) + 8px);
  background: transparent;
  font-size: 16px;
  line-height: 1;
  color: var(--fruitback-color-text-muted);
  cursor: grab;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}
.fruitback-thread-handle[data-fruitback-dragging] { cursor: grabbing; }
.fruitback-thread-handle:hover { background: var(--fruitback-color-surface-sunken) padding-box; color: var(--fruitback-color-text); }
.fruitback-thread-handle:focus-visible { outline: 2px solid var(--fruitback-color-accent); outline-offset: -6px; }
/* The line from the pin to a thread moved away from it (FRU-420): dashed, in the colour of its status. */
.fruitback-thread-tether {
  position: absolute;
  z-index: 2147483229;
  height: 0;
  border-top: 2px dashed var(--fruitback-pin-color);
  transform-origin: 0 0;
  pointer-events: none;
}
@media (forced-colors: active) {
  .fruitback-thread-handle { border-color: Canvas; }
  .fruitback-thread-tether { border-top-color: CanvasText; }
}
/* A long state takes the first line, and the way out goes under it (FRU-350). */
.fruitback-thread-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
  /* As tall as the cross is drawn, so that a one-line head centres its state on the cross. */
  min-height: 26px;
}
/*
  The status in a chip of 24 px (FRU-696): the round of its stage and its word, in a line of the edge
  and the corner of a control. A long word wraps inside it, and the chip grows.
*/
.fruitback-thread-stage {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 1 auto;
  min-width: 0;
  box-sizing: border-box;
  min-height: 24px;
  padding: 2px 8px 2px 6px;
  border: 1px solid var(--fruitback-color-border);
  border-radius: var(--fruitback-radius-sm);
  font-weight: 500;
  font-size: 13px;
  line-height: 18px;
}
.fruitback-thread-ring { flex: none; width: 14px; height: 14px; }
/*
  « You · this browser » (FRU-700): a chip of the sunken surface, after the word of the state, in the
  heading that wraps. Its words wrap too, in a thread narrower than the chip.
*/
.fruitback-thread-you {
  flex: 0 1 auto;
  min-width: 0;
  padding: 1px 7px;
  border-radius: var(--fruitback-radius-sm);
  background: var(--fruitback-color-surface-sunken);
  color: var(--fruitback-color-text);
  font: 500 12px/1.5 var(--fruitback-font-sans);
  letter-spacing: 0;
  overflow-wrap: anywhere;
}
@media (forced-colors: active) {
  .fruitback-thread-you { border: 1px solid CanvasText; }
}
/* The silhouette of the pin, which is not in the scale and is not settable (see theme.ts). */
.fruitback-thread-drop {
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 50% 50% 50% 0;
  transform: rotate(-45deg);
  background: var(--fruitback-pin-color);
  box-shadow: 0 0 0 1px var(--fruitback-color-stage-edge);
}
/* anywhere: the store names its states, and a long name must wrap inside the head. */
.fruitback-thread-state { min-width: 0; overflow-wrap: anywhere; }
/*
  The way out to the ticket (FRU-696): the mark of its tracker, « DEV-004 » and the sign of a new tab,
  24 px drawn, after the status. Its target is 44 px tall: a transparent border around it, and the
  margins give it back.
*/
.fruitback-thread-link {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-block: -10px;
  padding: 3px 6px;
  border: 10px solid transparent;
  border-inline-width: 0;
  border-radius: var(--fruitback-radius-sm) / calc(var(--fruitback-radius-sm) + 10px);
  background: transparent;
  color: var(--fruitback-color-text);
  font: 500 13px/18px var(--fruitback-font-sans);
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
}
.fruitback-thread-link:hover { background: var(--fruitback-color-surface-sunken) padding-box; }
.fruitback-thread-link:focus-visible { outline: 2px solid var(--fruitback-color-accent); outline-offset: -8px; }
.fruitback-thread-link-mark { width: 13px; height: 13px; }
.fruitback-thread-link-out { width: 12px; height: 12px; color: var(--fruitback-color-text-muted); }
/* The cross: 26 px drawn (FRU-696), 44 px to press, the margins give the difference back to the head. */
.fruitback-thread-close {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  margin: -9px;
  border: 9px solid transparent;
  border-radius: calc(var(--fruitback-radius-sm) + 9px);
  background: transparent;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  color: var(--fruitback-color-text-muted);
}
.fruitback-thread-close:hover { background: var(--fruitback-color-surface-sunken) padding-box; }
/*
  The menu « ⋯ » of the author (FRU-605), before the cross in the same column. Both are 26 px drawn and
  44 px to press (FRU-696): the gap keeps 18 px between the two targets, 0 between the drawn squares.
*/
.fruitback-thread-tools { display: flex; align-items: center; gap: 18px; }
.fruitback-thread-more-wrap { position: relative; }
.fruitback-thread-more {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  margin: -9px;
  border: 9px solid transparent;
  border-radius: calc(var(--fruitback-radius-sm) + 9px);
  background: transparent;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  color: var(--fruitback-color-text-muted);
}
.fruitback-thread-more:hover, .fruitback-thread-more[aria-expanded="true"] {
  background: var(--fruitback-color-surface-sunken) padding-box;
  color: var(--fruitback-color-text);
}
.fruitback-thread-more:focus-visible { outline: 2px solid var(--fruitback-color-accent); outline-offset: -6px; }
/* Under « ⋯ », on the end side: the thread is 344 px wide at most, and the menu stays inside it. */
.fruitback-thread-more-menu {
  position: absolute;
  top: calc(100% + 12px);
  inset-inline-end: -8px;
  z-index: 1;
  box-sizing: border-box;
  min-width: 220px;
  margin: 0;
  padding: 4px;
  list-style: none;
  border: 1px solid var(--fruitback-color-border);
  border-radius: var(--fruitback-radius-sm);
  background: var(--fruitback-color-surface);
  box-shadow: var(--fruitback-shadow-xl);
}
.fruitback-thread-more-menu[hidden] { display: none; }
/* FRU-632: the menu « More » fades in, as the thread does. */
.fruitback-thread-more-menu:not([hidden]) { animation: fruitback-thread-in var(--fruitback-duration-fast) var(--fruitback-ease-out); }
@media (prefers-reduced-motion: reduce) {
  .fruitback-thread-more-menu:not([hidden]) { animation: none; }
}
.fruitback-thread-more-menu li { display: block; margin: 0; padding: 0; }
.fruitback-thread-more-item {
  display: block;
  width: 100%;
  min-height: 36px;
  padding: 6px 10px;
  border: 0;
  border-radius: var(--fruitback-radius-sm);
  background: transparent;
  color: var(--fruitback-color-text);
  font: 500 13px/1.3 var(--fruitback-font-sans);
  text-align: start;
  cursor: pointer;
}
.fruitback-thread-more-item:hover, .fruitback-thread-more-item:focus-visible { background: var(--fruitback-color-surface-sunken); }
.fruitback-thread-more-item:focus-visible { outline: 2px solid var(--fruitback-color-accent); outline-offset: -2px; }
/* FRU-702: « Delete the note » of a visitor, in the red of the accent: it takes the pin away. */
.fruitback-thread-more-item[data-fruitback-danger] { color: var(--fruitback-color-accent-strong); }
.fruitback-thread-withdraw-detail { margin: 0; font-size: 12px; color: var(--fruitback-color-text-muted); }
.fruitback-thread-more-said { margin: -6px 0 0; font-size: 12px; color: var(--fruitback-color-text-muted); }
.fruitback-thread-more-link {
  box-sizing: border-box;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--fruitback-color-border);
  border-radius: var(--fruitback-radius-sm);
  background: var(--fruitback-color-surface-sunken);
  color: var(--fruitback-color-text);
  font: 12px/1.4 var(--fruitback-font-mono);
}
@media (forced-colors: active) {
  .fruitback-thread-close, .fruitback-thread-link, .fruitback-thread-more { border-color: Canvas; }
  .fruitback-thread-more-menu { outline: 1px solid CanvasText; }
}
/*
  The conversation (FRU-696): the note, then its replies, each a message of the same shape, the round of
  who wrote it (22 px), their name and its age, and the text aligned under the name. 12 px around.
*/
.fruitback-thread-body { display: flex; flex-direction: column; gap: 12px; padding: 12px 12px 0; }
.fruitback-thread-message { display: flex; gap: 10px; }
/* anywhere: an address has no space, and it must wrap inside the thread instead of leaving it (FRU-154). */
.fruitback-thread-note { margin: 0; font-size: 13px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.fruitback-thread-meta { margin: 0; font-size: 12px; line-height: 1.4; color: var(--fruitback-color-text-muted); overflow-wrap: anywhere; }
/* What the note points at: the selector, then the component and the file, in mono (FRU-304). */
.fruitback-thread-files { margin: 0; font-size: 12px; color: var(--fruitback-color-text-muted); }
.fruitback-thread-files a { color: var(--fruitback-color-text); text-underline-offset: 2px; }
.fruitback-thread-files a:hover { color: var(--fruitback-color-accent-strong); }
.fruitback-thread-files a:focus-visible { outline: 2px solid var(--fruitback-color-accent); outline-offset: 2px; }
/*
  Discreet (FRU-419): lines of 12 px in mono, no box. Selectable, for a developer who copies a path.
*/
.fruitback-thread-source {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font: 12px/1.5 var(--fruitback-font-mono);
  color: var(--fruitback-color-text-muted);
  overflow-wrap: anywhere;
  user-select: text;
  -webkit-user-select: text;
}
.fruitback-thread-selector, .fruitback-thread-component { margin: 0; }
.fruitback-thread-orphan { margin: 0; font-size: 12px; color: var(--fruitback-color-warning); }
.fruitback-thread-answers { padding: 12px 12px 0; }
.fruitback-thread-replies {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
  /* A long conversation belongs in the store, which the link of the head goes to. */
  max-height: 180px;
  overflow-y: auto;
}
.fruitback-thread-replies:focus-visible {
  outline: 2px solid var(--fruitback-color-accent);
  outline-offset: 2px;
  border-radius: var(--fruitback-radius-sm);
}
/*
  On the item, not only on the list. The host reset gives every element all:initial, which resets each
  item's own list-style-type to its initial value of disc — and a reset value beats what it would have
  inherited from the list. The bullets came back, and only a recording showed it.
*/
.fruitback-thread-reply { display: flex; gap: 10px; flex: none; list-style: none; }
/* The initial of who wrote, in a round of 22 px (FRU-696): white on the chip, as the mock-up draws it. */
.fruitback-thread-reply-avatar {
  flex: none;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: var(--fruitback-radius-pill);
  background: var(--fruitback-color-chip);
  color: var(--fruitback-color-on-chip);
  font: 600 10px/1 var(--fruitback-font-sans);
}
.fruitback-thread-reply-text { display: flex; flex: 1 1 auto; flex-direction: column; gap: 2px; min-width: 0; }
.fruitback-thread-reply-who { margin: 0; font-size: 12px; line-height: 1.4; color: var(--fruitback-color-text-muted); overflow-wrap: anywhere; }
/* Who wrote is what the eye looks for in a conversation: the name is in the ink, the age is not. */
.fruitback-thread-reply-name { font-size: 13px; font-weight: 600; color: var(--fruitback-color-text); }
.fruitback-thread-reply-body { margin: 0; font-size: 13px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
/*
  « Technical details » (FRU-696), folded under the conversation: a summary of 24 px, the caret turned a
  quarter when open, then the lines of mono. A native fold: its summary takes the keyboard.
*/
.fruitback-thread-tech { display: block; margin: 8px 12px 0; }
.fruitback-thread-tech-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  width: fit-content;
  min-height: 24px;
  padding-inline: 2px 6px;
  border-radius: var(--fruitback-radius-sm);
  color: var(--fruitback-color-text-muted);
  font: 500 12px/1 var(--fruitback-font-sans);
  list-style: none;
  cursor: pointer;
}
.fruitback-thread-tech-summary::-webkit-details-marker { display: none; }
.fruitback-thread-tech-summary:hover { color: var(--fruitback-color-text); background: var(--fruitback-color-surface-sunken); }
.fruitback-thread-tech-summary:focus-visible { outline: 2px solid var(--fruitback-color-accent); outline-offset: 1px; }
.fruitback-thread-tech-summary .fruitback-icon { width: 12px; height: 12px; flex: none; }
.fruitback-thread-tech-caret { transition: transform var(--fruitback-duration-fast) var(--fruitback-ease-out); }
.fruitback-thread-tech[open] .fruitback-thread-tech-caret { transform: rotate(90deg); }
@media (prefers-reduced-motion: reduce) {
  .fruitback-thread-tech-caret { transition: none; }
}
.fruitback-thread-tech .fruitback-thread-source { padding: 6px 0 2px 20px; }
/* The edit of a note by its author (FRU-475): a quiet word under the text, then the text in a field. */
.fruitback-thread-edit-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: -6px; }
.fruitback-thread-edit, .fruitback-thread-edit-cancel {
  padding: 0;
  border: 0;
  background: none;
  font: 600 12px/1.5 var(--fruitback-font-sans);
  color: var(--fruitback-color-text-muted);
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.fruitback-thread-edit:hover, .fruitback-thread-edit-cancel:hover:not([disabled]) { color: var(--fruitback-color-text); }
.fruitback-thread-edit:focus-visible, .fruitback-thread-edit-cancel:focus-visible,
.fruitback-thread-edit-save:focus-visible {
  outline: 2px solid var(--fruitback-color-accent);
  outline-offset: 2px;
  border-radius: var(--fruitback-radius-sm);
}
.fruitback-thread-edit-form { display: flex; flex-direction: column; gap: 8px; }
.fruitback-thread-edit-field {
  min-height: 64px;
  max-height: 200px;
  resize: vertical;
  field-sizing: content;
  border: 1px solid var(--fruitback-color-border-strong);
  border-radius: var(--fruitback-radius-field);
  padding: 7px 10px;
  font: 14px/1.5 var(--fruitback-font-sans);
  background: var(--fruitback-color-surface);
  color: inherit;
  caret-color: var(--fruitback-color-accent);
}
.fruitback-thread-edit-field:focus-visible { outline: 2px solid var(--fruitback-color-accent); outline-offset: 1px; }
.fruitback-thread-edit-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.fruitback-thread-edit-save {
  display: inline-flex;
  align-items: center;
  height: 32px;
  padding: 0 14px;
  border: 0;
  border-radius: var(--fruitback-radius-field);
  background: var(--fruitback-color-accent);
  color: var(--fruitback-color-on-accent);
  font: 600 13px/1 var(--fruitback-font-sans);
  cursor: pointer;
}
.fruitback-thread-edit-save:hover:not([disabled]) { background: var(--fruitback-color-accent-strong); }
.fruitback-thread-edit-save[disabled], .fruitback-thread-edit-cancel[disabled] { opacity: 0.55; cursor: default; }
.fruitback-thread-edit-status { font-size: 12px; color: var(--fruitback-color-text-muted); }
/* FRU-701: where the new words go, at the start of the row of « Save », which keeps the end. */
.fruitback-thread-edit-sent { margin-inline-end: auto; font-size: 12px; color: var(--fruitback-color-text-muted); }
/* FRU-701: what a visitor known by their browser may do with their note, under it. */
.fruitback-thread-you-may { margin: 0; font-size: 12px; color: var(--fruitback-color-text-muted); }
.fruitback-thread-edit-status:empty { display: none; }
@media (pointer: coarse) {
  .fruitback-thread-edit-field { font-size: 16px; }
  .fruitback-thread-edit-save, .fruitback-thread-edit, .fruitback-thread-edit-cancel { min-height: 44px; }
  /* « Edit » is one short word (FRU-701: a visitor's note offers it in public mode too): 44 px wide to press. */
  .fruitback-thread-edit { min-width: 44px; text-align: start; }
}
/*
  The foot where a reader replies (FRU-257), on one line (FRU-696): a row of 34 px with the edge of a
  field, the field, then « Send » of 26 px inside it. The field grows with the text, to four lines; the
  button stays at its foot.
*/
.fruitback-thread-reply-form { display: block; padding: 12px; }
.fruitback-thread-reply-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  box-sizing: border-box;
  min-height: 34px;
  padding: 3px 3px 3px 10px;
  border: 1px solid var(--fruitback-color-border-strong);
  border-radius: var(--fruitback-radius-sm);
  background: var(--fruitback-color-surface);
}
.fruitback-thread-reply-row:focus-within { outline: 2px solid var(--fruitback-color-accent); outline-offset: 1px; }
.fruitback-thread-reply-field {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 26px;
  max-height: calc(4lh + 8px);
  box-sizing: border-box;
  resize: none;
  field-sizing: content;
  border: 0;
  outline: 0;
  padding: 4px 0;
  font: 13px/18px var(--fruitback-font-sans);
  background: transparent;
  color: inherit;
  caret-color: var(--fruitback-color-accent);
}
.fruitback-thread-reply-send {
  flex: none;
  display: inline-flex;
  align-items: center;
  height: 26px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--fruitback-radius-sm);
  background: var(--fruitback-color-accent);
  color: var(--fruitback-color-on-accent);
  font: 600 13px/1 var(--fruitback-font-sans);
  letter-spacing: -0.006em;
  cursor: pointer;
}
.fruitback-thread-reply-send:hover:not([disabled]) { background: var(--fruitback-color-accent-strong); }
.fruitback-thread-reply-send[disabled] { opacity: 0.55; cursor: default; }
.fruitback-thread-reply-status { display: block; margin-top: 6px; font-size: 12px; color: var(--fruitback-color-text-muted); }
.fruitback-thread-reply-status:empty { display: none; }
@media (pointer: coarse) {
  .fruitback-thread-reply-field { font-size: 16px; }
  .fruitback-thread-reply-send { min-height: 44px; }
}
/* FRU-603: a note the team marked done, and the verdict of its author. Its field and « Send » are the edit's. */
.fruitback-thread-agent a { color: var(--fruitback-color-text); }
.fruitback-thread-done, .fruitback-thread-agent { margin: 0; padding: 10px 12px 0; font: 600 12px/1.5 var(--fruitback-font-sans); color: var(--fruitback-color-text-muted); }
.fruitback-thread-agent { padding-bottom: 10px; }
.fruitback-thread-check { display: flex; flex-direction: column; gap: 10px; padding: 12px; border-top: 1px solid var(--fruitback-color-border); }
.fruitback-thread-check-ask, .fruitback-thread-withdraw-ask { margin: 0; font: 600 13px/1.4 var(--fruitback-font-sans); }
.fruitback-thread-check-actions, .fruitback-thread-check-form-actions, .fruitback-thread-withdraw-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.fruitback-thread-check-fixed, .fruitback-thread-check-wrong, .fruitback-thread-check-cancel,
.fruitback-thread-withdraw-confirm, .fruitback-thread-withdraw-keep {
  height: 32px;
  padding: 0 14px;
  border: 1px solid var(--fruitback-color-border-strong);
  border-radius: var(--fruitback-radius-field);
  background: var(--fruitback-color-surface);
  color: var(--fruitback-color-text);
  font: 600 13px/1 var(--fruitback-font-sans);
  cursor: pointer;
}
.fruitback-thread-check button:hover:not([disabled]), .fruitback-thread-check-wrong[aria-expanded='true'] { background: var(--fruitback-color-surface-sunken); }
.fruitback-thread-check .fruitback-thread-edit-save:hover:not([disabled]) { background: var(--fruitback-color-accent-strong); }
.fruitback-thread-check [disabled] { opacity: 0.55; cursor: default; }
.fruitback-thread-check button:focus-visible { outline: 2px solid var(--fruitback-color-accent); outline-offset: 2px; }
.fruitback-thread-check-status, .fruitback-thread-check-said { margin: 0; font-size: 12px; color: var(--fruitback-color-text-muted); }
.fruitback-thread-check-status:empty { display: none; }
.fruitback-thread-check-said { padding: 10px 12px 12px; border-top: 1px solid var(--fruitback-color-border); outline: none; }
@media (pointer: coarse) {
  .fruitback-thread-check button { min-height: 44px; }
}
/* « Withdraw this note? » under its text (FRU-605): asked before the note closes for the team. */
.fruitback-thread-withdraw {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--fruitback-color-border);
  border-radius: var(--fruitback-radius-sm);
  background: var(--fruitback-color-surface-sunken);
}
.fruitback-thread-withdraw-confirm { border-color: transparent; background: var(--fruitback-color-accent); color: var(--fruitback-color-on-accent); }
.fruitback-thread-withdraw-confirm:hover:not([disabled]) { background: var(--fruitback-color-accent-strong); }
.fruitback-thread-withdraw-keep:hover:not([disabled]) { background: var(--fruitback-color-surface-sunken); }
.fruitback-thread-withdraw [disabled] { opacity: 0.55; cursor: default; }
.fruitback-thread-withdraw button:focus-visible { outline: 2px solid var(--fruitback-color-accent); outline-offset: 2px; }
.fruitback-thread-withdraw-status, .fruitback-thread-withdraw-said { margin: 0; font-size: 12px; color: var(--fruitback-color-text-muted); outline: none; }
.fruitback-thread-withdraw-status:empty { display: none; }
@media (pointer: coarse) {
  .fruitback-thread-withdraw button { min-height: 44px; }
}
`;
