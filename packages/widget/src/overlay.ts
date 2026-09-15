import { type SeedBounds, type SeedIssue } from '@fruitback/shared';
import { type Direction, type Translator, createTranslator, languageOf } from './messages.ts';
import { createIcon } from './icons.ts';
import { stageToken } from './theme.ts';
import { isElement } from './dom.ts';
import { deepActiveElement } from './focus.ts';
import { createOrphanList, type OrphanList } from './orphans.ts';
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
 * **The page moves under it, and nothing announces that.** Scroll and resize do not fire when a
 * framework swaps a subtree, so the overlay watches the document and re-resolves. A client's app
 * cannot do that for it (SKG-513).
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

/** A framework commit arrives as several mutation bursts. Resolving on each one repeats the cascade. */
const RESOLVE_DEBOUNCE_MS = 100;

/**
 * The ceiling on that coalescing.
 *
 * The timer restarts on every mutation. Without this cap, a page that mutates continuously restarts
 * it indefinitely and the pins are never resolved at all.
 */
const RESOLVE_MAX_WAIT_MS = 500;

export type OverlayOptions = {
  document?: Document;
  /**
   * Where the overlay's own DOM lives. Defaults to a container on `<body>`; SKG-492's Shadow DOM
   * host will pass its root here, which is what finally isolates these styles from the client's.
   * Whatever is passed has to sit at the document origin and be unpositioned, or the pins land
   * somewhere else — absolute positions resolve against the nearest positioned ancestor.
   */
  host?: Element | ShadowRoot;
  /**
   * Which pins to draw. Re-read on `refilter`, so a preference change does not need the issues to be
   * fetched again (SKG-503). Defaults to drawing everything.
   */
  shouldShow?: (issue: SeedIssue) => boolean;
  /** Called when a pin is clicked, in case the host wants to do more than open the thread. */
  onSelect?: (issue: SeedIssue) => void;
  /**
   * Called after the overlay re-resolves its pins on its own. The host is told, so it never has to
   * detect the change itself — which a client's app cannot do.
   */
  onResolve?: (resolutions: { issue: SeedIssue; strategy: AnchorResolution['strategy'] }[]) => void;
  /** The widget's words (SKG-530). Left out: English, with dates in this document's language. */
  translator?: Translator;
};

export type Overlay = {
  /** Draw this set of pins, replacing whatever was there. */
  render(issues: SeedIssue[]): void;
  /** Re-measure every pin. Called for you on scroll and resize. */
  reposition(): void;
  /**
   * Resolve every pin against the document as it is now, keeping the drawn pins and the open thread.
   * Called for you when the page mutates. Use `render` for new data.
   */
  resolve(): void;
  /**
   * Draw the last rendered set again through `shouldShow`. The issues are kept, so hiding a stage and
   * showing it again costs no request.
   */
  refilter(): void;
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
  const t = options.translator ?? createTranslator({ language: languageOf(document) });
  const container = document.createElement('div');
  container.className = 'fruitback-overlay';
  container.dataset.fruitbackOverlay = '';

  const style = document.createElement('style');
  style.textContent = STYLES;

  const host = options.host ?? document.body;
  host.append(style, container);

  /**
   * The notes whose element the cascade could not find at all (SKG-501).
   *
   * Owned here rather than by the embedder for the same reason the mutation observer is: on a
   * client's site there is nobody to notice that a redeploy detached three pins and no one to build
   * a list of them.
   */
  const orphans: OrphanList = createOrphanList({
    document,
    host,
    translator: t,
    onSelect: (issue) => {
      const entry = placed.find((candidate) => candidate.issue.seed.id === issue.seed.id);
      if (entry !== undefined) openThread(entry);
    },
  });

  // What `render` was last given, before filtering — `refilter` draws from here.
  let source: SeedIssue[] = [];
  let placed: Placed[] = [];
  let thread: HTMLElement | null = null;
  let frame = 0;
  let resolveTimer: ReturnType<typeof setTimeout> | undefined;
  let burstStartedAt = 0;

  function schedule(): void {
    if (view === null || frame !== 0) return;

    frame = view.requestAnimationFrame(() => {
      frame = 0;
      reposition();
    });
  }

  function resolutions(): { issue: SeedIssue; strategy: AnchorResolution['strategy'] }[] {
    return placed.map((entry) => ({ issue: entry.issue, strategy: entry.resolution.strategy }));
  }

  function reposition(): void {
    for (const entry of placed) place(entry);
    if (thread !== null)
      positionThread(thread, placed.find((entry) => entry.pin.dataset.fruitbackOpen === '')?.pin, t.direction);
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

    entry.pin.classList.toggle('fruitback-pin-orphan', !attached);
    entry.pin.classList.toggle('fruitback-pin-uncertain', !attached || !entry.resolution.confident);

    Object.assign(entry.pin.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  }

  /**
   * Re-run the cascade for every pin on screen, in place.
   *
   * Not `render`: that rebuilds the DOM and closes the thread, and a page can mutate while someone
   * reads a note. A resolution can change from `selector` to `bounds` and back, so the confidence
   * marks are re-applied.
   */
  function resolve(): void {
    if (placed.length === 0) return;

    const open = placed.find((entry) => entry.pin.dataset.fruitbackOpen === '');

    for (const entry of placed) {
      entry.resolution = resolveAnchor(entry.issue.seed.anchor, { document });
      applyResolution(entry.pin, entry.issue, entry.resolution, t);
      place(entry);
    }

    observeAnchors();
    listOrphans();

    // The thread quotes the resolution, so it is rebuilt rather than left contradicting its pin.
    if (open !== undefined && thread !== null) reopenThread(open);

    options.onResolve?.(resolutions());
  }

  /**
   * Coalesce a burst of mutations into one resolution: `resolveAnchor` runs a query per pin.
   *
   * The timer restarts on each mutation, so a commit longer than the debounce is handled once
   * instead of twice. `RESOLVE_MAX_WAIT_MS` caps that restarting.
   */
  function scheduleResolve(): void {
    const now = Date.now();

    if (resolveTimer === undefined) {
      burstStartedAt = now;
    } else if (now - burstStartedAt >= RESOLVE_MAX_WAIT_MS) {
      return;
    } else {
      clearTimeout(resolveTimer);
    }

    resolveTimer = setTimeout(() => {
      resolveTimer = undefined;
      resolve();
    }, RESOLVE_DEBOUNCE_MS);
  }

  /**
   * The widget's own DOM must not wake the observer.
   *
   * A Shadow root host hides it: mutations inside one never reach a document observer. The default
   * `<body>` host does not, and re-resolving mutates the container again.
   */
  function isOurs(node: Node): boolean {
    return container.contains(node) || node === container || node === style || orphans.owns(node);
  }

  function onMutations(records: MutationRecord[]): void {
    const fromThePage = records.some(
      (record) =>
        !isOurs(record.target) && ![...record.addedNodes, ...record.removedNodes].every((node) => isOurs(node)),
    );

    if (fromThePage) scheduleResolve();
  }

  /**
   * An element can move with no change to the document structure: a sibling loads an image, a font
   * swaps, a flex container reflows. The mutation observer does not see those.
   */
  function observeAnchors(): void {
    if (anchors === undefined) return;

    anchors.disconnect();
    for (const entry of placed) {
      if (entry.resolution.element !== null) anchors.observe(entry.resolution.element);
    }
  }

  function render(issues: SeedIssue[]): void {
    // A copy: `refilter` draws from this later, and a caller who keeps mutating the array they
    // passed would otherwise change what is on screen with no render of their own.
    source = [...issues];
    draw();
  }

  function refilter(): void {
    draw();
  }

  function draw(): void {
    closeThread();
    container.replaceChildren();

    placed = source
      .filter((issue) => options.shouldShow?.(issue) ?? true)
      .map((issue) => {
        const resolution = resolveAnchor(issue.seed.anchor, { document });
        const pin = buildPin(document, issue, resolution, t);
        const entry = { issue, resolution, pin };

        pin.querySelector('.fruitback-pin-badge')?.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          openThread(entry);
        });

        container.append(pin);
        place(entry);

        return entry;
      });

    observeAnchors();
    listOrphans();
  }

  /** A note is detached when nothing identified *or located* its element — resolveAnchor's last word. */
  function listOrphans(): void {
    orphans.update(placed.filter((entry) => entry.resolution.element === null).map((entry) => entry.issue));
  }

  /** Re-render the open thread against a resolution that has just changed under it. */
  function reopenThread(entry: Placed): void {
    const focused = threadHasFocus();
    thread?.remove();
    thread = buildThread(document, entry.issue, entry.resolution, t);
    thread.querySelector('.fruitback-thread-close')?.addEventListener('click', () => closeThread());
    container.append(thread);
    positionThread(thread, entry.pin, t.direction);
    if (focused) thread.querySelector<HTMLElement>('.fruitback-thread-close')?.focus();
  }

  function openThread(entry: Placed): void {
    closeThread();
    entry.pin.dataset.fruitbackOpen = '';
    thread = buildThread(document, entry.issue, entry.resolution, t);
    thread.querySelector('.fruitback-thread-close')?.addEventListener('click', () => closeThread());
    container.append(thread);
    positionThread(thread, entry.pin, t.direction);
    // The thread is the last child of the container, far from its badge in the tab order.
    thread.querySelector<HTMLElement>('.fruitback-thread-close')?.focus();
    options.onSelect?.(entry.issue);
  }

  function closeThread(): void {
    const focused = threadHasFocus();
    const opener = placed.find((entry) => entry.pin.dataset.fruitbackOpen !== undefined);
    thread?.remove();
    thread = null;
    for (const entry of placed) delete entry.pin.dataset.fruitbackOpen;
    if (focused) opener?.pin.querySelector<HTMLElement>('.fruitback-pin-badge')?.focus();
  }

  function threadHasFocus(): boolean {
    const active = deepActiveElement(document);

    return thread !== null && active !== null && thread.contains(active);
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

  // Structure only, no `attributes`. A design system toggles classes on every hover, and an element
  // that changed class but stayed in place needs no re-resolution. A replaced element always shows
  // up as a childList change.
  //
  // Taken off the document's own window, never `globalThis` — the same realm rule as `isElement` in
  // `dom.ts`. An iframe document, and the happy-dom one the tests mount, carry their own
  // constructors. Reading the global gets Node's, which has none, so the widget watches nothing and
  // does not fail.
  const mutations = view?.MutationObserver === undefined ? undefined : new view.MutationObserver(onMutations);
  mutations?.observe(document, { childList: true, subtree: true });

  // happy-dom has no ResizeObserver, and neither does an old browser.
  const anchors = view?.ResizeObserver === undefined ? undefined : new view.ResizeObserver(() => schedule());

  return {
    render,
    reposition,
    resolve,
    refilter,
    resolutions,
    destroy() {
      if (frame !== 0) view?.cancelAnimationFrame(frame);
      if (resolveTimer !== undefined) clearTimeout(resolveTimer);
      mutations?.disconnect();
      anchors?.disconnect();
      view?.removeEventListener('scroll', schedule, true);
      view?.removeEventListener('resize', schedule);
      document.removeEventListener('click', onDocumentClick, true);
      document.removeEventListener('keydown', onKeyDown);
      closeThread();
      orphans.destroy();
      container.remove();
      style.remove();
      placed = [];
      source = [];
    },
  };
}

function buildPin(document: Document, issue: SeedIssue, resolution: AnchorResolution, t: Translator): HTMLElement {
  const pin = document.createElement('div');

  pin.className = 'fruitback-pin';
  // The token rather than the hexadecimal the contract carries (SKG-528). One indirection buys the
  // dark theme, the host override and, once SKG-517 lands, a contract that stops shipping colours at
  // all — a widget's palette has no business travelling in the payload both ends must agree on.
  pin.style.setProperty('--fruitback-pin-color', stageToken(issue.stage));
  pin.dataset.fruitbackPin = issue.seed.id;
  pin.dataset.fruitbackStage = issue.stage;

  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = 'fruitback-pin-badge';
  badge.title = `${issue.identifier} · ${stateLabel(issue, t)}`;
  // The drop is rotated, so the glyph rides in its own span and is turned back upright.
  const glyph = document.createElement('span');
  glyph.className = 'fruitback-pin-glyph';
  badge.append(glyph);
  pin.append(badge);

  applyResolution(pin, issue, resolution, t);

  return pin;
}

/**
 * Everything on a pin that depends on what was found, rather than on which issue it is.
 *
 * A pin outlives its resolution: `resolve` re-resolves it in place, so the confidence marks have to
 * follow. Written once at build time, a pin that fell from `selector` to `bounds` kept claiming it
 * had been recognised.
 */
function applyResolution(pin: HTMLElement, issue: SeedIssue, resolution: AnchorResolution, t: Translator): void {
  // Three looks, because they mean three different things: found by identity, placed by position,
  // and not found at all.
  pin.classList.toggle('fruitback-pin-uncertain', !resolution.confident);
  pin.classList.toggle('fruitback-pin-orphan', resolution.element === null);
  pin.dataset.fruitbackStrategy = resolution.strategy;
  pin.dataset.fruitbackConfident = String(resolution.confident);

  const badge = pin.querySelector('.fruitback-pin-badge');
  // A drop of fruit rather than a rectangle of text. The note moves to the accessible name, which is
  // also what keeps it reachable by a screen reader and by a test looking for it by role.
  badge?.setAttribute(
    'aria-label',
    t.text(resolution.confident ? 'pin.label' : 'pin.labelUncertain', {
      stage: t.stage(issue.stage),
      note: summarise(issue),
    }),
  );
  const glyph = pin.querySelector('.fruitback-pin-glyph');
  // Empty when the pin is sure of itself (SKG-517): the drop's shape and its stage colour say which
  // stage it is, and the emoji that used to sit here was a rendering choice travelling in a published
  // type. The `≈` stays, because it is the whole warning in one character — this one was placed by
  // coordinates, not recognised — and a typographic symbol is not an emoji.
  if (glyph !== null) glyph.textContent = resolution.confident ? '' : '≈';
}

function summarise(issue: SeedIssue): string {
  const firstLine = issue.seed.note
    .split('\n')
    .find((line) => line.trim().length > 0)
    ?.trim();
  if (firstLine === undefined) return issue.identifier;

  return firstLine.length > BADGE_MAX_LENGTH ? `${firstLine.slice(0, BADGE_MAX_LENGTH - 1)}…` : firstLine;
}

/**
 * The team's answers, oldest first (SKG-502).
 *
 * This is what closes the loop: someone leaves a note, the team replies in Linear, and the reply
 * shows up where the note was left rather than in an inbox the reporter does not have.
 *
 * Three states, and they are not the same. Comments absent means the worker was not asked for them —
 * the widget says nothing at all, because "no replies yet" would be a claim it cannot make. An empty
 * list means it asked and there were none, which is worth saying. Anything else is the thread.
 */
function replies(document: Document, issue: SeedIssue, t: Translator): HTMLElement[] {
  if (issue.comments === undefined) return [];

  if (issue.comments.length === 0) {
    return [element(document, 'p', 'fruitback-thread-empty', t.text('thread.noReplies'))];
  }

  const list = document.createElement('ul');
  list.className = 'fruitback-thread-replies';

  for (const comment of issue.comments) {
    const item = document.createElement('li');
    item.className = 'fruitback-thread-reply';
    item.append(
      byline(
        document,
        'span',
        'fruitback-thread-reply-who',
        comment.author ?? t.text('thread.team'),
        comment.createdAt,
        t,
      ),
      // `textContent`, never markup: this is Linear's markdown, written by whoever can comment on the
      // issue, rendered inside someone else's page. It is text here and nothing more.
      element(document, 'p', 'fruitback-thread-reply-body', comment.body),
    );
    list.append(item);
  }

  return [list];
}

/**
 * What the store calls this issue's state, or the stage when it calls it nothing.
 *
 * The Linear connector reports `node.state?.name ?? ''`, so an issue with no state gives an empty
 * string. That used to be hidden behind the stage's emoji; with the glyph gone (SKG-517) it surfaced
 * twice — an empty thread header, and a tooltip reading `SKG-742 · ` with a dangling separator.
 *
 * **A function and not the expression inlined twice**, because the second site is how this was found:
 * the header was fixed in review and the badge's `title` was left behind. Two copies of a fallback
 * are two chances to fix only one of them.
 *
 * `||` and not `??`: an empty string is exactly the case being caught, and `??` would let it through.
 */
function stateLabel(issue: SeedIssue, t: Translator): string {
  return issue.stateName || t.stage(issue.stage);
}

/** Note, status, who said it, and the way through to Linear, which owns everything else. */
function buildThread(document: Document, issue: SeedIssue, resolution: AnchorResolution, t: Translator): HTMLElement {
  const thread = document.createElement('div');
  thread.className = 'fruitback-thread';
  thread.dataset.fruitbackThread = issue.seed.id;
  thread.setAttribute('role', 'dialog');
  thread.setAttribute('aria-label', t.text('thread.dialog', { identifier: issue.identifier }));
  thread.style.setProperty('--fruitback-pin-color', stageToken(issue.stage));

  const reporter = issue.seed.reporter?.name ?? issue.seed.reporter?.email ?? t.text('thread.anonymous');

  thread.append(
    // A div, not a header: inside the widget's region landmark a header is a banner (SKG-544).
    element(document, 'div', 'fruitback-thread-head', [
      // The store's own word for the state, with no glyph in front of it. `stateName` is what the
      // store said — Linear's "In Progress", SQLite's own — and the stage colour is already on the
      // thread's top border through `--fruitback-pin-color`.
      //
      // See `stateLabel` for why this is not just `issue.stateName`.
      element(document, 'span', 'fruitback-thread-stage', stateLabel(issue, t)),
      closeButton(document, t),
    ]),
    element(document, 'p', 'fruitback-thread-note', issue.seed.note || t.text('thread.noNote')),
    byline(document, 'p', 'fruitback-thread-meta', reporter, issue.seed.createdAt, t),
    // Said out loud rather than hidden. A reader who is told the pin might be on the wrong element
    // checks; a reader who is told nothing believes it.
    ...uncertaintyNote(document, resolution, t),
    ...replies(document, issue, t),
    ...link(document, issue, t),
  );

  return thread;
}

function uncertaintyNote(document: Document, resolution: AnchorResolution, t: Translator): HTMLElement[] {
  if (resolution.element === null) {
    return [element(document, 'p', 'fruitback-thread-orphan', t.text('thread.orphan'))];
  }
  if (!resolution.confident) {
    return [element(document, 'p', 'fruitback-thread-orphan', t.text('thread.uncertain'))];
  }

  return [];
}

function closeButton(document: Document, t: Translator): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'fruitback-thread-close';
  button.setAttribute('aria-label', t.text('thread.close'));
  button.append(createIcon(document, 'close'));

  return button;
}

/**
 * The way out to the store's own interface, when it has one (SKG-524).
 *
 * Two things changed here, and both were the contract leaking. The label said **Linear** in a widget
 * that is not supposed to know which store is behind the worker — the same reason `502` reports
 * `store-unavailable` and not `linear-unavailable` (SKG-522). And `url` is now optional, because
 * SQLite has no page to open: rendering an anchor anyway would put a link on every pin that leads
 * back to the page the reader is already on, which reads as the store having lost the note.
 *
 * Returns an array so the caller spreads nothing when there is nowhere to go.
 */
function link(document: Document, issue: SeedIssue, t: Translator): HTMLElement[] {
  if (issue.url === undefined) return [];

  const anchor = document.createElement('a');
  anchor.className = 'fruitback-thread-link';
  anchor.href = issue.url;
  anchor.target = '_blank';
  anchor.rel = 'noreferrer noopener';
  // The identifier is the handle a human searches for; where it opens is the link's own business.
  anchor.textContent = t.text('thread.link', { identifier: issue.identifier });

  return [anchor];
}

/**
 * Who, and when, as a relative date (SKG-531). The absolute date goes in the title, for a reader who
 * needs the day. A date the store wrote in a shape `Date` cannot read is shown as it came.
 */
function byline(
  document: Document,
  tag: string,
  className: string,
  who: string,
  written: string,
  t: Translator,
): HTMLElement {
  const date = new Date(written);
  if (Number.isNaN(date.getTime())) return element(document, tag, className, `${who} · ${written}`);

  const node = element(document, tag, className, `${who} · ${t.relative(date)}`);
  node.title = t.date(date);

  return node;
}

function element(document: Document, tag: string, className: string, content: string | HTMLElement[]): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (typeof content === 'string') node.textContent = content;
  else node.append(...content);

  return node;
}

/**
 * Below the pin when there is room for it on screen, above it when there is not. Aligned on the pin's
 * start edge for the reading direction; the value stays a physical left, like the pin (SKG-531).
 */
function positionThread(thread: HTMLElement, pin: HTMLElement | undefined, direction: Direction): void {
  if (pin === undefined) return;

  const view = thread.ownerDocument.defaultView;
  const left = Number.parseFloat(pin.style.left) || 0;
  const top = Number.parseFloat(pin.style.top) || 0;
  const pinHeight = Number.parseFloat(pin.style.height) || 0;
  const pinWidth = Number.parseFloat(pin.style.width) || 0;
  const viewportWidth = view?.innerWidth ?? 0;
  const viewportHeight = view?.innerHeight ?? 0;
  const scrollX = view?.scrollX ?? 0;
  const scrollY = view?.scrollY ?? 0;

  // Measured after insertion, so this is the height the thread actually took.
  const threadHeight = thread.offsetHeight;
  const below = top + pinHeight + THREAD_GAP;
  const roomBelow = below + threadHeight <= scrollY + viewportHeight;
  const start = direction === 'rtl' ? left + pinWidth - THREAD_WIDTH : left;

  // The pin's left is in document coordinates, so the window it must stay inside starts at `scrollX` (SKG-607).
  thread.style.left = `${Math.max(scrollX + THREAD_GAP, Math.min(start, scrollX + viewportWidth - THREAD_WIDTH - THREAD_GAP))}px`;
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
.fruitback-overlay { position: absolute; top: 0; left: 0; }
.fruitback-pin {
  position: absolute;
  z-index: 2147483000;
  /* Clicks go through to the client's page: the pin is an annotation, not a lid. */
  pointer-events: none;
  border: 2px solid var(--fruitback-pin-color);
  border-radius: var(--fruitback-radius-sm);
  background: color-mix(in srgb, var(--fruitback-pin-color) 12%, transparent);
}
.fruitback-pin-uncertain { border-style: dashed; opacity: 0.85; }
.fruitback-pin-orphan { border-style: dotted; }
.fruitback-pin-badge {
  position: absolute;
  bottom: 100%;
  left: -6px;
  margin-bottom: 6px;
  /* …except this, which is the one thing you can click. */
  pointer-events: auto;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: 0;
  padding: 0;
  /* Three round corners and one sharp: a seed, pointing down at the element it belongs to. */
  border-radius: 50% 50% 50% 0;
  transform: rotate(-45deg);
  background: var(--fruitback-pin-color);
  color: var(--fruitback-color-on-stage);
  font: 13px/1 var(--fruitback-font-sans);
  cursor: pointer;
  box-shadow: var(--fruitback-shadow-sm);
  /* Squash and stretch: the drop lands, flattens, and settles. */
  animation: fruitback-pin-drop var(--fruitback-duration-slow) cubic-bezier(0.2, 1.4, 0.35, 1);
}
.fruitback-pin-glyph { transform: rotate(45deg); font-size: 13px; line-height: 1; }
.fruitback-pin-badge:hover { filter: brightness(1.06); }
.fruitback-pin-badge:focus-visible { outline: 2px solid var(--fruitback-color-text); outline-offset: 2px; }

@keyframes fruitback-pin-drop {
  0% { opacity: 0; transform: rotate(-45deg) translate(0, -10px) scale(0.7, 1.25); }
  55% { opacity: 1; transform: rotate(-45deg) translate(0, 0) scale(1.18, 0.82); }
  100% { opacity: 1; transform: rotate(-45deg) scale(1, 1); }
}

@media (prefers-reduced-motion: reduce) {
  .fruitback-pin-badge { animation: none; }
}
.fruitback-thread {
  position: absolute;
  z-index: 2147483100;
  width: 300px;
  pointer-events: auto;
  border: 1px solid var(--fruitback-color-border-strong);
  border-top: 3px solid var(--fruitback-pin-color);
  border-radius: var(--fruitback-radius-md);
  padding: 12px 14px;
  background: var(--fruitback-color-surface);
  color: var(--fruitback-color-text);
  font: 14px/1.5 var(--fruitback-font-sans);
  box-shadow: var(--fruitback-shadow-lg);
}
.fruitback-thread-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.fruitback-thread-stage { font-weight: 600; font-size: 13px; letter-spacing: -0.006em; }
.fruitback-thread-close {
  display: grid;
  place-items: center;
  border: 0;
  background: none;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  color: var(--fruitback-color-text-muted);
}
.fruitback-thread-close:hover { color: var(--fruitback-color-text); }
.fruitback-thread-note { margin: 8px 0 0; white-space: pre-wrap; }
.fruitback-thread-meta { margin: 8px 0 0; font-size: 12px; color: var(--fruitback-color-text-muted); }
.fruitback-thread-orphan { margin: 8px 0 0; font-size: 12px; color: var(--fruitback-color-warning); }
.fruitback-thread-empty {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--fruitback-color-text-subtle);
  font-style: italic;
}
.fruitback-thread-replies {
  margin: 10px 0 0;
  padding: 0;
  padding-inline-start: 10px;
  border-inline-start: 2px solid var(--fruitback-color-border);
  list-style: none;
  /* A long conversation belongs in Linear, which the link below goes to. */
  max-height: 180px;
  overflow-y: auto;
}
/*
  On the item, not only on the list. The host reset gives every element all:initial, which resets each
  item's own list-style-type to its initial value of disc — and a reset value beats what it would have
  inherited from the list. The bullets came back, and only a recording showed it.
*/
.fruitback-thread-reply { list-style: none; }
.fruitback-thread-reply + .fruitback-thread-reply { margin-top: 8px; }
.fruitback-thread-reply-who { display: block; font-size: 11px; color: var(--fruitback-color-text-muted); }
.fruitback-thread-reply-body { margin: 2px 0 0; font-size: 12px; white-space: pre-wrap; }
.fruitback-thread-link {
  display: inline-block;
  margin-top: 10px;
  font-size: 13px;
  color: var(--fruitback-color-accent);
}
`;
