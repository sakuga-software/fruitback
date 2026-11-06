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
/* What the note points at, in the mono of a selector, on one line. */
.fruitback-composer-about {
  flex: 1;
  min-width: 0;
  font: 12px/1.5 var(--fruitback-font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
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
.fruitback-composer textarea {
  display: block;
  width: 100%;
  min-height: 96px;
  border: 1px solid var(--fruitback-color-border-strong);
  border-radius: var(--fruitback-radius-sm);
  padding: 10px 12px;
  font: 14px/1.5 var(--fruitback-font-sans);
  resize: vertical;
  background: var(--fruitback-color-surface);
  color: inherit;
  caret-color: var(--fruitback-color-accent);
}
.fruitback-composer textarea:focus-visible { outline: 2px solid var(--fruitback-color-accent); outline-offset: 2px; }
.fruitback-composer-identify {
  display: block;
  border: 0;
  background: none;
  padding: 0;
  color: var(--fruitback-color-text-muted);
  font: inherit;
  font-size: 12px;
  text-decoration: underline;
  cursor: pointer;
}
.fruitback-composer-who { display: flex; flex-direction: column; gap: 8px; }
.fruitback-composer-who[hidden] { display: none; }
.fruitback-composer-identify[hidden] { display: none; }
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
/* The files of the note (FRU-332): the ways to join one, then the list, each with its remove button. */
.fruitback-composer-attach { display: flex; flex-direction: column; gap: 6px; }
.fruitback-composer-attach[hidden], .fruitback-composer-attach-ways[hidden], .fruitback-composer-files[hidden],
.fruitback-composer-attach-way[hidden], .fruitback-composer-attach-none[hidden] { display: none; }
.fruitback-composer-attach-ways { display: flex; flex-wrap: wrap; gap: 6px; }
/* The inputs of the disk are opened by their buttons: the reset of a host can show them, so they are hidden here. */
.fruitback-composer-attach input[type="file"] { display: none; }
.fruitback-composer-attach-way {
  min-height: 32px;
  padding: 0 10px;
  border: 1px solid var(--fruitback-color-border-strong);
  border-radius: var(--fruitback-radius-pill);
  background: var(--fruitback-color-surface);
  color: var(--fruitback-color-text);
  font: 600 12px/1 var(--fruitback-font-sans);
  cursor: pointer;
}
.fruitback-composer-attach-way:hover:not([disabled]):not([aria-disabled="true"]) { background: var(--fruitback-color-surface-sunken); }
.fruitback-composer-attach-way:focus-visible { outline: 2px solid var(--fruitback-color-accent); outline-offset: 2px; }
.fruitback-composer-attach-way[disabled], .fruitback-composer-attach-way[aria-disabled="true"] { opacity: 0.55; cursor: default; }
.fruitback-composer-attach-none { margin: 0; font-size: 12px; color: var(--fruitback-color-text-muted); }
/*
  « Attach » and its menu (FRU-351). The menu floats over the composer, so the composer keeps its size
  (FRU-431). placeAttachMenu() puts it above the button when the window has no room below, as at the
  foot of the sheet of a phone, and limits its height to the room of its side.
*/
.fruitback-composer-attach-ways { position: relative; flex-direction: column; align-items: flex-start; }
.fruitback-composer-attach-trigger { display: inline-flex; align-items: center; gap: 4px; }
.fruitback-composer-attach-trigger .fruitback-icon { width: 14px; height: 14px; }
.fruitback-composer-attach-trigger[aria-expanded="true"] .fruitback-icon { transform: rotate(180deg); }
.fruitback-composer-attach-menu {
  position: absolute;
  top: calc(100% + ${MENU_GAP}px);
  inset-inline-start: 0;
  z-index: 1;
  box-sizing: border-box;
  min-width: 220px;
  max-width: 100%;
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
.fruitback-composer-attach-menu[hidden], .fruitback-composer-attach-menu li[hidden], .fruitback-composer-dropzone[hidden] { display: none; }
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
.fruitback-composer-dropzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 16px;
  border: 2px dashed var(--fruitback-color-border-strong);
  border-radius: var(--fruitback-radius-sm);
  background: var(--fruitback-color-surface-sunken);
  text-align: center;
}
.fruitback-composer-dropzone:focus-visible { outline: 2px solid var(--fruitback-color-accent); outline-offset: 2px; }
.fruitback-composer-dropzone[data-fruitback-dragging] { border-color: var(--fruitback-color-accent); }
.fruitback-composer-dropzone-words { margin: 0; font-size: 13px; color: var(--fruitback-color-text-muted); }
.fruitback-composer-dropzone-paste { margin: 0; font-size: 12px; color: var(--fruitback-color-text-muted); }
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
.fruitback-composer-place span, .fruitback-composer-identify { overflow-wrap: anywhere; }
/* A button that holds a name: its words wrap, against the rule of the labels (FRU-350). */
.fruitback-composer-identify { text-align: start; white-space: normal; }
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
.fruitback-composer-ghost:hover:not([disabled]) { background: var(--fruitback-color-surface-sunken) padding-box; }
/* FRU-601: the colour a host gives with actionColor, else the accent. */
.fruitback-composer-send {
  padding-inline: 12px 14px;
  background: var(--fruitback-color-action, var(--fruitback-color-accent)) padding-box;
  color: var(--fruitback-color-on-action, var(--fruitback-color-on-accent));
  letter-spacing: -0.006em;
}
/* The drop of the mark, 12 px tall. */
.fruitback-composer-send .fruitback-icon { width: 10px; height: 12px; color: var(--fruitback-color-action-mark, currentColor); }
.fruitback-composer-send:hover:not([disabled]) { background: var(--fruitback-color-action-strong, var(--fruitback-color-accent-strong)) padding-box; }
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
  .fruitback-composer, .fruitback-composer[data-fruitback-side="below"] {
    animation-name: fruitback-composer-sheet-in;
  }
}

/*
  A thumb, not a pointer (FRU-157). iOS Safari zooms the page into a field under 16 px, and the zoom
  stays after the field loses focus. A box is toggled by its whole row, and the row is tall enough.
*/
@media (pointer: coarse) {
  .fruitback-composer textarea, .fruitback-composer-who input[type="text"] { font-size: 16px; }
  .fruitback-composer-identify { min-height: 36px; }
  .fruitback-composer-check, .fruitback-composer-place { min-height: 36px; }
}

@keyframes fruitback-composer-sheet-in {
  from { transform: translateY(100%); }
  to { transform: none; }
}

@media (prefers-reduced-motion: reduce) {
  .fruitback-composer, .fruitback-composer[data-fruitback-side="below"] { animation: none; }
}
`;
