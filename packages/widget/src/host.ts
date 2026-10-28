import { type DockPosition, parseDockPosition } from './dock-position.ts';
import type { NoteSource } from '@fruitback/shared';
import { isElement } from './dom.ts';
import { componentOf } from './capture.ts';
import { isStableClass, isStableId } from './selector.ts';
import { deepActiveElement } from './focus.ts';
import { CAPTURE_START } from './events.ts';
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
  /** From react-grab, when the build kept the metadata. Goes straight into `captureNote`. */
  source: NoteSource | undefined;
};

export type CaptureHostOptions = {
  document?: Document;
  /** Swapped in the tests; production wants react-grab. */
  engine?: CaptureEngine;
  /**
   * The words on the frame of a capture (FRU-411). Left out, `aboutTarget`: the short selector, then
   * the component. `init` passes the head of the composer, so the two follow « Show CSS selectors »
   * together when the host asks for it.
   */
  nameOf?: (element: Element, source: NoteSource | undefined) => string;
  /** The reporter picked an element. The note UI is the caller's business (FRU-4). */
  onSelect: (target: CaptureTarget) => void;
  /** Label on the floating button. Wins over the translated one: a host's label is the host's word. */
  label?: string;
  /**
   * Adds a settings button next to the floating one, and calls this when it is pressed (FRU-14).
   * Left out, there is no button — a widget with a gear that opens nothing is worse than none.
   */
  onConfigure?: () => void;
  /**
   * Adds a button for the list of every note of the page, and calls this when it is pressed
   * (FRU-129). Left out, there is no button, for the same reason as the gear.
   */
  onList?: () => void;
  /**
   * Anything else the pointer must skip. The widget already excludes itself; a page that mounts its
   * own chrome around the widget — a dev toolbar, the config panel of FRU-14 — says so here, or the
   * reporter ends up leaving feedback about the feedback button.
   */
  ignore?: (element: Element) => boolean;
  /**
   * Design tokens the host overrides (FRU-35). Colours, shadows, the font family, the animation
   * durations — and nothing else: `applyTheme` writes only the names `ThemeToken` enumerates.
   */
  theme?: FruitbackTheme;
  /** The widget's words (FRU-37). Left out: English, with dates in this document's language. */
  translator?: Translator;
  /** The corner of the dock (FRU-443). Left out: the bottom corner at the end of the line. */
  position?: DockPosition;
};

export type CaptureHost = {
  /** Where to mount widget UI — pins included. Pass it to `createOverlay({ host })`. */
  root: ShadowRoot;
  /** Extra UI inside the Shadow root, e.g. the note popover. */
  panel: HTMLElement;
  /**
   * The capsule of the dock (FRU-303). The overlay puts the chip of the detached notes at its start:
   * one capsule, and no chip that floats over it.
   */
  dock: HTMLElement;
  /** Moves the dock, and what opens from it, to another corner (FRU-443). `undefined`: back to the default. */
  moveDock(position: DockPosition | undefined): void;
  start(): void;
  stop(): void;
  capturing(): boolean;
  /**
   * Keep the frame of a capture on an element, with the name of its component, while the caller
   * writes about it (FRU-258): `hold` in `onSelect`, `release` when the note is sent or given up.
   * A caller that asks for nothing gets what it had: the frame goes when the element is chosen.
   */
  hold(element: Element): void;
  release(): void;
  /**
   * The notes of the page could not be read, or they could again (FRU-316). The button of the list
   * wears a dot and says it in its name, and the sentence of the list is announced once, so the
   * page says it without the list being opened. `opener`: the name of the button then, « could not
   * be read » unless the host says why (FRU-394).
   */
  readFailed(failed: boolean, sentence: string, opener?: string): void;

  /**
   * Choose an element as a click of a capture would, with its component, and hand it to
   * `onSelect` (FRU-311): the note left on it comes back when its page comes back.
   */
  choose(element: Element): void;
  /**
   * The launch button opens a sign-in instead of a capture (FRU-315), with these words; `undefined`
   * gives it back. A capture that runs stops: no note can start that the worker will refuse.
   */
  offerSignIn(offer: { label: string; onSignIn: () => void } | undefined): void;
  /**
   * The worker takes no note of this reader here (FRU-330): the launch button wears `label`, is
   * `aria-disabled`, and a press says `sentence` and starts nothing. No capture starts, by the button
   * or by `start`; one that runs stops. `undefined` gives the button back.
   */
  closeNotes(closed: { label: string; sentence: string } | undefined): void;
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
  // not follow it (FRU-38).
  container.dir = t.direction;
  container.lang = t.lang;
  // A named landmark: a screen reader meets the widget in the middle of the host's content (FRU-51).
  container.setAttribute('role', 'region');
  container.setAttribute('aria-label', t.text('widget.label'));
  // Positioned at the document origin with no size of its own: children can then use document
  // coordinates directly, and nothing about it disturbs the page's layout.
  container.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;';
  // FRU-443: the corner of the dock, read by the rules of every stylesheet of this root.
  const moveDock = (position: DockPosition | undefined): void => {
    const corner = parseDockPosition(position);
    if (corner === undefined) delete container.dataset.fruitbackPosition;
    else container.dataset.fruitbackPosition = corner;
  };
  moveDock(options.position);
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
  // The note the button plants, as the shape the page will then show — not as an emoji (FRU-36).
  // The label lives in its own span so that setting it never removes the icon, and so the button's
  // accessible name stays exactly the label: the SVG is aria-hidden and contributes no text.
  const launchLabel = document.createElement('span');
  launchLabel.textContent = restingLabel;
  button.append(createIcon(document, 'mark'), launchLabel);
  // A switch (FRU-258): its name stays, and `aria-pressed` says that a capture runs. It changed its
  // words to « Esc to cancel » until the banner took them, and a switch that also changes its name
  // says two things at once to a screen reader.
  button.setAttribute('aria-pressed', 'false');

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

  const listing = document.createElement('button');
  listing.type = 'button';
  listing.className = 'fruitback-listing';
  listing.dataset.fruitbackHostList = '';
  listing.setAttribute('aria-label', t.text('sidebar.open'));
  listing.append(createIcon(document, 'list'));
  // The dot of a read that failed (FRU-316): a drawing, the name of the button says the same.
  const alert = document.createElement('span');
  alert.className = 'fruitback-listing-alert';
  alert.setAttribute('aria-hidden', 'true');
  alert.hidden = true;
  listing.append(alert);

  const highlight = document.createElement('div');
  highlight.className = 'fruitback-highlight';
  highlight.dataset.fruitbackHostHighlight = '';
  // The name of the component behind the element, when the page gives one (FRU-258). A drawing for
  // the eye: the note carries the same name, and a screen reader hears the element itself.
  const tag = document.createElement('span');
  tag.className = 'fruitback-highlight-tag';
  tag.setAttribute('aria-hidden', 'true');
  tag.hidden = true;
  highlight.append(tag);

  // What a capture asks for, and the way out of it (FRU-258). Always in the tree and empty at rest:
  // a live region that was hidden announces nothing when it comes back.
  const banner = document.createElement('div');
  banner.className = 'fruitback-banner';
  banner.dataset.fruitbackHostBanner = '';
  banner.setAttribute('role', 'status');
  // The way out: the key that does it, drawn, then the word (FRU-303). The key is a drawing for the
  // eye: the name of the button is its word, and the banner reads how to move.
  const halt = document.createElement('button');
  halt.type = 'button';
  halt.className = 'fruitback-banner-stop';
  const haltKey = document.createElement('kbd');
  haltKey.className = 'fruitback-banner-key';
  haltKey.setAttribute('aria-hidden', 'true');
  haltKey.textContent = t.text('capture.escape');
  const haltLabel = document.createElement('span');
  haltLabel.textContent = t.text('capture.stop');

  const panel = document.createElement('div');
  panel.className = 'fruitback-panel';
  panel.dataset.fruitbackHostPanel = '';

  // One capsule (FRU-303): the detached notes, the list, the gear and the launch button, in this
  // order. The overlay puts the chip of the detached notes at its start. A capture turns the same
  // capsule dark and gives it the banner: the way out is where the way in was.
  // No landmark of its own: the host element is the region « Fruitback feedback », and a second
  // region with the same name is two landmarks that a screen reader cannot tell apart.
  const dock = document.createElement('div');
  dock.className = 'fruitback-dock';
  dock.dataset.fruitbackDock = '';
  if (options.onList !== undefined) dock.append(listing);
  if (options.onConfigure !== undefined) dock.append(configure);
  dock.append(button, banner);

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

  listing.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    // Like the gear: the list must own the keys, and the capture mode takes the arrows and Enter.
    stop();
    options.onList?.();
  });

  let capturing = false;
  /** The failure of a read that came during a capture, said when the capture ends (FRU-316). */
  let unsaid = '';
  let hovered: Element | null = null;
  /** The element the frame is held on after a choice, from `hold` to `release`. */
  let chosen: Element | null = null;
  /**
   * What the engine said of each element, asked once. The pointer crosses an element many times, and
   * the choice asks for the same answer. Emptied at each start: a page hot-reloads between two notes.
   */
  let sources = new WeakMap<Element, Promise<NoteSource | undefined>>();

  // A note with no `source` is a perfectly good note, so a rejecting engine costs the metadata and
  // nothing else. Without the catch, a swapped-in engine that throws would drop the capture on the
  // floor and leave an unhandled rejection behind — the reporter's note lost to a missing filename.
  function sourceOf(element: Element): Promise<NoteSource | undefined> {
    let source = sources.get(element);
    if (source === undefined) {
      try {
        source = engine.sourceOf(element).catch(() => undefined);
      } catch {
        source = Promise.resolve(undefined);
      }
      sources.set(element, source);
    }

    return source;
  }

  /** Anything of ours, wherever it sits in the composed tree — plus whatever the caller disowns. */
  const isOurs = (element: Element) =>
    element === container || root.contains(element) || options.ignore?.(element) === true;

  const isCandidate = (element: Element) => !isOurs(element) && engine.grabbable(element);

  function onMove(event: MouseEvent): void {
    if (!capturing) return;

    show(engine.elementAt(event.clientX, event.clientY, isOurs));
  }

  function show(element: Element | null): void {
    const changed = element !== hovered;
    hovered = element;

    if (element === null) {
      highlight.style.display = 'none';
      return;
    }

    frame(element);
    if (changed) name(element);
  }

  /**
   * The frame is a line of 2 px, 3 px off the element, as an outline would draw it (FRU-303). It
   * follows the corners of the element, grown by the same 5 px, so a round button gets a round frame.
   */
  function frame(element: Element): void {
    const bounds = engine.boundsOf(element);
    const top = bounds.top + (view?.scrollY ?? 0) - HIGHLIGHT_OUTSET;
    Object.assign(highlight.style, {
      display: 'block',
      left: `${bounds.left + (view?.scrollX ?? 0) - HIGHLIGHT_OUTSET}px`,
      top: `${top}px`,
      width: `${bounds.width + 2 * HIGHLIGHT_OUTSET}px`,
      height: `${bounds.height + 2 * HIGHLIGHT_OUTSET}px`,
      borderRadius: cornersOf(element, view),
    });
    // The name sits above the frame. At the top of the document there is no above: it goes inside.
    highlight.toggleAttribute('data-fruitback-tag-inside', top < TAG_ROOM);
  }

  /**
   * Write on the frame what the note will point at: a short selector, then the component when the
   * page gives one (FRU-303), as « button.add · <AddToCart> ». Only if the element is still framed.
   */
  function name(element: Element): void {
    const nameOf = options.nameOf;
    tag.textContent = nameOf === undefined ? shortSelector(element) : nameOf(element, undefined);
    tag.hidden = false;
    void sourceOf(element).then((source) => {
      if (element !== hovered && element !== chosen) return;
      // As text: a name is whatever the page called its component.
      tag.textContent = (nameOf ?? aboutTarget)(element, source);
    });
  }

  /**
   * The frame is in document coordinates, and a scroll moves a fixed or sticky element against the
   * document, or an element inside a box that scrolls. So the frame is measured again at each scroll
   * and resize, on the element it shows: else it scrolls away from a sidebar that stays (FRU-457).
   */
  function onScroll(): void {
    const framed = capturing ? hovered : chosen;
    // An element the page took away measures as a box of nothing at 0, 0: the frame stays.
    if (framed !== null && framed.isConnected && highlight.style.display === 'block') frame(framed);
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
    // A choice ends what was held: the frame of the element before must not come back under a
    // note that is about this one. The caller holds the new element if it wants its frame.
    chosen = null;
    stop();
    void sourceOf(element).then((source) => options.onSelect({ element, source }));
  }

  function hold(element: Element): void {
    chosen = element;
    frame(element);
    name(element);
  }

  function release(): void {
    chosen = null;
    if (!capturing) highlight.style.display = 'none';
  }

  /** Out of the capture by its own controls: focus goes back to the button that started it. */
  function leave(): void {
    stop();
    button.focus();
  }

  /**
   * The capture mode without a pointer (FRU-51).
   *
   * - Down and Up move to the next or previous element in document order.
   * - Left moves to the parent and Right to the first child. The two keys swap in a right-to-left language.
   * - Enter or Space selects the highlighted element.
   */
  function onKeyDown(event: KeyboardEvent): void {
    if (!capturing) return;
    // A dialog of the widget that has focus owns the keys, Escape included.
    if (dialogHasFocus()) return;

    if (event.key === 'Escape') {
      // One key press cancels one thing: the page and the thread must not also act on it.
      event.preventDefault();
      event.stopPropagation();
      leave();

      return;
    }

    const target = keyboardTarget(event.key);
    if (target !== undefined) {
      // The page must not scroll under the reporter.
      event.preventDefault();
      event.stopPropagation();
      if (target !== null) point(target);

      return;
    }

    // Enter on the gear, or on another control of the widget, presses that control.
    if ((event.key === 'Enter' || event.key === ' ') && hovered !== null && !otherControlHasFocus()) {
      // Without this, Enter also presses the launch button that has focus, and stops the capture.
      event.preventDefault();
      event.stopPropagation();
      select(hovered);
    }
  }

  function otherControlHasFocus(): boolean {
    const active = deepActiveElement(document);

    // The way out stands in for the launch button while a capture runs: Enter selects what is
    // highlighted, and with nothing highlighted it presses the way out.
    return active !== null && active !== button && active !== halt && root.contains(active);
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
    // FRU-330: no note can start that the worker refuses, whoever asks for the capture.
    if (closed !== undefined) return;
    capturing = true;
    // `chosen` is left as it is: a capture started over an open composer must give the frame back
    // to the element the composer is about when it stops.
    sources = new WeakMap();
    container.dataset.fruitbackCapturing = '';
    button.setAttribute('aria-pressed', 'true');
    // A phone has no Escape key and no arrows (FRU-157). Read at each start: a tablet gains a
    // keyboard and a mouse, and loses them.
    const touch = view?.matchMedia?.('(pointer: coarse)').matches === true;
    const say = (className: string, key: Parameters<Translator['text']>[0]): HTMLElement => {
      const part = document.createElement('span');
      part.className = className;
      part.textContent = t.text(key);

      return part;
    };
    // The banner is the one voice of a start: what to do, and for a keyboard the way to move, which
    // is read and not drawn. Then the button, which a thumb needs, with the key that does the same.
    halt.replaceChildren(...(touch ? [] : [haltKey]), haltLabel);
    banner.replaceChildren(
      say('fruitback-banner-ask', touch ? 'capture.bannerTouch' : 'capture.banner'),
      ...(touch ? [] : [say('fruitback-banner-keys', 'capture.instructions')]),
      halt,
    );
    // The capsule hides its controls while a capture runs (FRU-303): the launch button, the list,
    // the gear, the chip of the detached notes. Focus that was on one of them goes to the way out,
    // which takes their place: Enter there still stops the capture.
    const active = deepActiveElement(document);
    if (active !== null && dock.contains(active) && !banner.contains(active)) halt.focus();
    // What the capsule holds folds what it opened: the list of the detached notes listens.
    dock.dispatchEvent(new (view?.Event ?? Event)(CAPTURE_START));
  }

  /**
   * Where focus goes when a capture stops (FRU-303), on every path:
   * - « Cancel » and Escape: `leave()` gives it to the launch button.
   * - Enter on the way out, with an element reached by the keyboard: the way out had focus and leaves
   *   the tree with the banner, so focus goes to the launch button, shown again; the composer opened
   *   by the choice then takes it, and gives it back there.
   * - A click on the page: the browser gave focus to the page at the press, before this runs, so it
   *   stays where the person put it, and the composer opened by the choice takes it.
   * - The gear or the list, which stop the capture to open their dialog: that dialog takes it.
   */
  function stop(): void {
    const outHadFocus = deepActiveElement(document) === halt;
    capturing = false;
    hovered = null;
    delete container.dataset.fruitbackCapturing;
    button.setAttribute('aria-pressed', 'false');
    banner.replaceChildren();
    if (outHadFocus) button.focus();
    // The frame goes back to the element that is held, if one is: the capture borrowed it.
    if (chosen === null) highlight.style.display = 'none';
    else hold(chosen);
    // A failure of the read that came during the capture is said now that the region is free.
    announcer.textContent = unsaid;
    unsaid = '';
  }

  let signIn: { label: string; onSignIn: () => void } | undefined;
  let closed: { label: string; sentence: string } | undefined;
  button.addEventListener('click', () => {
    if (closed !== undefined) {
      // Said again at each press: the same words twice are not announced twice by a live region.
      announcer.textContent = '';
      announcer.textContent = closed.sentence;

      return;
    }
    if (signIn !== undefined) {
      signIn.onSignIn();

      return;
    }
    if (capturing) stop();
    else start();
  });

  /**
   * The same pill, other words and another action (FRU-315). Not a switch while it signs in: it has
   * nothing to be pressed for, so it loses `aria-pressed` rather than saying « not pressed ».
   */
  function offerSignIn(offer: { label: string; onSignIn: () => void } | undefined): void {
    signIn = offer;
    if (offer !== undefined) {
      if (capturing) stop();
      launchLabel.textContent = offer.label;
      button.removeAttribute('aria-pressed');
      container.dataset.fruitbackSignedOut = '';

      return;
    }
    launchLabel.textContent = restingLabel;
    button.setAttribute('aria-pressed', 'false');
    delete container.dataset.fruitbackSignedOut;
  }
  /** The launch button of a site whose notes are « Members only », for a reader with no session (FRU-330). */
  function closeNotes(offer: { label: string; sentence: string } | undefined): void {
    closed = offer;
    if (offer !== undefined) {
      if (capturing) stop();
      launchLabel.textContent = offer.label;
      button.removeAttribute('aria-pressed');
      button.setAttribute('aria-disabled', 'true');
      // Seen too, under a pointer: the live region speaks to a screen reader only.
      button.title = offer.sentence;
      container.dataset.fruitbackClosed = '';

      return;
    }
    button.removeAttribute('aria-disabled');
    button.removeAttribute('title');
    delete container.dataset.fruitbackClosed;
    // The sign-in offer, when there is one, keeps its words.
    offerSignIn(signIn);
  }
  halt.addEventListener('click', (event) => {
    // Inside the Shadow root, so the capture does not take this click for a choice; and the page
    // must not hear it either.
    event.preventDefault();
    event.stopPropagation();
    leave();
  });
  // Capture phase, so the page's own handlers never see the pointer while selection is on.
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  // Capture phase: a scroll event does not bubble, and a box of the page that scrolls must count too.
  view?.addEventListener('scroll', onScroll, { passive: true, capture: true });
  view?.addEventListener('resize', onScroll, { passive: true });

  return {
    root,
    panel,
    dock,
    moveDock,
    start,
    stop,
    capturing: () => capturing,
    hold,
    release,
    readFailed(failed, sentence, opener = t.text('sidebar.openFailed')) {
      const name = failed ? opener : t.text('sidebar.open');
      if (alert.hidden === !failed && listing.getAttribute('aria-label') === name) return;
      alert.hidden = !failed;
      listing.setAttribute('aria-label', name);
      // Said once, when it starts: a screen reader hears it at the load, with no list to open. A
      // capture holds the same region for its own words: the sentence waits for its end (review).
      if (!failed) unsaid = '';
      else if (capturing) unsaid = sentence;
      else announcer.textContent = sentence;
    },
    choose: select,
    offerSignIn,
    closeNotes,
    destroy() {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeyDown, true);
      view?.removeEventListener('scroll', onScroll, true);
      view?.removeEventListener('resize', onScroll);
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
  const text = readableName(element);
  if (text === '') return t.text('capture.elementEmpty', { tag });

  return t.text('capture.element', { tag, text });
}

/**
 * A name a person reads for an element: its accessible name when the page wrote one, its text
 * otherwise, on one line and cut at 80 characters. Empty when the element says nothing. It is what
 * the keyboard capture reads out, and what the composer writes after « on » (FRU-258).
 */
export function readableName(element: Element): string {
  const oneLine = (text: string | null) => (text ?? '').replace(/\s+/g, ' ').trim();
  // `||`: a label left empty names nothing, and the text of the element is then the name.
  const text = oneLine(element.getAttribute('aria-label')) || oneLine(element.textContent);

  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/**
 * What the frame of a capture writes for an element (FRU-303): its tag, then its id or the class
 * that names it best, as a person would write it in a stylesheet. « button.add », « input#email »,
 * « main ». It is a name to read, not a selector to run: the note carries the one that selects.
 *
 * The class that names it best is the one the fewest elements of the page share, the last one on a
 * tie, and never a modifier (« --md »). A design system puts its own classes first and the class of
 * the author last (« button button--md add »), and « button.button » says nothing.
 */
export function shortSelector(element: Element): string {
  const tag = element.tagName.toLowerCase();
  // The id and the classes a person wrote, as selector.ts judges them: a useId or a hash is no name.
  const id = element.getAttribute('id')?.trim() ?? '';
  if (id !== '' && !/\s/.test(id) && isStableId(id)) return `${tag}#${id}`;
  const classes = (element.getAttribute('class') ?? '')
    .trim()
    .split(/\s+/)
    .filter((name) => name !== '' && name !== tag && !name.includes('--') && isStableClass(name));
  let best: string | undefined;
  let fewest = Number.POSITIVE_INFINITY;
  for (const name of classes) {
    const count = element.ownerDocument.getElementsByClassName(name).length;
    if (count <= fewest) {
      best = name;
      fewest = count;
    }
  }

  return best === undefined ? tag : `${tag}.${best}`;
}

/**
 * What a note on this element points at, as the frame of a capture and the head of the composer
 * write it (FRU-303, FRU-305): « button.add · <AddToCart> », the short selector alone when the page
 * gives no component. The component is the one the note will carry: see `componentOf`.
 */
export function aboutTarget(element: Element, source: NoteSource | undefined): string {
  const selector = shortSelector(element);
  const component = componentOf(element, source)?.trim() ?? '';

  return component === '' ? selector : `${selector} · <${component}>`;
}

/**
 * The head of the composer with no selector (FRU-411): what a person reads for the element, then its
 * component, « Commander · <AddToCart> ». The component alone when the element says nothing, and the
 * tag when the page gives neither.
 */
export function plainHead(element: Element, source: NoteSource | undefined): string {
  const name = readableName(element);
  const component = componentOf(element, source)?.trim() ?? '';
  const parts = [name, component === '' ? '' : `<${component}>`].filter((part) => part !== '');

  return parts.length === 0 ? element.tagName.toLowerCase() : parts.join(' · ');
}

/**
 * The corners of the frame: those of the element, grown by the outset, or the small radius when the
 * element is square or its corners are not in pixels.
 */
function cornersOf(element: Element, view: Window | null): string {
  const style = view?.getComputedStyle?.(element);
  if (style === undefined) return '';
  const corners = [
    style.borderTopLeftRadius,
    style.borderTopRightRadius,
    style.borderBottomRightRadius,
    style.borderBottomLeftRadius,
  ].map((corner) => (/^\d+(\.\d+)?px$/.test(corner ?? '') ? Number.parseFloat(corner) : Number.NaN));
  if (corners.some((corner) => Number.isNaN(corner)) || corners.every((corner) => corner === 0)) return '';

  return corners.map((corner) => `${corner === 0 ? 0 : corner + HIGHLIGHT_OUTSET}px`).join(' ');
}

/**
 * How far the frame of a capture stands off its element: an outline of 2 px, 3 px off (FRU-303).
 * And the room its name takes above it.
 */
const HIGHLIGHT_OUTSET = 5;
const TAG_ROOM = 28;

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
  anywhere. Measured in Chromium before this was written (FRU-36).
*/
*:not(svg, svg *) { all: initial; box-sizing: border-box; color: inherit; font: inherit; letter-spacing: inherit; overflow-wrap: inherit; white-space: inherit; }
/*
  all:initial also stops inheritance. Without the three inherit values above, an element with no colour
  rule of its own is black at 16px: the launch label on a chip, and the thread and the panel on a dark
  surface, where axe measured 1.2 to 1 (FRU-51). The host gives the first values to inherit.

  The two wrap values inherit for the same reason (FRU-350). Without them every element starts at
  overflow-wrap:normal: an address or a long name with no space ran out of its box wherever a rule
  of the parent had asked for anywhere, and a nowrap on a button stopped at the span of its words.
*/
:host { color: var(--fruitback-color-text); font: 14px/1.45 var(--fruitback-font-sans); overflow-wrap: anywhere; }
/*
  The rule of the text, in two halves (FRU-350). Content wraps anywhere, so an address, a file path
  or a long word never runs past its box: :host above gives it to every element. A label never
  breaks inside its words: a button, a switch, a tab and a key stay on one line, and what they hold
  inherits it. The few buttons that hold a note, the rows of a list, say white-space: normal in their
  own module. A field keeps the line breaks its writer typed, as the browser draws it.
*/
button, [role='switch'], [role='tab'], kbd { white-space: nowrap; }
textarea { white-space: pre-wrap; }
/*
  all:initial is thorough enough to undo the browser's own display:none on a style element, which
  then renders the stylesheet as a column of visible text in the corner of the client's page. Found
  by looking at it; no unit test would have, since happy-dom draws nothing.
*/
style, script { display: none; }
/* The reset also removes the focus ring. The keyboard reaches these controls, so they must show focus (FRU-51). */
button:focus-visible, a:focus-visible, input:focus-visible, textarea:focus-visible {
  outline: 2px solid var(--fruitback-color-accent);
  outline-offset: 2px;
}
/*
  And it undoes the browser's display:block on every block element, so a paragraph is inline until
  something says otherwise: in the note thread the note, its byline and the "found by position"
  warning all ran together into one line, vertical margins silently doing nothing. Restoring it here
  rather than on each class is what keeps the next element added to the widget from inheriting the
  same surprise. Found by looking at a recording — every unit test passed. A list was missing from
  this rule until FRU-154: the replies of a thread were inline, so their height limit, their scroll
  and their indent did nothing.
*/
div, p, header, footer, section, form, ul, ol { display: block; }
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
/*
  The dock of the mock-up of 2026-10-20 (FRU-303): one capsule, 24 px from the corner, on the surface.
  Every control in it is 44 px tall, and draws a smaller shape inside a transparent border: 36 px for
  the round ones and the way out, 40 px for the launch button. The capsule is then the 52 px of the
  mock-up, and a target is never under 44 px.
*/
.fruitback-dock {
  position: fixed;
  inset-inline-end: 24px;
  bottom: 24px;
  z-index: 2147483200;
  display: flex;
  align-items: center;
  max-width: calc(100vw - 48px);
  padding-block: 3px;
  padding-inline: 1px 3px;
  border: 1px solid var(--fruitback-color-border);
  border-radius: var(--fruitback-radius-pill);
  background: var(--fruitback-color-surface);
  box-shadow: var(--fruitback-shadow-md);
}
/*
  FRU-443: a corner that was chosen is a corner of the window, whatever the direction of the page.
  The settings and the list of the detached notes open from the dock: see panel.ts and orphans.ts.
*/
:host([data-fruitback-position$='-right']) .fruitback-dock { right: 24px; left: auto; }
:host([data-fruitback-position$='-left']) .fruitback-dock { left: 24px; right: auto; }
:host([data-fruitback-position^='top-']) .fruitback-dock { top: 24px; bottom: auto; }
.fruitback-launch {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 44px;
  margin-inline-start: 2px;
  padding-inline: 14px 18px;
  border: 2px solid transparent;
  border-radius: var(--fruitback-radius-pill);
  background: var(--fruitback-color-accent) padding-box;
  color: var(--fruitback-color-on-accent);
  /* Tightened tracking rather than a smaller size: the label is the widget's only voice on the
     page, and shrinking it is how a control starts looking like an advert. */
  font: 600 13px/1 var(--fruitback-font-sans);
  letter-spacing: -0.006em;
  white-space: nowrap;
  cursor: pointer;
}
/* The drop of the mark, 14 px tall and narrower than tall, as the mock-up draws it. */
.fruitback-launch .fruitback-icon { width: 11px; height: 14px; }
.fruitback-launch:hover { background: var(--fruitback-color-accent-strong) padding-box; }
/* A site whose notes are « Members only », for a reader with no session (FRU-330): the pill of a chip,
   which offers nothing. */
.fruitback-launch[aria-disabled='true'],
.fruitback-launch[aria-disabled='true']:hover {
  background: var(--fruitback-color-chip) padding-box;
  color: var(--fruitback-color-on-chip);
  cursor: default;
}
.fruitback-configure,
.fruitback-listing {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border: 4px solid transparent;
  border-radius: var(--fruitback-radius-pill);
  background: transparent;
  color: var(--fruitback-color-text-subtle);
  font: 600 18px/1 var(--fruitback-font-sans);
  cursor: pointer;
}
/* The gear is drawn 1 px smaller than the list, as in the mock-up. */
.fruitback-configure { font-size: 17px; }
.fruitback-configure:hover,
.fruitback-listing:hover { background: var(--fruitback-color-surface-sunken) padding-box; }
.fruitback-listing { position: relative; }
/* The dot of a read that failed (FRU-316), on the corner of the round shape, ringed by the surface
   of the capsule so it reads on the icon. */
.fruitback-listing-alert {
  position: absolute;
  top: 2px;
  inset-inline-end: 2px;
  width: 10px;
  height: 10px;
  border-radius: var(--fruitback-radius-pill);
  background: var(--fruitback-color-accent);
  box-shadow: 0 0 0 2px var(--fruitback-color-surface);
}
.fruitback-listing-alert[hidden] { display: none; }
@media (forced-colors: active) {
  .fruitback-listing-alert { background: Mark; box-shadow: none; outline: 1px solid CanvasText; }
}
/*
  The frame of a capture (FRU-303): a line of 2 px, 3 px off the element, as an outline draws it, and
  nothing over the element itself. A tint hid the colour the reporter is writing about.
*/
.fruitback-highlight {
  position: absolute;
  display: none;
  z-index: 2147483100;
  /* The reporter is aiming at the page, not at this box. */
  pointer-events: none;
  border: 2px solid var(--fruitback-color-accent);
  border-radius: var(--fruitback-radius-sm);
}
/*
  What the note will point at, centred above the frame: « button.add · <AddToCart> », in the mono of
  a selector. Centred with the physical left, because the middle has no side.
*/
.fruitback-highlight-tag {
  position: absolute;
  /* The reset gives every element its pointer back: the name must not take a click the page needs. */
  pointer-events: none;
  left: 50%;
  top: -28px;
  transform: translateX(-50%);
  max-width: min(320px, 90vw);
  padding: 3px 8px;
  border-radius: var(--fruitback-radius-sm);
  background: var(--fruitback-color-accent);
  color: var(--fruitback-color-on-accent);
  font: 600 11px/1.5 var(--fruitback-font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fruitback-highlight-tag[hidden] { display: none; }
.fruitback-highlight[data-fruitback-tag-inside] .fruitback-highlight-tag { top: 2px; }
/*
  The banner of a capture (FRU-303) lives in the capsule. Empty at rest, and still in the tree: no
  box, no paint, and a live region that a screen reader already knows.
*/
.fruitback-banner { display: flex; align-items: center; min-width: 0; }
.fruitback-banner-ask {
  flex: 1 1 auto;
  min-width: 0;
  max-width: 240px;
  padding-inline: 12px 10px;
  color: var(--fruitback-color-on-ink-muted);
  font: 12px/1.35 var(--fruitback-font-sans);
}
/* Read, not drawn: how a keyboard moves. */
.fruitback-banner-keys {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.fruitback-banner-stop {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 44px;
  padding: 0 14px;
  border: 4px solid transparent;
  border-radius: var(--fruitback-radius-pill);
  background: var(--fruitback-color-chip) padding-box;
  color: var(--fruitback-color-on-chip);
  font: 600 13px/1 var(--fruitback-font-sans);
  white-space: nowrap;
  cursor: pointer;
}
/* The key, drawn as a key: a border, and a bottom of 2 px. */
.fruitback-banner-key {
  display: inline-block;
  padding: 2px 5px;
  border: 1px solid var(--fruitback-color-on-ink-muted);
  border-bottom-width: 2px;
  border-radius: calc(var(--fruitback-radius-sm) - 2px);
  font: 700 11px/1 var(--fruitback-font-sans);
}
/*
  While a capture runs, the capsule is the ink of the mock-up, in both schemes: it lies on the page of
  the host. It holds only the banner: the launch button, the list and the gear stand aside.
*/
:host([data-fruitback-capturing]) .fruitback-dock {
  /* 46 px tall, as the mock-up draws it: the way out is the one control left. */
  padding-block: 0;
  padding-inline-end: 1px;
  border-color: var(--fruitback-color-ink);
  background: var(--fruitback-color-ink);
  color: var(--fruitback-color-on-ink);
}
:host([data-fruitback-capturing]) .fruitback-dock > :not(.fruitback-banner) { display: none; }
/*
  FRU-351: while a capture of the page or of an area is taken, the pins, their tooltips, the open
  thread and the frame of the element are not on the page: the file shows the page only.
*/
:host([data-fruitback-shooting]) .fruitback-overlay,
:host([data-fruitback-shooting]) .fruitback-overlay *,
:host([data-fruitback-shooting]) .fruitback-highlight,
:host([data-fruitback-shooting]) .fruitback-highlight * { visibility: hidden !important; }
/*
  A forced palette paints every border, a transparent one too, and drops the fills: the shape of a
  control is then a line of the system's colours, inside the border that makes its target 44 px.
*/
@media (forced-colors: active) {
  .fruitback-launch,
  .fruitback-configure,
  .fruitback-listing,
  .fruitback-banner-stop { border-color: Canvas; }
  .fruitback-launch,
  .fruitback-banner-stop { outline: 1px solid ButtonText; outline-offset: -3px; }
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
/*
  The dock stands aside while the list of the page is open (FRU-259), as the mock-up draws it: the
  list covers this corner, and holds its own button to leave a note and its own cross.
*/
:host([data-fruitback-listing]) .fruitback-dock { display: none; }
`;
