/** The width of the mock-up (FRU-258): `place` clamps against it, so the stylesheet uses it too. */
export const WIDTH = 360;
/** The space between « Attach » and its menu. */
export const MENU_GAP = 4;

/**
 * The composer of the mock-up of 2026-10-13 (FRU-258): a head, the note, a foot behind a rule.
 * `prefers-reduced-motion` turns the animation off rather than shortening it — a widget that
 * overlays someone else's site is the last thing that should ignore that setting.
 */
export const STYLES = `
.fruitback-composer {
  position: absolute;
  border: 1px solid var(--fruitback-color-border);
  /* WIDTH is what place() clamps against, so the rendered box has to be exactly that. Set here
     rather than inherited from the host's reset: this file has to hold up wherever it is mounted. */
  box-sizing: border-box;
  left: var(--fruitback-composer-left, 0px);
  top: var(--fruitback-composer-top, 0px);
  z-index: 2147483300;
  width: ${WIDTH}px;
  border-radius: var(--fruitback-radius-lg);
  background: var(--fruitback-color-surface);
  color: var(--fruitback-color-text);
  font: 14px/1.5 var(--fruitback-font-sans);
  box-shadow: var(--fruitback-shadow-xl);
  /* The curve and the time of the mock-up (FRU-233): it arrives fast and settles, with no overshoot.
     It grows from the corner nearest to its element. */
  animation: fruitback-composer-in var(--fruitback-duration-slow) var(--fruitback-ease-out) both;
  transform-origin: bottom left;
}
.fruitback-composer:dir(rtl) { transform-origin: bottom right; }
.fruitback-composer[data-fruitback-side="below"] { animation-name: fruitback-composer-down; transform-origin: top left; }
.fruitback-composer[data-fruitback-side="below"]:dir(rtl) { transform-origin: top right; }
/* Beside its element (FRU-607), it grows from the top corner on the side of the element. */
.fruitback-composer[data-fruitback-side="right"] { animation-name: fruitback-composer-from-left; transform-origin: top left; }
.fruitback-composer[data-fruitback-side="left"] { animation-name: fruitback-composer-from-right; transform-origin: top right; }
/*
  The tether (FRU-607): a line of 2 px from the edge of the composer to the frame of its element, at
  the middle of the element. place() sets where it meets the edge and how long it is.
*/
.fruitback-composer-tether {
  position: absolute;
  display: block;
  background: var(--fruitback-color-accent);
  pointer-events: none;
}
.fruitback-composer[data-fruitback-side="right"] .fruitback-composer-tether,
.fruitback-composer[data-fruitback-side="left"] .fruitback-composer-tether {
  /* Less the border of the composer, which the offset counts and the containing block does not, and half the line. */
  top: calc(var(--fruitback-composer-tether, 24px) - 2px);
  width: var(--fruitback-composer-tether-length, 16px);
  height: 2px;
}
.fruitback-composer[data-fruitback-side="right"] .fruitback-composer-tether { right: calc(100% + 1px); }
.fruitback-composer[data-fruitback-side="left"] .fruitback-composer-tether { left: calc(100% + 1px); }
.fruitback-composer[data-fruitback-side="below"] .fruitback-composer-tether,
.fruitback-composer[data-fruitback-side="above"] .fruitback-composer-tether {
  width: 2px;
  height: var(--fruitback-composer-tether-length, 10px);
}
.fruitback-composer[data-fruitback-side="below"] .fruitback-composer-tether { bottom: calc(100% + 1px); left: calc(var(--fruitback-composer-tether, 24px) - 2px); }
.fruitback-composer[data-fruitback-side="above"] .fruitback-composer-tether { top: calc(100% + 1px); left: calc(var(--fruitback-composer-tether, 24px) - 2px); }
.fruitback-composer:not([data-fruitback-side]) .fruitback-composer-tether { display: none; }
@media (forced-colors: active) {
  .fruitback-composer-tether { background: CanvasText; }
}
/* Words for a screen reader only: the name of an icon, the whole path of a place. */
.fruitback-composer-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
.fruitback-composer[hidden] { display: none; }
/* A shadow is not drawn in forced colours: the composer then needs an edge of its own. */
@media (forced-colors: active) {
  .fruitback-composer { outline: 1px solid CanvasText; }
}
.fruitback-composer-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-block: 12px;
  padding-inline: 14px 12px;
  border-bottom: 1px solid var(--fruitback-color-border);
  border-start-start-radius: var(--fruitback-radius-lg);
  border-start-end-radius: var(--fruitback-radius-lg);
  background: var(--fruitback-color-surface-warm);
}
/* The drop of a new note, in the colour of « new »: the pin this note will be. */
.fruitback-composer-drop {
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 50% 50% 50% 0;
  transform: rotate(-45deg);
  background: var(--fruitback-stage-new);
  box-shadow: 0 0 0 1px var(--fruitback-color-stage-edge);
}
/*
  What the note points at, on one line: the words of the element, « €29 / month » (FRU-607), or its
  selector in mono, on request (FRU-411).
*/
.fruitback-composer-about {
  flex: 1;
  min-width: 0;
  font: 600 13px/1.5 var(--fruitback-font-sans);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fruitback-composer-about[data-fruitback-selector] { font: 12px/1.5 var(--fruitback-font-mono); }
/* « Choose another element »: a word in a chip, 44 px to press, the margins give the difference back to the head. */
.fruitback-composer-pick {
  flex: none;
  margin-block: -9px;
  padding: 4px 6px;
  border: 9px solid transparent;
  border-inline-width: 0;
  border-radius: var(--fruitback-radius-sm);
  background: transparent;
  color: var(--fruitback-color-text-muted);
  font: 600 12px/1.5 var(--fruitback-font-sans);
  cursor: pointer;
}
.fruitback-composer-pick:hover { background: var(--fruitback-color-surface-sunken) padding-box; color: var(--fruitback-color-text); }
.fruitback-composer-pick[hidden] { display: none; }
.fruitback-composer-body { display: flex; flex-direction: column; gap: 12px; padding: 14px; }
/* A label above its field, as the mock-up writes « Your comment » and « Name (optional) ». */
.fruitback-composer-field { display: flex; flex-direction: column; gap: 6px; }
.fruitback-composer-label { font-size: 12px; color: var(--fruitback-color-text-muted); }
/*
  The field (FRU-607): one box that holds the note, then its files, then a row of icons with the
  signature at its end. The box takes the edge and the focus ring; the text area inside draws none.
*/
.fruitback-composer-box {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--fruitback-color-border-strong);
  border-radius: var(--fruitback-radius-sm);
  background: var(--fruitback-color-surface);
}
.fruitback-composer-box:focus-within:has(textarea:focus-visible) { outline: 2px solid var(--fruitback-color-accent); outline-offset: 2px; }
.fruitback-composer-box[data-fruitback-dragging] { border-color: var(--fruitback-color-accent); background: var(--fruitback-color-surface-sunken); }
.fruitback-composer textarea {
  display: block;
  box-sizing: border-box;
  width: 100%;
  min-height: 96px;
  /* fitField() grows it with its text up to 150 px, then it scrolls (FRU-611, P7). */
  max-height: 150px;
  overflow-y: auto;
  border: 0;
  border-radius: var(--fruitback-radius-sm);
  padding: 10px 12px;
  font: 14px/1.5 var(--fruitback-font-sans);
  resize: none;
  background: transparent;
  color: inherit;
  caret-color: var(--fruitback-color-accent);
}
.fruitback-composer textarea:focus-visible { outline: 0; }
/* More text below the fold of the field: it fades out at the foot. */
.fruitback-composer textarea[data-fruitback-more] {
  -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 24px), transparent);
  mask-image: linear-gradient(to bottom, #000 calc(100% - 24px), transparent);
}
/* The row of icons at the foot of the field, and the avatar at its end. */
.fruitback-composer-tools {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px 6px 6px;
}
.fruitback-composer-tools[hidden] { display: none; }
.fruitback-composer-tool {
  position: relative;
  display: inline-grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: var(--fruitback-radius-sm);
  background: transparent;
  color: var(--fruitback-color-text-muted);
  cursor: pointer;
}
.fruitback-composer-tool .fruitback-icon { width: 18px; height: 18px; }
.fruitback-composer-tool:hover:not([disabled]):not([aria-disabled="true"]) { background: var(--fruitback-color-surface-sunken); color: var(--fruitback-color-text); }
.fruitback-composer-tool:focus-visible, .fruitback-composer-toggle:has(input:focus-visible) { outline: 2px solid var(--fruitback-color-accent); outline-offset: 1px; }
.fruitback-composer-tool[disabled], .fruitback-composer-tool[aria-disabled="true"] { opacity: 0.55; cursor: default; }
.fruitback-composer-tool[hidden] { display: none; }
/* The picture of the element is a box, drawn as an icon that is lit while it is ticked. */
.fruitback-composer-toggle input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
.fruitback-composer-toggle:has(input:checked) { background: var(--fruitback-color-surface-sunken); color: var(--fruitback-color-accent); }
/* The signature (FRU-607): the initials in a round, or « Guest » in dashes. */
.fruitback-composer-avatar {
  display: inline-grid;
  place-items: center;
  min-width: 28px;
  height: 28px;
  margin-inline-start: auto;
  padding: 0 6px;
  box-sizing: border-box;
  border: 1px solid var(--fruitback-color-border-strong);
  border-radius: var(--fruitback-radius-pill);
  background: var(--fruitback-color-surface-sunken);
  color: var(--fruitback-color-text);
  font: 600 11px/1 var(--fruitback-font-sans);
  letter-spacing: 0.02em;
  cursor: pointer;
}
.fruitback-composer-avatar[data-fruitback-avatar="guest"] {
  border-style: dashed;
  background: transparent;
  color: var(--fruitback-color-text-muted);
  font-weight: 500;
}
.fruitback-composer-avatar:hover { border-color: var(--fruitback-color-text-muted); }
.fruitback-composer-avatar:focus-visible { outline: 2px solid var(--fruitback-color-accent); outline-offset: 1px; }
.fruitback-composer-avatar[hidden] { display: none; }
.fruitback-composer-who { display: flex; flex-direction: column; gap: 8px; }
.fruitback-composer-who[hidden] { display: none; }
/* A box and its words: the picture, and the name to remember. */
.fruitback-composer-check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  cursor: pointer;
}
.fruitback-composer-remember { color: var(--fruitback-color-text-muted); }
.fruitback-composer-check[hidden] { display: none; }
.fruitback-composer-check input, .fruitback-composer-place input {
  /* The reset of the host sets appearance to none, and a native box then draws nothing. */
  appearance: auto;
  -webkit-appearance: checkbox;
  flex: none;
  width: 16px;
  height: 16px;
  margin: 0;
  /* The accent of the widget, as the mock-up ticks the box (FRU-305). */
  accent-color: var(--fruitback-color-accent);
  cursor: pointer;
}
/* The files of the note (FRU-332), in the field, above its icons (FRU-607). */
.fruitback-composer-attach { display: flex; flex-direction: column; gap: 6px; padding: 0 8px 4px; }
.fruitback-composer-attach[hidden], .fruitback-composer-attach-ways[hidden], .fruitback-composer-files[hidden],
.fruitback-composer-attach-none[hidden] { display: none; }
.fruitback-composer-attach:not(:has(> :not([hidden]):not(.fruitback-composer-sr))) { display: none; }
.fruitback-composer-attach-ways { display: flex; align-items: center; gap: 2px; }
/* The inputs of the disk are opened by their buttons: the reset of a host can show them, so they are hidden here. */
.fruitback-composer-attach-ways input[type="file"] { display: none; }
.fruitback-composer-attach-none { margin: 0; font-size: 12px; color: var(--fruitback-color-text-muted); }
/*
  The menu of the capture (FRU-351). It floats over the composer, so the composer keeps its size
  (FRU-431). placeAttachMenu() puts it above the icon when the window has no room below, as at the
  foot of the sheet of a phone, and limits its height to the room of its side.
*/
.fruitback-composer-attach-ways { position: relative; }
.fruitback-composer-attach-trigger[aria-expanded="true"] { background: var(--fruitback-color-surface-sunken); color: var(--fruitback-color-text); }
.fruitback-composer-attach-menu {
  position: absolute;
  top: calc(100% + ${MENU_GAP}px);
  inset-inline-start: 0;
  z-index: 1;
  box-sizing: border-box;
  min-width: 220px;
  max-height: var(--fruitback-composer-attach-room, none);
  overflow-y: auto;
  margin: 0;
  padding: 4px;
  list-style: none;
  border: 1px solid var(--fruitback-color-border);
  border-radius: var(--fruitback-radius-sm);
  background: var(--fruitback-color-surface);
  box-shadow: var(--fruitback-shadow-xl);
}
.fruitback-composer-attach-menu[data-fruitback-side="above"] { top: auto; bottom: calc(100% + ${MENU_GAP}px); }
.fruitback-composer-attach-menu li { display: block; list-style: none; margin: 0; padding: 0; }
.fruitback-composer-attach-menu[hidden], .fruitback-composer-attach-menu li[hidden] { display: none; }
.fruitback-composer-attach-item {
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
.fruitback-composer-attach-item:hover:not([aria-disabled="true"]), .fruitback-composer-attach-item:focus-visible { background: var(--fruitback-color-surface-sunken); }
.fruitback-composer-attach-item:focus-visible { outline: 2px solid var(--fruitback-color-accent); outline-offset: -2px; }
.fruitback-composer-attach-item[aria-disabled="true"] { opacity: 0.55; cursor: default; }
.fruitback-composer-files { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.fruitback-composer-file {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-block: 4px;
  padding-inline: 10px 4px;
  border: 1px solid var(--fruitback-color-border);
  border-radius: var(--fruitback-radius-sm);
  background: var(--fruitback-color-surface-sunken);
}
.fruitback-composer-file-words { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.fruitback-composer-file-name { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fruitback-composer-file-detail { font-size: 11px; color: var(--fruitback-color-text-muted); }
.fruitback-composer-file[data-fruitback-file="refused"] .fruitback-composer-file-detail { color: var(--fruitback-color-accent-strong); }
.fruitback-composer-file-remove {
  flex: none;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: var(--fruitback-radius-sm);
  background: transparent;
  color: var(--fruitback-color-text-muted);
  cursor: pointer;
}
.fruitback-composer-file-remove .fruitback-icon { width: 12px; height: 12px; }
.fruitback-composer-file-remove:hover { background: var(--fruitback-color-surface); color: var(--fruitback-color-text); }
.fruitback-composer-file-remove:focus-visible { outline: 2px solid var(--fruitback-color-accent); outline-offset: 1px; }
/* Where the note goes, when there are several places (FRU-123). */
.fruitback-composer-places { display: flex; flex-direction: column; gap: 6px; }
.fruitback-composer-places[hidden] { display: none; }
.fruitback-composer-place {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--fruitback-color-text-muted);
  cursor: pointer;
}
.fruitback-composer-place input { -webkit-appearance: radio; }
/* A name comes from a tracker and can be one long word. */
.fruitback-composer-place span { overflow-wrap: anywhere; }
/*
  Where the note goes, in icons (FRU-607): the tile of the tool, then the most precise name, on one
  line. The whole path is the tooltip. A button when the member can choose, words otherwise.
*/
.fruitback-composer-lands, .fruitback-composer-destination { display: inline-flex; align-items: center; gap: 6px; }
.fruitback-composer-tile {
  flex: none;
  display: inline-grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: var(--fruitback-radius-sm);
  background: var(--fruitback-color-ink);
  color: var(--fruitback-color-on-ink);
  font: 700 10px/1 var(--fruitback-font-sans);
}
.fruitback-composer-place-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fruitback-composer-destination {
  order: 4;
  flex: 0 1 auto;
  min-width: 0;
  max-width: 60%;
  height: 44px;
  margin-block: -5px;
  margin-inline-end: auto;
  padding: 0 8px;
  border: 5px solid transparent;
  border-inline-width: 0;
  border-radius: var(--fruitback-radius-pill);
  background: transparent;
  color: var(--fruitback-color-text-muted);
  font: 500 12px/1 var(--fruitback-font-sans);
  cursor: pointer;
}
.fruitback-composer-destination:hover { background: var(--fruitback-color-surface-sunken) padding-box; color: var(--fruitback-color-text); }
.fruitback-composer-destination:focus-visible { outline: 2px solid var(--fruitback-color-accent); outline-offset: -3px; }
.fruitback-composer-destination .fruitback-icon { flex: none; width: 12px; height: 12px; }
.fruitback-composer-destination[aria-expanded="true"] .fruitback-icon { transform: rotate(180deg); }
.fruitback-composer-destination[hidden] { display: none; }
/* Always in the tree, because a live region that was hidden announces nothing. Empty, it takes no room. */
.fruitback-composer-notice { font-size: 12px; color: var(--fruitback-color-accent); }
.fruitback-composer-notice:empty { display: none; }
.fruitback-composer-who input[type="text"] {
  min-width: 0;
  height: 36px;
  padding: 0 10px;
  border: 1px solid var(--fruitback-color-border-strong);
  border-radius: var(--fruitback-radius-sm);
  font: 13px/1.4 var(--fruitback-font-sans);
  color: inherit;
  background: var(--fruitback-color-surface);
}
.fruitback-composer-who input[type="text"]:focus-visible { outline: 2px solid var(--fruitback-color-accent); outline-offset: 2px; }
/* « Not sent », and what to do (FRU-305). The text stays in the field above. */
.fruitback-composer-failed {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 16px;
  border-top: 1px solid var(--fruitback-color-border);
}
.fruitback-composer-failed[hidden] { display: none; }
.fruitback-composer-failed-title { margin: 0; font-size: 13px; font-weight: 600; color: var(--fruitback-color-accent); }
.fruitback-composer-failed-text { margin: 0; font-size: 12px; color: var(--fruitback-color-text-muted); }
/*
  The card of a sent note (FRU-305): it takes the place of the note and of the foot. The drop of the
  new pin with its number, « Sent as DEV-3 », the sentence in green, « Open → ».
*/
.fruitback-composer[data-fruitback-state="sent"] .fruitback-composer-head,
.fruitback-composer[data-fruitback-state="sent"] .fruitback-composer-body,
.fruitback-composer[data-fruitback-state="sent"] .fruitback-composer-foot { display: none; }
.fruitback-composer-sent { display: flex; align-items: center; gap: 12px; padding: 16px; outline: 0; }
.fruitback-composer-sent[hidden] { display: none; }
.fruitback-composer-sent-drop {
  flex: none;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 2px solid var(--fruitback-color-on-stage);
  border-radius: 50% 50% 50% 0;
  transform: rotate(-45deg);
  /* The colour of « new », through the variable every pin is painted with. */
  --fruitback-pin-color: var(--fruitback-stage-new);
  background: var(--fruitback-pin-color);
  color: var(--fruitback-color-on-stage-new, var(--fruitback-color-on-stage));
  font: 700 12px/1 var(--fruitback-font-sans);
  box-shadow: 0 0 0 1px var(--fruitback-color-stage-edge), var(--fruitback-shadow-sm);
}
.fruitback-composer-sent-drop > span { transform: rotate(45deg); }
.fruitback-composer-sent-words { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.fruitback-composer-sent-title { margin: 0; font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.fruitback-composer-sent-text { margin: 0; font-size: 12px; color: var(--fruitback-color-success); }
.fruitback-composer-sent-open {
  flex: none;
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 0 4px;
  color: var(--fruitback-color-text);
  font: 600 12px/1.5 var(--fruitback-font-sans);
  text-decoration: none;
  cursor: pointer;
}
.fruitback-composer-sent-open:hover { color: var(--fruitback-color-accent-strong); }
.fruitback-composer-sent-open[hidden] { display: none; }
/*
  « Send » ends the row, whatever the length of the words (FRU-317). The row is laid out from its end
  (\`row-reverse\`) and its lines from the bottom (\`wrap-reverse\`), in the \`order\` below: « Send »
  first, so it holds the end of the last line, then « Cancel », « Keep for later », the line of where
  the note lands, and the status. When the words do not fit, they go to a line above « Send », never
  the reverse. The source order, which is the order of the keyboard, stays « Keep for later »,
  « Cancel », « Send ». In a language written from the right, the end is the left.
*/
.fruitback-composer-foot {
  display: flex;
  flex-direction: row-reverse;
  flex-wrap: wrap-reverse;
  align-items: center;
  gap: 8px;
  padding-block: 10px 12px;
  padding-inline: 14px 12px;
  border-top: 1px solid var(--fruitback-color-border);
}
.fruitback-composer-status { flex: 1 1 100%; min-width: 0; font-size: 12px; color: var(--fruitback-color-text-muted); }
.fruitback-composer-status:empty { display: none; }
/*
  « Creates a new issue in Linear »: where the note goes, before the buttons. At least 4.5em wide
  (FRU-350): beside the buttons, which stay on one line, its words wrap; with less room than that,
  they take a line of their own above them, never a column of letters beside them.
*/
.fruitback-composer-lands { flex: 1 1 0; min-width: min(4.5em, 100%); font-size: 12px; color: var(--fruitback-color-text-muted); }
.fruitback-composer-lands .fruitback-composer-place-name { flex: 0 1 auto; }
.fruitback-composer-lands[hidden] { display: none; }
.fruitback-composer-send { order: 1; }
.fruitback-composer-foot > .fruitback-composer-ghost:not(.fruitback-composer-keep) { order: 2; }
.fruitback-composer-keep { order: 3; }
.fruitback-composer-lands { order: 4; }
.fruitback-composer-status { order: 5; }
/* 34 px drawn, as the mock-up does, inside a transparent border that makes the target 44 px. */
.fruitback-composer-ghost, .fruitback-composer-send {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 44px;
  margin-block: -5px;
  border: 5px solid transparent;
  border-inline-width: 0;
  border-radius: var(--fruitback-radius-pill);
  font: 600 13px/1 var(--fruitback-font-sans);
  cursor: pointer;
}
.fruitback-composer-ghost { padding: 0 12px; background: transparent; color: var(--fruitback-color-text-muted); }
/*
  A button never wraps (FRU-611, P7): its words end in « … » and the tooltip gives them whole. A
  ghost holds only its words, so it is a block of one line, where an ellipsis works.
*/
.fruitback-composer-ghost, .fruitback-composer-pick {
  display: inline-block;
  max-width: 100%;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.fruitback-composer-ghost { line-height: 34px; }
.fruitback-composer-send { max-width: 100%; min-width: 0; white-space: nowrap; }
.fruitback-composer-send > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.fruitback-composer-ghost:hover:not([disabled]) { background: var(--fruitback-color-surface-sunken) padding-box; }
.fruitback-composer-send {
  padding-inline: 12px 14px;
  background: var(--fruitback-color-accent) padding-box;
  color: var(--fruitback-color-on-accent);
  letter-spacing: -0.006em;
}
/* The drop of the mark, 12 px tall. */
.fruitback-composer-send .fruitback-icon { width: 10px; height: 12px; }
.fruitback-composer-send:hover:not([disabled]) { background: var(--fruitback-color-accent-strong) padding-box; }
.fruitback-composer-send[disabled] { opacity: 0.55; cursor: default; }
.fruitback-composer-keep[hidden], .fruitback-composer-sign-in[hidden] { display: none; }
/* « Sign in again » is the way out of the sentence above it: it reads as an action, in the text colour. */
.fruitback-composer-sign-in { color: var(--fruitback-color-text); text-decoration: underline; text-underline-offset: 3px; }
.fruitback-composer-keep[disabled] { opacity: 0.55; cursor: default; }
.fruitback-composer[data-fruitback-state="kept"] .fruitback-composer-status {
  color: var(--fruitback-color-success);
  font-weight: 600;
}
@media (forced-colors: active) {
  .fruitback-composer-ghost, .fruitback-composer-send, .fruitback-composer-pick { border-color: Canvas; }
  .fruitback-composer-send { outline: 1px solid ButtonText; outline-offset: -6px; }
}

/* The « rise » of the mock-up: no fade, it is there at once and settles. */
@keyframes fruitback-composer-in {
  from { transform: translateY(6px) scale(0.96); }
  to { transform: none; }
}
@keyframes fruitback-composer-down {
  from { transform: translateY(-6px) scale(0.96); }
  to { transform: none; }
}
@keyframes fruitback-composer-from-left {
  from { transform: translateX(-6px) scale(0.96); }
  to { transform: none; }
}
@keyframes fruitback-composer-from-right {
  from { transform: translateX(6px) scale(0.96); }
  to { transform: none; }
}

/* Full screen on a phone: a 360px popover anchored to an element is unusable at that width. */
@media (max-width: 640px) {
  .fruitback-composer {
    position: fixed;
    /* Beats the custom properties above, which are only meaningful for the anchored popover. */
    inset: auto 0 0 0;
    left: 0;
    top: auto;
    width: auto;
    border-radius: var(--fruitback-radius-lg) var(--fruitback-radius-lg) 0 0;
    padding-bottom: env(safe-area-inset-bottom);
  }
  .fruitback-composer, .fruitback-composer[data-fruitback-side] {
    animation-name: fruitback-composer-sheet-in;
  }
  /* A sheet stands on the foot of the window, away from its element: no line goes to it. */
  .fruitback-composer-tether { display: none; }
}

/*
  A thumb, not a pointer (FRU-157). iOS Safari zooms the page into a field under 16 px, and the zoom
  stays after the field loses focus. A box is toggled by its whole row, and the row is tall enough.
*/
@media (pointer: coarse) {
  .fruitback-composer textarea, .fruitback-composer-who input[type="text"] { font-size: 16px; }
  .fruitback-composer-tool { width: 44px; height: 44px; }
  .fruitback-composer-avatar { min-width: 36px; height: 36px; }
  .fruitback-composer-check, .fruitback-composer-place { min-height: 36px; }
}

@keyframes fruitback-composer-sheet-in {
  from { transform: translateY(100%); }
  to { transform: none; }
}

@media (prefers-reduced-motion: reduce) {
  .fruitback-composer, .fruitback-composer[data-fruitback-side] { animation: none; }
}
`;
