import { SEED_STAGE_STYLES, type SeedBounds, type SeedIssue } from '@fruitback/shared';
import { isElement } from './dom.ts';
import { type AnchorResolution, resolveAnchor } from './resolve.ts';

/**
 * The pins on the page: one box over each element someone left a note on, coloured by where the
 * issue has got to in Linear, and a thread behind each one.
 *
 * Two things shape the implementation more than anything else.
 *
 * **Document coordinates, not viewport ones.** A pin is placed at an absolute position in the
 * document, so it belongs to the page rather than to the current scroll offset. Everything is
 * re-measured on scroll and resize anyway — a `position: fixed` header moves relative to the
 * document as you scroll, and lazily loaded content reflows what is below it.
 *
 * **The overlay must not take the page hostage.** The client's site still has to be usable while
 * pins are on it, so the pin outlines let clicks through and only the badge is clickable. That is
 * also the difference between a widget people leave on and one they turn off.
 */

/** How long a note stays readable on the badge before it turns into a tooltip. */
const BADGE_MAX_LENGTH = 32;

/** Kept next to the stylesheet's `width`, because `positionThread` has to know it to flip sides. */
const THREAD_WIDTH = 300;
const THREAD_GAP = 8;

export type OverlayOptions = {
  document?: Document;
  /**
   * Where the overlay's own DOM lives. Defaults to a container on `<body>`; SKG-492's Shadow DOM
   * host will pass its root here, which is what finally isolates these styles from the client's.
   * Whatever is passed has to sit at the document origin and be unpositioned, or the pins land
   * somewhere else — absolute positions resolve against the nearest positioned ancestor.
   */
  host?: Element | ShadowRoot;
  /** Called when a pin is clicked, in case the host wants to do more than open the thread. */
  onSelect?: (issue: SeedIssue) => void;
};

export type Overlay = {
  /** Draw this set of pins, replacing whatever was there. */
  render(issues: SeedIssue[]): void;
  /** Re-measure every pin. Called for you on scroll and resize. */
  reposition(): void;
  /** What each pin resolved to, in render order — the honest account of what was found. */
  resolutions(): { issue: SeedIssue; strategy: AnchorResolution['strategy'] }[];
  destroy(): void;
};

type Placed = {
  issue: SeedIssue;
  resolution: AnchorResolution;
  pin: HTMLElement;
};

export function createOverlay(options: OverlayOptions = {}): Overlay {
  const document = options.document ?? globalThis.document;
  const view = document.defaultView;
  const container = document.createElement('div');
  container.className = 'fb-overlay';
  container.dataset.fruitbackOverlay = '';

  const style = document.createElement('style');
  style.textContent = STYLES;

  const host = options.host ?? document.body;
  host.append(style, container);

  let placed: Placed[] = [];
  let thread: HTMLElement | null = null;
  let frame = 0;

  function schedule(): void {
    if (view === null || frame !== 0) return;

    frame = view.requestAnimationFrame(() => {
      frame = 0;
      reposition();
    });
  }

  function reposition(): void {
    for (const entry of placed) place(entry);
    if (thread !== null) positionThread(thread, placed.find((entry) => entry.pin.dataset.fbOpen === '')?.pin);
  }

  function place(entry: Placed): void {
    // An orphan keeps the box it was planted on: the element is gone, and its last known position is
    // the only thing left that says anything about where the note was pointing.
    //
    // `isConnected` is the same case arriving late. On an SPA the element we resolved can be torn out
    // of the document between two renders, and a detached node measures 0×0 — which would slide the
    // pin to the top-left corner of the page and look like a bug in the positioning rather than a
    // page that moved on. The next `render` re-resolves it properly; until then it degrades here.
    const element = entry.resolution.element;
    const attached = element !== null && element.isConnected;
    const rect = attached ? documentRect(element) : boundsToPixels(entry.issue.seed.anchor.bounds, document);

    entry.pin.classList.toggle('fb-pin-orphan', !attached);
    entry.pin.classList.toggle('fb-pin-uncertain', !attached || !entry.resolution.confident);

    Object.assign(entry.pin.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  }

  function render(issues: SeedIssue[]): void {
    closeThread();
    container.replaceChildren();

    placed = issues.map((issue) => {
      const resolution = resolveAnchor(issue.seed.anchor, { document });
      const pin = buildPin(document, issue, resolution);
      const entry = { issue, resolution, pin };

      pin.querySelector('.fb-pin-badge')?.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openThread(entry);
      });

      container.append(pin);
      place(entry);

      return entry;
    });
  }

  function openThread(entry: Placed): void {
    closeThread();
    entry.pin.dataset.fbOpen = '';
    thread = buildThread(document, entry.issue, entry.resolution);
    thread.querySelector('.fb-thread-close')?.addEventListener('click', () => closeThread());
    container.append(thread);
    positionThread(thread, entry.pin);
    options.onSelect?.(entry.issue);
  }

  function closeThread(): void {
    thread?.remove();
    thread = null;
    for (const entry of placed) delete entry.pin.dataset.fbOpen;
  }

  function onDocumentClick(event: Event): void {
    if (thread === null) return;

    // `composedPath`, not `event.target`: once the overlay lives in a Shadow root (SKG-492), a click
    // inside the thread is retargeted to the host element on the way out, and `contains` would say
    // the click came from outside and close the thread the user just clicked into.
    const path = event.composedPath();
    const inside = path.length > 0 ? path.includes(thread) : isElement(event.target) && thread.contains(event.target);

    if (!inside) closeThread();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') closeThread();
  }

  view?.addEventListener('scroll', schedule, { passive: true, capture: true });
  view?.addEventListener('resize', schedule, { passive: true });
  document.addEventListener('click', onDocumentClick, true);
  document.addEventListener('keydown', onKeyDown);

  return {
    render,
    reposition,
    resolutions: () => placed.map((entry) => ({ issue: entry.issue, strategy: entry.resolution.strategy })),
    destroy() {
      if (frame !== 0) view?.cancelAnimationFrame(frame);
      view?.removeEventListener('scroll', schedule, true);
      view?.removeEventListener('resize', schedule);
      document.removeEventListener('click', onDocumentClick, true);
      document.removeEventListener('keydown', onKeyDown);
      closeThread();
      container.remove();
      style.remove();
      placed = [];
    },
  };
}

function buildPin(document: Document, issue: SeedIssue, resolution: AnchorResolution): HTMLElement {
  const style = SEED_STAGE_STYLES[issue.stage];
  const pin = document.createElement('div');

  // Three looks, because they mean three different things: found by identity, placed by position,
  // and not found at all.
  pin.className = [
    'fb-pin',
    resolution.confident ? '' : 'fb-pin-uncertain',
    resolution.element === null ? 'fb-pin-orphan' : '',
  ]
    .filter(Boolean)
    .join(' ');
  pin.style.setProperty('--fb-pin-color', style.color);
  pin.dataset.fbPin = issue.seed.id;
  pin.dataset.fbStage = issue.stage;
  pin.dataset.fbStrategy = resolution.strategy;
  pin.dataset.fbConfident = String(resolution.confident);

  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = 'fb-pin-badge';
  badge.title = `${issue.identifier} · ${issue.stateName}`;
  // The `≈` is the whole warning, in one character, where the pin is: this one was placed by
  // coordinates, not recognised.
  badge.textContent = `${style.emoji} ${resolution.confident ? '' : '≈ '}${summarise(issue)}`;
  pin.append(badge);

  return pin;
}

function summarise(issue: SeedIssue): string {
  const firstLine = issue.seed.note
    .split('\n')
    .find((line) => line.trim().length > 0)
    ?.trim();
  if (firstLine === undefined) return issue.identifier;

  return firstLine.length > BADGE_MAX_LENGTH ? `${firstLine.slice(0, BADGE_MAX_LENGTH - 1)}…` : firstLine;
}

/** Note, status, who said it, and the way through to Linear, which owns everything else. */
function buildThread(document: Document, issue: SeedIssue, resolution: AnchorResolution): HTMLElement {
  const style = SEED_STAGE_STYLES[issue.stage];
  const thread = document.createElement('div');
  thread.className = 'fb-thread';
  thread.dataset.fbThread = issue.seed.id;
  thread.style.setProperty('--fb-pin-color', style.color);

  const reporter = issue.seed.reporter?.name ?? issue.seed.reporter?.email ?? 'Anonyme';
  const planted = new Date(issue.seed.createdAt);

  thread.append(
    element(document, 'header', 'fb-thread-head', [
      element(document, 'span', 'fb-thread-stage', `${style.emoji} ${issue.stateName}`),
      closeButton(document),
    ]),
    element(document, 'p', 'fb-thread-note', issue.seed.note || 'Aucune note.'),
    element(
      document,
      'p',
      'fb-thread-meta',
      `${reporter} · ${Number.isNaN(planted.getTime()) ? issue.seed.createdAt : planted.toLocaleDateString()}`,
    ),
    // Said out loud rather than hidden. A reader who is told the pin might be on the wrong element
    // checks; a reader who is told nothing believes it.
    ...uncertaintyNote(document, resolution),
    link(document, issue),
  );

  return thread;
}

function uncertaintyNote(document: Document, resolution: AnchorResolution): HTMLElement[] {
  if (resolution.element === null) {
    return [element(document, 'p', 'fb-thread-orphan', 'Élément introuvable — position approximative.')];
  }
  if (!resolution.confident) {
    return [
      element(
        document,
        'p',
        'fb-thread-orphan',
        'Élément retrouvé par sa position, pas par son identité — la page a peut-être changé sous le pin.',
      ),
    ];
  }

  return [];
}

function closeButton(document: Document): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'fb-thread-close';
  button.setAttribute('aria-label', 'Fermer');
  button.textContent = '×';

  return button;
}

function link(document: Document, issue: SeedIssue): HTMLElement {
  const anchor = document.createElement('a');
  anchor.className = 'fb-thread-link';
  anchor.href = issue.url;
  anchor.target = '_blank';
  anchor.rel = 'noreferrer noopener';
  anchor.textContent = `${issue.identifier} sur Linear →`;

  return anchor;
}

function element(document: Document, tag: string, className: string, content: string | HTMLElement[]): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (typeof content === 'string') node.textContent = content;
  else node.append(...content);

  return node;
}

/** Below the pin when there is room for it on screen, above it when there is not. */
function positionThread(thread: HTMLElement, pin: HTMLElement | undefined): void {
  if (pin === undefined) return;

  const view = thread.ownerDocument.defaultView;
  const left = Number.parseFloat(pin.style.left) || 0;
  const top = Number.parseFloat(pin.style.top) || 0;
  const pinHeight = Number.parseFloat(pin.style.height) || 0;
  const viewportWidth = view?.innerWidth ?? 0;
  const viewportHeight = view?.innerHeight ?? 0;
  const scrollY = view?.scrollY ?? 0;

  // Measured after insertion, so this is the height the thread actually took.
  const threadHeight = thread.offsetHeight;
  const below = top + pinHeight + THREAD_GAP;
  const roomBelow = below + threadHeight <= scrollY + viewportHeight;

  thread.style.left = `${Math.max(THREAD_GAP, Math.min(left, viewportWidth - THREAD_WIDTH - THREAD_GAP))}px`;
  thread.style.top = `${roomBelow ? below : Math.max(0, top - threadHeight - THREAD_GAP)}px`;
}

function documentRect(element: Element): { left: number; top: number; width: number; height: number } {
  const view = element.ownerDocument.defaultView;
  const rect = element.getBoundingClientRect();

  return {
    left: rect.left + (view?.scrollX ?? 0),
    top: rect.top + (view?.scrollY ?? 0),
    width: rect.width,
    height: rect.height,
  };
}

function boundsToPixels(
  bounds: SeedBounds,
  document: Document,
): { left: number; top: number; width: number; height: number } {
  const view = document.defaultView;
  const width = Math.max(document.documentElement.scrollWidth, view?.innerWidth ?? 0);
  const height = Math.max(document.documentElement.scrollHeight, view?.innerHeight ?? 0);

  return {
    left: (bounds.xPct / 100) * width,
    top: (bounds.yPct / 100) * height,
    width: (bounds.wPct / 100) * width,
    height: (bounds.hPct / 100) * height,
  };
}

/**
 * Kept in one string rather than set per element: when the host becomes a Shadow root (SKG-492) this
 * whole sheet moves inside it untouched, and the class names stop mattering.
 */
const STYLES = `
.fb-overlay { position: absolute; top: 0; left: 0; }
.fb-pin {
  position: absolute;
  z-index: 2147483000;
  /* Clicks go through to the client's page: the pin is an annotation, not a lid. */
  pointer-events: none;
  border: 2px solid var(--fb-pin-color);
  border-radius: 6px;
  background: color-mix(in srgb, var(--fb-pin-color) 12%, transparent);
}
.fb-pin-uncertain { border-style: dashed; opacity: 0.85; }
.fb-pin-orphan { border-style: dotted; }
.fb-pin-badge {
  position: absolute;
  bottom: 100%;
  left: -2px;
  margin-bottom: 4px;
  /* …except this, which is the one thing you can click. */
  pointer-events: auto;
  border: 0;
  border-radius: 5px;
  padding: 4px 7px;
  background: var(--fb-pin-color);
  color: #fff;
  font: 600 11px/1.2 -apple-system, system-ui, sans-serif;
  white-space: nowrap;
  cursor: pointer;
}
.fb-thread {
  position: absolute;
  z-index: 2147483100;
  width: 300px;
  pointer-events: auto;
  border: 1px solid #d6d3d1;
  border-top: 3px solid var(--fb-pin-color);
  border-radius: 10px;
  padding: 12px 14px;
  background: #fff;
  color: #1c1917;
  font: 14px/1.5 -apple-system, system-ui, sans-serif;
  box-shadow: 0 10px 34px rgba(0, 0, 0, 0.18);
}
.fb-thread-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.fb-thread-stage { font-weight: 600; font-size: 13px; }
.fb-thread-close { border: 0; background: none; font-size: 18px; line-height: 1; cursor: pointer; color: #78716c; }
.fb-thread-note { margin: 8px 0 0; white-space: pre-wrap; }
.fb-thread-meta { margin: 8px 0 0; font-size: 12px; color: #78716c; }
.fb-thread-orphan { margin: 8px 0 0; font-size: 12px; color: #8d6e63; }
.fb-thread-link { display: inline-block; margin-top: 10px; font-size: 13px; color: #e53935; }
`;
