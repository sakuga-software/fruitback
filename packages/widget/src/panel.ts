import { SEED_STAGES, type SeedStage } from '@fruitback/shared';
import { type Translator, createTranslator, languageOf } from './messages.ts';
import { RESOLVED_STAGES, type ConfigStore } from './config.ts';
import { createIcon } from './icons.ts';

/**
 * The settings panel, opened from the floating button (SKG-503).
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
   * Whether the embedder gave `init` a way to capture an image (SKG-495). Without one the toggle is
   * not rendered at all: a switch that controls nothing is worse than no switch, which is why this
   * setting was left out of SKG-503 in the first place.
   */
  screenshotSupported?: boolean;
  document?: Document;
  /** The widget's words (SKG-530). Left out: English, with dates in this document's language. */
  translator?: Translator;
};

export type ConfigPanel = {
  open(): void;
  close(): void;
  toggle(): void;
  readonly isOpen: boolean;
  destroy(): void;
};

export function createConfigPanel(options: ConfigPanelOptions): ConfigPanel {
  const document = options.document ?? options.host.ownerDocument ?? globalThis.document;
  const store = options.store;
  const t = options.translator ?? createTranslator({ language: languageOf(document) });

  const style = document.createElement('style');
  style.textContent = STYLES;

  const root = document.createElement('div');
  root.className = 'fruitback-panel-config';
  root.dataset.fruitbackConfig = '';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', t.text('settings.dialog'));

  const endpoint = field(document, 'endpoint', t.text('settings.endpoint'), 'https://…');
  const clientId = field(document, 'client', t.text('settings.client'), 'acme');

  const stages = document.createElement('div');
  stages.className = 'fruitback-config-stages';
  const stageInputs = new Map<SeedStage, HTMLInputElement>();
  for (const stage of SEED_STAGES) {
    const { input, label } = checkbox(document, `stage-${stage}`, t.stage(stage));
    stageInputs.set(stage, input);
    stages.append(label);
  }

  const { input: hideResolved, label: hideResolvedLabel } = checkbox(
    document,
    'hide-resolved',
    t.text('settings.hideResolved'),
  );

  const { input: screenshot, label: screenshotLabel } = checkbox(document, 'screenshot', t.text('settings.screenshot'));

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
  title.textContent = t.text('settings.title');
  head.append(title, close);

  const stagesTitle = document.createElement('p');
  stagesTitle.className = 'fruitback-config-legend';
  stagesTitle.textContent = t.text('settings.stages');

  root.append(head, endpoint.label, clientId.label, stagesTitle, stages, hideResolvedLabel);
  if (options.screenshotSupported === true) root.append(screenshotLabel);
  options.host.append(style, root);

  /** The store is the truth; the inputs only ever mirror it. */
  function paint(): void {
    const config = store.get();
    endpoint.input.value = config.endpoint;
    clientId.input.value = config.clientId;

    for (const [stage, input] of stageInputs) input.checked = !config.hiddenStages.includes(stage);
    hideResolved.checked = RESOLVED_STAGES.every((stage) => config.hiddenStages.includes(stage));
    screenshot.checked = config.screenshot;
  }

  function hiddenFromInputs(): SeedStage[] {
    return SEED_STAGES.filter((stage) => stageInputs.get(stage)?.checked === false);
  }

  endpoint.input.addEventListener('input', () => store.set({ endpoint: endpoint.input.value.trim() }));
  clientId.input.addEventListener('input', () => store.set({ clientId: clientId.input.value.trim() }));

  for (const input of stageInputs.values()) {
    input.addEventListener('change', () => store.set({ hiddenStages: hiddenFromInputs() }));
  }

  // The shortcut and the per-stage boxes describe the same state, so it is written once: the
  // shortcut sets the two resolved stages and leaves the others where the reporter put them.
  hideResolved.addEventListener('change', () => {
    const hidden = new Set(hiddenFromInputs());
    for (const stage of RESOLVED_STAGES) {
      if (hideResolved.checked) hidden.add(stage);
      else hidden.delete(stage);
    }
    store.set({ hiddenStages: SEED_STAGES.filter((stage) => hidden.has(stage)) });
  });

  screenshot.addEventListener('change', () => store.set({ screenshot: screenshot.checked }));

  close.addEventListener('click', () => panel.close());

  // Painted from outside too: the config can change without this panel, and an open panel showing
  // stale values is a panel that overwrites the change on the next keystroke.
  const unsubscribe = store.subscribe(paint);
  paint();

  const panel: ConfigPanel = {
    open() {
      paint();
      root.hidden = false;
      endpoint.input.focus();
    },
    close() {
      root.hidden = true;
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
      root.remove();
      style.remove();
    },
  };

  return panel;
}

function field(
  document: Document,
  name: string,
  text: string,
  placeholder: string,
): { label: HTMLLabelElement; input: HTMLInputElement } {
  const label = document.createElement('label');
  label.className = 'fruitback-config-field';

  const span = document.createElement('span');
  span.textContent = text;

  const input = document.createElement('input');
  input.type = 'text';
  input.name = name;
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.autocomplete = 'off';

  label.append(span, input);

  return { label, input };
}

function checkbox(
  document: Document,
  name: string,
  text: string,
): { label: HTMLLabelElement; input: HTMLInputElement } {
  const label = document.createElement('label');
  label.className = 'fruitback-config-check';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.name = name;

  const span = document.createElement('span');
  span.textContent = text;

  label.append(input, span);

  return { label, input };
}

// No backticks in here: one inside this literal closes it and the module stops parsing.
const STYLES = `
.fruitback-panel-config {
  position: fixed;
  right: 16px;
  bottom: 68px;
  z-index: 2147483000;
  width: 280px;
  padding: 14px;
  border-radius: var(--fruitback-radius-lg);
  background: var(--fruitback-color-surface);
  color: var(--fruitback-color-text);
  font-size: 13px;
  line-height: 1.45;
  box-shadow: var(--fruitback-shadow-lg);
}
.fruitback-panel-config[hidden] { display: none; }
.fruitback-config-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.fruitback-config-title { font-weight: 600; letter-spacing: -0.006em; }
.fruitback-config-close {
  display: grid;
  place-items: center;
  border: 0;
  background: none;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  color: var(--fruitback-color-text-muted);
}
.fruitback-config-close:hover { color: var(--fruitback-color-text); }
.fruitback-config-field { display: block; margin-top: 10px; }
.fruitback-config-field span {
  display: block;
  margin-bottom: 3px;
  font-size: 12px;
  color: var(--fruitback-color-text-muted);
}
.fruitback-config-field input {
  display: block;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--fruitback-color-border-strong);
  border-radius: var(--fruitback-radius-sm);
  font: inherit; color: inherit; background: var(--fruitback-color-surface);
}
.fruitback-config-field input:focus-visible { outline: 2px solid var(--fruitback-color-accent); outline-offset: 1px; }
.fruitback-config-legend { margin: 12px 0 4px; font-size: 12px; color: var(--fruitback-color-text-muted); }
.fruitback-config-stages { display: flex; flex-direction: column; gap: 2px; }
.fruitback-config-check { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.fruitback-config-check input {
  /*
    all:initial in the host reset sets appearance to none, which is its initial value — so a native
    checkbox draws nothing at all. The boxes were invisible while still being checkable, which no
    unit test could see. Restored here, next to the size that depends on it.
  */
  appearance: auto;
  -webkit-appearance: checkbox;
  width: 14px;
  height: 14px;
  accent-color: var(--fruitback-color-accent);
}
.fruitback-panel-config > .fruitback-config-check {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--fruitback-color-border);
}
.fruitback-panel-config > .fruitback-config-check + .fruitback-config-check {
  margin-top: 6px;
  padding-top: 0;
  border-top: 0;
}
@media (max-width: 480px) {
  .fruitback-panel-config { right: 8px; left: 8px; width: auto; }
}
`;
