import { GROUND_INK } from './page-ground.ts';
/**
 * `all: initial` on every element, because a Shadow root stops the page's *selectors* but not its
 * inherited properties: `body { font-family: Papyrus }` reaches in here otherwise.
 */
export const STYLES = `
:host { all: initial; }
/*
  The reset stops at the edge of an SVG, and that exclusion is load-bearing rather than tidy. Under a
  plain star selector, a path computes d:none and stroke:none — the geometry itself is a CSS property
  since SVG2, so all:initial erases the drawing. Every icon renders as an empty box, with no error
  anywhere. Measured in Chromium before this was written (FRU-36).
*/
*:not(svg, svg *) { all: initial; box-sizing: border-box; color: inherit; font: inherit; letter-spacing: inherit; overflow-wrap: inherit; white-space: inherit; }
/*
  all:initial also stops inheritance. Without the three inherit values above, an element with no colour
  rule of its own is black at 16px: the launch label on a chip, and the thread and the panel on a dark
  surface, where axe measured 1.2 to 1 (FRU-51). The host gives the first values to inherit.

  The two wrap values inherit for the same reason (FRU-350). Without them every element starts at
  overflow-wrap:normal: an address or a long name with no space ran out of its box wherever a rule
  of the parent had asked for anywhere, and a nowrap on a button stopped at the span of its words.
*/
:host { color: var(--fruitback-color-text); font: 14px/1.45 var(--fruitback-font-sans); overflow-wrap: anywhere; }
/*
  The rule of the text, in two halves (FRU-350). Content wraps anywhere, so an address, a file path
  or a long word never runs past its box: :host above gives it to every element. A label never
  breaks inside its words: a button, a switch, a tab and a key stay on one line, and what they hold
  inherits it. The few buttons that hold a note, the rows of a list, say white-space: normal in their
  own module. A field keeps the line breaks its writer typed, as the browser draws it.
*/
button, [role='switch'], [role='tab'], kbd { white-space: nowrap; }
textarea { white-space: pre-wrap; }
/*
  all:initial is thorough enough to undo the browser's own display:none on a style element, which
  then renders the stylesheet as a column of visible text in the corner of the client's page. Found
  by looking at it; no unit test would have, since happy-dom draws nothing.
*/
style, script { display: none; }
/* The reset also removes the focus ring. The keyboard reaches these controls, so they must show focus (FRU-51). */
button:focus-visible, a:focus-visible, input:focus-visible, textarea:focus-visible {
  outline: 2px solid var(--fruitback-color-accent);
  outline-offset: 2px;
}
/*
  And it undoes the browser's display:block on every block element, so a paragraph is inline until
  something says otherwise: in the note thread the note, its byline and the "found by position"
  warning all ran together into one line, vertical margins silently doing nothing. Restoring it here
  rather than on each class is what keeps the next element added to the widget from inheriting the
  same surprise. Found by looking at a recording — every unit test passed. A list was missing from
  this rule until FRU-154: the replies of a thread were inline, so their height limit, their scroll
  and their indent did nothing.
*/
div, p, header, footer, section, form, ul, ol { display: block; }
li { display: list-item; }
/*
  Every glyph in the widget, and this rule sizes them and nothing else. The paint is on the paths
  themselves, because a fill declared here would be a class selector beating the presentation
  attribute Phosphor ships its icons with — every imported icon would render in the wrong colour, or
  not at all. Size in em so an icon is as big as the text beside it, which is the whole reason these
  are SVG and not characters: an emoji obeys neither the size nor the colour.
*/
.fruitback-icon {
  display: inline-block;
  width: 1em;
  height: 1em;
  /* A flex item shrinks by default, and a squashed icon reads as a rendering bug. */
  flex: none;
  overflow: hidden;
}
/*
  The dock of the mock-up of 2026-10-20 (FRU-303): one capsule, 24 px from the corner, on the surface.
  Every control in it is 44 px tall, and draws a smaller shape inside a transparent border: 36 px for
  the round ones and the way out, 40 px for the launch button. The capsule is then the 52 px of the
  mock-up, and a target is never under 44 px.
*/
.fruitback-dock {
  position: fixed;
  inset-inline-end: 24px;
  bottom: 24px;
  z-index: 2147483200;
  display: flex;
  align-items: center;
  max-width: calc(100vw - 48px);
  padding-block: 3px;
  padding-inline: 1px 3px;
  border: 1px solid var(--fruitback-color-border);
  border-radius: var(--fruitback-radius-pill);
  background: var(--fruitback-color-surface);
  box-shadow: var(--fruitback-shadow-md);
}
/*
  FRU-471: the dock fades in when the widget mounts, and when it comes back after the list. Opacity
  only: its box is where the specs and the person expect it from the first frame.
*/
.fruitback-dock { animation: fruitback-dock-in var(--fruitback-duration-fast) var(--fruitback-ease-out) both; }
@keyframes fruitback-dock-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
/* A press of a button of the dock gives way a little, and comes back. */
.fruitback-dock button { transition: transform var(--fruitback-duration-fast) var(--fruitback-ease-out); }
.fruitback-dock button:active:not([aria-disabled='true']) { transform: scale(0.96); }
@media (prefers-reduced-motion: reduce) {
  .fruitback-dock { animation: none; }
  .fruitback-dock button { transition: none; }
  .fruitback-dock button:active:not([aria-disabled='true']) { transform: none; }
}
/*
  FRU-632: every button of the widget answers the pointer. Its colours ease in 120 ms, a press gives
  way to 97 % and comes back, and a chevron turns. All the parts of the widget are in this root.
  The selector :where keeps the specificity at zero: a rule of a part that sets its own transition or transform wins.
*/
:where(.fruitback-composer, .fruitback-thread, .fruitback-sidebar, .fruitback-panel-config, .fruitback-area-bar,
  .fruitback-orphans, .fruitback-banner) button {
  transition:
    background-color 120ms ease,
    border-color 120ms ease,
    color 120ms ease,
    box-shadow 120ms ease,
    transform var(--fruitback-duration-fast) var(--fruitback-ease-out);
}
:where(.fruitback-composer, .fruitback-thread, .fruitback-sidebar, .fruitback-panel-config, .fruitback-area-bar,
  .fruitback-orphans, .fruitback-banner) button:where(:active:not([disabled], [aria-disabled='true'])) {
  transform: scale(0.97);
}
:where(.fruitback-composer, .fruitback-thread, .fruitback-sidebar, .fruitback-panel-config) button .fruitback-icon {
  transition: transform var(--fruitback-duration-fast) var(--fruitback-ease-out);
}
@media (prefers-reduced-motion: reduce) {
  :where(.fruitback-composer, .fruitback-thread, .fruitback-sidebar, .fruitback-panel-config, .fruitback-area-bar,
    .fruitback-orphans, .fruitback-banner) button,
  :where(.fruitback-composer, .fruitback-thread, .fruitback-sidebar, .fruitback-panel-config) button .fruitback-icon {
    transition: none;
  }
  :where(.fruitback-composer, .fruitback-thread, .fruitback-sidebar, .fruitback-panel-config, .fruitback-area-bar,
    .fruitback-orphans, .fruitback-banner) button:where(:active) {
    transform: none;
  }
}
/*
  FRU-443: a corner that was chosen is a corner of the window, whatever the direction of the page.
  The settings and the list of the detached notes open from the dock: see panel.ts and orphans.ts.
*/
:host([data-fruitback-position$='-right']) .fruitback-dock { right: 24px; left: auto; }
:host([data-fruitback-position$='-left']) .fruitback-dock { left: 24px; right: auto; }
:host([data-fruitback-position^='top-']) .fruitback-dock { top: 24px; bottom: auto; }
.fruitback-launch {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 44px;
  margin-inline-start: 2px;
  padding-inline: 14px 18px;
  border: 2px solid transparent;
  border-radius: var(--fruitback-radius-pill);
  background: var(--fruitback-color-accent) padding-box;
  color: var(--fruitback-color-on-accent);
  /* Tightened tracking rather than a smaller size: the label is the widget's only voice on the
     page, and shrinking it is how a control starts looking like an advert. */
  font: 600 13px/1 var(--fruitback-font-sans);
  letter-spacing: -0.006em;
  white-space: nowrap;
  cursor: pointer;
}
/* The drop of the mark, 14 px tall and narrower than tall, as the mock-up draws it. */
.fruitback-launch .fruitback-icon { width: 11px; height: 14px; }
.fruitback-launch:hover { background: var(--fruitback-color-accent-strong) padding-box; }
/* A site whose notes are « Members only », for a reader with no session (FRU-330): the pill of a chip,
   which offers nothing. */
.fruitback-launch[aria-disabled='true'],
.fruitback-launch[aria-disabled='true']:hover {
  background: var(--fruitback-color-chip) padding-box;
  color: var(--fruitback-color-on-chip);
  cursor: default;
}
.fruitback-configure,
.fruitback-listing {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border: 4px solid transparent;
  border-radius: var(--fruitback-radius-pill);
  background: transparent;
  color: var(--fruitback-color-text-subtle);
  font: 600 18px/1 var(--fruitback-font-sans);
  cursor: pointer;
}
/* The gear is drawn 1 px smaller than the list, as in the mock-up. */
.fruitback-configure { font-size: 17px; }
.fruitback-configure:hover,
.fruitback-listing:hover { background: var(--fruitback-color-surface-sunken) padding-box; }
.fruitback-listing { position: relative; }
/* The dot of a read that failed (FRU-316), on the corner of the round shape, ringed by the surface
   of the capsule so it reads on the icon. */
.fruitback-listing-alert {
  position: absolute;
  top: 2px;
  inset-inline-end: 2px;
  width: 10px;
  height: 10px;
  border-radius: var(--fruitback-radius-pill);
  background: var(--fruitback-color-accent);
  box-shadow: 0 0 0 2px var(--fruitback-color-surface);
}
.fruitback-listing-alert[hidden] { display: none; }
@media (forced-colors: active) {
  .fruitback-listing-alert { background: Mark; box-shadow: none; outline: 1px solid CanvasText; }
}
/*
  The frame of a capture (FRU-303): a line of 2 px, 3 px off the element, as an outline draws it, and
  nothing over the element itself. A tint hid the colour the reporter is writing about.
*/
.fruitback-highlight {
  position: absolute;
  display: none;
  z-index: 2147483100;
  /* The reporter is aiming at the page, not at this box. */
  pointer-events: none;
  border: 2px solid var(--fruitback-color-accent);
  border-radius: var(--fruitback-radius-sm);
}
/*
  What the note will point at, centred above the frame: « button.add · <AddToCart> », in the mono of
  a selector. Centred with the physical left, because the middle has no side.
*/
.fruitback-highlight-tag {
  position: absolute;
  /* The reset gives every element its pointer back: the name must not take a click the page needs. */
  pointer-events: none;
  left: 50%;
  top: -28px;
  transform: translateX(-50%);
  max-width: min(320px, 90vw);
  padding: 3px 8px;
  border-radius: var(--fruitback-radius-sm);
  background: var(--fruitback-color-accent);
  color: var(--fruitback-color-on-accent);
  font: 600 11px/1.5 var(--fruitback-font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fruitback-highlight-tag[hidden] { display: none; }
/*
  The ground of the page (FRU-611, P7, page-ground.ts). Dark: the frame takes a light halo, so it
  reads on the page and not only on the element. Faint, a red site: the frame and its name take the
  ink with a white contour, as the red would vanish there.
*/
:host([data-fruitback-ground="dark"]) .fruitback-highlight { box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.55); }
:host([data-fruitback-faint]) .fruitback-highlight {
  border-color: ${GROUND_INK};
  box-shadow: 0 0 0 2px #ffffff;
}
:host([data-fruitback-faint]) .fruitback-highlight-tag {
  background: ${GROUND_INK};
  color: #ffffff;
  box-shadow: 0 0 0 1px #ffffff;
}
.fruitback-highlight[data-fruitback-tag-inside] .fruitback-highlight-tag { top: 2px; }
/*
  The banner of a capture (FRU-303) lives in the capsule. Empty at rest, and still in the tree: no
  box, no paint, and a live region that a screen reader already knows.
*/
.fruitback-banner { display: flex; align-items: center; min-width: 0; }
.fruitback-banner-ask {
  flex: 1 1 auto;
  min-width: 0;
  max-width: 240px;
  padding-inline: 12px 10px;
  color: var(--fruitback-color-on-ink-muted);
  font: 12px/1.35 var(--fruitback-font-sans);
}
/* Read, not drawn: how a keyboard moves. */
.fruitback-banner-keys {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.fruitback-banner-stop {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 44px;
  padding: 0 14px;
  border: 4px solid transparent;
  border-radius: calc(var(--fruitback-radius-md) + 4px);
  background: var(--fruitback-color-chip) padding-box;
  color: var(--fruitback-color-on-chip);
  font: 600 13px/1 var(--fruitback-font-sans);
  white-space: nowrap;
  cursor: pointer;
}
/* The key, drawn as a key: a border, and a bottom of 2 px. */
.fruitback-banner-key {
  display: inline-block;
  padding: 2px 5px;
  border: 1px solid var(--fruitback-color-on-ink-muted);
  border-bottom-width: 2px;
  border-radius: calc(var(--fruitback-radius-sm) - 2px);
  font: 700 11px/1 var(--fruitback-font-sans);
}
/*
  While a capture runs, the capsule is the ink of the mock-up, in both schemes: it lies on the page of
  the host. It holds only the banner: the launch button, the list and the gear stand aside.
*/
:host([data-fruitback-capturing]) .fruitback-dock {
  /* 46 px tall, as the mock-up draws it: the way out is the one control left. */
  padding-block: 0;
  padding-inline-end: 1px;
  border-color: var(--fruitback-color-ink);
  background: var(--fruitback-color-ink);
  color: var(--fruitback-color-on-ink);
}
:host([data-fruitback-capturing]) .fruitback-dock > :not(.fruitback-banner) { display: none; }
/*
  FRU-351: while a capture of the page or of an area is taken, the pins, their tooltips, the open
  thread and the frame of the element are not on the page: the file shows the page only.
*/
:host([data-fruitback-shooting]) .fruitback-overlay,
:host([data-fruitback-shooting]) .fruitback-overlay *,
:host([data-fruitback-shooting]) .fruitback-highlight,
:host([data-fruitback-shooting]) .fruitback-highlight * { visibility: hidden !important; }
/*
  A forced palette paints every border, a transparent one too, and drops the fills: the shape of a
  control is then a line of the system's colours, inside the border that makes its target 44 px.
*/
@media (forced-colors: active) {
  .fruitback-launch,
  .fruitback-configure,
  .fruitback-listing,
  .fruitback-banner-stop { border-color: Canvas; }
  .fruitback-launch,
  .fruitback-banner-stop { outline: 1px solid ButtonText; outline-offset: -3px; }
}
.fruitback-panel { position: absolute; top: 0; left: 0; }
.fruitback-announcer {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
/*
  The dock stands aside while the list of the page is open (FRU-259), as the mock-up draws it: the
  list covers this corner, and holds its own button to leave a note and its own cross.
*/
:host([data-fruitback-listing]) .fruitback-dock { display: none; }
`;
