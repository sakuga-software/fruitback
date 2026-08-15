import type { SeedSource } from '@fruitback/shared';
import { isElement } from './dom.ts';
import { type CaptureEngine, reactGrabEngine } from './engine.ts';

/**
 * The widget's own patch of DOM, and the selection mode that runs inside it.
 *
 * **Everything the widget draws lives in one Shadow root.** That is not tidiness: the widget runs on
 * a stranger's site, under CSS nobody has read, and a `button { width: 100% }` in their stylesheet
 * would otherwise reshape our toolbar while our own rules leaked back into their page. A Shadow root
 * makes both directions impossible, which is the only version of "no style conflicts" that survives
 * contact with a real client site.
 *
 * Two consequences worth knowing before changing anything here:
 *
 * - **The host sits at the document origin, unpositioned in the page's terms**, because the overlay
 *   places pins in document coordinates and absolute positions resolve against the nearest positioned
 *   ancestor. `createOverlay({ host: host.root })` relies on it.
 * - **Hit testing has to be told to ignore us.** react-grab traverses open shadow roots, so without a
 *   filter the pointer lands on our own highlight box instead of the element behind it.
 */

export type CaptureTarget = {
  element: Element;
  /** From react-grab, when the build kept the metadata. Goes straight into `captureSeed`. */
  source: SeedSource | undefined;
};

export type CaptureHostOptions = {
  document?: Document;
  /** Swapped in the tests; production wants react-grab. */
  engine?: CaptureEngine;
  /** The reporter picked an element. The note UI is the caller's business (SKG-493). */
  onSelect: (target: CaptureTarget) => void;
  /** Label on the floating button. */
  label?: string;
  /**
   * Adds a settings button next to the floating one, and calls this when it is pressed (SKG-503).
   * Left out, there is no button — a widget with a gear that opens nothing is worse than none.
   */
  onConfigure?: () => void;
  /**
   * Anything else the pointer must skip. The widget already excludes itself; a page that mounts its
   * own chrome around the widget — a dev toolbar, the config panel of SKG-503 — says so here, or the
   * reporter ends up leaving feedback about the feedback button.
   */
  ignore?: (element: Element) => boolean;
};

export type CaptureHost = {
  /** Where to mount widget UI — pins included. Pass it to `createOverlay({ host })`. */
  root: ShadowRoot;
  /** Extra UI inside the Shadow root, e.g. the note popover. */
  panel: HTMLElement;
  start(): void;
  stop(): void;
  capturing(): boolean;
  destroy(): void;
};

export function createCaptureHost(options: CaptureHostOptions): CaptureHost {
  const document = options.document ?? globalThis.document;
  const engine = options.engine ?? reactGrabEngine;
  const view = document.defaultView;

  const container = document.createElement('div');
  container.dataset.fruitbackHost = '';
  // Positioned at the document origin with no size of its own: children can then use document
  // coordinates directly, and nothing about it disturbs the page's layout.
  container.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;';
  document.body.append(container);

  const root = container.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLES;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'fb-launch';
  button.dataset.fbHostLaunch = '';
  button.textContent = options.label ?? '🌱 Laisser un feedback';

  // Beside the launch button rather than inside the settings panel, because the panel is what it
  // opens. Only built when there is something to open.
  const configure = document.createElement('button');
  configure.type = 'button';
  configure.className = 'fb-configure';
  configure.dataset.fbHostConfigure = '';
  // Distinct from the panel's own name: two things sharing one accessible name is ambiguous to a
  // screen reader, and to anything else that finds elements by their name.
  configure.setAttribute('aria-label', 'Ouvrir les réglages Fruitback');
  configure.textContent = '⚙';

  const highlight = document.createElement('div');
  highlight.className = 'fb-highlight';
  highlight.dataset.fbHostHighlight = '';

  const panel = document.createElement('div');
  panel.className = 'fb-panel';
  panel.dataset.fbHostPanel = '';

  root.append(style, button, highlight, panel);
  if (options.onConfigure !== undefined) root.append(configure);

  configure.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    options.onConfigure?.();
  });

  let capturing = false;
  let hovered: Element | null = null;

  /** Anything of ours, wherever it sits in the composed tree — plus whatever the caller disowns. */
  const isOurs = (element: Element) =>
    element === container || root.contains(element) || options.ignore?.(element) === true;

  function onMove(event: MouseEvent): void {
    if (!capturing) return;

    const element = engine.elementAt(event.clientX, event.clientY, isOurs);
    hovered = element;

    if (element === null) {
      highlight.style.display = 'none';
      return;
    }

    const bounds = engine.boundsOf(element);
    Object.assign(highlight.style, {
      display: 'block',
      left: `${bounds.left + (view?.scrollX ?? 0)}px`,
      top: `${bounds.top + (view?.scrollY ?? 0)}px`,
      width: `${bounds.width}px`,
      height: `${bounds.height}px`,
    });
  }

  function onClick(event: MouseEvent): void {
    if (!capturing) return;
    // Our own launch button is inside the Shadow root, so a click on it arrives here retargeted;
    // `composedPath` is what tells the two apart.
    if (event.composedPath().some((node) => isElement(node) && isOurs(node))) return;

    // The page must not act on this click: the reporter is pointing, not using the site.
    event.preventDefault();
    event.stopPropagation();

    const element = engine.elementAt(event.clientX, event.clientY, isOurs) ?? hovered;
    if (element === null) return;

    stop();
    // A seed with no `source` is a perfectly good seed, so a rejecting engine costs the metadata and
    // nothing else. Without the catch, a swapped-in engine that throws would drop the capture on the
    // floor and leave an unhandled rejection behind — the reporter's note lost to a missing filename.
    void engine
      .sourceOf(element)
      .catch(() => undefined)
      .then((source) => options.onSelect({ element, source }));
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') stop();
  }

  function start(): void {
    capturing = true;
    container.dataset.fbCapturing = '';
    button.textContent = 'Échap pour annuler';
  }

  function stop(): void {
    capturing = false;
    hovered = null;
    delete container.dataset.fbCapturing;
    button.textContent = options.label ?? '🌱 Laisser un feedback';
    highlight.style.display = 'none';
  }

  button.addEventListener('click', () => (capturing ? stop() : start()));
  // Capture phase, so the page's own handlers never see the pointer while selection is on.
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);

  return {
    root,
    panel,
    start,
    stop,
    capturing: () => capturing,
    destroy() {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeyDown, true);
      container.remove();
    },
  };
}

/**
 * `all: initial` on every element, because a Shadow root stops the page's *selectors* but not its
 * inherited properties: `body { font-family: Papyrus }` reaches in here otherwise.
 */
const STYLES = `
:host { all: initial; }
* { all: initial; box-sizing: border-box; font-family: -apple-system, system-ui, sans-serif; }
/*
  all:initial is thorough enough to undo the browser's own display:none on a style element, which
  then renders the stylesheet as a column of visible text in the corner of the client's page. Found
  by looking at it; no unit test would have, since happy-dom draws nothing.
*/
style, script { display: none; }
/*
  And it undoes the browser's display:block on every block element, so a paragraph is inline until
  something says otherwise: in the note thread the note, its byline and the "found by position"
  warning all ran together into one line, vertical margins silently doing nothing. Restoring it here
  rather than on each class is what keeps the next element added to the widget from inheriting the
  same surprise. Found by looking at a recording — every unit test passed.
*/
div, p, header, footer, section, form { display: block; }
li { display: list-item; }
.fb-launch {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483200;
  padding: 10px 14px;
  border-radius: 999px;
  background: #e53935;
  color: #fff;
  font: 600 13px/1 -apple-system, system-ui, sans-serif;
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.25);
  cursor: pointer;
}
.fb-configure {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483200;
  width: 30px;
  height: 30px;
  border-radius: 999px;
  background: #44403c;
  color: #fff;
  font: 600 14px/1 -apple-system, system-ui, sans-serif;
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.25);
  cursor: pointer;
  /* Left of the launch button, whose width the widget does not know: the label is the embedder's. */
  transform: translateX(calc(-100% - 8px));
}
.fb-highlight {
  position: absolute;
  display: none;
  z-index: 2147483100;
  /* The reporter is aiming at the page, not at this box. */
  pointer-events: none;
  outline: 2px solid #e53935;
  background: rgba(229, 57, 53, 0.08);
  border-radius: 4px;
}
.fb-panel { position: absolute; top: 0; left: 0; }
:host([data-fb-capturing]) .fb-launch { background: #44403c; }
`;
