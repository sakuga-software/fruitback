import { SEED_STAGES, SEED_STAGE_STYLES, type SeedStage } from '@fruitback/shared';
import { RESOLVED_STAGES, type ConfigStore } from './config.ts';

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

  const style = document.createElement('style');
  style.textContent = STYLES;

  const root = document.createElement('div');
  root.className = 'fb-panel-config';
  root.dataset.fbConfig = '';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Réglages Fruitback');

  const endpoint = field(document, 'endpoint', 'Worker', 'https://…');
  const clientId = field(document, 'client', 'Client', 'acme');

  const stages = document.createElement('div');
  stages.className = 'fb-config-stages';
  const stageInputs = new Map<SeedStage, HTMLInputElement>();
  for (const stage of SEED_STAGES) {
    const { input, label } = checkbox(
      document,
      `stage-${stage}`,
      `${SEED_STAGE_STYLES[stage].emoji} ${SEED_STAGE_STYLES[stage].label}`,
    );
    stageInputs.set(stage, input);
    stages.append(label);
  }

  const { input: hideResolved, label: hideResolvedLabel } = checkbox(
    document,
    'hide-resolved',
    'Masquer les feedbacks résolus',
  );

  const { input: screenshot, label: screenshotLabel } = checkbox(
    document,
    'screenshot',
    'Joindre une image de l’élément',
  );

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'fb-config-close';
  close.setAttribute('aria-label', 'Fermer les réglages');
  close.textContent = '×';

  // A div, not a header: Playwright's selectors pierce open shadow roots, so a generic tag here
  // makes the client's own `header button` ambiguous for anything that inspects the composed tree.
  // The dialog already carries its name through `aria-label`.
  const head = document.createElement('div');
  head.className = 'fb-config-head';
  const title = document.createElement('span');
  title.className = 'fb-config-title';
  title.textContent = '🌱 Réglages';
  head.append(title, close);

  const stagesTitle = document.createElement('p');
  stagesTitle.className = 'fb-config-legend';
  stagesTitle.textContent = 'Pins affichés';

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
  label.className = 'fb-config-field';

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
  label.className = 'fb-config-check';

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
.fb-panel-config {
  position: fixed;
  right: 16px;
  bottom: 68px;
  z-index: 2147483000;
  width: 280px;
  padding: 14px;
  border-radius: 14px;
  background: #fff;
  color: #1c1917;
  font-size: 13px;
  line-height: 1.45;
  box-shadow: 0 10px 30px rgb(0 0 0 / 18%);
}
.fb-panel-config[hidden] { display: none; }
.fb-config-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.fb-config-title { font-weight: 600; }
.fb-config-close {
  border: 0; background: none; font-size: 18px; line-height: 1; cursor: pointer; color: #78716c;
}
.fb-config-field { display: block; margin-top: 10px; }
.fb-config-field span { display: block; margin-bottom: 3px; font-size: 12px; color: #78716c; }
.fb-config-field input {
  display: block; width: 100%; padding: 6px 8px; border: 1px solid #d6d3d1; border-radius: 8px;
  font: inherit; color: inherit; background: #fff;
}
.fb-config-field input:focus-visible { outline: 2px solid #e53935; outline-offset: 1px; }
.fb-config-legend { margin: 12px 0 4px; font-size: 12px; color: #78716c; }
.fb-config-stages { display: flex; flex-direction: column; gap: 2px; }
.fb-config-check { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.fb-config-check input {
  /*
    all:initial in the host reset sets appearance to none, which is its initial value — so a native
    checkbox draws nothing at all. The boxes were invisible while still being checkable, which no
    unit test could see. Restored here, next to the size that depends on it.
  */
  appearance: auto;
  -webkit-appearance: checkbox;
  width: 14px;
  height: 14px;
  accent-color: #e53935;
}
.fb-panel-config > .fb-config-check { margin-top: 10px; padding-top: 10px; border-top: 1px solid #e7e5e4; }
.fb-panel-config > .fb-config-check + .fb-config-check { margin-top: 6px; padding-top: 0; border-top: 0; }
@media (max-width: 480px) {
  .fb-panel-config { right: 8px; left: 8px; width: auto; }
}
`;
