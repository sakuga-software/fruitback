export const STYLES = `
.fruitback-area {
  position: fixed;
  inset: 0;
  z-index: 2147483600;
  cursor: crosshair;
  outline: 0;
  touch-action: none;
}
.fruitback-area-box {
  position: fixed;
  box-sizing: border-box;
  border: 2px solid var(--fruitback-color-accent);
  border-radius: var(--fruitback-radius-sm);
  /* The page outside the area, dimmed: the shadow is the rest of the window. */
  box-shadow: 0 0 0 100vmax color-mix(in srgb, var(--fruitback-color-ink) 45%, transparent);
  pointer-events: none;
}
.fruitback-area-size {
  position: fixed;
  transform: translate(-100%, 6px);
  padding: 2px 6px;
  border-radius: var(--fruitback-radius-sm);
  background: var(--fruitback-color-ink);
  color: var(--fruitback-color-on-ink);
  font: 600 11px/1.4 var(--fruitback-font-mono);
  pointer-events: none;
  white-space: nowrap;
}
.fruitback-area:focus-visible .fruitback-area-box { outline: 2px solid var(--fruitback-color-on-accent); outline-offset: 2px; }
.fruitback-area-bar {
  position: fixed;
  inset-inline: 12px;
  bottom: 12px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--fruitback-color-border);
  border-radius: var(--fruitback-radius-lg);
  background: var(--fruitback-color-surface);
  color: var(--fruitback-color-text);
  font: 13px/1.5 var(--fruitback-font-sans);
  box-shadow: var(--fruitback-shadow-lg);
  cursor: default;
}
.fruitback-area-help { flex: 1 1 200px; margin: 0; color: var(--fruitback-color-text-muted); }
.fruitback-area-take, .fruitback-area-cancel {
  min-height: 44px;
  padding: 0 14px;
  border: 0;
  border-radius: var(--fruitback-radius-pill);
  font: 600 13px/1 var(--fruitback-font-sans);
  cursor: pointer;
}
.fruitback-area-cancel { background: transparent; color: var(--fruitback-color-text-muted); }
.fruitback-area-cancel:hover { background: var(--fruitback-color-surface-sunken); }
.fruitback-area-take { background: var(--fruitback-color-accent); color: var(--fruitback-color-on-accent); }
.fruitback-area-take:hover { background: var(--fruitback-color-accent-strong); }
.fruitback-area-take:focus-visible, .fruitback-area-cancel:focus-visible {
  outline: 2px solid var(--fruitback-color-accent);
  outline-offset: 2px;
}
@media (forced-colors: active) {
  .fruitback-area-box { border-color: Highlight; box-shadow: none; }
  .fruitback-area-take, .fruitback-area-cancel { outline: 1px solid ButtonText; }
}
`;
