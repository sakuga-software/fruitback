// No backticks in here: one inside this literal closes it and the module stops parsing.
export const STYLES = `
.fruitback-panel-config {
  position: fixed;
  inset-inline-end: 16px;
  bottom: 84px;
  z-index: 2147483000;
  width: 320px;
  border: 1px solid var(--fruitback-color-border);
  border-radius: var(--fruitback-radius-lg);
  background: var(--fruitback-color-surface);
  color: var(--fruitback-color-text);
  font-size: 13px;
  line-height: 1.45;
  box-shadow: var(--fruitback-shadow-lg);
}
.fruitback-panel-config[hidden] { display: none; }
/* FRU-471: the settings fade in at each opening. Opacity only: their box does not move. */
.fruitback-panel-config:not([hidden]) { animation: fruitback-panel-in var(--fruitback-duration-fast) var(--fruitback-ease-out); }
@keyframes fruitback-panel-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
/* FRU-443: the settings open from the corner of the dock, above it or under it. */
:host([data-fruitback-position$='-right']) .fruitback-panel-config { right: 16px; left: auto; }
:host([data-fruitback-position$='-left']) .fruitback-panel-config { left: 16px; right: auto; }
:host([data-fruitback-position^='top-']) .fruitback-panel-config { top: 84px; bottom: auto; }
/* The head of the mock-up of 2026-10-20 (FRU-305): the drop in the accent, « Settings », the cross. */
.fruitback-config-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-block: 14px 12px;
  padding-inline: 16px 12px;
  border-bottom: 1px solid var(--fruitback-color-border);
}
.fruitback-config-title { display: flex; align-items: center; gap: 8px; font-weight: 600; letter-spacing: -0.006em; }
.fruitback-config-title .fruitback-icon { width: 11px; height: 14px; color: var(--fruitback-color-accent); }
/* The cross: 28 px drawn, 44 px to press, the margins give the difference back to the head. */
.fruitback-config-close {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  margin: -8px;
  border: 8px solid transparent;
  border-radius: calc(var(--fruitback-radius-sm) + 8px);
  background: none;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  color: var(--fruitback-color-text-muted);
}
.fruitback-config-close:hover { color: var(--fruitback-color-text); background: var(--fruitback-color-surface-sunken) padding-box; }
.fruitback-config-body { display: flex; flex-direction: column; padding: 14px 16px 12px; }
.fruitback-config-legend { margin: 0 0 6px; font-size: 12px; color: var(--fruitback-color-text-muted); }
/* « Pins shown »: a chip for each status, on as many lines as it takes. */
.fruitback-config-stages { display: flex; flex-wrap: wrap; gap: 0 8px; margin-bottom: 4px; }
/*
  A chip of 30 px, inside a transparent border that makes it 44 px to press. Its edge is an inset
  shadow, drawn inside that border: grey when the status is shown, the strong edge of a field and the
  sunken fill when it is.
*/
.fruitback-config-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 44px;
  padding: 0 10px;
  border: 7px solid transparent;
  border-inline-width: 0;
  border-radius: var(--fruitback-radius-pill);
  background: var(--fruitback-color-surface) padding-box;
  box-shadow: inset 0 0 0 1px var(--fruitback-color-border);
  font: 600 12px/1 var(--fruitback-font-sans);
  cursor: pointer;
}
.fruitback-config-chip:has(input:checked) {
  background: var(--fruitback-color-surface-sunken) padding-box;
  box-shadow: inset 0 0 0 1px var(--fruitback-color-border-strong);
}
.fruitback-config-chip:has(input:focus-visible) { outline: 2px solid var(--fruitback-color-accent); outline-offset: -5px; }
.fruitback-config-chip[hidden] { display: none; }
/*
  The box of a chip: out of sight over the whole chip, so a click on the chip is a click on the box,
  still in the order of the keyboard, and still named by the words of its chip.
*/
.fruitback-config-chip { position: relative; }
.fruitback-config-chip input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}
.fruitback-config-chip-drop {
  flex: none;
  width: 9px;
  height: 9px;
  border-radius: 50% 50% 50% 0;
  transform: rotate(-45deg);
  background: var(--fruitback-pin-color);
  box-shadow: 0 0 0 1px var(--fruitback-color-stage-edge);
}
/* A forced palette drops the fill and the shadow: the chip of a shown status is then its outline. */
@media (forced-colors: active) {
  .fruitback-config-chip { border-color: Canvas; outline: 1px solid GrayText; outline-offset: -8px; }
  .fruitback-config-chip:has(input:checked) { outline-color: Highlight; outline-width: 2px; }
}
/* A row of words and a switch at its end, 44 px tall: the whole row toggles it. */
.fruitback-config-check {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 44px;
  cursor: pointer;
}
.fruitback-config-check[hidden] { display: none; }
/*
  The switch of the mock-up: 36 × 20, a knob of 16 px, the ink when on. Off, it takes the edge of a
  field and not the light grey of the mock-up: 1.48:1 on the surface would not show where it is (3.42:1).
*/
.fruitback-config-check input {
  appearance: none;
  -webkit-appearance: none;
  flex: none;
  position: relative;
  width: 36px;
  height: 20px;
  margin: 0;
  border-radius: var(--fruitback-radius-pill);
  background: var(--fruitback-color-border-strong);
  cursor: pointer;
  transition: background var(--fruitback-duration-fast) var(--fruitback-ease-out);
}
.fruitback-config-check input::before {
  content: '';
  position: absolute;
  top: 2px;
  inset-inline-start: 2px;
  width: 16px;
  height: 16px;
  border-radius: var(--fruitback-radius-pill);
  background: var(--fruitback-color-surface);
  box-shadow: var(--fruitback-shadow-xs);
  transition: transform var(--fruitback-duration-fast) var(--fruitback-ease-out);
}
.fruitback-config-check input:checked { background: var(--fruitback-color-text); }
.fruitback-config-check input:checked::before { transform: translateX(16px); }
.fruitback-config-check input:checked:dir(rtl)::before { transform: translateX(-16px); }
.fruitback-config-check input:focus-visible { outline: 2px solid var(--fruitback-color-accent); outline-offset: 2px; }
@media (forced-colors: active) {
  .fruitback-config-check input { border: 1px solid ButtonText; }
  .fruitback-config-check input::before { background: ButtonText; }
  .fruitback-config-check input:checked { background: Highlight; }
}
@media (prefers-reduced-motion: reduce) {
  .fruitback-config-check input, .fruitback-config-check input::before { transition: none; }
  .fruitback-panel-config:not([hidden]) { animation: none; }
}
/*
  FRU-472: the four corners, in a square laid out left to right whatever the reading direction. Each
  is a chip of 36 px in a target of 44 px, like a status, with a drawing of the window and its corner.
*/
.fruitback-config-legend:not(:first-child) { margin-top: 10px; }
.fruitback-config-corners {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 8px;
  direction: ltr;
}
.fruitback-config-corner {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 44px;
  padding: 0 10px;
  border: 4px solid transparent;
  border-inline-width: 0;
  border-radius: var(--fruitback-radius-md);
  background: var(--fruitback-color-surface) padding-box;
  box-shadow: inset 0 0 0 1px var(--fruitback-color-border);
  font: 600 12px/1.2 var(--fruitback-font-sans);
  cursor: pointer;
}
.fruitback-config-corner:has(input:checked) {
  background: var(--fruitback-color-surface-sunken) padding-box;
  box-shadow: inset 0 0 0 1px var(--fruitback-color-border-strong);
}
.fruitback-config-corner:has(input:focus-visible) { outline: 2px solid var(--fruitback-color-accent); outline-offset: -2px; }
.fruitback-config-corner input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}
/* The window, and a dot in its corner: the ink when chosen, the muted text otherwise. */
.fruitback-config-corner-drawing {
  flex: none;
  position: relative;
  width: 16px;
  height: 12px;
  border: 1.5px solid var(--fruitback-color-text-muted);
  border-radius: 3px;
}
.fruitback-config-corner-drawing::after {
  content: '';
  position: absolute;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--fruitback-color-text-muted);
}
.fruitback-config-corner:has(input:checked) .fruitback-config-corner-drawing { border-color: var(--fruitback-color-text); }
.fruitback-config-corner:has(input:checked) .fruitback-config-corner-drawing::after { background: var(--fruitback-color-accent); }
.fruitback-config-corner-drawing[data-fruitback-corner^='top-']::after { top: 1px; }
.fruitback-config-corner-drawing[data-fruitback-corner^='bottom-']::after { bottom: 1px; }
.fruitback-config-corner-drawing[data-fruitback-corner$='-left']::after { left: 1px; }
.fruitback-config-corner-drawing[data-fruitback-corner$='-right']::after { right: 1px; }
@media (forced-colors: active) {
  .fruitback-config-corner { border-color: Canvas; outline: 1px solid GrayText; outline-offset: -5px; }
  .fruitback-config-corner:has(input:checked) { outline-color: Highlight; outline-width: 2px; }
  .fruitback-config-corner-drawing { border-color: CanvasText; }
  .fruitback-config-corner-drawing::after { background: CanvasText; }
}
.fruitback-config-copy {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 16px 14px;
  border-top: 1px solid var(--fruitback-color-border);
}
.fruitback-config-copy-button {
  min-height: 36px;
  border: 1px solid var(--fruitback-color-border-strong);
  border-radius: var(--fruitback-radius-pill);
  padding: 6px 12px;
  background: none;
  color: var(--fruitback-color-text);
  font: 600 12px/1 var(--fruitback-font-sans);
  cursor: pointer;
}
.fruitback-config-copy-status { font-size: 12px; color: var(--fruitback-color-text-muted); }
.fruitback-config-copy-text {
  display: block;
  box-sizing: border-box;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--fruitback-color-border-strong);
  border-radius: var(--fruitback-radius-sm);
  background: var(--fruitback-color-surface);
  color: inherit;
  font: 11px/1.4 ui-monospace, monospace;
  resize: vertical;
}
@media (max-width: 480px) {
  .fruitback-panel-config { inset-inline: 8px; width: auto; }
  :host([data-fruitback-position]) .fruitback-panel-config { left: 8px; right: 8px; }
}
/* A thumb, not a pointer (FRU-157): the copy button is 44 px. */
@media (pointer: coarse) {
  .fruitback-config-copy-button { min-height: 44px; }
}
`;
