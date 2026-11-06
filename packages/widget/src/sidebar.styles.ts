/*
  No backtick in this literal: a comment that quotes a symbol closes it. See theme.ts.
  Layout follows the reading direction (inset-inline-end, text-align: start). Nothing here is geometry.
*/
export const STYLES = `
.fruitback-sidebar {
  position: fixed;
  inset-block: 0;
  inset-inline-end: 0;
  z-index: 2147483050;
  display: flex;
  flex-direction: column;
  width: 392px;
  max-width: 100vw;
  box-sizing: border-box;
  border-inline-start: 1px solid var(--fruitback-color-border);
  background: var(--fruitback-color-surface);
  color: var(--fruitback-color-text);
  font: 14px/1.45 var(--fruitback-font-sans);
  /* The shadow of the board, cast over the page, which is at the start side of the list. */
  box-shadow: -10px 0 30px rgba(0, 0, 0, 0.06);
  animation: fruitback-sidebar-in var(--fruitback-duration-fast) ease-out;
}
.fruitback-sidebar:dir(rtl) { box-shadow: 10px 0 30px rgba(0, 0, 0, 0.06); }
.fruitback-sidebar[hidden] { display: none; }
@keyframes fruitback-sidebar-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.fruitback-sidebar-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding-block: 16px 12px;
  padding-inline: 18px 12px;
}
.fruitback-sidebar-heading { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; }
.fruitback-sidebar-heading .fruitback-icon { flex: none; width: 16px; height: 16px; color: var(--fruitback-color-accent); }
.fruitback-sidebar-title { flex: none; font-weight: 650; font-size: 15px; letter-spacing: -0.01em; }
/* anywhere: a host has no space to wrap at. */
.fruitback-sidebar-address { min-width: 0; font-size: 12px; color: var(--fruitback-color-text-muted); overflow-wrap: anywhere; }
.fruitback-sidebar-icon {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: var(--fruitback-radius-md);
  background: transparent;
  color: var(--fruitback-color-text-muted);
  cursor: pointer;
}
.fruitback-sidebar-icon .fruitback-icon { width: 17px; height: 17px; }
.fruitback-sidebar-close .fruitback-icon { width: 14px; height: 14px; }
.fruitback-sidebar-icon:hover { background: var(--fruitback-color-surface-sunken); color: var(--fruitback-color-text); }
.fruitback-sidebar button:focus-visible, .fruitback-sidebar input:focus-visible {
  outline: 2px solid var(--fruitback-color-accent);
  outline-offset: 2px;
}
.fruitback-sidebar-actions {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 0 18px 12px;
  border-bottom: 1px solid var(--fruitback-color-border);
}
/* The rail of the scope, with its one part drawn as the chosen tab of the board. */
.fruitback-sidebar-scope {
  margin: 0;
  padding: 3px;
  border-radius: var(--fruitback-radius-md);
  background: var(--fruitback-color-surface-sunken);
}
/*
  FRU-470: « This page » and « All pages », two halves of the rail. The chosen one is drawn as the
  chosen tab of the board; the other is words on the sunken rail. 36 px, and 44 px under a thumb.
*/
.fruitback-sidebar-scopes { display: grid; grid-template-columns: 1fr 1fr; gap: 3px; }
.fruitback-sidebar-scopes > button {
  height: 32px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--fruitback-radius-field);
  background: none;
  color: var(--fruitback-color-text-muted);
  font: 600 12px/1 var(--fruitback-font-sans);
  cursor: pointer;
}
.fruitback-sidebar-scopes > button[aria-pressed='true'] {
  background: var(--fruitback-color-surface);
  box-shadow: var(--fruitback-shadow-xs);
  color: var(--fruitback-color-text);
}
@media (pointer: coarse) { .fruitback-sidebar-scopes > button { height: 44px; } }
@media (forced-colors: active) {
  .fruitback-sidebar-scopes > button[aria-pressed='true'] { outline: 2px solid Highlight; }
}
/*
  FRU-606: To check, Open and Done, the tabs of the side panel, drawn as the rail of the scope.
  Under the head while « Search and options » is closed.
*/
.fruitback-sidebar-tabs {
  flex: none;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 3px;
  margin: 0 18px 12px;
  padding: 3px;
  border-radius: var(--fruitback-radius-md);
  background: var(--fruitback-color-surface-sunken);
}
.fruitback-sidebar-tab {
  height: 32px;
  padding: 0 6px;
  border: 0;
  border-radius: var(--fruitback-radius-field);
  background: none;
  color: var(--fruitback-color-text-muted);
  font: 600 12px/1 var(--fruitback-font-sans);
  white-space: nowrap;
  cursor: pointer;
}
.fruitback-sidebar-tab[aria-selected='true'] {
  background: var(--fruitback-color-surface);
  box-shadow: var(--fruitback-shadow-xs);
  color: var(--fruitback-color-text);
}
@media (pointer: coarse) { .fruitback-sidebar-tab { height: 44px; } }
@media (forced-colors: active) {
  .fruitback-sidebar-tab[aria-selected='true'] { outline: 2px solid Highlight; }
}
/* A class that sets a display beats the rule of the browser for hidden: « All pages » hides the chips. */
.fruitback-sidebar-chips[hidden] { display: none; }
.fruitback-sidebar-actions[hidden] { display: none; }
.fruitback-sidebar-tabs[hidden] { display: none; }
.fruitback-sidebar-more { align-self: center; margin: 4px auto 12px; display: block; }
.fruitback-sidebar-more[hidden] { display: none; }
.fruitback-sidebar-item[aria-disabled='true'] { cursor: default; opacity: 0.7; }
.fruitback-sidebar-scope > span {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 30px;
  border-radius: var(--fruitback-radius-field);
  background: var(--fruitback-color-surface);
  box-shadow: var(--fruitback-shadow-xs);
  font-size: 12px;
  font-weight: 600;
}
.fruitback-sidebar-search { position: relative; display: block; }
.fruitback-sidebar-search .fruitback-icon {
  position: absolute;
  inset-inline-start: 10px;
  top: 9px;
  width: 15px;
  height: 15px;
  color: var(--fruitback-color-text-muted);
  pointer-events: none;
}
.fruitback-sidebar-search-field {
  width: 100%;
  height: 34px;
  box-sizing: border-box;
  margin: 0;
  padding-block: 0;
  padding-inline: 32px 10px;
  border: 1px solid var(--fruitback-color-border-strong);
  border-radius: var(--fruitback-radius-sm);
  background: var(--fruitback-color-surface);
  color: var(--fruitback-color-text);
  font: 13px/1.45 var(--fruitback-font-sans);
}
.fruitback-sidebar-search-field::placeholder { color: var(--fruitback-color-text-muted); opacity: 1; }
.fruitback-sidebar-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.fruitback-sidebar-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--fruitback-color-border);
  border-radius: var(--fruitback-radius-pill);
  background: var(--fruitback-color-surface);
  color: var(--fruitback-color-text);
  font: 600 12px/1 var(--fruitback-font-sans);
  cursor: pointer;
}
.fruitback-sidebar-chip[hidden] { display: none; }
.fruitback-sidebar-chip[aria-pressed='true'] {
  border-color: var(--fruitback-color-text);
  background: var(--fruitback-color-surface-sunken);
}
.fruitback-sidebar-count { color: var(--fruitback-color-text-muted); font-weight: 500; }
.fruitback-sidebar-count:empty { display: none; }
/* The round of a stage in a chip (FRU-606): 12 px, no margin of its own. */
.fruitback-sidebar-chip .fruitback-stage-ring { width: 12px; height: 12px; margin: 0; }
.fruitback-sidebar-panel {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px 12px;
}
.fruitback-sidebar-panel[hidden] { display: none; }
.fruitback-sidebar-empty { margin: 0; padding: 12px 10px; color: var(--fruitback-color-text-muted); }
.fruitback-sidebar-drafts { margin: 0 2px 6px; padding: 10px; border-radius: var(--fruitback-radius-md); box-shadow: inset 0 0 0 1px var(--fruitback-color-border); font-size: 13px; }
.fruitback-sidebar-drafts[hidden] { display: none; }
.fruitback-sidebar-drafts-title { margin: 0 0 6px; font-weight: 600; font-size: 12px; }
.fruitback-sidebar-drafts-list { margin: 0 0 10px; padding: 0; list-style: none; }
.fruitback-sidebar-draft { display: flex; flex-direction: column; gap: 2px; padding: 4px 0; list-style: none; }
.fruitback-sidebar-draft + .fruitback-sidebar-draft { border-top: 1px solid var(--fruitback-color-border); }
.fruitback-sidebar-empty[hidden] { display: none; }
.fruitback-sidebar-failed-text { margin: 0; padding: 12px 10px 8px; }
.fruitback-sidebar-failed-text:empty { padding: 0; }
.fruitback-sidebar-failed { padding: 0 10px; }
.fruitback-sidebar-failed[hidden] { display: none; }
.fruitback-sidebar-retry[aria-disabled='true'], .fruitback-sidebar-send[aria-disabled='true'], .fruitback-sidebar-more[aria-disabled='true'] { opacity: 0.6; cursor: progress; }
.fruitback-sidebar-sent { margin: 0; padding: 0 10px 8px; font-size: 13px; }
.fruitback-sidebar-sent:empty { padding: 0; }
.fruitback-sidebar-retry, .fruitback-sidebar-send, .fruitback-sidebar-more {
  padding: 6px 12px;
  border: 1px solid var(--fruitback-color-text-muted);
  border-radius: var(--fruitback-radius-sm);
  background: none;
  color: var(--fruitback-color-text);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
/* FRU-394: no « Try again » on a site that its members read. The reset of the host shows a button. */
.fruitback-sidebar-retry[hidden] { display: none; }
.fruitback-sidebar-list, .fruitback-sidebar-site-list { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.fruitback-sidebar-list[hidden], .fruitback-sidebar-site-list[hidden] { display: none; }
.fruitback-sidebar-list > li, .fruitback-sidebar-site-list > li, .fruitback-sidebar-unplaced-list > li { list-style: none; }
.fruitback-sidebar-item {
  display: flex;
  gap: 12px;
  width: 100%;
  box-sizing: border-box;
  padding: 12px;
  border: 0;
  border-radius: var(--fruitback-radius-md);
  background: none;
  color: var(--fruitback-color-text);
  font: inherit;
  text-align: start;
  /* A button that holds a note: its words wrap, against the rule of the labels (FRU-350). */
  white-space: normal;
  cursor: pointer;
}
.fruitback-sidebar-item:hover { background: var(--fruitback-color-surface-raised); }
/* The note whose thread is open: the card of the board. After the pointer, so it holds under it too. */
.fruitback-sidebar-item[aria-current='true'], .fruitback-sidebar-lost[aria-current='true'] {
  background: var(--fruitback-color-surface-warm);
  box-shadow: inset 0 0 0 1px var(--fruitback-color-border);
}
/* The drop of the pin, 24 px, the point down, with a white edge as on the page. */
.fruitback-sidebar-pin {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  box-sizing: border-box;
  margin-top: 2px;
  border: 2px solid #fff;
  border-radius: 50% 50% 50% 0;
  transform: rotate(-45deg);
  background: var(--fruitback-sidebar-stage);
  box-shadow: 0 0 0 1px var(--fruitback-color-stage-edge), 0 2px 6px rgba(24, 24, 27, 0.2);
}
.fruitback-sidebar-pin > span {
  transform: rotate(45deg);
  color: var(--fruitback-sidebar-on-stage);
  font: 700 11px/1 var(--fruitback-font-sans);
}
.fruitback-sidebar-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.fruitback-sidebar-top { display: flex; align-items: center; gap: 8px; font-size: 12px; line-height: 1.5; }
.fruitback-sidebar-status { font-weight: 600; letter-spacing: -0.006em; }
/* The round of the stage (FRU-606), before its word, in the colour of the pin of the note. */
.fruitback-stage-ring { flex: none; width: 14px; height: 14px; margin-inline-end: -3px; }
.fruitback-sidebar { --fruitback-stage-ring-mark: var(--fruitback-color-surface); }
@media (forced-colors: active) { .fruitback-stage-ring { color: CanvasText !important; } }
/* An identifier is a label: DEV-002 never breaks at its dash (FRU-350). */
.fruitback-sidebar-id { color: var(--fruitback-color-text-muted); white-space: nowrap; }
.fruitback-sidebar-age { margin-inline-start: auto; color: var(--fruitback-color-text-muted); white-space: nowrap; }
/* Two lines at most: the whole note is in its thread. */
.fruitback-sidebar-note {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.fruitback-sidebar-draft .fruitback-sidebar-note { display: block; }
.fruitback-sidebar-meta { color: var(--fruitback-color-text-muted); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.fruitback-sidebar-below[hidden] { display: none; }
.fruitback-sidebar-unplaced {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
  padding: 10px 8px 4px;
  border-top: 1px solid var(--fruitback-color-border);
}
.fruitback-sidebar-unplaced[hidden] { display: none; }
/* The title of the board, in capitals. Its words in the muted text, and its drop in the grey of a note with no place. */
.fruitback-sidebar-unplaced-title {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--fruitback-color-text-muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.fruitback-sidebar-unplaced-title .fruitback-icon { width: 12px; height: 15px; color: var(--fruitback-color-unplaced); }
.fruitback-sidebar-unplaced-list { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
/* A dashed card, as the board draws it: it still opens the thread of its note. */
.fruitback-sidebar-lost {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  box-sizing: border-box;
  padding: 10px 12px;
  border: 1px dashed var(--fruitback-color-unplaced);
  border-radius: var(--fruitback-radius-md);
  background: var(--fruitback-color-surface-warm);
  color: var(--fruitback-color-text);
  font: inherit;
  text-align: start;
  white-space: normal;
  cursor: pointer;
}
.fruitback-sidebar-lost:hover { background: var(--fruitback-color-surface-raised); }
.fruitback-sidebar-lost-note { overflow-wrap: anywhere; }
.fruitback-sidebar-actions[hidden], .fruitback-sidebar-detail[hidden] { display: none; }
/* The thread of a note in place of the rows (FRU-312): the way back, then the thread, which scrolls. */
.fruitback-sidebar-detail { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; }
.fruitback-sidebar-back {
  align-self: flex-start;
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 44px;
  margin: 6px 8px 0;
  padding: 0 10px;
  border: 0;
  border-radius: var(--fruitback-radius-md);
  background: none;
  color: var(--fruitback-color-text-subtle);
  font: 600 13px/1.45 var(--fruitback-font-sans);
  cursor: pointer;
}
.fruitback-sidebar-back:hover { background: var(--fruitback-color-surface-raised); color: var(--fruitback-color-text); }
.fruitback-sidebar-foot {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 18px 18px;
  border-top: 1px solid var(--fruitback-color-border);
}
.fruitback-sidebar-foot:empty { display: none; }
.fruitback-sidebar-leave {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 44px;
  border: 0;
  border-radius: var(--fruitback-radius-pill);
  background: var(--fruitback-color-accent);
  color: var(--fruitback-color-on-accent);
  font: 600 13px/1.45 var(--fruitback-font-sans);
  letter-spacing: -0.006em;
  cursor: pointer;
}
.fruitback-sidebar-leave[hidden] { display: none; }
/* The drop of the mark, taller than wide, as on the launch button. */
.fruitback-sidebar-leave .fruitback-icon { width: 12px; height: 15px; }
.fruitback-sidebar-leave:hover { background: var(--fruitback-color-accent-strong); }
/* A row of words and its switch, 32 × 18 as the board draws it: the whole row toggles it. */
.fruitback-sidebar-pins {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--fruitback-color-text-muted);
  font-size: 12px;
  cursor: pointer;
}
/* Off, the edge of a field and not the light grey of the kit: 3.42:1 on the surface shows where it is. */
.fruitback-sidebar-pins input {
  appearance: none;
  -webkit-appearance: none;
  flex: none;
  position: relative;
  width: 32px;
  height: 18px;
  margin: 0;
  border-radius: var(--fruitback-radius-pill);
  background: var(--fruitback-color-border-strong);
  cursor: pointer;
  transition: background var(--fruitback-duration-fast) var(--fruitback-ease-out);
}
.fruitback-sidebar-pins input::before {
  content: '';
  position: absolute;
  top: 2px;
  inset-inline-start: 2px;
  width: 14px;
  height: 14px;
  border-radius: var(--fruitback-radius-pill);
  background: var(--fruitback-color-surface);
  transition: transform var(--fruitback-duration-fast) var(--fruitback-ease-out);
}
.fruitback-sidebar-pins input:checked { background: var(--fruitback-color-text); }
.fruitback-sidebar-pins input:checked::before { transform: translateX(14px); }
.fruitback-sidebar-pins input:checked:dir(rtl)::before { transform: translateX(-14px); }
@media (forced-colors: active) {
  .fruitback-sidebar-pins input { border: 1px solid ButtonText; }
  .fruitback-sidebar-pins input::before { background: ButtonText; }
  .fruitback-sidebar-pins input:checked { background: Highlight; }
  .fruitback-sidebar-chip[aria-pressed='true'] { outline: 2px solid Highlight; }
}
@media (prefers-reduced-motion: reduce) {
  .fruitback-sidebar { animation: none; }
  .fruitback-sidebar-pins input, .fruitback-sidebar-pins input::before { transition: none; }
}
/* A sheet at the bottom of a phone, as before: the board draws no phone. */
@media (max-width: 480px) {
  .fruitback-sidebar {
    inset-block-start: auto;
    width: 100vw;
    max-height: 70vh;
    border-inline-start: 0;
    border-radius: var(--fruitback-radius-lg) var(--fruitback-radius-lg) 0 0;
  }
  .fruitback-sidebar-foot { padding-bottom: calc(18px + env(safe-area-inset-bottom)); }
}
/* A thumb, not a pointer (FRU-157): the buttons of the head, the chips and the field are 44 px. */
@media (pointer: coarse) {
  .fruitback-sidebar-icon { width: 44px; height: 44px; margin-block: -6px; }
  .fruitback-sidebar-close { margin-inline-end: -6px; }
  .fruitback-sidebar-chip, .fruitback-sidebar-search-field { min-height: 44px; }
  .fruitback-sidebar-search .fruitback-icon { top: 14px; }
  .fruitback-sidebar-pins { min-height: 44px; }
  .fruitback-sidebar-retry, .fruitback-sidebar-send, .fruitback-sidebar-more { min-height: 44px; }
}
`;
