// No backticks in here: one inside this literal closes it and the module stops parsing. It has
// happened four times in this repo.
export const STYLES = `
.fruitback-orphans {
  position: fixed;
  /*
    Alone, stacked above the corner of the dock rather than in the opposite corner. Claiming a second
    corner of someone else's page is how a widget ends up on top of their cookie banner or their
    support chat. In the capsule (FRU-303) it is not fixed at all: see below.
  */
  inset-inline-end: 16px;
  bottom: 84px;
  z-index: 2147483000;
  max-width: 300px;
  font: 13px/1.45 var(--fruitback-font-sans);
  color: var(--fruitback-color-text);
}
.fruitback-orphans[hidden] { display: none; }
/* FRU-443: above the corner of the dock, or under it at the top of the window. */
:host([data-fruitback-position$='-right']) .fruitback-orphans:not([data-fruitback-docked]) { right: 16px; left: auto; }
:host([data-fruitback-position$='-left']) .fruitback-orphans:not([data-fruitback-docked]) { left: 16px; right: auto; align-items: flex-start; }
:host([data-fruitback-position^='top-']) .fruitback-orphans:not([data-fruitback-docked]) { top: 84px; bottom: auto; flex-direction: column; }
.fruitback-orphans-announcer {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
/* Chip last in the DOM order it reads in, list above it on screen. */
.fruitback-orphans { display: flex; flex-direction: column-reverse; align-items: flex-end; }
.fruitback-orphans-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border: 0;
  border-radius: var(--fruitback-radius-field);
  /* The grey of a note whose element is gone, and white on it (FRU-334). */
  --fruitback-pin-color: var(--fruitback-color-unplaced);
  background: var(--fruitback-pin-color);
  color: var(--fruitback-color-on-stage);
  font: 600 12px/1 var(--fruitback-font-sans);
  box-shadow: var(--fruitback-shadow-md);
  cursor: pointer;
}
/*
  In the capsule of the dock (FRU-303): its first control, 44 px tall like the others, with the
  grey chip of 36 px (FRU-334) inside a transparent border. The list opens above the capsule.
  The radius adds the border: the corner drawn is 10 px, as on « Stop » (FRU-632).
*/
.fruitback-orphans[data-fruitback-docked] { position: relative; inset: auto; z-index: auto; max-width: none; }
.fruitback-orphans[data-fruitback-docked] .fruitback-orphans-toggle {
  gap: 7px;
  height: 44px;
  padding-inline: 12px 14px;
  border: 4px solid transparent;
  border-radius: calc(var(--fruitback-radius-md) + 4px);
  background: var(--fruitback-pin-color) padding-box;
  font-size: 13px;
  letter-spacing: -0.006em;
  white-space: nowrap;
  box-shadow: none;
}
.fruitback-orphans-toggle .fruitback-icon { width: 13px; height: 13px; }
.fruitback-orphans[data-fruitback-docked] .fruitback-orphans-list {
  position: absolute;
  bottom: calc(100% + 12px);
  inset-inline-end: 0;
  width: max-content;
  max-width: min(300px, calc(100vw - 48px));
  /*
    No higher than the room above the capsule: 24 px under it, 52 px of capsule, 12 px of gap, and
    16 px left at the top of the window. A low window scrolls the list, and never pushes it out.
    Never under one row of 44 px either: a window lower than that has no room for any list.
  */
  max-height: max(44px, min(220px, calc(100vh - 104px)));
  margin: 0;
}
/* FRU-443: a dock at the top of the window opens its list under it, and on its side. */
:host([data-fruitback-position^='top-']) .fruitback-orphans[data-fruitback-docked] .fruitback-orphans-list {
  top: calc(100% + 12px);
  bottom: auto;
}
:host([data-fruitback-position$='-left']) .fruitback-orphans[data-fruitback-docked] .fruitback-orphans-list {
  left: 0;
  right: auto;
}
:host([data-fruitback-position$='-right']) .fruitback-orphans[data-fruitback-docked] .fruitback-orphans-list {
  right: 0;
  left: auto;
}
@media (forced-colors: active) {
  .fruitback-orphans-toggle { border-color: Canvas; outline: 1px solid ButtonText; outline-offset: -5px; }
}
.fruitback-orphans-list {
  display: block;
  /* Above the chip: it sits at the bottom of the page, so a list below it would have nowhere to go. */
  margin: 0 0 8px;
  padding: 8px;
  border-radius: var(--fruitback-radius-md);
  background: var(--fruitback-color-surface);
  box-shadow: var(--fruitback-shadow-lg);
  list-style: none;
  max-height: 220px;
  overflow-y: auto;
}
.fruitback-orphans-list[hidden] { display: none; }
.fruitback-orphans-item { display: flex; align-items: baseline; gap: 6px; list-style: none; }
.fruitback-orphans-stage { color: var(--fruitback-pin-color); font-size: 11px; }
/*
  The edge of a drop (FRU-334): the grey of « to do » is 1.39:1 on the surface, its edge 3.42:1. Drawn
  under the fill (paint-order), so it never covers the colour of the status: only its outer half
  shows, 1.5 of the 16 units of the drop, about 1 px at 11 px. Round joins, so the point of the drop
  stays inside the box of the icon; and the box does not clip what is left.
*/
.fruitback-orphans-stage { overflow: visible; }
.fruitback-orphans-stage path {
  stroke: var(--fruitback-color-stage-edge);
  stroke-width: 3px;
  stroke-linejoin: round;
  paint-order: stroke;
}
.fruitback-orphans-item + .fruitback-orphans-item { margin-top: 6px; }
.fruitback-orphans-note {
  flex: 1;
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  color: inherit;
  text-align: start;
  /* A button that holds a note: its words wrap, against the rule of the labels (FRU-350). */
  white-space: normal;
  cursor: pointer;
}
.fruitback-orphans-link {
  font-size: 11px;
  color: var(--fruitback-color-accent);
  text-decoration: none;
  white-space: nowrap;
}
`;
