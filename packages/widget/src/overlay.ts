import { type Note, type NoteBounds, type NoteComment, type NoteIssue, type NoteStatus } from '@fruitback/shared';
import { type Direction, type Translator, createTranslator, languageOf } from './messages.ts';
import { createIcon } from './icons.ts';
import { type Box, type Offset, NO_OFFSET, attachHandle, clampOffset, moved, tether } from './bubble-drag.ts';
import { statusLabel, statusPaint } from './status-paint.ts';
import { isElement } from './dom.ts';
import { deepActiveElement } from './focus.ts';
import { createOrphanList, type OrphanList } from './orphans.ts';
import { type AnchorResolution, resolveAnchor } from './resolve.ts';
import { PREVIEW_STYLES, PREVIEW_WIDTH, buildPreview, previewPlace } from './pin-preview.ts';
import { besideElement } from './thread-place.ts';

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
 * 344 px of the mock-up of 2026-10-20 (FRU-304); a window narrower than that takes what it leaves.
 */
const THREAD_WIDTH = 344;
const THREAD_GAP = 8;
/**
 * Where the bubble sits beside its pin (FRU-304): 26 px past the point of the drop, on its end side,
 * or on the other side when the window has no room there. Its top is 8 px above the drop, and never
 * nearer than 24 px to the top or the bottom of the window.
 */
const THREAD_BESIDE = 26;
const THREAD_RISE = 8;
const THREAD_MARGIN = 24;

/**
 * How far apart the badges of one spot sit (FRU-155). Kept next to the stylesheet, which reads it
 * through `--fruitback-pin-slot`: a 28 px drop and a 2 px gap.
 */
const BADGE_STEP = 30;

/**
 * The drop of a pin (FRU-304): 28 px, turned by 45 degrees, its point on the anchor of the note.
 * Its box is 34 px above the point and 14 px on each side of it, as the mock-up places it.
 */
const BADGE_HALF = 14;
const BADGE_RISE = 34;
/**
 * Where on its element a pin points: 16 px in from its start corner, on its top edge, or the middle
 * of an element narrower than 32 px.
 */
const ANCHOR_INSET = 16;

/**
 * How far the frame of a pin stands off its element, on every side (FRU-304): a line of 2 px, 3 px
 * off, as an outline draws it, and as the frame of a capture does (FRU-303). It shows only while its
 * note is pointed at, focused or open.
 */
const FRAME_OUTSET = 5;
/** The line of the frame. The drop is placed from inside it, and `place` counts from outside it. */
const FRAME_BORDER = 2;

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
  /** The capsule of the dock, where the chip of the detached notes goes (FRU-303). See `OrphanListOptions`. */
  dock?: Element;
  /**
   * Which pins to draw. Re-read on `refilter`, so a preference change does not need the issues to be
   * fetched again (FRU-14). Defaults to drawing everything.
   */
  shouldShow?: (issue: NoteIssue) => boolean;
  /**
   * Which issues are notes kept for later, not sent yet (FRU-124). Their pin is neutral, because no
   * tracker gave them a state, and their thread says they are not sent. Defaults to none.
   */
  isDraft?: (issue: NoteIssue) => boolean;
  /**
   * The status of an issue, from the `statuses` of its read (FRU-370). Its pin, its thread and its
   * entry in the detached notes take its colour and its name. `undefined`: the stage, as before.
   * Asked at each render. Left out: every pin is drawn by its stage.
   */
  statusOf?: (issue: NoteIssue) => NoteStatus | undefined;
  /** Called when a pin is clicked, in case the host wants to do more than open the thread. */
  onSelect?: (issue: NoteIssue) => void;
  /** Called when a thread opens or closes: the list of the page marks the note that is open (FRU-259). */
  onThread?: () => void;
  /**
   * Called after the overlay re-resolves its pins on its own. The host is told, so it never has to
   * detect the change itself — which a client's app cannot do.
   */
  onResolve?: (resolutions: { issue: NoteIssue; strategy: AnchorResolution['strategy'] }[]) => void;
  /** The widget's words (FRU-37). Left out: English, with dates in this document's language. */
  translator?: Translator;
  /** How a reader replies to a note from its thread (FRU-257). Left out: no thread has a field. */
  reply?: ReplySeam;
  /**
   * How the author edits the text of their note from its thread (FRU-475). Offered on a note whose
   * read says `editable`. Left out: no thread offers it.
   */
  edit?: EditSeam;
  /**
   * Show the CSS selector of the element in a thread (FRU-349). Off by default: a reviewer reads the
   * note, and the selector is for a developer. The note and the issue keep it either way.
   */
  showSelectors?: boolean;
};

/** Why a reply did not go. The text stays in its field in every case. */
export type ReplyFailure = 'retry' | 'wait' | 'signed-out';

/**
 * A seam like `onSubmit` of the composer (FRU-257): the overlay does not know the worker. `allowed`
 * is asked when a thread is built, and `send` answers the reply as the store wrote it.
 */
export type ReplySeam = {
  allowed(issue: NoteIssue): boolean;
  send(issue: NoteIssue, body: string): Promise<NoteComment | ReplyFailure>;
};

/**
 * Why an edit did not go (FRU-475). The text stays in its field in every case. `refused`: the worker
 * takes no edit of this note any more (the team moved it), and trying again does not change it.
 */
export type EditFailure = ReplyFailure | 'refused';

/**
 * What the store kept of an edit (FRU-475): the note, and the reply that says it was edited, when the
 * reader reads the replies.
 */
export type EditAnswer = { note: Note; comment?: NoteComment };

/** A seam like `ReplySeam` (FRU-475): `send` answers the note as the store kept it. */
export type EditSeam = {
  send(issue: NoteIssue, text: string): Promise<EditAnswer | EditFailure>;
};

export type Overlay = {
  /** Draw this set of pins, replacing whatever was there. */
  render(issues: NoteIssue[]): void;
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
    issue: NoteIssue;
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
   *
   * With `home`, the thread is drawn in that element and not on the page (FRU-312): the list of the
   * page shows it in its own column, in place of its rows. It closes like any thread.
   */
  select(id: string, home?: HTMLElement): boolean;
  /** Closes the open thread, if any, and gives focus back as Close does. */
  closeThread(): void;
  /**
   * Shows the pin of this note above the others, a fifth bigger (FRU-299): the row a list outside
   * the page has open. `undefined` lets it go. Kept across a draw. `false`: no pin of that note.
   */
  mark(id: string | undefined): boolean;
  /**
   * Shows or hides the pins of the page (FRU-308): « Show pins on the page » of the list. The frame
   * of the note chosen in the list stays, so the element it is about stays marked.
   */
  showPins(on: boolean): void;
  /**
   * Shows or hides the CSS selector in a thread (FRU-349). An open thread is drawn again, and a reply
   * being typed in it keeps its text and its caret.
   */
  showSelectors(on: boolean): void;
  destroy(): void;
};

type Placed = {
  issue: NoteIssue;
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
  style.textContent = STYLES + PREVIEW_STYLES;

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
    ...(options.dock === undefined ? {} : { dock: options.dock }),
    translator: t,
    statusOf: (issue) => STATUSES.get(issue),
    onSelect: (issue) => {
      const entry = placed.find((candidate) => candidate.issue.note.id === issue.note.id);
      if (entry !== undefined) openThread(entry);
    },
  });

  // What `render` was last given, before filtering — `refilter` draws from here.
  let source: NoteIssue[] = [];
  let placed: Placed[] = [];
  let thread: HTMLElement | null = null;
  /** Where the open thread is drawn when it is not on the page: a panel of the widget (FRU-312). */
  let threadHome: HTMLElement | null = null;
  /** What had focus when the thread opened: its badge, or an entry of the detached-notes list. */
  let threadOpener: HTMLElement | null = null;
  let selectorsShown = options.showSelectors === true;
  /**
   * How far the open thread was moved by its handle from its place beside the pin (FRU-420). An
   * offset and not a position: on a scroll or a resize the thread is placed beside its pin again, and
   * keeps this offset, so it follows its pin. Forgotten when the thread closes.
   */
  let threadOffset: Offset = NO_OFFSET;
  /** The place beside the pin the offset counts from, in document coordinates. */
  let threadPlace: Box | undefined;
  /** The dashed line from the pin to the thread, while the thread is away from its place. */
  let tetherLine: HTMLElement | null = null;
  /** The preview of the pin under the pointer or with the keyboard focus (FRU-422). */
  let preview: { node: HTMLElement; entry: Placed } | null = null;
  /**
   * The kind of pointer that last pressed a pin. A tap or a click gives the pin the focus too, and
   * that focus shows no preview: only the focus of the keyboard does.
   */
  let pressedWith: string | undefined;
  /** True while a closed thread gives the focus back to its pin: that focus shows no preview. */
  let givingBack = false;
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
    // A thread in a panel of the widget (FRU-312) has no place on the page.
    if (thread !== null && threadHome === null) placeThread(thread, openPin());
    if (preview !== null) placePreview(preview.node, preview.entry);
  }

  /** Shows the preview of a pin, unless its thread is open (FRU-422). */
  function showPreview(entry: Placed, by: 'pointer' | 'keyboard'): void {
    hidePreview();
    if (entry.pin.dataset.fruitbackOpen !== undefined) return;
    const node = buildPreview(document, {
      color: pinColor(entry.issue),
      state: stateLabel(entry.issue, t),
      identifier: entry.issue.url === undefined ? undefined : entry.issue.identifier,
      note: entry.issue.note.text.trim() || entry.issue.identifier,
      hint: t.text(by === 'keyboard' ? 'pin.previewKey' : 'pin.previewClick'),
    });
    container.append(node);
    preview = { node, entry };
    placePreview(node, entry);
  }

  function hidePreview(): void {
    preview?.node.remove();
    preview = null;
  }

  function placePreview(node: HTMLElement, entry: Placed): void {
    const drop = (pin: HTMLElement) => {
      const badge = pin.querySelector('.fruitback-pin-badge');
      return badge === null ? undefined : documentRect(badge);
    };
    const own = drop(entry.pin);
    if (own === undefined) return;
    const others = placed.filter((other) => other !== entry).flatMap((other) => drop(other.pin) ?? []);
    const where = previewPlace(
      own,
      { width: node.offsetWidth || PREVIEW_WIDTH, height: node.offsetHeight },
      {
        left: view?.scrollX ?? 0,
        top: view?.scrollY ?? 0,
        width: document.documentElement.clientWidth || (view?.innerWidth ?? 0),
        height: document.documentElement.clientHeight || (view?.innerHeight ?? 0),
      },
      others,
      t.direction,
    );
    node.style.left = `${where.left}px`;
    node.style.top = `${where.top}px`;
  }

  function openPin(): HTMLElement | undefined {
    return placed.find((entry) => entry.pin.dataset.fruitbackOpen === '')?.pin;
  }

  /** Beside its pin, then moved by the offset the handle gave it (FRU-420). */
  function placeThread(node: HTMLElement, pin: HTMLElement | undefined): void {
    const side = pin === undefined ? undefined : sideOfElement(node, pin);
    if (side === undefined) {
      // No room on any side of the element: beside the pin, as before (FRU-304), with no arrow.
      positionThread(node, pin, t.direction);
      delete node.dataset.fruitbackArrow;
    } else {
      node.style.left = `${side.left}px`;
      node.style.top = `${side.top}px`;
      node.dataset.fruitbackArrow = side.edge;
      node.style.setProperty('--fruitback-arrow-at', `${side.arrow}px`);
    }
    threadPlace = {
      left: Number.parseFloat(node.style.left) || 0,
      top: Number.parseFloat(node.style.top) || 0,
      width: node.offsetWidth || THREAD_WIDTH,
      height: node.offsetHeight,
    };
    showOffset(node, pin);
  }

  /** Under, above or beside the element of the pin, where the window has the room (FRU-421). */
  function sideOfElement(node: HTMLElement, pin: HTMLElement) {
    const frame = {
      left: Number.parseFloat(pin.style.left) || 0,
      top: Number.parseFloat(pin.style.top) || 0,
      width: Number.parseFloat(pin.style.width) || 0,
      height: Number.parseFloat(pin.style.height) || 0,
    };
    const tip = {
      x: frame.left + (Number.parseFloat(pin.style.getPropertyValue('--fruitback-pin-tip-x')) || 0),
      y: frame.top + (Number.parseFloat(pin.style.getPropertyValue('--fruitback-pin-tip-y')) || 0),
    };
    const dropOf = (other: HTMLElement) => {
      const badge = other.querySelector('.fruitback-pin-badge');
      const box = badge === null ? undefined : documentRect(badge);
      return box !== undefined && box.width > 0 ? box : undefined;
    };
    const drop = dropOf(pin) ?? {
      left: tip.x - BADGE_HALF,
      top: tip.y - BADGE_RISE,
      width: 2 * BADGE_HALF,
      height: BADGE_RISE,
    };

    return besideElement(
      frame,
      drop,
      tip,
      { width: node.offsetWidth || THREAD_WIDTH, height: node.offsetHeight },
      {
        left: view?.scrollX ?? 0,
        top: view?.scrollY ?? 0,
        width: document.documentElement.clientWidth || (view?.innerWidth ?? 0),
        height: document.documentElement.clientHeight || (view?.innerHeight ?? 0),
      },
      placed.filter((entry) => entry.pin !== pin).flatMap((entry) => dropOf(entry.pin) ?? []),
      t.direction,
    );
  }

  function showOffset(node: HTMLElement, pin: HTMLElement | undefined): void {
    if (threadPlace === undefined) return;
    node.style.left = `${threadPlace.left + threadOffset.x}px`;
    node.style.top = `${threadPlace.top + threadOffset.y}px`;
    node.toggleAttribute('data-fruitback-moved', moved(threadOffset));
    drawTether(node, pin);
  }

  /** The handle asks for an offset: the thread stays in the window, 8 px from each edge. */
  function moveThread(offset: Offset): void {
    if (thread === null || threadHome !== null || threadPlace === undefined) return;
    const inSight = {
      left: view?.scrollX ?? 0,
      top: view?.scrollY ?? 0,
      // Inside the scroll bars, which `innerWidth` counts.
      width: document.documentElement.clientWidth || (view?.innerWidth ?? 0),
      height: document.documentElement.clientHeight || (view?.innerHeight ?? 0),
    };
    threadOffset = clampOffset(offset, { ...threadPlace, height: thread.offsetHeight }, inSight);
    showOffset(thread, openPin());
  }

  function homeThread(): void {
    threadOffset = NO_OFFSET;
    if (thread !== null && threadHome === null) showOffset(thread, openPin());
  }

  /** A dashed line from the point of the pin to the nearest edge of the thread, once it has moved. */
  function drawTether(node: HTMLElement, pin: HTMLElement | undefined): void {
    const line =
      pin === undefined || !moved(threadOffset)
        ? undefined
        : tether(
            {
              left: Number.parseFloat(node.style.left) || 0,
              top: Number.parseFloat(node.style.top) || 0,
              width: node.offsetWidth || THREAD_WIDTH,
              height: node.offsetHeight,
            },
            {
              x:
                (Number.parseFloat(pin.style.left) || 0) +
                (Number.parseFloat(pin.style.getPropertyValue('--fruitback-pin-tip-x')) || 0),
              y:
                (Number.parseFloat(pin.style.top) || 0) +
                (Number.parseFloat(pin.style.getPropertyValue('--fruitback-pin-tip-y')) || 0),
            },
          );
    if (line === undefined) {
      tetherLine?.remove();
      tetherLine = null;
      return;
    }
    if (tetherLine === null) {
      tetherLine = document.createElement('div');
      tetherLine.className = 'fruitback-thread-tether';
      tetherLine.dataset.fruitbackTether = '';
      tetherLine.setAttribute('aria-hidden', 'true');
    }
    // Before the thread, so that the thread is drawn over its end.
    if (tetherLine.nextSibling !== node) container.insertBefore(tetherLine, node);
    tetherLine.style.setProperty('--fruitback-pin-color', node.style.getPropertyValue('--fruitback-pin-color'));
    Object.assign(tetherLine.style, {
      left: `${line.x}px`,
      top: `${line.y}px`,
      width: `${line.length}px`,
      transform: `rotate(${line.angle}rad)`,
    });
  }

  /** The cross closes, and the handle moves a thread on the page (FRU-420). */
  function wireThread(node: HTMLElement): void {
    node.querySelector('.fruitback-thread-close')?.addEventListener('click', () => closeThread());
    const handle = node.querySelector<HTMLElement>('.fruitback-thread-handle');
    if (handle !== null) attachHandle(handle, { current: () => threadOffset, move: moveThread, home: homeThread });
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
    const rect = attached ? documentRect(element) : boundsToPixels(entry.issue.note.anchor.bounds, document);

    entry.pin.classList.toggle('fruitback-pin-orphan', !attached);
    entry.pin.classList.toggle('fruitback-pin-uncertain', !attached || !entry.resolution.confident);

    Object.assign(entry.pin.style, {
      left: `${rect.left - FRAME_OUTSET}px`,
      top: `${rect.top - FRAME_OUTSET}px`,
      width: `${rect.width + 2 * FRAME_OUTSET}px`,
      height: `${rect.height + 2 * FRAME_OUTSET}px`,
    });
    // The point of the drop, in the box of the pin (FRU-304). Physical, like the pin (FRU-38). At the
    // top of the document the drop has no room above its element: the point goes down by what is missing.
    const tipTop = Math.max(rect.top, BADGE_RISE);
    entry.pin.style.setProperty('--fruitback-pin-tip-x', `${Math.min(ANCHOR_INSET, rect.width / 2) + FRAME_OUTSET}px`);
    entry.pin.style.setProperty('--fruitback-pin-tip-y', `${tipTop - rect.top + FRAME_OUTSET}px`);
  }

  /**
   * Several notes on one spot fan their badges out, in render order (FRU-155).
   *
   * Without it the badges lay exactly on top of each other: one drop showed, and only the last one
   * took the click. Pins whose drops point at one spot share a place, whether they are on one element
   * or on two of the same box. Each note keeps its own drop, its own stage colour and its own thread.
   * The fan goes on to the right, one drop and 2 px at a time: the first one keeps the point.
   */
  function fan(): void {
    const taken = new Map<string, number>();
    for (const { pin } of placed) {
      const x =
        (Number.parseFloat(pin.style.left) || 0) +
        (Number.parseFloat(pin.style.getPropertyValue('--fruitback-pin-tip-x')) || 0);
      const y =
        (Number.parseFloat(pin.style.top) || 0) +
        (Number.parseFloat(pin.style.getPropertyValue('--fruitback-pin-tip-y')) || 0);
      const key = `${Math.round(x)},${Math.round(y)}`;
      const slot = taken.get(key) ?? 0;
      taken.set(key, slot + 1);
      pin.style.setProperty('--fruitback-pin-slot', String(slot));
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
      entry.resolution = resolveAnchor(entry.issue.note.anchor, { document });
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
    if (thread !== null && threadHome === null) anchors.observe(thread);
  }

  function render(issues: NoteIssue[]): void {
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
    // A thread drawn in the list (FRU-312) is not on the page and outlives a draw: a read that
    // answers while somebody reads it must not send the list back to its rows. It is built again
    // below on the new pin of its note, or closed if the note is no longer drawn.
    const homed = threadHome === null ? undefined : thread?.dataset.fruitbackThread;
    if (homed === undefined) closeThread(false);
    // The preview is a child of the container, and goes with the pins it was about.
    preview = null;
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
        STATUSES.delete(issue);
      } else {
        DRAFTS.delete(issue);
        NUMBERS.set(issue, (count += 1));
        const status = options.statusOf?.(issue);
        if (status === undefined) STATUSES.delete(issue);
        else STATUSES.set(issue, status);
      }
    }

    placed = source
      .filter((issue) => options.shouldShow?.(issue) ?? true)
      .map((issue) => {
        const resolution = resolveAnchor(issue.note.anchor, { document });
        const pin = buildPin(document, issue, resolution, t);
        if (marked !== undefined && issue.note.id === marked) pin.dataset.fruitbackMarked = '';
        const entry = { issue, resolution, pin };

        const badge = pin.querySelector<HTMLElement>('.fruitback-pin-badge');
        badge?.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          openThread(entry);
        });
        // The preview (FRU-422): a mouse or a pen that comes over the drop, or the focus of the
        // keyboard. A finger shows none: a tap opens the thread, as before.
        badge?.addEventListener('pointerenter', (event) => {
          if (event.pointerType !== 'touch') showPreview(entry, 'pointer');
        });
        badge?.addEventListener('pointerleave', () => {
          if (preview?.entry === entry && !badge.matches(':focus')) hidePreview();
        });
        badge?.addEventListener('pointerdown', (event) => {
          pressedWith = event.pointerType || 'mouse';
          if (pressedWith === 'touch') hidePreview();
        });
        badge?.addEventListener('focus', () => {
          if (pressedWith === undefined && !givingBack) showPreview(entry, 'keyboard');
        });
        badge?.addEventListener('blur', () => {
          pressedWith = undefined;
          if (preview?.entry === entry) hidePreview();
        });

        container.append(pin);
        place(entry);

        return entry;
      });

    fan();
    observeAnchors();
    listOrphans();
    if (homed !== undefined) {
      const entry = placed.find((candidate) => candidate.issue.note.id === homed);
      if (entry === undefined) closeThread(false);
      else {
        entry.pin.dataset.fruitbackOpen = '';
        entry.pin.querySelector('.fruitback-pin-badge')?.setAttribute('aria-expanded', 'true');
        // Built again in its place, with focus, the caret and the text of a reply kept.
        reopenThread(entry);
      }
    }
    // The pins, and the entries of a list that changed, are new nodes: focus on an old one would fall to the page.
    // Focus in a thread kept in the list stays there: `reopenThread` gave it back.
    if (refocus !== undefined && !(homed !== undefined && thread !== null && refocus.id === homed)) {
      const badge = placed
        .find((entry) => entry.issue.note.id === refocus.id)
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

    return entry === undefined ? undefined : { id: entry.issue.note.id, inList: false };
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
  const replySettled = (issue: NoteIssue, answer: NoteComment | ReplyFailure): void => {
    const entry = placed.find((candidate) => candidate.issue.id === issue.id);
    if (entry === undefined || thread?.dataset.fruitbackThread !== issue.note.id) return;
    // A read may have drawn the note again since: the reply goes on the issue that is on screen too.
    if (typeof answer !== 'string' && !(entry.issue.comments ?? []).some((each) => each.id === answer.id)) {
      entry.issue.comments = [...(entry.issue.comments ?? []), answer];
    }
    const focused = threadHasFocus();
    reopenThread(entry);
    const field = thread?.querySelector<HTMLTextAreaElement>('.fruitback-thread-reply-field');
    if (focused) field?.focus();
  };
  // FRU-475: the edit of a note outlives its thread too, as a reply does. `editing` holds the notes
  // whose text is open in a field.
  const editing = new Set<string>();
  const editTexts = new Map<string, string>();
  const editsInFlight = new Set<string>();
  const editSaid = new Map<string, string>();
  /** Draws the thread of `issue` again, if it is open, and puts focus where the person was. */
  const editSettled = (issue: NoteIssue, focus: 'field' | 'edit' | undefined): void => {
    const entry = placed.find((candidate) => candidate.issue.id === issue.id);
    if (entry === undefined || thread?.dataset.fruitbackThread !== issue.note.id) return;
    // A read may have drawn the note again since: the text goes on the issue that is on screen too.
    if (entry.issue !== issue) {
      entry.issue.note = issue.note;
      if (issue.comments !== undefined) entry.issue.comments = issue.comments;
    }
    reopenThread(entry);
    if (focus === 'field') thread?.querySelector<HTMLTextAreaElement>('.fruitback-thread-edit-field')?.focus();
    if (focus === 'edit') thread?.querySelector<HTMLElement>('.fruitback-thread-edit')?.focus();
  };
  const editFor = (issue: NoteIssue): EditFooter | undefined =>
    options.edit === undefined || DRAFTS.has(issue) || issue.editable !== true
      ? undefined
      : {
          seam: options.edit,
          editing,
          texts: editTexts,
          inFlight: editsInFlight,
          said: editSaid,
          settled: editSettled,
        };
  const replyFor = (issue: NoteIssue): ReplyFooter | undefined =>
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
      isElement(active) &&
      (active.classList.contains('fruitback-thread-reply-field') ||
        active.classList.contains('fruitback-thread-edit-field'))
        ? (active as HTMLTextAreaElement)
        : undefined;
    const typingIn = typing?.classList.contains('fruitback-thread-edit-field')
      ? '.fruitback-thread-edit-field'
      : '.fruitback-thread-reply-field';
    const caret = typing === undefined ? undefined : ([typing.selectionStart, typing.selectionEnd] as const);
    const onHandle = isElement(active) && active.classList.contains('fruitback-thread-handle');
    thread?.remove();
    thread = buildThread(
      document,
      entry.issue,
      entry.resolution,
      t,
      replyFor(entry.issue),
      selectorsShown,
      threadHome === null,
      editFor(entry.issue),
    );
    wireThread(thread);
    mountThread(thread, entry);
    const field = thread.querySelector<HTMLTextAreaElement>(typingIn);
    if (caret !== undefined && field !== null) {
      field.focus();
      field.setSelectionRange(caret[0], caret[1]);
    } else if (focused)
      thread.querySelector<HTMLElement>(onHandle ? '.fruitback-thread-handle' : '.fruitback-thread-close')?.focus();
  }

  /** On the page beside its pin, or in the panel that asked for it (FRU-312). */
  function mountThread(node: HTMLElement, entry: Placed): void {
    if (threadHome !== null) {
      node.dataset.fruitbackHome = '';
      threadHome.replaceChildren(node);
      return;
    }
    container.append(node);
    placeThread(node, entry.pin);
    // The thread grows after it opens (its replies, the form of a reply), and a side that had the room
    // for its first height can lack it for the next (FRU-421): it is placed again when it grows.
    anchors?.observe(node);
  }

  function openThread(entry: Placed, home: HTMLElement | null = null): void {
    const active = deepActiveElement(document);
    hidePreview();
    closeThread();
    threadOpener = active !== null && active !== document.body ? (active as HTMLElement) : null;
    threadHome = home;
    // Chosen in the list (FRU-308): a ring around its element, and the other pins step back.
    container.toggleAttribute('data-fruitback-choosing', home !== null);
    entry.pin.dataset.fruitbackOpen = '';
    entry.pin.querySelector('.fruitback-pin-badge')?.setAttribute('aria-expanded', 'true');
    thread = buildThread(
      document,
      entry.issue,
      entry.resolution,
      t,
      replyFor(entry.issue),
      selectorsShown,
      home === null,
      editFor(entry.issue),
    );
    wireThread(thread);
    mountThread(thread, entry);
    // The thread is the last child of the container, far from its badge in the tab order.
    thread.querySelector<HTMLElement>('.fruitback-thread-close')?.focus();
    options.onSelect?.(entry.issue);
    options.onThread?.();
  }

  function closeThread(restoreFocus = true): void {
    const focused = restoreFocus && threadHasFocus();
    // The last word of a reply is said once: a thread opened again starts with an empty status.
    replySaid.clear();
    editSaid.clear();
    const opener = placed.find((entry) => entry.pin.dataset.fruitbackOpen !== undefined);
    const wasOpen = thread !== null;
    // A thread in the list gives focus back through the list, to the row of its note (FRU-312): the
    // pin on the page is not where the person was.
    const homed = threadHome !== null;
    thread?.remove();
    thread = null;
    threadHome = null;
    // A thread opened again opens in its place (FRU-420).
    threadOffset = NO_OFFSET;
    threadPlace = undefined;
    tetherLine?.remove();
    tetherLine = null;
    container.removeAttribute('data-fruitback-choosing');
    for (const entry of placed) {
      delete entry.pin.dataset.fruitbackOpen;
      entry.pin.querySelector('.fruitback-pin-badge')?.setAttribute('aria-expanded', 'false');
    }
    const badge = opener?.pin.querySelector<HTMLElement>('.fruitback-pin-badge');
    givingBack = true;
    if (focused && !homed) (threadOpener?.isConnected === true ? threadOpener : badge)?.focus();
    givingBack = false;
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
    if (event.key !== 'Escape') return;
    // Escape closes the preview first, and the thread when no preview is shown.
    if (preview !== null) hidePreview();
    else closeThread();
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
    openId: () => placed.find((entry) => entry.pin.dataset.fruitbackOpen !== undefined)?.issue.note.id,
    below(id) {
      const entry = placed.find((candidate) => candidate.issue.note.id === id);
      if (entry === undefined || entry.resolution.element === null || view === null) return false;

      // The top of its frame, in document coordinates, against the bottom edge of the window.
      return (Number.parseFloat(entry.pin.style.top) || 0) >= view.scrollY + view.innerHeight;
    },
    mark(id) {
      marked = id;
      let found = false;
      for (const entry of placed) {
        if (id !== undefined && entry.issue.note.id === id) {
          entry.pin.dataset.fruitbackMarked = '';
          found = true;
        } else delete entry.pin.dataset.fruitbackMarked;
      }

      return id === undefined || found;
    },
    showPins(on) {
      container.toggleAttribute('data-fruitback-pins-hidden', !on);
    },
    showSelectors(on) {
      if (on === selectorsShown) return;
      selectorsShown = on;
      const open = placed.find((entry) => entry.pin.dataset.fruitbackOpen === '');
      if (open !== undefined && thread !== null) reopenThread(open);
    },
    select(id, home) {
      const entry = placed.find((candidate) => candidate.issue.note.id === id);
      if (entry === undefined) return false;
      // The element when the page still has it, the pin otherwise: a detached note has only its pin.
      // No smooth scroll: it is an animation, and nothing here reads `prefers-reduced-motion`.
      const element = entry.resolution.element;
      const target = element !== null && element.isConnected ? element : entry.pin;
      target.scrollIntoView?.({ block: 'center', inline: 'nearest' });
      openThread(entry, home ?? null);

      return true;
    },
    closeThread: () => closeThread(),
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
      hidePreview();
      orphans.destroy();
      container.remove();
      style.remove();
      placed = [];
      source = [];
    },
  };
}

/** The number an overlay gave a note: its place among the notes of the page (FRU-252). */
const NUMBERS = new WeakMap<NoteIssue, number>();

/** The issues an overlay was told are drafts. Marked on the object, which the overlay draws as it got it. */
const DRAFTS = new WeakSet<NoteIssue>();

/**
 * The status an overlay was told each issue is in (FRU-370). Written at each draw, like the two marks
 * above: a note whose status leaves the list is drawn by its stage again.
 */
const STATUSES = new WeakMap<NoteIssue, NoteStatus>();

/**
 * The colour of its status, the stage's token, or a neutral one for a draft: it has no state in any
 * tracker yet (FRU-124).
 */
function pinColor(issue: NoteIssue): string {
  return DRAFTS.has(issue) ? 'var(--fruitback-color-text-muted)' : statusPaint(issue, STATUSES.get(issue)).fill;
}

function buildPin(document: Document, issue: NoteIssue, resolution: AnchorResolution, t: Translator): HTMLElement {
  const pin = document.createElement('div');

  pin.className = 'fruitback-pin';
  // The token rather than the hexadecimal the contract carries (FRU-35). One indirection buys the
  // dark theme, the host override and, once FRU-24 lands, a contract that stops shipping colours at
  // all — a widget's palette has no business travelling in the payload both ends must agree on.
  pin.style.setProperty('--fruitback-pin-color', pinColor(issue));
  // What is written on the drop: dark on the amber of « in progress », white on the others (FRU-233),
  // or the text colour of its status (FRU-370).
  if (!DRAFTS.has(issue))
    pin.style.setProperty('--fruitback-pin-on-color', statusPaint(issue, STATUSES.get(issue)).ink);
  pin.dataset.fruitbackPin = issue.note.id;
  if (DRAFTS.has(issue)) pin.dataset.fruitbackDraft = '';
  pin.dataset.fruitbackStage = issue.stage;
  const status = STATUSES.get(issue);
  if (status !== undefined) pin.dataset.fruitbackStatus = status.key;

  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = 'fruitback-pin-badge';
  // A pin opens its note: a screen reader is told which one is open, and is not told it twice.
  badge.setAttribute('aria-expanded', 'false');
  // No `title` (FRU-422): the preview of the widget takes its place, and the two would show together.
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
function applyResolution(pin: HTMLElement, issue: NoteIssue, resolution: AnchorResolution, t: Translator): void {
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

function summarise(issue: NoteIssue): string {
  const firstLine = issue.note.text
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
 * Comments absent means the worker was not asked for them. An empty list means it asked and there
 * were none. In both cases the thread shows no section (FRU-419): a title over nothing is noise, and
 * the field to reply is below. Anything else is the thread.
 */
function replies(document: Document, issue: NoteIssue, t: Translator): HTMLElement[] {
  if (issue.comments === undefined) return [];

  // No reply yet: no section at all (FRU-419). The field to reply, and its placeholder, say enough.
  if (issue.comments.length === 0) return [];

  // « Replies », above the list (FRU-304). For the eye: the list is named by the same word.
  const title = element(document, 'p', 'fruitback-thread-answers-title', t.text('thread.replies'));
  title.setAttribute('aria-hidden', 'true');

  const list = document.createElement('ul');
  list.className = 'fruitback-thread-replies';
  // The list scrolls past 180 px, and a region that scrolls must take focus, or a keyboard cannot
  // read its end (FRU-154). The name says what the stop is.
  list.tabIndex = 0;
  list.setAttribute('aria-label', t.text('thread.replies'));

  for (const comment of issue.comments) {
    const item = document.createElement('li');
    item.className = 'fruitback-thread-reply';
    const fromPage = replyFromPage(comment.body) ?? editFromPage(comment.body, t);
    const who = fromPage === undefined ? (comment.author ?? t.text('thread.team')) : fromPage.name;
    // FRU-465: the worker says that an agent wrote it. The word is the reader's, not the line's.
    const qualifier = comment.by === 'agent' ? t.text('thread.agent') : fromPage?.who;
    // The initial of who answers, in a round of 24 px (FRU-304). A drawing: the name follows it.
    const avatar = element(document, 'span', 'fruitback-thread-reply-avatar', initialOf(who));
    avatar.setAttribute('aria-hidden', 'true');
    item.append(
      avatar,
      element(document, 'div', 'fruitback-thread-reply-text', [
        byline(
          document,
          'p',
          'fruitback-thread-reply-who',
          who,
          comment.createdAt,
          t,
          // Who answers is what the eye looks for in a conversation: the name is in the ink, the date is not.
          'fruitback-thread-reply-name',
          qualifier,
        ),
        // `textContent`, never markup: this is Linear's markdown, written by whoever can comment on the
        // issue, rendered inside someone else's page. It is text here and nothing more.
        element(document, 'p', 'fruitback-thread-reply-body', fromPage?.text ?? comment.body),
      ]),
    );
    list.append(item);
  }

  return [element(document, 'div', 'fruitback-thread-answers', [title, list])];
}

/** The first letter of a name, as a person reads it, for the round of a reply. */
function initialOf(name: string): string {
  const first = [...name.trim()][0];

  return first === undefined ? '' : first.toLocaleUpperCase();
}

/**
 * What the note points at, in lines of mono (FRU-304, FRU-419): the selector the note carries, then
 * the component and the file behind the element when the capture found them (FRU-256), as
 * « <AddToCart> · src/components/Card.tsx:42 ». As text, like everything a note carries.
 *
 * Both show only when the host asks for the selectors (FRU-349, FRU-419): a reviewer reads the note,
 * and these lines are for a developer.
 */
function sourceBlock(document: Document, issue: NoteIssue, showSelector: boolean): HTMLElement[] {
  if (!showSelector) return [];
  const source = issue.note.source;
  const selector = issue.note.anchor.selector;
  const line = source?.line === undefined ? '' : `:${source.line}`;
  const file = source?.file === undefined ? undefined : `${source.file}${line}`;
  const component = source?.component?.trim() ? `<${source.component.trim()}>` : undefined;
  const parts = [component, file].filter((part): part is string => part !== undefined && part.trim() !== '');

  return [
    element(document, 'div', 'fruitback-thread-source', [
      element(document, 'p', 'fruitback-thread-selector', selector),
      ...(parts.length > 0 ? [element(document, 'p', 'fruitback-thread-component', parts.join(' · '))] : []),
    ]),
  ];
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
 * are two chances to fix only one of them. The preview of a pin (FRU-422) reads it too.
 *
 * `||` and not `??`: an empty string is exactly the case being caught, and `??` would let it through.
 */
function stateLabel(issue: NoteIssue, t: Translator): string {
  if (DRAFTS.has(issue)) return t.text('thread.draft');

  return statusLabel(issue, STATUSES.get(issue), t);
}

/** Note, status, who said it, and the way through to Linear, which owns everything else. */
function buildThread(
  document: Document,
  issue: NoteIssue,
  resolution: AnchorResolution,
  t: Translator,
  reply: ReplyFooter | undefined,
  showSelector: boolean,
  movable: boolean,
  edit?: EditFooter,
): HTMLElement {
  const thread = document.createElement('div');
  thread.className = 'fruitback-thread';
  thread.dataset.fruitbackThread = issue.note.id;
  thread.setAttribute('role', 'dialog');
  thread.setAttribute(
    'aria-label',
    // « Note 2 », the number its drop carries (FRU-256): the name of the dialog and the name of the pin
    // that opens it then say the same note. The identifier of the store is the link of the head.
    DRAFTS.has(issue) ? t.text('thread.draftDialog') : t.text('thread.dialog', { number: NUMBERS.get(issue) ?? 0 }),
  );
  thread.style.setProperty('--fruitback-pin-color', pinColor(issue));

  const reporter = issue.note.reporter?.name ?? issue.note.reporter?.email ?? t.text('thread.anonymous');

  // The drop of the pin, small, in front of the word of the state: the colour is never alone.
  const drop = document.createElement('span');
  drop.className = 'fruitback-thread-drop';
  drop.setAttribute('aria-hidden', 'true');

  // The store's own word for the state. `stateName` is what the store said — Linear's "In Progress",
  // SQLite's own — and the drop beside it carries the stage colour through `--fruitback-pin-color`.
  // See `stateLabel` for why this is not just `issue.stateName`.
  const state = element(document, 'span', 'fruitback-thread-state', stateLabel(issue, t));
  // Since when the note is in its state (FRU-304): in the title of its word, not in the head (FRU-419).
  const since = stateSince(issue, t);
  if (since !== undefined) state.title = since;

  // A div, not a header: inside the widget's region landmark a header is a banner (FRU-51).
  // Two columns (FRU-419): the state and the way out wrap in the first, and the cross keeps the
  // second, at the top.
  const head = element(document, 'div', 'fruitback-thread-head', [
    // On the page only: a thread in the list of the page has its place in the column (FRU-312).
    ...(movable ? [handleButton(document, t)] : []),
    element(document, 'div', 'fruitback-thread-heading', [
      element(document, 'span', 'fruitback-thread-stage', [drop, state]),
      // In the head (FRU-256), where the mock-up draws it: the way out is known before the note is read.
      ...link(document, issue, t),
    ]),
    closeButton(document, t),
  ]);
  // An attribute and not `:has()`: a browser with no `:has()` drops the rule, and the cross would
  // fall to a second line again.
  if (movable) head.dataset.fruitbackMovable = '';

  thread.append(
    head,
    element(document, 'div', 'fruitback-thread-body', [
      ...noteText(document, issue, t, edit),
      byline(document, 'p', 'fruitback-thread-meta', reporter, issue.note.createdAt, t),
      ...sourceBlock(document, issue, showSelector),
      ...attachmentsLine(document, issue, t),
      // Said out loud rather than hidden. A reader who is told the pin might be on the wrong element
      // checks; a reader who is told nothing believes it.
      ...uncertaintyNote(document, resolution, t),
    ]),
    ...replies(document, issue, t),
    ...(reply === undefined ? [] : [replyForm(document, issue, t, reply)]),
  );

  return thread;
}

/** What the edits of the notes share, by note, as `ReplyFooter` (FRU-475). */
type EditFooter = {
  seam: EditSeam;
  editing: Set<string>;
  texts: Map<string, string>;
  inFlight: Set<string>;
  said: Map<string, string>;
  settled: (issue: NoteIssue, focus: 'field' | 'edit' | undefined) => void;
};

const EDIT_FAILURES = {
  retry: 'edit.failed',
  wait: 'edit.failedWait',
  'signed-out': 'edit.failedSignedOut',
  refused: 'edit.refused',
} as const;

/**
 * The text of the note, and for its author the way to edit it (FRU-475): « Edit » under the text, then
 * a field with the text, « Save » and « Cancel ».
 *
 * WARNING: nothing here clears the field but an edit that the store kept, or « Cancel ». A failure
 * keeps the text and says why. The text lives in `texts` too, so a thread built again shows it again.
 */
function noteText(document: Document, issue: NoteIssue, t: Translator, edit: EditFooter | undefined): HTMLElement[] {
  const text = element(document, 'p', 'fruitback-thread-note', issue.note.text || t.text('thread.noNote'));
  if (edit === undefined) return [text];
  const id = issue.note.id;
  const status = document.createElement('span');
  status.className = 'fruitback-thread-edit-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent = edit.said.get(id) ?? '';

  if (!edit.editing.has(id)) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'fruitback-thread-edit';
    open.textContent = t.text('edit.open');
    open.setAttribute('aria-label', t.text('edit.openLabel'));
    open.addEventListener('click', () => {
      edit.editing.add(id);
      edit.said.delete(id);
      edit.settled(issue, 'field');
    });

    return [text, element(document, 'div', 'fruitback-thread-edit-row', [open, status])];
  }

  const form = document.createElement('form');
  form.className = 'fruitback-thread-edit-form';
  const field = document.createElement('textarea');
  field.className = 'fruitback-thread-edit-field';
  field.rows = 3;
  field.setAttribute('aria-label', t.text('edit.label'));
  field.value = edit.texts.get(id) ?? issue.note.text;
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'fruitback-thread-edit-save';
  save.textContent = t.text('edit.save');
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'fruitback-thread-edit-cancel';
  cancel.textContent = t.text('edit.cancel');
  const inFlight = edit.inFlight.has(id);
  save.disabled = inFlight;
  cancel.disabled = inFlight;
  field.readOnly = inFlight;
  if (inFlight) status.textContent = t.text('edit.saving');

  field.addEventListener('input', () => {
    edit.texts.set(id, field.value);
    edit.said.delete(id);
    status.textContent = '';
  });
  cancel.addEventListener('click', () => {
    // The one way out that drops the text: the person asked for it.
    edit.editing.delete(id);
    edit.texts.delete(id);
    edit.said.delete(id);
    edit.settled(issue, 'edit');
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const typed = field.value;
    if (edit.inFlight.has(id) || typed.trim() === '') return;
    // Nothing changed: nothing to send, and the note stays as it is.
    if (typed.trim() === issue.note.text) {
      edit.editing.delete(id);
      edit.texts.delete(id);
      edit.settled(issue, 'edit');
      return;
    }
    edit.inFlight.add(id);
    save.disabled = true;
    cancel.disabled = true;
    field.readOnly = true;
    status.textContent = t.text('edit.saving');
    void edit.seam
      .send(issue, typed)
      .catch((): EditFailure => 'retry')
      .then((answer) => {
        edit.inFlight.delete(id);
        if (typeof answer === 'string') {
          edit.texts.set(id, typed);
          edit.said.set(id, t.text(EDIT_FAILURES[answer]));
          edit.settled(issue, 'field');
          return;
        }
        applyEdit(issue, answer);
        edit.editing.delete(id);
        edit.texts.delete(id);
        edit.said.set(id, t.text('edit.saved'));
        edit.settled(issue, 'edit');
      });
  });
  form.append(field, element(document, 'div', 'fruitback-thread-edit-actions', [save, cancel]), status);

  return [form];
}

/** The note as the store kept it, and the reply of the edit once, on the issue on screen (FRU-475). */
export function applyEdit(issue: NoteIssue, answer: EditAnswer): void {
  issue.note = answer.note;
  const { comment } = answer;
  if (comment !== undefined && issue.comments !== undefined && !issue.comments.some((each) => each.id === comment.id)) {
    issue.comments = [...issue.comments, comment];
  }
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
  settled: (issue: NoteIssue, answer: NoteComment | ReplyFailure) => void;
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

/**
 * The reply the worker writes when the author edits a note (FRU-475, `editText`): the line of who
 * wrote it, then « Edited the note » in the language of the team. The page shows the name, and its own
 * words for the edit. Any other comment is `undefined`.
 */
const EDITED = /^\*\*([^*\n]+)\*\* via Fruitback · ([^\n]+)\n(?:Edited the note|A modifié la note)$/u;

export function editFromPage(body: string, t: Translator): { name: string; who: string; text: string } | undefined {
  const match = EDITED.exec(body);

  return match === null ? undefined : { name: match[1] ?? '', who: match[2] ?? '', text: t.text('thread.edited') };
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
function replyForm(document: Document, issue: NoteIssue, t: Translator, reply: ReplyFooter): HTMLElement {
  const form = document.createElement('form');
  form.className = 'fruitback-thread-reply-form';
  const field = document.createElement('textarea');
  field.className = 'fruitback-thread-reply-field';
  field.rows = 1;
  field.setAttribute('aria-label', t.text('reply.label'));
  const author = issue.note.reporter?.name;
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

/**
 * « In Progress since 10/23/2026 », from the last change the store reports (FRU-304, FRU-419). A
 * draft has no store, and a date the store wrote in a shape `Date` cannot read says nothing.
 */
function stateSince(issue: NoteIssue, t: Translator): string | undefined {
  if (DRAFTS.has(issue)) return undefined;
  const date = new Date(issue.updatedAt);
  if (Number.isNaN(date.getTime())) return undefined;

  return t.text('thread.stateSince', { state: stateLabel(issue, t), date: t.date(date) });
}

/**
 * The handle that moves the thread (FRU-420): by a pointer, by the arrow keys, and back to its place
 * by Home or a double click. Its name says all of that. `bubble-drag.ts` gives it its moves.
 */
function handleButton(document: Document, t: Translator): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'fruitback-thread-handle';
  button.setAttribute('aria-label', t.text('thread.move'));
  button.append(createIcon(document, 'grip'));

  return button;
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
function link(document: Document, issue: NoteIssue, t: Translator): HTMLElement[] {
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
 * « 1 attachment, in DEV-3 » (FRU-332): how many files the note has in its tracker, and the way to its
 * ticket, where they are. **No file is shown here**: the files are the tracker's, and Fruitback serves
 * none. A reader with no link to the tracker (a guest) reads the count alone.
 */
function attachmentsLine(document: Document, issue: NoteIssue, t: Translator): HTMLElement[] {
  const count = issue.attachments?.length ?? 0;
  if (count === 0) return [];
  const line = document.createElement('p');
  line.className = 'fruitback-thread-files';
  line.dataset.fruitbackFiles = String(count);
  line.append(t.plural('thread.attachments', count, { count }));
  if (issue.url !== undefined) {
    const anchor = document.createElement('a');
    anchor.href = issue.url;
    anchor.target = '_blank';
    anchor.rel = 'noreferrer noopener';
    anchor.textContent = t.text('thread.attachmentsIn', { identifier: issue.identifier });
    line.append(' · ', anchor);
  }

  return [line];
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
 * Beside the drop when the window has the room (FRU-304): 26 px past its point on the end side for
 * the reading direction, or on the other side, a little above the drop, and never nearer than 24 px
 * to the top or the bottom of the window. Otherwise below the pin, or above it when there is no room
 * below: that is every phone. The values stay physical, like the pin (FRU-38).
 */
function positionThread(thread: HTMLElement, pin: HTMLElement | undefined, direction: Direction): void {
  if (pin === undefined) return;

  const view = thread.ownerDocument.defaultView;
  const left = Number.parseFloat(pin.style.left) || 0;
  const top = Number.parseFloat(pin.style.top) || 0;
  const pinHeight = Number.parseFloat(pin.style.height) || 0;
  const pinWidth = Number.parseFloat(pin.style.width) || 0;
  const tipX = left + (Number.parseFloat(pin.style.getPropertyValue('--fruitback-pin-tip-x')) || 0);
  const tipY = top + (Number.parseFloat(pin.style.getPropertyValue('--fruitback-pin-tip-y')) || 0);
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

  const after = tipX + THREAD_BESIDE;
  const before = tipX - THREAD_BESIDE - threadWidth;
  const sides = direction === 'rtl' ? [before, after] : [after, before];
  const beside = sides.find((side) => side >= first && side <= last);
  if (beside !== undefined) {
    const highest = scrollY + THREAD_MARGIN;
    const lowest = scrollY + viewportHeight - threadHeight - THREAD_MARGIN;
    thread.style.left = `${beside}px`;
    thread.style.top = `${Math.max(highest, Math.min(tipY - BADGE_RISE - THREAD_RISE, lowest))}px`;
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
  bounds: NoteBounds,
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
  /*
    The frame of the mock-up of 2026-10-20 (FRU-304): a line of 2 px, 3 px off the element, in the
    colour of the status. Transparent at rest: the mock-up draws the drop alone.
  */
  border: 2px solid transparent;
  border-radius: var(--fruitback-radius-sm);
}
/*
  The frame only while its note is pointed at, focused or open (FRU-158). Left on, it lined every
  annotated element of the page, and the more a page was annotated, the less it could be read.

  Two rules and not one list: a browser with no :has() drops the whole rule that names it, and the
  frame of an open thread must not go with it.
*/
.fruitback-pin[data-fruitback-open] {
  z-index: 2147483001;
  border-color: var(--fruitback-pin-color);
  outline: 1px var(--fruitback-pin-frame-style, solid) var(--fruitback-color-stage-edge);
}
/*
  The frame has the edge of the drop outside it (FRU-334): the grey of « to do » is 1.39:1 on a white
  page, and the frame of its note would be lost there.
*/
.fruitback-pin:has(.fruitback-pin-badge:hover),
.fruitback-pin:has(.fruitback-pin-badge:focus-visible) {
  border-color: var(--fruitback-pin-color);
  outline: 1px var(--fruitback-pin-frame-style, solid) var(--fruitback-color-stage-edge);
}
/* Dashed, and its edge too. A custom property, so that the outline stays off at rest. */
.fruitback-pin-uncertain { border-style: dashed; --fruitback-pin-frame-style: dashed; }
/* Detached: listed in the dock, not on the page (FRU-304). A draft keeps its pin where it was planted. */
.fruitback-pin-orphan:not([data-fruitback-draft]) { display: none; }
/*
  The pin of the row a list outside the page has open (FRU-299): above the others, a fifth bigger.
  Its z-index counts against the one of every pin, 2147483000, not against 0 (FRU-326).
*/
/*
  A note chosen in the list of the page (FRU-308): its frame is the ring of the board, 12 px round with
  a halo, and the other pins step back. Not the forced palette: there the frame alone says it.
*/
.fruitback-overlay[data-fruitback-choosing] .fruitback-pin[data-fruitback-open] {
  border-radius: 12px;
  box-shadow: 0 0 0 6px rgba(255, 255, 255, 0.6);
}
.fruitback-overlay[data-fruitback-choosing] .fruitback-pin:not([data-fruitback-open]) { opacity: 0.55; }
/*
  « Show pins on the page » off (FRU-308): no pin but the open one, so a thread open on the page keeps
  its pin, and the note chosen in the list keeps its ring and its drop.
*/
.fruitback-overlay[data-fruitback-pins-hidden] .fruitback-pin:not([data-fruitback-open]) { display: none; }
.fruitback-pin[data-fruitback-marked] { z-index: 2147483001; }
.fruitback-pin[data-fruitback-marked] .fruitback-pin-badge { scale: 1.2; }
.fruitback-pin-orphan { border-style: dotted; }
.fruitback-pin-badge {
  position: absolute;
  /*
    The point of the drop is on the anchor of the note (FRU-304), which place() writes in the box of
    the pin. A child is placed from inside the border of the frame, so the border comes off. One step
    to the right for each note before this one on the same spot (FRU-155).
  */
  left: calc(var(--fruitback-pin-tip-x, 0px) - ${BADGE_HALF + FRAME_BORDER}px + var(--fruitback-pin-slot, 0) * ${BADGE_STEP}px);
  top: calc(var(--fruitback-pin-tip-y, 0px) - ${BADGE_RISE + FRAME_BORDER}px);
  /* …except this, which is the one thing you can click. */
  pointer-events: auto;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  /* A ring of the foreground of the stages, so the drop reads on any page. */
  border: 2px solid var(--fruitback-color-on-stage);
  /* Three round corners and one sharp: a drop, pointing down at its spot. */
  border-radius: 50% 50% 50% 0;
  transform: rotate(-45deg);
  background: var(--fruitback-pin-color);
  color: var(--fruitback-pin-on-color, var(--fruitback-color-on-stage));
  font: 700 12px/1 var(--fruitback-font-sans);
  cursor: pointer;
  /* The edge outside the white ring (FRU-334): a light pin holds on a white page too. */
  box-shadow: 0 0 0 1px var(--fruitback-color-stage-edge), var(--fruitback-shadow-sm);
  transition: transform var(--fruitback-duration-fast) var(--fruitback-ease-out);
  /* Squash and stretch: the drop lands, flattens, and settles. */
  animation: fruitback-pin-drop var(--fruitback-duration-slow) cubic-bezier(0.2, 1.4, 0.35, 1);
}
/* Found by position, not by identity: the same drop, its ring dashed. The number stays. */
.fruitback-pin-uncertain .fruitback-pin-badge { border-style: dashed; }
/* Open: the drop grows, above the others. */
.fruitback-pin[data-fruitback-open] .fruitback-pin-badge { transform: rotate(-45deg) scale(1.15); }
.fruitback-pin-glyph {
  transform: rotate(45deg);
  font-size: 12px;
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.fruitback-pin-badge:hover { filter: brightness(1.06); }
.fruitback-pin-badge:focus-visible { outline: 2px solid var(--fruitback-color-text); outline-offset: 2px; }
/* A forced palette drops the fill: the drop is then its ring. */
@media (forced-colors: active) {
  .fruitback-pin-badge { border-color: ButtonText; }
  .fruitback-pin[data-fruitback-open],
  .fruitback-pin:has(.fruitback-pin-badge:hover) { border-color: Highlight; }
}

@keyframes fruitback-pin-drop {
  0% { opacity: 0; transform: translate(0, -7px) rotate(-45deg) scale(0.7, 1.25); }
  55% { opacity: 1; transform: translate(0, 0) rotate(-45deg) scale(1.18, 0.82); }
  100% { opacity: 1; transform: rotate(-45deg) scale(1, 1); }
}

@media (prefers-reduced-motion: reduce) {
  .fruitback-pin-badge { animation: none; transition: none; }
}
/* FRU-471: a thread fades in where it opens. Opacity only: the placement measures its box. */
@keyframes fruitback-thread-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.fruitback-thread {
  position: absolute;
  z-index: 2147483100;
  /* 344 px, and what a narrower window leaves: 8 px on each side, the gap the placement keeps. */
  width: min(344px, calc(100vw - 16px));
  pointer-events: auto;
  border: 1px solid var(--fruitback-color-border);
  border-radius: var(--fruitback-radius-lg);
  background: var(--fruitback-color-surface);
  color: var(--fruitback-color-text);
  font: 14px/1.5 var(--fruitback-font-sans);
  box-shadow: var(--fruitback-shadow-lg);
  animation: fruitback-thread-in var(--fruitback-duration-fast) var(--fruitback-ease-out);
}
@media (prefers-reduced-motion: reduce) {
  .fruitback-thread { animation: none; }
}
/*
  In a panel of the widget (FRU-312): the column of the list holds it, so it has no place of its own,
  no edge and no shadow.
*/
.fruitback-thread[data-fruitback-home] {
  position: static;
  width: auto;
  border: 0;
  border-radius: 0;
  box-shadow: none;
}
/*
  The arrow from the edge that faces the element to its pin (FRU-421): a square of 12 px turned by 45
  degrees, half out of the bubble, with the two lines of its outer corner. Gone once the thread is moved
  by its handle, where the dashed line takes its place, and in a panel of the widget.
*/
.fruitback-thread[data-fruitback-arrow]::before {
  content: '';
  position: absolute;
  width: 12px;
  height: 12px;
  box-sizing: border-box;
  border: 1px solid var(--fruitback-color-border);
  background: var(--fruitback-color-surface);
  transform: rotate(45deg);
  pointer-events: none;
}
.fruitback-thread[data-fruitback-arrow='top']::before {
  top: -7px;
  left: calc(var(--fruitback-arrow-at) - 6px);
  border-right: 0;
  border-bottom: 0;
}
.fruitback-thread[data-fruitback-arrow='bottom']::before {
  bottom: -7px;
  left: calc(var(--fruitback-arrow-at) - 6px);
  border-top: 0;
  border-left: 0;
}
.fruitback-thread[data-fruitback-arrow='left']::before {
  left: -7px;
  top: calc(var(--fruitback-arrow-at) - 6px);
  border-top: 0;
  border-right: 0;
}
.fruitback-thread[data-fruitback-arrow='right']::before {
  right: -7px;
  top: calc(var(--fruitback-arrow-at) - 6px);
  border-bottom: 0;
  border-left: 0;
}
.fruitback-thread[data-fruitback-moved]::before,
.fruitback-thread[data-fruitback-home]::before { display: none; }
/* A shadow is not drawn in forced colours: the bubble then needs an edge of its own. */
@media (forced-colors: active) {
  .fruitback-thread { outline: 1px solid CanvasText; }
  .fruitback-thread[data-fruitback-home] { outline: 0; }
}
/*
  Two columns (FRU-419): what the head says, and the cross. The cross keeps its column and the top of
  it, so a long head wraps under the state and never pushes the cross to a line of its own.
*/
.fruitback-thread-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  column-gap: 10px;
  padding-block: 14px 12px;
  padding-inline: 16px 14px;
  border-bottom: 1px solid var(--fruitback-color-border);
}
/* With the handle that moves it (FRU-420), first, in a column of its own. */
.fruitback-thread-head[data-fruitback-movable] { grid-template-columns: auto minmax(0, 1fr) auto; }
/*
  The handle (FRU-420): 28 px drawn, 44 px to press, like the cross. Only the handle moves the thread,
  so the text stays selectable everywhere else. No scroll of the page under a finger on it.
*/
.fruitback-thread-handle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  margin: -8px;
  border: 8px solid transparent;
  border-radius: calc(var(--fruitback-radius-sm) + 8px);
  background: transparent;
  font-size: 16px;
  line-height: 1;
  color: var(--fruitback-color-text-muted);
  cursor: grab;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}
.fruitback-thread-handle[data-fruitback-dragging] { cursor: grabbing; }
.fruitback-thread-handle:hover { background: var(--fruitback-color-surface-sunken) padding-box; color: var(--fruitback-color-text); }
.fruitback-thread-handle:focus-visible { outline: 2px solid var(--fruitback-color-accent); outline-offset: -6px; }
/* The line from the pin to a thread moved away from it (FRU-420): dashed, in the colour of its status. */
.fruitback-thread-tether {
  position: absolute;
  z-index: 2147483099;
  height: 0;
  border-top: 2px dashed var(--fruitback-pin-color);
  transform-origin: 0 0;
  pointer-events: none;
}
@media (forced-colors: active) {
  .fruitback-thread-handle { border-color: Canvas; }
  .fruitback-thread-tether { border-top-color: CanvasText; }
}
/* A long state takes the first line, and the way out goes under it (FRU-350). */
.fruitback-thread-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  min-width: 0;
  /* As tall as the cross is drawn, so that a one-line head centres its state on the cross. */
  min-height: 28px;
}
.fruitback-thread-stage {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 1 1 auto;
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
  transform: rotate(-45deg);
  background: var(--fruitback-pin-color);
  box-shadow: 0 0 0 1px var(--fruitback-color-stage-edge);
}
/* anywhere: the store names its states, and a long name must wrap inside the head. */
.fruitback-thread-state { min-width: 0; overflow-wrap: anywhere; }
/*
  The way out to the store (FRU-304): « FRU-128 → » in a chip of the sunken surface, at the end of the
  head. Its target is 44 px tall: a transparent border around the chip, and the margins give it back.
*/
.fruitback-thread-link {
  flex: none;
  display: inline-flex;
  align-items: center;
  margin-inline-start: auto;
  margin-block: -9px;
  padding: 4px 8px;
  border: 9px solid transparent;
  border-inline-width: 0;
  border-radius: var(--fruitback-radius-sm);
  background: var(--fruitback-color-surface-sunken) padding-box;
  color: var(--fruitback-color-text);
  font: 600 12px/1.5 var(--fruitback-font-sans);
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
}
.fruitback-thread-link:hover { color: var(--fruitback-color-accent-strong); }
/* The cross: 28 px drawn, 44 px to press, the margins give the difference back to the head. */
.fruitback-thread-close {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  margin: -8px;
  border: 8px solid transparent;
  border-radius: calc(var(--fruitback-radius-sm) + 8px);
  background: transparent;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  color: var(--fruitback-color-text-muted);
}
.fruitback-thread-close:hover { background: var(--fruitback-color-surface-sunken) padding-box; }
@media (forced-colors: active) {
  .fruitback-thread-close, .fruitback-thread-link { border-color: Canvas; }
}
.fruitback-thread-body { display: flex; flex-direction: column; gap: 10px; padding: 14px 16px 4px; }
/* anywhere: an address has no space, and it must wrap inside the thread instead of leaving it (FRU-154). */
.fruitback-thread-note { margin: 0; font-size: 14px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.fruitback-thread-meta { margin: 0; font-size: 12px; color: var(--fruitback-color-text-muted); overflow-wrap: anywhere; }
/* What the note points at: the selector, then the component and the file, in mono (FRU-304). */
.fruitback-thread-files { margin: 0; font-size: 12px; color: var(--fruitback-color-text-muted); }
.fruitback-thread-files a { color: var(--fruitback-color-text); text-underline-offset: 2px; }
.fruitback-thread-files a:hover { color: var(--fruitback-color-accent-strong); }
.fruitback-thread-files a:focus-visible { outline: 2px solid var(--fruitback-color-accent); outline-offset: 2px; }
/*
  Discreet (FRU-419): lines of 12 px in mono, no box. Selectable, for a developer who copies a path.
*/
.fruitback-thread-source {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font: 12px/1.5 var(--fruitback-font-mono);
  color: var(--fruitback-color-text-muted);
  overflow-wrap: anywhere;
  user-select: text;
  -webkit-user-select: text;
}
.fruitback-thread-selector, .fruitback-thread-component { margin: 0; }
.fruitback-thread-orphan { margin: 0; font-size: 12px; color: var(--fruitback-color-warning); }
.fruitback-thread-answers { padding: 10px 16px 16px; }
.fruitback-thread-answers-title {
  margin: 0 0 10px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--fruitback-color-text-muted);
}
.fruitback-thread-replies {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
  /* A long conversation belongs in the store, which the link of the head goes to. */
  max-height: 180px;
  overflow-y: auto;
}
.fruitback-thread-replies:focus-visible {
  outline: 2px solid var(--fruitback-color-accent);
  outline-offset: 2px;
  border-radius: var(--fruitback-radius-sm);
}
/*
  On the item, not only on the list. The host reset gives every element all:initial, which resets each
  item's own list-style-type to its initial value of disc — and a reset value beats what it would have
  inherited from the list. The bullets came back, and only a recording showed it.
*/
.fruitback-thread-reply { display: flex; gap: 10px; flex: none; list-style: none; }
/* The initial of who answers, in a round of 24 px. */
.fruitback-thread-reply-avatar {
  flex: none;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: var(--fruitback-radius-pill);
  background: var(--fruitback-color-surface-sunken);
  color: var(--fruitback-color-text-subtle);
  font: 700 11px/1 var(--fruitback-font-sans);
}
.fruitback-thread-reply-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.fruitback-thread-reply-who { margin: 0; font-size: 11px; color: var(--fruitback-color-text-muted); overflow-wrap: anywhere; }
.fruitback-thread-reply-name { font-weight: 600; color: var(--fruitback-color-text); }
.fruitback-thread-reply-body { margin: 0; font-size: 13px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
/* The edit of a note by its author (FRU-475): a quiet word under the text, then the text in a field. */
.fruitback-thread-edit-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: -6px; }
.fruitback-thread-edit, .fruitback-thread-edit-cancel {
  padding: 0;
  border: 0;
  background: none;
  font: 600 12px/1.5 var(--fruitback-font-sans);
  color: var(--fruitback-color-text-muted);
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.fruitback-thread-edit:hover, .fruitback-thread-edit-cancel:hover:not([disabled]) { color: var(--fruitback-color-text); }
.fruitback-thread-edit:focus-visible, .fruitback-thread-edit-cancel:focus-visible,
.fruitback-thread-edit-save:focus-visible {
  outline: 2px solid var(--fruitback-color-accent);
  outline-offset: 2px;
  border-radius: var(--fruitback-radius-sm);
}
.fruitback-thread-edit-form { display: flex; flex-direction: column; gap: 8px; }
.fruitback-thread-edit-field {
  min-height: 64px;
  max-height: 200px;
  resize: vertical;
  field-sizing: content;
  border: 1px solid var(--fruitback-color-border-strong);
  border-radius: var(--fruitback-radius-field);
  padding: 7px 10px;
  font: 14px/1.5 var(--fruitback-font-sans);
  background: var(--fruitback-color-surface);
  color: inherit;
  caret-color: var(--fruitback-color-accent);
}
.fruitback-thread-edit-field:focus-visible { outline: 2px solid var(--fruitback-color-accent); outline-offset: 1px; }
.fruitback-thread-edit-actions { display: flex; align-items: center; gap: 12px; }
.fruitback-thread-edit-save {
  display: inline-flex;
  align-items: center;
  height: 32px;
  padding: 0 14px;
  border: 0;
  border-radius: var(--fruitback-radius-pill);
  background: var(--fruitback-color-accent);
  color: var(--fruitback-color-on-accent);
  font: 600 13px/1 var(--fruitback-font-sans);
  cursor: pointer;
}
.fruitback-thread-edit-save:hover:not([disabled]) { background: var(--fruitback-color-accent-strong); }
.fruitback-thread-edit-save[disabled], .fruitback-thread-edit-cancel[disabled] { opacity: 0.55; cursor: default; }
.fruitback-thread-edit-status { font-size: 12px; color: var(--fruitback-color-text-muted); }
.fruitback-thread-edit-status:empty { display: none; }
@media (pointer: coarse) {
  .fruitback-thread-edit-field { font-size: 16px; }
  .fruitback-thread-edit-save, .fruitback-thread-edit, .fruitback-thread-edit-cancel { min-height: 44px; }
}
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
  .fruitback-thread-reply-field { font-size: 16px; }
  .fruitback-thread-reply-send { min-height: 44px; }
}
`;
