import { NOTE_STAGES, type NoteStage } from '@fruitback/shared';
import { type Translator, createTranslator, languageOf } from './messages.ts';
import { RESOLVED_STAGES, type ConfigStore } from './config.ts';
import { holdFocus } from './focus.ts';
import { createIcon } from './icons.ts';
import { stageToken } from './theme.ts';
import { DOCK_POSITIONS, type DockPosition } from './dock-position.ts';
import { adoptStyles } from './stylesheet.ts';

/**
 * The settings panel, opened from the floating button (FRU-14).
 *
 * There is no dashboard: a client who can reach the page can reach the settings. That is the whole
 * distribution story for a widget dropped into someone else's site.
 *
 * It writes through the store on every change rather than behind a Save button. A settings panel
 * with unsaved state has a way to lose it, and there is nothing here worth a confirmation step.
 */

export type ConfigPanelOptions = {
  /** Where to render. The Shadow root, in practice — see `host.ts`. */
  host: Element | ShadowRoot;
  store: ConfigStore;
  /**
   * Whether the embedder gave `init` a way to capture an image (FRU-6). Without one the toggle is
   * not rendered at all: a switch that controls nothing is worse than no switch, which is why this
   * setting was left out of FRU-14 in the first place.
   */
  screenshotSupported?: boolean;
  /** The stages to offer a filter for. If left out, the panel offers every stage. */
  stages?: OfferedStages;
  /**
   * The feedback of the page as text (FRU-109). If left out, the panel has no button to copy it:
   * a button that copies nothing is worse than no button.
   */
  exportText?: () => string;
  document?: Document;
  /** The widget's words (FRU-37). Left out: English, with dates in this document's language. */
  translator?: Translator;
  /**
   * The corner the dock stands in while the reporter chose none (FRU-472): the host's, or the
   * default of the reading direction. Given, the panel offers the four corners under « Pins shown »
   * and writes the choice to the store, which the widget follows. Left out, no corner is offered:
   * a choice that moves nothing is worse than no choice.
   */
  dockCorner?: () => DockPosition;
};

export type ConfigPanel = {
  open(): void;
  close(): void;
  toggle(): void;
  readonly isOpen: boolean;
  destroy(): void;
};

/**
 * The stages the worker can report, as the last read said (FRU-32).
 *
 * Not in `ConfigStore`: that store keeps the reporter's preferences in `localStorage`. This list
 * comes from the worker, and a stored copy would outlive a change of store.
 */
export type OfferedStages = {
  get(): readonly NoteStage[];
  set(stages: readonly NoteStage[]): void;
  subscribe(listener: () => void): () => void;
};

export function createOfferedStages(): OfferedStages {
  let current: readonly NoteStage[] = NOTE_STAGES;
  const listeners = new Set<() => void>();

  return {
    get: () => current,
    set(stages) {
      current = [...stages];
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
  };
}

export function createConfigPanel(options: ConfigPanelOptions): ConfigPanel {
  const document = options.document ?? options.host.ownerDocument ?? globalThis.document;
  const store = options.store;
  const offered = options.stages ?? createOfferedStages();
  const t = options.translator ?? createTranslator({ language: languageOf(document) });

  const root = document.createElement('div');
  root.className = 'fruitback-panel-config';
  root.dataset.fruitbackConfig = '';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', t.text('settings.dialog'));

  const stages = document.createElement('div');
  stages.className = 'fruitback-config-stages';
  const stageInputs = new Map<NoteStage, HTMLInputElement>();
  const stageLabels = new Map<NoteStage, HTMLLabelElement>();
  for (const stage of NOTE_STAGES) {
    // A chip for each status (FRU-305): the drop of its colour and its name. The box stays, out of
    // sight and in the order of the keyboard.
    const { input, label } = checkbox(document, `stage-${stage}`, t.stage(stage), 'chip');
    const drop = document.createElement('span');
    drop.className = 'fruitback-config-chip-drop';
    drop.setAttribute('aria-hidden', 'true');
    drop.style.setProperty('--fruitback-pin-color', stageToken(stage));
    input.after(drop);
    stageInputs.set(stage, input);
    stageLabels.set(stage, label);
    stages.append(label);
  }

  // Two switches, as the mock-up draws them (FRU-305). Still boxes, which say « on » and « off ».
  const { input: hideResolved, label: hideResolvedLabel } = checkbox(
    document,
    'hide-resolved',
    t.text('settings.hideResolved'),
    'switch',
  );

  const { input: screenshot, label: screenshotLabel } = checkbox(
    document,
    'screenshot',
    t.text('settings.screenshot'),
    'switch',
  );

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'fruitback-config-close';
  close.setAttribute('aria-label', t.text('settings.close'));
  close.append(createIcon(document, 'close'));

  // A div, not a header: Playwright's selectors pierce open shadow roots, so a generic tag here
  // makes the client's own `header button` ambiguous for anything that inspects the composed tree.
  // The dialog already carries its name through `aria-label`.
  const head = document.createElement('div');
  head.className = 'fruitback-config-head';
  const title = document.createElement('span');
  title.className = 'fruitback-config-title';
  // The drop of the mark in the accent, before the word (FRU-305).
  const mark = createIcon(document, 'mark');
  const words = document.createElement('span');
  words.textContent = t.text('settings.title');
  title.append(mark, words);
  head.append(title, close);

  const stagesTitle = document.createElement('p');
  stagesTitle.className = 'fruitback-config-legend';
  stagesTitle.textContent = t.text('settings.stages');

  // FRU-472: the corner of the dock, under the statuses. Four radios in the corners of a square, in
  // the order of the window whatever the reading direction: a corner is a corner of the window.
  const corners = new Map<DockPosition, HTMLInputElement>();
  const cornersTitle = document.createElement('p');
  cornersTitle.className = 'fruitback-config-legend';
  cornersTitle.id = 'fruitback-config-position';
  cornersTitle.textContent = t.text('settings.position');
  const cornersGroup = document.createElement('div');
  cornersGroup.className = 'fruitback-config-corners';
  cornersGroup.setAttribute('role', 'radiogroup');
  cornersGroup.setAttribute('aria-labelledby', cornersTitle.id);
  for (const corner of CORNER_ORDER) {
    const label = document.createElement('label');
    label.className = 'fruitback-config-corner';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'dock-position';
    input.value = corner;
    const drawing = document.createElement('span');
    drawing.className = 'fruitback-config-corner-drawing';
    drawing.dataset.fruitbackCorner = corner;
    drawing.setAttribute('aria-hidden', 'true');
    const words = document.createElement('span');
    words.textContent = t.text(CORNER_WORDS[corner]);
    label.append(input, drawing, words);
    input.addEventListener('change', () => {
      if (input.checked) store.set({ position: corner });
    });
    corners.set(corner, input);
    cornersGroup.append(label);
  }

  const body = document.createElement('div');
  body.className = 'fruitback-config-body';
  body.append(stagesTitle, stages, hideResolvedLabel);
  if (options.dockCorner !== undefined) body.append(cornersTitle, cornersGroup);
  if (options.screenshotSupported === true) body.append(screenshotLabel);
  root.append(head, body);
  if (options.exportText !== undefined) root.append(copySection(options.exportText));
  const style = adoptStyles(options.host, STYLES);
  options.host.append(root);
  const focus = holdFocus(root, () => panel.close());

  /** The store is the truth; the inputs only ever mirror it. */
  function paint(): void {
    const config = store.get();
    const available = offered.get();

    // A stage that the store cannot report gets no box. If the reporter hid that stage before, it
    // stays in the config, so a worker that reports it again shows the reporter's choice.
    for (const [stage, label] of stageLabels) label.hidden = !available.includes(stage);
    hideResolvedLabel.hidden = !RESOLVED_STAGES.some((stage) => available.includes(stage));

    for (const [stage, input] of stageInputs) input.checked = !config.hiddenStages.includes(stage);
    hideResolved.checked = RESOLVED_STAGES.filter((stage) => available.includes(stage)).every((stage) =>
      config.hiddenStages.includes(stage),
    );
    screenshot.checked = config.screenshot;
    if (options.dockCorner !== undefined) {
      const current = config.position ?? options.dockCorner();
      for (const [corner, input] of corners) input.checked = corner === current;
    }
  }

  /**
   * The button that copies the feedback, and what it says after.
   *
   * A clipboard can refuse: no permission, no secure context, or a browser that has none. The text
   * then shows in a field with its content selected. A copy that fails with nothing to see reads as
   * a copy that worked.
   */
  function copySection(exportText: () => string): HTMLElement {
    const section = document.createElement('div');
    section.className = 'fruitback-config-copy';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fruitback-config-copy-button';
    button.textContent = t.text('settings.copy');

    const status = document.createElement('span');
    status.className = 'fruitback-config-copy-status';
    status.setAttribute('role', 'status');

    let manual: HTMLTextAreaElement | null = null;

    button.addEventListener('click', () => {
      const text = exportText();
      status.textContent = '';
      manual?.remove();
      manual = null;

      void writeToClipboard(text).then((copied) => {
        if (copied) {
          status.textContent = t.text('settings.copied');

          return;
        }

        manual = document.createElement('textarea');
        manual.className = 'fruitback-config-copy-text';
        manual.readOnly = true;
        manual.rows = 6;
        manual.value = text;
        manual.setAttribute('aria-label', t.text('settings.copyManually'));
        status.textContent = t.text('settings.copyManually');
        section.append(manual);
        // FRU-288: `select()` puts the end of the selection at the end of the text, and the field
        // scrolls to it: the person saw the last note, not the title. A backward selection keeps
        // all the text selected and puts its moving end at the start. `scrollTop` is set too,
        // because a browser can scroll on focus before the selection is made.
        manual.focus({ preventScroll: true });
        manual.setSelectionRange(0, text.length, 'backward');
        manual.scrollTop = 0;
      });
    });

    section.append(button, status);

    return section;
  }

  async function writeToClipboard(text: string): Promise<boolean> {
    try {
      const clipboard = document.defaultView?.navigator?.clipboard;
      if (clipboard === undefined) return false;
      await clipboard.writeText(text);

      return true;
    } catch {
      return false;
    }
  }

  /** The first stage that has a box, or the close button when the worker reports no stage. */
  function firstControl(): HTMLElement {
    const stage = NOTE_STAGES.find((candidate) => stageLabels.get(candidate)?.hidden === false);

    return (stage !== undefined ? stageInputs.get(stage) : undefined) ?? close;
  }

  function hiddenFromInputs(): NoteStage[] {
    return NOTE_STAGES.filter((stage) => stageInputs.get(stage)?.checked === false);
  }

  for (const input of stageInputs.values()) {
    input.addEventListener('change', () => store.set({ hiddenStages: hiddenFromInputs() }));
  }

  // The shortcut and the per-stage boxes describe the same state, so it is written once: the
  // shortcut sets the two resolved stages and leaves the others where the reporter put them.
  hideResolved.addEventListener('change', () => {
    const hidden = new Set(hiddenFromInputs());
    // A stage with no box keeps the choice the reporter made for it.
    for (const stage of RESOLVED_STAGES.filter((resolved) => offered.get().includes(resolved))) {
      if (hideResolved.checked) hidden.add(stage);
      else hidden.delete(stage);
    }
    store.set({ hiddenStages: NOTE_STAGES.filter((stage) => hidden.has(stage)) });
  });

  screenshot.addEventListener('change', () => store.set({ screenshot: screenshot.checked }));

  close.addEventListener('click', () => panel.close());

  // Painted from outside too: the config can change without this panel, and an open panel showing
  // stale values is a panel that overwrites the change on the next keystroke.
  const unsubscribe = store.subscribe(paint);
  const unsubscribeStages = offered.subscribe(paint);
  paint();

  const panel: ConfigPanel = {
    open() {
      paint();
      focus.remember();
      root.hidden = false;
      firstControl().focus();
    },
    close() {
      root.hidden = true;
      focus.restore();
    },
    toggle() {
      if (root.hidden) panel.open();
      else panel.close();
    },
    get isOpen() {
      return !root.hidden;
    },
    destroy() {
      unsubscribe();
      unsubscribeStages();
      focus.destroy();
      root.remove();
      style.remove();
    },
  };

  return panel;
}

/** In the order of the square they are drawn in: the top row, then the bottom one. */
const CORNER_ORDER: readonly DockPosition[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

const CORNER_WORDS = {
  'top-left': 'settings.position.topLeft',
  'top-right': 'settings.position.topRight',
  'bottom-left': 'settings.position.bottomLeft',
  'bottom-right': 'settings.position.bottomRight',
} as const satisfies Record<(typeof DOCK_POSITIONS)[number], string>;

/**
 * A box and its words. `chip`: a status, drawn as a chip whose box is out of sight (FRU-305).
 * `switch`: a row of words and a switch at its end, which is the box drawn otherwise, with the role
 * that says « on » and « off ».
 */
function checkbox(
  document: Document,
  name: string,
  text: string,
  kind: 'chip' | 'switch',
): { label: HTMLLabelElement; input: HTMLInputElement } {
  const label = document.createElement('label');
  label.className = kind === 'chip' ? 'fruitback-config-chip' : 'fruitback-config-check';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.name = name;
  if (kind === 'switch') input.setAttribute('role', 'switch');

  const span = document.createElement('span');
  span.textContent = text;

  // The words first and the switch at the end of the row; the box first in a chip.
  if (kind === 'switch') label.append(span, input);
  else label.append(input, span);

  return { label, input };
}

// No backticks in here: one inside this literal closes it and the module stops parsing.
const STYLES = `
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
