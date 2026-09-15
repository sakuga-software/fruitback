import type { SeedSource } from '@fruitback/shared';
import { isElement } from './dom.ts';
import { deepActiveElement } from './focus.ts';
import { type FruitbackTheme, THEME_STYLES, applyTheme } from './theme.ts';
import { type CaptureEngine, reactGrabEngine } from './engine.ts';
import { createIcon } from './icons.ts';
import { type Translator, createTranslator, languageOf } from './messages.ts';

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
  /** Label on the floating button. Wins over the translated one: a host's label is the host's word. */
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
  /**
   * Design tokens the host overrides (SKG-528). Colours, shadows, the font family, the animation
   * durations — and nothing else: `applyTheme` writes only the names `ThemeToken` enumerates.
   */
  theme?: FruitbackTheme;
  /** The widget's words (SKG-530). Left out: English, with dates in this document's language. */
  translator?: Translator;
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
  const t = options.translator ?? createTranslator({ language: languageOf(document) });
  const restingLabel = options.label ?? t.text('launch.label');

  const container = document.createElement('div');
  container.dataset.fruitbackHost = '';
  // Inherited by everything in the Shadow root. The positions below are document coordinates and do
  // not follow it (SKG-531).
  container.dir = t.direction;
  container.lang = t.lang;
  // A named landmark: a screen reader meets the widget in the middle of the host's content (SKG-544).
  container.setAttribute('role', 'region');
  container.setAttribute('aria-label', t.text('widget.label'));
  // Positioned at the document origin with no size of its own: children can then use document
  // coordinates directly, and nothing about it disturbs the page's layout.
  container.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;';
  document.body.append(container);

  // Written on the host element rather than into the stylesheet, so an inline custom property wins
  // over the `:host` declaration without needing a more specific selector.
  applyTheme(container, options.theme);

  const root = container.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  // Tokens first: every other stylesheet in this root — the overlay's, the composer's, the panel's —
  // resolves `var(--fruitback-…)` against them by inheritance, without importing anything.
  style.textContent = THEME_STYLES + STYLES;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'fruitback-launch';
  button.dataset.fruitbackHostLaunch = '';
  // The seed the button plants, as the shape the page will then show — not as an emoji (SKG-529).
  // The label lives in its own span so that setting it never removes the icon, and so the button's
  // accessible name stays exactly the label: the SVG is aria-hidden and contributes no text.
  const launchLabel = document.createElement('span');
  launchLabel.textContent = restingLabel;
  button.append(createIcon(document, 'drop'), launchLabel);

  // Beside the launch button rather than inside the settings panel, because the panel is what it
  // opens. Only built when there is something to open.
  const configure = document.createElement('button');
  configure.type = 'button';
  configure.className = 'fruitback-configure';
  configure.dataset.fruitbackHostConfigure = '';
  // Distinct from the panel's own name: two things sharing one accessible name is ambiguous to a
  // screen reader, and to anything else that finds elements by their name.
  configure.setAttribute('aria-label', t.text('settings.open'));
  configure.append(createIcon(document, 'gear'));

  const highlight = document.createElement('div');
  highlight.className = 'fruitback-highlight';
  highlight.dataset.fruitbackHostHighlight = '';

  const panel = document.createElement('div');
  panel.className = 'fruitback-panel';
  panel.dataset.fruitbackHostPanel = '';

  // A dock rather than two fixed corners: the gear has to sit beside a button whose width is the
  // embedder's label, and no offset computed from the gear's own size can know that. It overlapped
  // the launch button until a recording showed it.
  const dock = document.createElement('div');
  dock.className = 'fruitback-dock';
  if (options.onConfigure !== undefined) dock.append(configure);
  dock.append(button);

  const announcer = document.createElement('div');
  announcer.className = 'fruitback-announcer';
  announcer.dataset.fruitbackAnnouncer = '';
  announcer.setAttribute('role', 'status');
  announcer.setAttribute('aria-live', 'polite');

  root.append(style, dock, highlight, panel, announcer);

  configure.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    // The settings dialog must own the keys, and the capture mode takes the arrows and Enter.
    stop();
    options.onConfigure?.();
  });

  let capturing = false;
  let hovered: Element | null = null;

  /** Anything of ours, wherever it sits in the composed tree — plus whatever the caller disowns. */
  const isOurs = (element: Element) =>
    element === container || root.contains(element) || options.ignore?.(element) === true;

  const isCandidate = (element: Element) => !isOurs(element) && engine.grabbable(element);

  function onMove(event: MouseEvent): void {
    if (!capturing) return;

    show(engine.elementAt(event.clientX, event.clientY, isOurs));
  }

  function show(element: Element | null): void {
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

    select(element);
  }

  function select(element: Element): void {
    stop();
    // A seed with no `source` is a perfectly good seed, so a rejecting engine costs the metadata and
    // nothing else. Without the catch, a swapped-in engine that throws would drop the capture on the
    // floor and leave an unhandled rejection behind — the reporter's note lost to a missing filename.
    void engine
      .sourceOf(element)
      .catch(() => undefined)
      .then((source) => options.onSelect({ element, source }));
  }

  /**
   * The capture mode without a pointer (SKG-544).
   *
   * - Down and Up move to the next or previous element in document order.
   * - Left moves to the parent and Right to the first child. The two keys swap in a right-to-left language.
   * - Enter or Space selects the highlighted element.
   */
  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      stop();

      return;
    }
    if (!capturing) return;
    if (dialogHasFocus()) return;

    const target = keyboardTarget(event.key);
    if (target !== undefined) {
      // The page must not scroll under the reporter.
      event.preventDefault();
      event.stopPropagation();
      if (target !== null) point(target);

      return;
    }

    if ((event.key === 'Enter' || event.key === ' ') && hovered !== null) {
      // Without this, Enter also presses the launch button that has focus, and stops the capture.
      event.preventDefault();
      event.stopPropagation();
      select(hovered);
    }
  }

  /** A dialog of the widget that has focus owns the keys. */
  function dialogHasFocus(): boolean {
    const active = deepActiveElement(document);

    return active !== null && root.contains(active) && active.closest('[role="dialog"]') !== null;
  }

  /** The element a navigation key moves to, `null` if there is none, `undefined` for another key. */
  function keyboardTarget(key: string): Element | null | undefined {
    const body = document.body;
    const [toParent, toChild] = t.direction === 'rtl' ? ['ArrowRight', 'ArrowLeft'] : ['ArrowLeft', 'ArrowRight'];
    const next = (element: Element) => following(element, body);
    const previous = (element: Element) => preceding(element, body);
    const parent = (element: Element) => (element.parentElement === body ? null : element.parentElement);

    if (key === 'ArrowDown') return search(hovered === null ? body.firstElementChild : next(hovered), next);
    if (key === 'ArrowUp') {
      return hovered === null ? search(body.firstElementChild, next) : search(previous(hovered), previous);
    }
    if (key === toParent) return hovered === null ? null : search(parent(hovered), parent);
    if (key === toChild) return hovered === null ? null : search(hovered.firstElementChild, next, hovered);

    return undefined;
  }

  function search(start: Element | null, step: (element: Element) => Element | null, inside?: Element): Element | null {
    for (let node = start; node !== null; node = step(node)) {
      if (inside !== undefined && !inside.contains(node)) return null;
      if (isCandidate(node)) return node;
    }

    return null;
  }

  function point(element: Element): void {
    if (typeof (element as HTMLElement).scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    show(element);
    announcer.textContent = describe(element, t);
  }

  function start(): void {
    capturing = true;
    container.dataset.fruitbackCapturing = '';
    launchLabel.textContent = t.text('launch.capturing');
    announcer.textContent = t.text('capture.instructions');
  }

  function stop(): void {
    capturing = false;
    hovered = null;
    delete container.dataset.fruitbackCapturing;
    launchLabel.textContent = restingLabel;
    highlight.style.display = 'none';
    announcer.textContent = '';
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

/** The next element in document order, inside `root`. */
function following(element: Element, root: Element): Element | null {
  if (element.firstElementChild !== null) return element.firstElementChild;

  for (let node: Element | null = element; node !== null && node !== root; node = node.parentElement) {
    if (node.nextElementSibling !== null) return node.nextElementSibling;
  }

  return null;
}

/** The previous element in document order, inside `root`. */
function preceding(element: Element, root: Element): Element | null {
  const sibling = element.previousElementSibling;
  if (sibling === null) return element.parentElement === root ? null : element.parentElement;

  let node = sibling;
  while (node.lastElementChild !== null) node = node.lastElementChild;

  return node;
}

/** What a screen reader says about the element under the keyboard cursor. */
function describe(element: Element, t: Translator): string {
  const tag = element.tagName.toLowerCase();
  const text = (element.getAttribute('aria-label') ?? element.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (text === '') return t.text('capture.elementEmpty', { tag });

  return t.text('capture.element', { tag, text: text.length > 80 ? `${text.slice(0, 79)}…` : text });
}

/**
 * `all: initial` on every element, because a Shadow root stops the page's *selectors* but not its
 * inherited properties: `body { font-family: Papyrus }` reaches in here otherwise.
 */
const STYLES = `
:host { all: initial; }
/*
  The reset stops at the edge of an SVG, and that exclusion is load-bearing rather than tidy. Under a
  plain star selector, a path computes d:none and stroke:none — the geometry itself is a CSS property
  since SVG2, so all:initial erases the drawing. Every icon renders as an empty box, with no error
  anywhere. Measured in Chromium before this was written (SKG-529).
*/
*:not(svg, svg *) { all: initial; box-sizing: border-box; color: inherit; font: inherit; letter-spacing: inherit; }
/*
  all:initial also stops inheritance. Without the three inherit values above, an element with no colour
  rule of its own is black at 16px: the launch label on a chip, and the thread and the panel on a dark
  surface, where axe measured 1.2 to 1 (SKG-544). The host gives the first values to inherit.
*/
:host { color: var(--fruitback-color-text); font: 14px/1.45 var(--fruitback-font-sans); }
/*
  all:initial is thorough enough to undo the browser's own display:none on a style element, which
  then renders the stylesheet as a column of visible text in the corner of the client's page. Found
  by looking at it; no unit test would have, since happy-dom draws nothing.
*/
style, script { display: none; }
/* The reset also removes the focus ring. The keyboard reaches these controls, so they must show focus (SKG-544). */
button:focus-visible, a:focus-visible, input:focus-visible, textarea:focus-visible {
  outline: 2px solid var(--fruitback-color-accent);
  outline-offset: 2px;
}
/*
  And it undoes the browser's display:block on every block element, so a paragraph is inline until
  something says otherwise: in the note thread the note, its byline and the "found by position"
  warning all ran together into one line, vertical margins silently doing nothing. Restoring it here
  rather than on each class is what keeps the next element added to the widget from inheriting the
  same surprise. Found by looking at a recording — every unit test passed.
*/
div, p, header, footer, section, form { display: block; }
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
.fruitback-dock {
  position: fixed;
  inset-inline-end: 16px;
  bottom: 16px;
  z-index: 2147483200;
  display: flex;
  align-items: center;
  gap: 6px;
}
.fruitback-launch {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 14px;
  border-radius: var(--fruitback-radius-pill);
  background: var(--fruitback-color-accent);
  color: var(--fruitback-color-on-accent);
  /* Tightened tracking rather than a smaller size: the label is the widget's only voice on the
     page, and shrinking it is how a control starts looking like an advert. */
  font: 600 13px/1 var(--fruitback-font-sans);
  letter-spacing: -0.006em;
  box-shadow: var(--fruitback-shadow-md);
  cursor: pointer;
}
.fruitback-configure {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: var(--fruitback-radius-pill);
  background: var(--fruitback-color-chip);
  color: var(--fruitback-color-on-chip);
  font: 600 14px/1 var(--fruitback-font-sans);
  box-shadow: var(--fruitback-shadow-md);
  cursor: pointer;
}
.fruitback-highlight {
  position: absolute;
  display: none;
  z-index: 2147483100;
  /* The reporter is aiming at the page, not at this box. */
  pointer-events: none;
  outline: 2px solid var(--fruitback-color-accent);
  background: color-mix(in srgb, var(--fruitback-color-accent) 8%, transparent);
  border-radius: var(--fruitback-radius-sm);
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
:host([data-fruitback-capturing]) .fruitback-launch { background: var(--fruitback-color-chip); }
`;
