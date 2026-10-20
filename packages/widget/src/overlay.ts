import { type SeedBounds, type SeedComment, type SeedIssue } from '@fruitback/shared';
import { type Direction, type Translator, createTranslator, languageOf } from './messages.ts';
import { createIcon } from './icons.ts';
import { onStageToken, stageToken } from './theme.ts';
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
 * cannot do that for it (FRU-21).
 *
 * **The overlay must not take the page hostage.** The client's site still has to be usable while
 * pins are on it, so the pin outlines let clicks through and only the badge is clickable. That is
 * also the difference between a widget people leave on and one they turn off.
 */

/**
 * How much of a note the name of a pin holds (FRU-320). A screen reader reads the name once, so it
 * is cut at the end of a word, near 60 characters: at 32, cut inside a word, « devrait être 18 € »
 * lost the very number that mattered.
 */
const NAME_MAX_LENGTH = 60;

/**
 * Kept next to the stylesheet's `width`, because `positionThread` has to know it to flip sides. The
 * 360 px of the mock-up (FRU-256); a window narrower than that takes the width the stylesheet left.
 */
const THREAD_WIDTH = 360;
const THREAD_GAP = 8;
/**
 * Where the bubble sits beside its pin, read on the mock-up (FRU-256): 30 px past the element and
 * 36 px above its top. The frame stands 4 px off the element, so that is 26 and 32 px from the frame,
 * and 8 px above the drop.
 */
const THREAD_BESIDE = 26;
const THREAD_RISE = 32;

/**
 * How far apart the badges of one spot sit (FRU-155). Kept next to the stylesheet, which reads it
 * through `--fruitback-pin-slot`: a 26 px drop and a 4 px gap.
 */
const BADGE_STEP = 30;

/**
 * How far the frame of a pin stands off its element, on every side (FRU-252): the 4 px of the
 * mock-up. The frame is 2 px thick, so 2 px of the page show between the element and its frame, and
 * the frame draws around the element and not on it.
 */
const FRAME_OUTSET = 4;

/**
 * The room a badge needs on the left of its element, from the document's edge: the 26 px drop
 * (FRU-158). With less, the fan goes back above the element.
 */
const BADGE_ROOM = 26;

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
   * Where the overlay's own DOM lives. Defaults to a container on `<body>`; FRU-3's Shadow DOM
   * host will pass its root here, which is what finally isolates these styles from the client's.
   * Whatever is passed has to sit at the document origin and be unpositioned, or the pins land
   * somewhere else — absolute positions resolve against the nearest positioned ancestor.
   */
  host?: Element | ShadowRoot;
  /**
   * Which pins to draw. Re-read on `refilter`, so a preference change does not need the issues to be
   * fetched again (FRU-14). Defaults to drawing everything.
   */
  shouldShow?: (issue: SeedIssue) => boolean;
  /**
   * Which issues are notes kept for later, not sent yet (FRU-124). Their pin is neutral, because no
   * tracker gave them a state, and their thread says they are not sent. Defaults to none.
   */
  isDraft?: (issue: SeedIssue) => boolean;
  /** Called when a pin is clicked, in case the host wants to do more than open the thread. */
  onSelect?: (issue: SeedIssue) => void;
  /** Called when a thread opens or closes: the list of the page marks the note that is open (FRU-259). */
  onThread?: () => void;
  /**
   * Called after the overlay re-resolves its pins on its own. The host is told, so it never has to
   * detect the change itself — which a client's app cannot do.
   */
  onResolve?: (resolutions: { issue: SeedIssue; strategy: AnchorResolution['strategy'] }[]) => void;
  /** The widget's words (FRU-37). Left out: English, with dates in this document's language. */
  translator?: Translator;
  /** How a reader replies to a note from its thread (FRU-257). Left out: no thread has a field. */
  reply?: ReplySeam;
};

/** Why a reply did not go. The text stays in its field in every case. */
export type ReplyFailure = 'retry' | 'wait' | 'signed-out';

/**
 * A seam like `onSubmit` of the composer (FRU-257): the overlay does not know the worker. `allowed`
 * is asked when a thread is built, and `send` answers the reply as the store wrote it.
 */
export type ReplySeam = {
  allowed(issue: SeedIssue): boolean;
  send(issue: SeedIssue, body: string): Promise<SeedComment | ReplyFailure>;
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
  resolutions(): {
    issue: SeedIssue;
    strategy: AnchorResolution['strategy'];
    confident: boolean;
    /** The number its pin carries (FRU-252). A note kept for later has none. */
    number?: number;
  }[];
  /** Whether a thread is open. `render` closes it, so a caller that can wait asks first. */
  threadOpen(): boolean;
  /** The note whose thread is open, if any (FRU-259). */
  openId(): string | undefined;
  /**
   * Whether the element of this note is under the part of the page in sight (FRU-259): the list
   * then says « further down ». `false` for a note that is not drawn, or whose element is gone.
   */
  below(id: string): boolean;
  /**
   * Scrolls to the pin of this note and opens its thread (FRU-129). `false` when the note is not
   * drawn: a stage the reporter hid, or a note that is gone.
   */
  select(id: string): boolean;
  /**
   * Shows the pin of this note above the others, a fifth bigger (FRU-299): the row a list outside
   * the page has open. `undefined` lets it go. Kept across a draw. `false`: no pin of that note.
   */
  mark(id: string | undefined): boolean;
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
   * The notes whose element the cascade could not find at all (FRU-12).
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
  /** What had focus when the thread opened: its badge, or an entry of the detached-notes list. */
  let threadOpener: HTMLElement | null = null;
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

  function resolutions(): ReturnType<Overlay['resolutions']> {
    return placed.map((entry) => {
      const number = NUMBERS.get(entry.issue);

      return {
        issue: entry.issue,
        strategy: entry.resolution.strategy,
        confident: entry.resolution.confident,
        ...(number === undefined ? {} : { number }),
      };
    });
  }

  function reposition(): void {
    for (const entry of placed) place(entry);
    fan();
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
      left: `${rect.left - FRAME_OUTSET}px`,
      top: `${rect.top - FRAME_OUTSET}px`,
      width: `${rect.width + 2 * FRAME_OUTSET}px`,
      height: `${rect.height + 2 * FRAME_OUTSET}px`,
    });
  }

  /**
   * Several notes on one spot fan their badges out, in render order (FRU-155).
   *
   * Without it the badges lay exactly on top of each other: one drop showed, and only the last one
   * took the click. A badge hangs from the top-left corner of its pin, so pins that share that
   * corner share a badge position, whether they are on one element or on two of the same box. Each
   * note keeps its own drop, its own stage colour and its own thread.
   *
   * The badge sits outside that corner, up and to the left, and the fan goes on to the left
   * (FRU-158): above the element is where a label, a title or a price is written. An element too
   * close to the left edge of the document for the whole fan keeps it above itself, going right —
   * `fruitback-pin-tight` — because a badge off the page cannot be clicked at all.
   */
  function fan(): void {
    const corners = placed.map((entry) => {
      const left = Number.parseFloat(entry.pin.style.left) || 0;
      const top = Number.parseFloat(entry.pin.style.top) || 0;

      return { pin: entry.pin, left, key: `${Math.round(left)},${Math.round(top)}` };
    });
    const counts = new Map<string, number>();
    for (const { key } of corners) counts.set(key, (counts.get(key) ?? 0) + 1);

    const taken = new Map<string, number>();
    for (const { pin, left, key } of corners) {
      const slot = taken.get(key) ?? 0;
      taken.set(key, slot + 1);
      pin.style.setProperty('--fruitback-pin-slot', String(slot));
      pin.classList.toggle('fruitback-pin-tight', left < BADGE_ROOM + ((counts.get(key) ?? 1) - 1) * BADGE_STEP);
    }
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

    fan();
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

  /** The note a list outside the page has open (FRU-299): its pin stays marked across a draw. */
  let marked: string | undefined;

  function draw(): void {
    const refocus = focusedTarget();
    closeThread(false);
    container.replaceChildren();
    // A note has the number of its place among the notes of the page, before any is hidden: hiding a
    // stage must not give « note 3 » to another note. A note kept for later is not counted.
    // Both marks are written at each draw, and the other one taken away: the two stores outlive a
    // render, and an object a caller draws first as a draft and then as a sent note must not keep
    // the look of the draft.
    let count = 0;
    for (const issue of source) {
      if (options.isDraft?.(issue) === true) {
        DRAFTS.add(issue);
        NUMBERS.delete(issue);
      } else {
        DRAFTS.delete(issue);
        NUMBERS.set(issue, (count += 1));
      }
    }

    placed = source
      .filter((issue) => options.shouldShow?.(issue) ?? true)
      .map((issue) => {
        const resolution = resolveAnchor(issue.seed.anchor, { document });
        const pin = buildPin(document, issue, resolution, t);
        if (marked !== undefined && issue.seed.id === marked) pin.dataset.fruitbackMarked = '';
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

    fan();
    observeAnchors();
    listOrphans();
    // The pins, and the entries of a list that changed, are new nodes: focus on an old one would fall to the page.
    if (refocus !== undefined) {
      const badge = placed
        .find((entry) => entry.issue.seed.id === refocus.id)
        ?.pin.querySelector<HTMLElement>('.fruitback-pin-badge');
      (refocus.inList ? (orphans.entry(refocus.id) ?? badge) : badge)?.focus();
    }
  }

  /**
   * The issue that had focus, and where: its badge, or its entry in the detached-notes list.
   *
   * A focused thread counts as the element that opened it.
   */
  function focusedTarget(): { id: string; inList: boolean } | undefined {
    const active = deepActiveElement(document);
    if (active === null) return undefined;

    if (thread !== null && thread.contains(active)) {
      const id = thread.dataset.fruitbackThread;

      return id === undefined ? undefined : { id, inList: threadOpener !== null && orphans.owns(threadOpener) };
    }
    if (orphans.owns(active)) {
      const id = active.closest<HTMLElement>('[data-fruitback-orphan]')?.dataset.fruitbackOrphan;

      return id === undefined ? undefined : { id, inList: true };
    }

    const entry = placed.find((candidate) => candidate.pin.contains(active));

    return entry === undefined ? undefined : { id: entry.issue.seed.id, inList: false };
  }

  /** A note is detached when nothing identified *or located* its element — resolveAnchor's last word. */
  function listOrphans(): void {
    // Not a draft (FRU-124): that list names a stage and an identifier, and a draft has neither. It
    // keeps its pin where it was planted, and it is in the group of drafts of the list of notes.
    orphans.update(
      placed
        .filter((entry) => entry.resolution.element === null && !DRAFTS.has(entry.issue))
        .map((entry) => entry.issue),
    );
  }

  // The text of each reply not sent yet, by note: a thread is built again on each resolve and each
  // render, and the text of a person must outlive it (FRU-257).
  const replyTexts = new Map<string, string>();
  const repliesInFlight = new Set<string>();
  const replySaid = new Map<string, string>();
  /** Shows the end of a reply in the thread of its note, if that thread is open now. */
  const replySettled = (issue: SeedIssue, answer: SeedComment | ReplyFailure): void => {
    const entry = placed.find((candidate) => candidate.issue.id === issue.id);
    if (entry === undefined || thread?.dataset.fruitbackThread !== issue.seed.id) return;
    // A read may have drawn the note again since: the reply goes on the issue that is on screen too.
    if (typeof answer !== 'string' && !(entry.issue.comments ?? []).some((each) => each.id === answer.id)) {
      entry.issue.comments = [...(entry.issue.comments ?? []), answer];
    }
    const focused = threadHasFocus();
    reopenThread(entry);
    const field = thread?.querySelector<HTMLTextAreaElement>('.fruitback-thread-reply-field');
    if (focused) field?.focus();
  };
  const replyFor = (issue: SeedIssue): ReplyFooter | undefined =>
    options.reply === undefined || DRAFTS.has(issue) || !options.reply.allowed(issue)
      ? undefined
      : { seam: options.reply, texts: replyTexts, inFlight: repliesInFlight, said: replySaid, settled: replySettled };

  /** Re-render the open thread against a resolution that has just changed under it. */
  function reopenThread(entry: Placed): void {
    const focused = threadHasFocus();
    // A person who types a reply keeps the field, the caret and the selection (FRU-257): the page
    // can change under the thread at any keystroke, and focus on Close would take the next ones.
    const active = deepActiveElement(document);
    const typing =
      isElement(active) && active.classList.contains('fruitback-thread-reply-field')
        ? (active as HTMLTextAreaElement)
        : undefined;
    const caret = typing === undefined ? undefined : ([typing.selectionStart, typing.selectionEnd] as const);
    thread?.remove();
    thread = buildThread(document, entry.issue, entry.resolution, t, replyFor(entry.issue));
    thread.querySelector('.fruitback-thread-close')?.addEventListener('click', () => closeThread());
    container.append(thread);
    positionThread(thread, entry.pin, t.direction);
    const field = thread.querySelector<HTMLTextAreaElement>('.fruitback-thread-reply-field');
    if (caret !== undefined && field !== null) {
      field.focus();
      field.setSelectionRange(caret[0], caret[1]);
    } else if (focused) thread.querySelector<HTMLElement>('.fruitback-thread-close')?.focus();
  }

  function openThread(entry: Placed): void {
    const active = deepActiveElement(document);
    closeThread();
    threadOpener = active !== null && active !== document.body ? (active as HTMLElement) : null;
    entry.pin.dataset.fruitbackOpen = '';
    entry.pin.querySelector('.fruitback-pin-badge')?.setAttribute('aria-expanded', 'true');
    thread = buildThread(document, entry.issue, entry.resolution, t, replyFor(entry.issue));
    thread.querySelector('.fruitback-thread-close')?.addEventListener('click', () => closeThread());
    container.append(thread);
    positionThread(thread, entry.pin, t.direction);
    // The thread is the last child of the container, far from its badge in the tab order.
    thread.querySelector<HTMLElement>('.fruitback-thread-close')?.focus();
    options.onSelect?.(entry.issue);
    options.onThread?.();
  }

  function closeThread(restoreFocus = true): void {
    const focused = restoreFocus && threadHasFocus();
    // The last word of a reply is said once: a thread opened again starts with an empty status.
    replySaid.clear();
    const opener = placed.find((entry) => entry.pin.dataset.fruitbackOpen !== undefined);
    const wasOpen = thread !== null;
    thread?.remove();
    thread = null;
    for (const entry of placed) {
      delete entry.pin.dataset.fruitbackOpen;
      entry.pin.querySelector('.fruitback-pin-badge')?.setAttribute('aria-expanded', 'false');
    }
    const badge = opener?.pin.querySelector<HTMLElement>('.fruitback-pin-badge');
    if (focused) (threadOpener?.isConnected === true ? threadOpener : badge)?.focus();
    threadOpener = null;
    if (wasOpen) options.onThread?.();
  }

  function threadHasFocus(): boolean {
    const active = deepActiveElement(document);

    return thread !== null && active !== null && thread.contains(active);
  }

  function onDocumentClick(event: Event): void {
    if (thread === null) return;

    // `composedPath`, not `event.target`: once the overlay lives in a Shadow root (FRU-3), a click
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
    threadOpen: () => thread !== null,
    openId: () => placed.find((entry) => entry.pin.dataset.fruitbackOpen !== undefined)?.issue.seed.id,
    below(id) {
      const entry = placed.find((candidate) => candidate.issue.seed.id === id);
      if (entry === undefined || entry.resolution.element === null || view === null) return false;

      // The top of its frame, in document coordinates, against the bottom edge of the window.
      return (Number.parseFloat(entry.pin.style.top) || 0) >= view.scrollY + view.innerHeight;
    },
    mark(id) {
      marked = id;
      let found = false;
      for (const entry of placed) {
        if (id !== undefined && entry.issue.seed.id === id) {
          entry.pin.dataset.fruitbackMarked = '';
          found = true;
        } else delete entry.pin.dataset.fruitbackMarked;
      }

      return id === undefined || found;
    },
    select(id) {
      const entry = placed.find((candidate) => candidate.issue.seed.id === id);
      if (entry === undefined) return false;
      // The element when the page still has it, the pin otherwise: a detached note has only its pin.
      // No smooth scroll: it is an animation, and nothing here reads `prefers-reduced-motion`.
      const element = entry.resolution.element;
      const target = element !== null && element.isConnected ? element : entry.pin;
      target.scrollIntoView?.({ block: 'center', inline: 'nearest' });
      openThread(entry);

      return true;
    },
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

/** The number an overlay gave a note: its place among the notes of the page (FRU-252). */
const NUMBERS = new WeakMap<SeedIssue, number>();

/** The issues an overlay was told are drafts. Marked on the object, which the overlay draws as it got it. */
const DRAFTS = new WeakSet<SeedIssue>();

/** The stage's token, or a neutral one for a draft: it has no state in any tracker yet (FRU-124). */
function pinColor(issue: SeedIssue): string {
  return DRAFTS.has(issue) ? 'var(--fruitback-color-text-muted)' : stageToken(issue.stage);
}

function buildPin(document: Document, issue: SeedIssue, resolution: AnchorResolution, t: Translator): HTMLElement {
  const pin = document.createElement('div');

  pin.className = 'fruitback-pin';
  // The token rather than the hexadecimal the contract carries (FRU-35). One indirection buys the
  // dark theme, the host override and, once FRU-24 lands, a contract that stops shipping colours at
  // all — a widget's palette has no business travelling in the payload both ends must agree on.
  pin.style.setProperty('--fruitback-pin-color', pinColor(issue));
  // What is written on the drop: dark on the amber of « in progress », white on the others (FRU-233).
  if (!DRAFTS.has(issue)) pin.style.setProperty('--fruitback-pin-on-color', onStageToken(issue.stage));
  pin.dataset.fruitbackPin = issue.seed.id;
  if (DRAFTS.has(issue)) pin.dataset.fruitbackDraft = '';
  pin.dataset.fruitbackStage = issue.stage;

  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = 'fruitback-pin-badge';
  // A pin opens its note: a screen reader is told which one is open, and is not told it twice.
  badge.setAttribute('aria-expanded', 'false');
  badge.title = DRAFTS.has(issue) ? stateLabel(issue, t) : `${issue.identifier} · ${stateLabel(issue, t)}`;
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
    DRAFTS.has(issue)
      ? t.text('pin.labelDraft', { note: summarise(issue) })
      : t.text(resolution.confident ? 'pin.label' : 'pin.labelUncertain', {
          number: NUMBERS.get(issue) ?? 0,
          // « Note 2, in progress »: the name of a stage is a label, written with a capital. In a
          // sentence it takes none.
          stage: t.stage(issue.stage).toLocaleLowerCase(t.lang),
          note: summarise(issue),
        }),
  );
  const glyph = pin.querySelector('.fruitback-pin-glyph');
  // The number of the note (FRU-252), which the list of the page writes beside the same note. It is
  // what the `≈` of an unsure pin gave way to: the dashed frame, the name of the pin and its thread
  // still say that this one was placed by coordinates, and one drop holds one mark. A note kept for
  // later has no number: the drop is empty, in its neutral colour.
  const number = NUMBERS.get(issue);
  if (glyph !== null) glyph.textContent = number === undefined ? '' : String(number);
}

function summarise(issue: SeedIssue): string {
  const firstLine = issue.seed.note
    .split('\n')
    .find((line) => line.trim().length > 0)
    ?.trim();
  if (firstLine === undefined) return issue.identifier;

  return shortened(firstLine, NAME_MAX_LENGTH);
}

/**
 * The text whole when it fits, or cut at the last space before `max`, with « … ». A word longer than
 * half of `max` is cut inside, rather than leaving a name of three letters.
 */
export function shortened(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = text.slice(0, max - 1);
  const space = room.lastIndexOf(' ');
  const cut = space >= max / 2 ? room.slice(0, space) : room;

  return `${cut.replace(/[\s,;:.\-–—]+$/u, '')}…`;
}

/**
 * The team's answers, oldest first (FRU-13).
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
    return [
      element(document, 'div', 'fruitback-thread-answers', [
        element(document, 'p', 'fruitback-thread-empty', t.text('thread.noReplies')),
      ]),
    ];
  }

  const list = document.createElement('ul');
  list.className = 'fruitback-thread-replies';
  // The list scrolls past 180 px, and a region that scrolls must take focus, or a keyboard cannot
  // read its end (FRU-154). The name says what the stop is.
  list.tabIndex = 0;
  list.setAttribute('aria-label', t.text('thread.replies'));

  for (const comment of issue.comments) {
    const item = document.createElement('li');
    item.className = 'fruitback-thread-reply';
    const fromPage = replyFromPage(comment.body);
    item.append(
      byline(
        document,
        'p',
        'fruitback-thread-reply-who',
        fromPage === undefined ? (comment.author ?? t.text('thread.team')) : fromPage.name,
        comment.createdAt,
        t,
        // Who answers is what the eye looks for in a conversation: the name is in the ink, the date is not.
        'fruitback-thread-reply-name',
        fromPage?.who,
      ),
      // `textContent`, never markup: this is Linear's markdown, written by whoever can comment on the
      // issue, rendered inside someone else's page. It is text here and nothing more.
      element(document, 'p', 'fruitback-thread-reply-body', fromPage?.text ?? comment.body),
    );
    list.append(item);
  }

  return [element(document, 'div', 'fruitback-thread-answers', [list])];
}

/**
 * The component and the file behind the element, when the capture found them (FRU-256).
 *
 * It is what a developer reads first, and until now only the export said it. A note taken on a page
 * with no React, or on a production build, has none: the line is then absent, and nothing stands in.
 * As text, like everything a note carries.
 */
function sourceLine(document: Document, issue: SeedIssue): HTMLElement[] {
  const source = issue.seed.source;
  if (source === undefined) return [];

  const line = source.line === undefined ? '' : `:${source.line}`;
  const file = source.file === undefined ? undefined : `${source.file}${line}`;
  const parts = [source.component, file].filter((part): part is string => part !== undefined && part.trim() !== '');

  return parts.length > 0 ? [element(document, 'p', 'fruitback-thread-source', parts.join(' · '))] : [];
}

/**
 * What the store calls this issue's state, or the stage when it calls it nothing.
 *
 * The Linear connector reports `node.state?.name ?? ''`, so an issue with no state gives an empty
 * string. That used to be hidden behind the stage's emoji; with the glyph gone (FRU-24) it surfaced
 * twice — an empty thread header, and a tooltip reading `SKG-742 · ` with a dangling separator.
 *
 * **A function and not the expression inlined twice**, because the second site is how this was found:
 * the header was fixed in review and the badge's `title` was left behind. Two copies of a fallback
 * are two chances to fix only one of them.
 *
 * `||` and not `??`: an empty string is exactly the case being caught, and `??` would let it through.
 */
function stateLabel(issue: SeedIssue, t: Translator): string {
  if (DRAFTS.has(issue)) return t.text('thread.draft');

  return issue.stateName || t.stage(issue.stage);
}

/** Note, status, who said it, and the way through to Linear, which owns everything else. */
function buildThread(
  document: Document,
  issue: SeedIssue,
  resolution: AnchorResolution,
  t: Translator,
  reply: ReplyFooter | undefined,
): HTMLElement {
  const thread = document.createElement('div');
  thread.className = 'fruitback-thread';
  thread.dataset.fruitbackThread = issue.seed.id;
  thread.setAttribute('role', 'dialog');
  thread.setAttribute(
    'aria-label',
    // « Note 2 », the number its drop carries (FRU-256): the name of the dialog and the name of the pin
    // that opens it then say the same note. The identifier of the store is the link of the head.
    DRAFTS.has(issue) ? t.text('thread.draftDialog') : t.text('thread.dialog', { number: NUMBERS.get(issue) ?? 0 }),
  );
  thread.style.setProperty('--fruitback-pin-color', pinColor(issue));

  const reporter = issue.seed.reporter?.name ?? issue.seed.reporter?.email ?? t.text('thread.anonymous');

  // The drop of the pin, small, in front of the word of the state: the colour is never alone.
  const drop = document.createElement('span');
  drop.className = 'fruitback-thread-drop';
  drop.setAttribute('aria-hidden', 'true');

  thread.append(
    // A div, not a header: inside the widget's region landmark a header is a banner (FRU-51).
    element(document, 'div', 'fruitback-thread-head', [
      // The store's own word for the state. `stateName` is what the store said — Linear's
      // "In Progress", SQLite's own — and the drop beside it carries the stage colour through
      // `--fruitback-pin-color`.
      //
      // See `stateLabel` for why this is not just `issue.stateName`.
      element(document, 'span', 'fruitback-thread-stage', [
        drop,
        element(document, 'span', 'fruitback-thread-state', stateLabel(issue, t)),
      ]),
      // In the head (FRU-256), where the mock-up draws it: the way out is known before the note is read.
      ...link(document, issue, t),
      closeButton(document, t),
    ]),
    element(document, 'div', 'fruitback-thread-body', [
      element(document, 'p', 'fruitback-thread-note', issue.seed.note || t.text('thread.noNote')),
      byline(document, 'p', 'fruitback-thread-meta', reporter, issue.seed.createdAt, t),
      ...sourceLine(document, issue),
      // Said out loud rather than hidden. A reader who is told the pin might be on the wrong element
      // checks; a reader who is told nothing believes it.
      ...uncertaintyNote(document, resolution, t),
    ]),
    ...replies(document, issue, t),
    ...(reply === undefined ? [] : [replyForm(document, issue, t, reply)]),
  );

  return thread;
}

/**
 * What the forms of the replies share, by note: a form is built again with its thread, and the state
 * of a reply outlives it. `said` is the last word of the status line.
 */
type ReplyFooter = {
  seam: ReplySeam;
  texts: Map<string, string>;
  inFlight: Set<string>;
  said: Map<string, string>;
  settled: (issue: SeedIssue, answer: SeedComment | ReplyFailure) => void;
};

/**
 * A reply written from the page, as the worker writes it in a tracker (FRU-257): a first line with
 * the name and what the worker knows of the person, then the text, quoted. The page shows the name
 * as the author and the text as it was typed. Any other comment is shown as it is.
 *
 * WARNING: a person who comments in the tracker can type the same first line. The page then shows
 * the name they typed: they are people of the team of the site, who can change the issue too.
 */
const FROM_PAGE = /^\*\*([^*\n]+)\*\* via Fruitback · ([^\n]+)\n\n((?:>(?: [^\n]*)?(?:\n|$))+)$/u;

export function replyFromPage(body: string): { name: string; who: string; text: string } | undefined {
  const match = FROM_PAGE.exec(body);
  if (match === null) return undefined;
  const text = (match[3] ?? '')
    .replace(/\n$/u, '')
    .split('\n')
    .map((line) => line.replace(/^> ?/u, ''))
    .join('\n');

  return { name: match[1] ?? '', who: match[2] ?? '', text };
}

const REPLY_FAILURES = {
  retry: 'reply.failed',
  wait: 'reply.failedWait',
  'signed-out': 'reply.failedSignedOut',
} as const;

/**
 * The foot of a thread, where a reader replies (FRU-257). Enter sends, and Shift+Enter goes to the
 * next line.
 *
 * WARNING: nothing here clears the field but a reply that the store kept. A failure keeps the text
 * and says why. The text lives in `texts` too, so a thread built again shows it again.
 */
function replyForm(document: Document, issue: SeedIssue, t: Translator, reply: ReplyFooter): HTMLElement {
  const form = document.createElement('form');
  form.className = 'fruitback-thread-reply-form';
  const field = document.createElement('textarea');
  field.className = 'fruitback-thread-reply-field';
  field.rows = 1;
  field.setAttribute('aria-label', t.text('reply.label'));
  const author = issue.seed.reporter?.name;
  field.placeholder =
    author === undefined ? t.text('reply.placeholderAnonymous') : t.text('reply.placeholder', { name: author });
  field.value = reply.texts.get(issue.id) ?? '';
  const send = document.createElement('button');
  send.type = 'submit';
  send.className = 'fruitback-thread-reply-send';
  send.textContent = t.text('reply.send');
  // The visible word is in the name: a second « Send » can be on screen, the one of the composer.
  send.setAttribute('aria-label', t.text('reply.sendLabel'));
  const status = document.createElement('span');
  status.className = 'fruitback-thread-reply-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  // A thread built again while its reply is in flight shows the send, and takes no second one.
  const inFlight = reply.inFlight.has(issue.id);
  send.disabled = inFlight;
  field.readOnly = inFlight;
  status.textContent = inFlight ? t.text('reply.sending') : (reply.said.get(issue.id) ?? '');

  field.addEventListener('input', () => {
    reply.texts.set(issue.id, field.value);
    reply.said.delete(issue.id);
    status.textContent = '';
  });
  field.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    form.requestSubmit();
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const body = field.value;
    if (reply.inFlight.has(issue.id) || body.trim() === '') return;
    reply.inFlight.add(issue.id);
    send.disabled = true;
    field.readOnly = true;
    status.textContent = t.text('reply.sending');
    void reply.seam
      .send(issue, body)
      .catch((): ReplyFailure => 'retry')
      .then((answer) => {
        reply.inFlight.delete(issue.id);
        if (typeof answer === 'string') {
          reply.said.set(issue.id, t.text(REPLY_FAILURES[answer]));
        } else {
          issue.comments = [...(issue.comments ?? []), answer];
          reply.texts.delete(issue.id);
          reply.said.set(issue.id, t.text('reply.sent'));
        }
        // The thread of this note as it is now, which may be another than the one that sent.
        reply.settled(issue, answer);
      });
  });

  form.append(field, send, status);

  return form;
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
 * The way out to the store's own interface, when it has one (FRU-31).
 *
 * Two things changed here, and both were the contract leaking. The label said **Linear** in a widget
 * that is not supposed to know which store is behind the worker — the same reason `502` reports
 * `store-unavailable` and not `linear-unavailable` (FRU-29). And `url` is now optional, because
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
 * Who, and when, as a relative date (FRU-38). The absolute date goes in the title, for a reader who
 * needs the day. A date the store wrote in a shape `Date` cannot read is shown as it came.
 */
function byline(
  document: Document,
  tag: string,
  className: string,
  who: string,
  written: string,
  t: Translator,
  nameClass?: string,
  qualifier?: string,
): HTMLElement {
  const date = new Date(written);
  const when = Number.isNaN(date.getTime()) ? written : t.relative(date);
  const node =
    nameClass === undefined
      ? element(document, tag, className, `${who} · ${when}`)
      : element(document, tag, className, [element(document, 'span', nameClass, who)]);
  if (nameClass !== undefined) node.append(`${qualifier === undefined ? '' : ` · ${qualifier}`} · ${when}`);
  if (!Number.isNaN(date.getTime())) node.title = t.date(date);

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
 * Beside the frame when the window has the room, as the mock-up draws it (FRU-256): past its end edge
 * for the reading direction, a little above its top. Otherwise below the pin, or above it when there
 * is no room below: that is every phone, and every element that runs to the edge of the window. The
 * values stay physical, like the pin (FRU-38).
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

  // Measured after insertion, so these are the sizes the thread actually took. A window narrower than
  // the bubble gives it less than `THREAD_WIDTH`; a document with no layout gives 0, and the constant.
  const threadHeight = thread.offsetHeight;
  const threadWidth = thread.offsetWidth || THREAD_WIDTH;
  // The pin's left is in document coordinates, so the window it must stay inside starts at `scrollX` (FRU-68).
  const first = scrollX + THREAD_GAP;
  const last = scrollX + viewportWidth - threadWidth - THREAD_GAP;

  const beside = direction === 'rtl' ? left - THREAD_BESIDE - threadWidth : left + pinWidth + THREAD_BESIDE;
  if (beside >= first && beside <= last) {
    // Never under the bottom of the window, and never above its top: the head holds the way out.
    const lowest = scrollY + viewportHeight - threadHeight - THREAD_GAP;
    thread.style.left = `${beside}px`;
    thread.style.top = `${Math.max(scrollY + THREAD_GAP, Math.min(top - THREAD_RISE, lowest))}px`;
    return;
  }

  const below = top + pinHeight + THREAD_GAP;
  const roomBelow = below + threadHeight <= scrollY + viewportHeight;
  const start = direction === 'rtl' ? left + pinWidth - threadWidth : left;

  thread.style.left = `${Math.max(first, Math.min(start, last))}px`;
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
 * Kept in one string rather than set per element: when the host becomes a Shadow root (FRU-3) this
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
}
/*
  The tint only while its note is pointed at, focused or open (FRU-158). Left on, it greyed every
  annotated element of the page, and the more a page was annotated, the less it could be read.

  Two rules and not one list: a browser with no :has() drops the whole rule that names it, and the
  tint of an open thread must not go with it.
*/
.fruitback-pin[data-fruitback-open] { background: color-mix(in srgb, var(--fruitback-pin-color) 12%, transparent); }
.fruitback-pin:has(.fruitback-pin-badge:hover),
.fruitback-pin:has(.fruitback-pin-badge:focus-visible) {
  background: color-mix(in srgb, var(--fruitback-pin-color) 12%, transparent);
}
.fruitback-pin-uncertain { border-style: dashed; opacity: 0.85; }
/* The pin of the row a list outside the page has open (FRU-299): above the others, a fifth bigger. */
.fruitback-pin[data-fruitback-marked] { z-index: 1; }
.fruitback-pin[data-fruitback-marked] .fruitback-pin-badge { scale: 1.2; }
.fruitback-pin-orphan { border-style: dotted; }
.fruitback-pin-badge {
  position: absolute;
  /*
    Outside the top-left corner, its point on the corner of the frame and not one pixel over the element (FRU-158). Above the element is
    where its label or its price is written, and the badge covered it. One step to the left for each
    note before this one on the same spot (FRU-155).
  */
  bottom: 100%;
  right: calc(100% + var(--fruitback-pin-slot, 0) * ${BADGE_STEP}px);
  /* …except this, which is the one thing you can click. */
  pointer-events: auto;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: 0;
  padding: 0;
  /* Three round corners and one sharp: a seed, pointing down and in at the corner of its element. */
  border-radius: 50% 50% 50% 0;
  transform: rotate(-90deg);
  background: var(--fruitback-pin-color);
  color: var(--fruitback-pin-on-color, var(--fruitback-color-on-stage));
  font: 600 13px/1 var(--fruitback-font-sans);
  cursor: pointer;
  box-shadow: var(--fruitback-shadow-sm);
  /* Squash and stretch: the drop lands, flattens, and settles. */
  animation: fruitback-pin-drop var(--fruitback-duration-slow) cubic-bezier(0.2, 1.4, 0.35, 1);
}
.fruitback-pin-glyph {
  transform: rotate(90deg);
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
/* No room on the left: above the element, going right, as before FRU-158. */
.fruitback-pin-tight .fruitback-pin-badge {
  right: auto;
  left: calc(var(--fruitback-pin-slot, 0) * ${BADGE_STEP}px);
  bottom: calc(100% + 4px);
}
.fruitback-pin-badge:hover { filter: brightness(1.06); }
.fruitback-pin-badge:focus-visible { outline: 2px solid var(--fruitback-color-text); outline-offset: 2px; }

@keyframes fruitback-pin-drop {
  0% { opacity: 0; transform: translate(-7px, -7px) rotate(-90deg) scale(0.7, 1.25); }
  55% { opacity: 1; transform: translate(0, 0) rotate(-90deg) scale(1.18, 0.82); }
  100% { opacity: 1; transform: rotate(-90deg) scale(1, 1); }
}

@media (prefers-reduced-motion: reduce) {
  .fruitback-pin-badge { animation: none; }
}
.fruitback-thread {
  position: absolute;
  z-index: 2147483100;
  /* 360 px, and what a narrower window leaves: 8 px on each side, the gap the placement keeps. */
  width: min(360px, calc(100vw - 16px));
  pointer-events: auto;
  border-radius: var(--fruitback-radius-lg);
  background: var(--fruitback-color-surface);
  color: var(--fruitback-color-text);
  font: 14px/1.5 var(--fruitback-font-sans);
  box-shadow: var(--fruitback-shadow-lg);
}
/* A shadow is not drawn in forced colours: the bubble then needs an edge of its own. */
@media (forced-colors: active) {
  .fruitback-thread { outline: 1px solid CanvasText; }
}
.fruitback-thread-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-block: 8px;
  padding-inline: 16px 8px;
  border-bottom: 1px solid var(--fruitback-color-border);
}
.fruitback-thread-stage {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  font-weight: 600;
  font-size: 13px;
  letter-spacing: -0.006em;
}
/* The silhouette of the pin, which is not in the scale and is not settable (see theme.ts). */
.fruitback-thread-drop {
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 50% 50% 50% 0;
  transform: rotate(-90deg);
  background: var(--fruitback-pin-color);
}
/* anywhere: the store names its states, and a long name must wrap inside the head. */
.fruitback-thread-state { min-width: 0; overflow-wrap: anywhere; }
.fruitback-thread-close {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  margin-inline-start: auto;
  border: 0;
  border-radius: var(--fruitback-radius-field);
  background: var(--fruitback-color-surface);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  color: var(--fruitback-color-text-muted);
}
.fruitback-thread-close:hover { background: var(--fruitback-color-surface-sunken); }
.fruitback-thread-body { display: flex; flex-direction: column; gap: 8px; padding: 14px 16px; }
/* anywhere: an address has no space, and it must wrap inside the thread instead of leaving it (FRU-154). */
.fruitback-thread-note { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.fruitback-thread-meta { margin: 0; font-size: 12px; color: var(--fruitback-color-text-muted); overflow-wrap: anywhere; }
.fruitback-thread-source {
  margin: 4px 0 0;
  padding: 6px 8px;
  border: 1px solid var(--fruitback-color-border);
  border-radius: var(--fruitback-radius-sm);
  background: var(--fruitback-color-surface-raised);
  color: var(--fruitback-color-text-subtle);
  font: 11.5px/1.5 var(--fruitback-font-mono);
  overflow-wrap: anywhere;
}
.fruitback-thread-orphan { margin: 0; font-size: 12px; color: var(--fruitback-color-warning); }
.fruitback-thread-answers { border-top: 1px solid var(--fruitback-color-border); }
.fruitback-thread-empty {
  margin: 0;
  padding: 12px 16px;
  font-size: 12px;
  color: var(--fruitback-color-text-subtle);
  font-style: italic;
}
.fruitback-thread-replies {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 12px 16px;
  list-style: none;
  /* A long conversation belongs in Linear, which the link of the head goes to. */
  max-height: 180px;
  overflow-y: auto;
}
/*
  Inside, not around: the list goes to the edges of the bubble, and a ring drawn outside it would lie
  on the rule above and leave the bubble below.
*/
.fruitback-thread-replies:focus-visible {
  outline: 2px solid var(--fruitback-color-accent);
  outline-offset: -2px;
  border-end-start-radius: var(--fruitback-radius-lg);
  border-end-end-radius: var(--fruitback-radius-lg);
}
/*
  On the item, not only on the list. The host reset gives every element all:initial, which resets each
  item's own list-style-type to its initial value of disc — and a reset value beats what it would have
  inherited from the list. The bullets came back, and only a recording showed it.
*/
.fruitback-thread-reply { display: flex; flex-direction: column; gap: 2px; flex: none; list-style: none; }
.fruitback-thread-reply-who { margin: 0; font-size: 11px; color: var(--fruitback-color-text-muted); overflow-wrap: anywhere; }
.fruitback-thread-reply-name { font-weight: 600; color: var(--fruitback-color-text); }
.fruitback-thread-reply-body { margin: 0; font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.fruitback-thread-link {
  flex: none;
  font-size: 12px;
  color: var(--fruitback-color-text-muted);
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
  cursor: pointer;
}
.fruitback-thread-link:hover { color: var(--fruitback-color-accent-strong); }
/*
  A thumb, not a pointer (FRU-157). The cross stays 15 px and its button grows to 44 px. The negative
  margins give the extra size back to the padding of the head, so the head keeps its height.
*/
/* The foot where a reader replies (FRU-257): the field grows with the text, the button stays at its foot. */
.fruitback-thread-reply-form {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 8px;
  padding: 10px 12px 12px 16px;
  border-top: 1px solid var(--fruitback-color-border);
}
.fruitback-thread-reply-field {
  flex: 1 1 160px;
  min-height: 36px;
  max-height: 120px;
  resize: none;
  field-sizing: content;
  border: 1px solid var(--fruitback-color-border-strong);
  border-radius: var(--fruitback-radius-field);
  padding: 7px 10px;
  font: 14px/1.4 var(--fruitback-font-sans);
  background: var(--fruitback-color-surface);
  color: inherit;
  caret-color: var(--fruitback-color-accent);
}
.fruitback-thread-reply-field:focus-visible { outline: 2px solid var(--fruitback-color-accent); outline-offset: 1px; }
.fruitback-thread-reply-send {
  display: inline-flex;
  align-items: center;
  height: 36px;
  padding: 0 16px;
  border: 0;
  border-radius: var(--fruitback-radius-pill);
  background: var(--fruitback-color-accent);
  color: var(--fruitback-color-on-accent);
  font: 600 13px/1 var(--fruitback-font-sans);
  letter-spacing: -0.006em;
  cursor: pointer;
}
.fruitback-thread-reply-send:hover:not([disabled]) { background: var(--fruitback-color-accent-strong); }
.fruitback-thread-reply-send[disabled] { opacity: 0.55; cursor: default; }
.fruitback-thread-reply-status { flex-basis: 100%; font-size: 12px; color: var(--fruitback-color-text-muted); }
.fruitback-thread-reply-status:empty { display: none; }
@media (pointer: coarse) {
  .fruitback-thread-close { min-width: 44px; min-height: 44px; margin-block: -6px; margin-inline-end: -6px; }
  .fruitback-thread-link { display: inline-flex; align-items: center; min-height: 32px; }
  .fruitback-thread-reply-field { font-size: 16px; }
  .fruitback-thread-reply-send { min-height: 44px; }
}
`;
