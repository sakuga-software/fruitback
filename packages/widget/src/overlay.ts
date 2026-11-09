import {
  type Note,
  type NoteBounds,
  type NoteComment,
  type NoteIssue,
  type NoteStage,
  type NoteStatus,
  anchorSelectorPath,
} from '@fruitback/shared';
import { type Direction, type Translator, createTranslator, languageOf } from './messages.ts';
import { createIcon } from './icons.ts';
import { type Box, type Offset, NO_OFFSET, attachHandle, clampOffset, moved, tether } from './bubble-drag.ts';
import { statusLabel, statusPaint } from './status-paint.ts';
import { isElement } from './dom.ts';
import { deepActiveElement } from './focus.ts';
import { createOrphanList, type OrphanList } from './orphans.ts';
import { type AnchorResolution, followHosts, resolveAnchor } from './resolve.ts';
import { PREVIEW_STYLES, PREVIEW_WIDTH, buildPreview, previewPlace } from './pin-preview.ts';
import { besideElement } from './thread-place.ts';
import { adoptStyles } from './stylesheet.ts';
import { firstLine, readDate } from './note-words.ts';
import { BADGE_HALF, BADGE_RISE, STYLES } from './overlay.styles.ts';
import {
  type MoreFooter,
  type MoreSaid,
  type WithdrawFooter,
  type WithdrawSeam,
  applyWithdraw,
  authorMenuOffered,
  moreMenu,
  moreSaid,
  withdrawBlock,
} from './thread-more.ts';

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
   * How the author of a note the team marked done says whether it looks fixed (FRU-603): « Looks
   * fixed » or « Still wrong » in its thread. Offered when the read says the note is `done`, `mine`
   * and not `checked`. Left out: no thread offers it.
   */
  check?: CheckSeam;
  /**
   * How the author withdraws an open note (FRU-605), from « ⋯ » of its thread. Offered on a note whose
   * read says `withdrawable`. Left out: no thread offers it.
   */
  withdraw?: WithdrawSeam;
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

/** « Looks fixed » or « Still wrong » (FRU-294), as the worker names them. */
export type CheckVerdict = 'fixed' | 'wrong';

/** What the store kept of a verdict (FRU-603): the reply it wrote, and the stage of the note now. */
export type CheckAnswer = { comment: NoteComment; stage: NoteStage };

/**
 * Why a verdict did not go. `refused`: the worker takes none from this reader on this note now (a
 * note moved since the read, or checked already), and trying again does not change it.
 */
export type CheckFailure = ReplyFailure | 'refused';

/** A seam like `ReplySeam` (FRU-603): `send` answers what the store kept of the verdict. */
export type CheckSeam = {
  /** `kept`: the store took it and said nothing of it; the next read says where the note is. */
  send(issue: NoteIssue, verdict: CheckVerdict, body?: string): Promise<CheckAnswer | CheckFailure | 'kept'>;
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
  /** The drop of the pin: the button that opens its thread. */
  badge: HTMLButtonElement;
};

export function createOverlay(options: OverlayOptions = {}): Overlay {
  const document = options.document ?? globalThis.document;
  const view = document.defaultView;
  const t = options.translator ?? createTranslator({ language: languageOf(document) });
  const container = document.createElement('div');
  container.className = 'fruitback-overlay';
  container.dataset.fruitbackOverlay = '';

  const host = options.host ?? document.body;
  const style = adoptStyles(host, STYLES + PREVIEW_STYLES);
  host.append(container);

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
    const own = documentRect(entry.badge);
    const others = placed.filter((other) => other !== entry).map((other) => documentRect(other.badge));
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
      applyResolution(entry, entry.issue, entry.resolution, t);
      place(entry);
    }

    fan();
    observeAnchors();
    observeShadowRoots();
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
    return container.contains(node) || node === container || style.owns(node) || orphans.owns(node);
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

  /**
   * A document observer does not see into a shadow root. So the open shadow roots that the `hosts`
   * of the pins go through are observed too, with the same callback and the same debounce (FRU-582).
   * Only those roots: a page can hold hundreds of web components, and a note names a few.
   *
   * Armed again after each resolution, as `observeAnchors` is. `disconnect` lets go of a root that
   * left the page, and the next walk takes a root that came in. A host that appears later is
   * inserted into a root observed already: the document, or the root of the host above it.
   *
   * The widget's own Shadow root is never observed, even when a host names it: its dock and its
   * popover change on each move of the pointer. A closed root has no `shadowRoot` to observe, so a
   * pin in one stays on its position.
   */
  function observeShadowRoots(): void {
    if (shadowMutations === undefined) return;

    shadowMutations.disconnect();
    const ours = container.getRootNode();
    const roots = new Set<ShadowRoot>();
    for (const entry of placed) {
      const hosts = entry.issue.note.anchor.hosts;
      if (hosts === undefined || hosts.length === 0) continue;

      const walk = followHosts(hosts, document);
      for (const root of walk.roots) if (root !== ours) roots.add(root);
      if (walk.stopped !== null) awaitDefinition(walk.stopped);
    }
    for (const root of roots) shadowMutations.observe(root, { childList: true, subtree: true });
  }

  /**
   * A custom element defined after the pins resolved attaches its shadow root when it upgrades. No
   * mutation record says so, in the document or anywhere. So a host with no shadow root whose name
   * is not defined yet resolves the pins again once it is. One wait per name, and none for a name
   * already defined: that host has a closed root, or none.
   */
  function awaitDefinition(host: Element): void {
    const registry = view?.customElements;
    const name = host.localName;
    if (registry === undefined || !name.includes('-') || awaited.has(name) || registry.get(name) !== undefined) return;

    awaited.add(name);
    registry.whenDefined(name).then(
      () => {
        awaited.delete(name);
        // After `destroy`, `placed` is empty and the resolution returns at once.
        scheduleResolve();
      },
      // Not a valid custom element name: it never upgrades, so there is nothing to wait for.
      () => undefined,
    );
  }

  function render(issues: NoteIssue[]): void {
    // A copy: `refilter` draws from this later, and a caller who keeps mutating the array they
    // passed would otherwise change what is on screen with no render of their own.
    source = [...issues];
    // A read says where each note is now: a verdict answered with no word is asked again if it must be.
    checkAnswered.clear();
    draw();
  }

  function refilter(): void {
    draw();
  }

  /** The note a list outside the page has open (FRU-299): its pin stays marked across a draw. */
  let marked: string | undefined;
  /** The note whose thread on the page a draw keeps open: the one a verdict just changed (FRU-603). */
  let keeping: string | undefined;

  function draw(): void {
    const refocus = focusedTarget();
    // A thread drawn in the list (FRU-312) is not on the page and outlives a draw: a read that
    // answers while somebody reads it must not send the list back to its rows. It is built again
    // below on the new pin of its note, or closed if the note is no longer drawn.
    const open = thread?.dataset.fruitbackThread;
    // A verdict changed the stage of a note (FRU-603): its pin takes its new colour, and its thread,
    // on the page, stays open with the answer in it.
    const homed = threadHome !== null || (keeping !== undefined && keeping === open) ? open : undefined;
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
        const { pin, badge } = buildPin(document, issue, resolution, t);
        if (marked !== undefined && issue.note.id === marked) pin.dataset.fruitbackMarked = '';
        const entry = { issue, resolution, pin, badge };

        badge.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          openThread(entry);
        });
        // The preview (FRU-422): a mouse or a pen that comes over the drop, or the focus of the
        // keyboard. A finger shows none: a tap opens the thread, as before.
        badge.addEventListener('pointerenter', (event) => {
          if (event.pointerType !== 'touch') showPreview(entry, 'pointer');
        });
        badge.addEventListener('pointerleave', () => {
          if (preview?.entry === entry && !badge.matches(':focus')) hidePreview();
        });
        badge.addEventListener('pointerdown', (event) => {
          pressedWith = event.pointerType || 'mouse';
          if (pressedWith === 'touch') hidePreview();
        });
        badge.addEventListener('focus', () => {
          if (pressedWith === undefined && !givingBack) showPreview(entry, 'keyboard');
        });
        badge.addEventListener('blur', () => {
          pressedWith = undefined;
          if (preview?.entry === entry) hidePreview();
        });

        container.append(pin);
        place(entry);

        return entry;
      });

    fan();
    observeAnchors();
    observeShadowRoots();
    listOrphans();
    if (homed !== undefined) {
      const entry = placed.find((candidate) => candidate.issue.note.id === homed);
      if (entry === undefined) closeThread(false);
      else {
        entry.pin.dataset.fruitbackOpen = '';
        entry.badge.setAttribute('aria-expanded', 'true');
        // Built again in its place, with focus, the caret and the text of a reply kept.
        reopenThread(entry);
      }
    }
    // The pins, and the entries of a list that changed, are new nodes: focus on an old one would fall to the page.
    // Focus in a thread kept in the list stays there: `reopenThread` gave it back.
    if (refocus !== undefined && !(homed !== undefined && thread !== null && refocus.id === homed)) {
      const badge = placed.find((entry) => entry.issue.note.id === refocus.id)?.badge;
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
  // FRU-603: the verdict of the author outlives its thread too. `checkWriting` holds the notes whose
  // field « What is still wrong? » is open.
  const checkWriting = new Set<string>();
  const checkAnswered = new Set<string>();
  const checkTexts = new Map<string, string>();
  const checksInFlight = new Map<string, CheckVerdict>();
  const checkSaid = new Map<string, string>();
  /**
   * Draws the thread of `issue` again, if it is open, and puts focus where the person goes next. A
   * verdict the store kept may have changed the stage: the pins are drawn again, this thread kept.
   */
  const checkSettled = (issue: NoteIssue, focus: CheckFocus, kept?: { verdict: CheckVerdict; answer: CheckAnswer }) => {
    const entry = placed.find((candidate) => candidate.issue.id === issue.id);
    if (kept !== undefined) {
      // A read may have drawn the note again since: the answer goes on the issue that is on screen too.
      if (entry !== undefined && entry.issue !== issue) applyCheck(entry.issue, kept.verdict, kept.answer);
    }
    if (entry === undefined || thread?.dataset.fruitbackThread !== issue.note.id) return;
    const focused = threadHasFocus();
    if (kept !== undefined) {
      keeping = issue.note.id;
      try {
        draw();
      } finally {
        keeping = undefined;
      }
    } else reopenThread(entry);
    if (!focused && focus !== 'field') return;
    const target = {
      field: '.fruitback-thread-check-field',
      wrong: '.fruitback-thread-check-wrong',
      said: '.fruitback-thread-check-said',
      close: '.fruitback-thread-close',
    }[focus];
    (
      thread?.querySelector<HTMLElement>(target) ?? thread?.querySelector<HTMLElement>('.fruitback-thread-close')
    )?.focus();
  };
  const checkFor = (issue: NoteIssue): CheckFooter | undefined =>
    options.check === undefined || DRAFTS.has(issue)
      ? undefined
      : {
          seam: options.check,
          answered: checkAnswered,
          writing: checkWriting,
          texts: checkTexts,
          inFlight: checksInFlight,
          said: checkSaid,
          settled: checkSettled,
        };
  // FRU-605: the withdrawal of a note by its author outlives its thread too, as a verdict does.
  const withdrawAsking = new Set<string>();
  const withdrawsInFlight = new Set<string>();
  const withdrawSaid = new Map<string, string>();
  const withdrawSettled: WithdrawFooter['settled'] = (issue, focus, kept) => {
    const entry = placed.find((candidate) => candidate.issue.id === issue.id);
    if (kept !== undefined) {
      applyWithdraw(issue, kept);
      // A read may have drawn the note again since: the answer goes on the issue on screen too.
      if (entry !== undefined && entry.issue !== issue) applyWithdraw(entry.issue, kept);
    }
    if (entry === undefined || thread?.dataset.fruitbackThread !== issue.note.id) return;
    if (kept !== undefined) {
      keeping = issue.note.id;
      try {
        draw();
      } finally {
        keeping = undefined;
      }
    } else reopenThread(entry);
    const target = {
      confirm: '.fruitback-thread-withdraw-confirm',
      said: '.fruitback-thread-withdraw-said',
      more: '.fruitback-thread-more',
    }[focus];
    (
      thread?.querySelector<HTMLElement>(target) ?? thread?.querySelector<HTMLElement>('.fruitback-thread-close')
    )?.focus();
  };
  const withdrawFor = (issue: NoteIssue): WithdrawFooter | undefined =>
    options.withdraw === undefined || DRAFTS.has(issue)
      ? undefined
      : {
          seam: options.withdraw,
          asking: withdrawAsking,
          inFlight: withdrawsInFlight,
          said: withdrawSaid,
          settled: withdrawSettled,
        };
  // FRU-605: the menu « ⋯ » of the author. What its last action said outlives its thread, as a reply.
  const moreSaidOf = new Map<string, MoreSaid>();
  const moreFor = (issue: NoteIssue): MoreFooter | undefined => {
    if (DRAFTS.has(issue) || !authorMenuOffered(issue)) return undefined;
    const edit = editFor(issue);
    const settled = (focus: string): void => {
      const entry = placed.find((candidate) => candidate.issue.id === issue.id);
      if (entry === undefined || thread?.dataset.fruitbackThread !== issue.note.id) return;
      reopenThread(entry);
      thread?.querySelector<HTMLElement>(focus)?.focus();
    };

    const withdraw = issue.withdrawable === true ? withdrawFor(issue) : undefined;

    return {
      said: moreSaidOf,
      ...(withdraw === undefined
        ? {}
        : {
            withdraw: () => {
              withdraw.asking.add(issue.note.id);
              withdraw.said.delete(issue.note.id);
              withdraw.settled(issue, 'confirm');
            },
          }),
      ...(edit === undefined
        ? {}
        : {
            edit: () => {
              edit.editing.add(issue.note.id);
              edit.said.delete(issue.note.id);
              edit.settled(issue, 'field');
            },
          }),
      settled: () =>
        settled(moreSaidOf.get(issue.note.id) === 'manual' ? '.fruitback-thread-more-link' : '.fruitback-thread-more'),
    };
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
      checkFor(entry.issue),
      moreFor(entry.issue),
      withdrawFor(entry.issue),
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
    entry.badge.setAttribute('aria-expanded', 'true');
    thread = buildThread(
      document,
      entry.issue,
      entry.resolution,
      t,
      replyFor(entry.issue),
      selectorsShown,
      home === null,
      editFor(entry.issue),
      checkFor(entry.issue),
      moreFor(entry.issue),
      withdrawFor(entry.issue),
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
    checkSaid.clear();
    moreSaidOf.clear();
    withdrawSaid.clear();
    withdrawAsking.clear();
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
      entry.badge.setAttribute('aria-expanded', 'false');
    }
    const badge = opener?.badge;
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

  // The open shadow roots that the hosts of the pins go through (FRU-582), and the custom element
  // names a host waits on.
  const shadowMutations = view?.MutationObserver === undefined ? undefined : new view.MutationObserver(onMutations);
  const awaited = new Set<string>();

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
      shadowMutations?.disconnect();
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

function buildPin(
  document: Document,
  issue: NoteIssue,
  resolution: AnchorResolution,
  t: Translator,
): { pin: HTMLElement; badge: HTMLButtonElement } {
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

  applyResolution({ pin, badge }, issue, resolution, t);

  return { pin, badge };
}

/**
 * Everything on a pin that depends on what was found, rather than on which issue it is.
 *
 * A pin outlives its resolution: `resolve` re-resolves it in place, so the confidence marks have to
 * follow. Written once at build time, a pin that fell from `selector` to `bounds` kept claiming it
 * had been recognised.
 */
function applyResolution(
  { pin, badge }: { pin: HTMLElement; badge: HTMLButtonElement },
  issue: NoteIssue,
  resolution: AnchorResolution,
  t: Translator,
): void {
  // Three looks, because they mean three different things: found by identity, placed by position,
  // and not found at all.
  pin.classList.toggle('fruitback-pin-uncertain', !resolution.confident);
  pin.classList.toggle('fruitback-pin-orphan', resolution.element === null);
  pin.dataset.fruitbackStrategy = resolution.strategy;
  pin.dataset.fruitbackConfident = String(resolution.confident);

  // A drop of fruit rather than a rectangle of text. The note moves to the accessible name, which is
  // also what keeps it reachable by a screen reader and by a test looking for it by role.
  badge.setAttribute(
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
  const glyph = badge.querySelector('.fruitback-pin-glyph');
  // The number of the note (FRU-252), which the list of the page writes beside the same note. It is
  // what the `≈` of an unsure pin gave way to: the dashed frame, the name of the pin and its thread
  // still say that this one was placed by coordinates, and one drop holds one mark. A note kept for
  // later has no number: the drop is empty, in its neutral colour.
  const number = NUMBERS.get(issue);
  if (glyph !== null) glyph.textContent = number === undefined ? '' : String(number);
}

function summarise(issue: NoteIssue): string {
  const line = firstLine(issue.note.text);

  return line === undefined ? issue.identifier : shortened(line, NAME_MAX_LENGTH);
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
    const fromPage = replyFromPage(comment.body) ?? editFromPage(comment.body, t) ?? verdictFromPage(comment.body, t);
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
  // The hosts first, when the element is in a web component (FRU-580): its selector alone finds nothing.
  const selector = anchorSelectorPath(issue.note.anchor);
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
  check?: CheckFooter,
  more?: MoreFooter,
  withdraw?: WithdrawFooter,
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
    // The menu of the author (FRU-605) beside the cross, in its column: the cross keeps the top.
    more === undefined
      ? closeButton(document, t)
      : element(document, 'div', 'fruitback-thread-tools', [
          moreMenu(document, issue, t, more),
          closeButton(document, t),
        ]),
  ]);
  // An attribute and not `:has()`: a browser with no `:has()` drops the rule, and the cross would
  // fall to a second line again.
  if (movable) head.dataset.fruitbackMovable = '';

  thread.append(
    head,
    element(document, 'div', 'fruitback-thread-body', [
      ...noteText(document, issue, t, edit),
      ...moreSaid(document, issue, t, more),
      ...withdrawBlock(document, issue, t, withdraw),
      byline(document, 'p', 'fruitback-thread-meta', reporter, issue.note.createdAt, t),
      ...sourceBlock(document, issue, showSelector),
      ...attachmentsLine(document, issue, t),
      // Said out loud rather than hidden. A reader who is told the pin might be on the wrong element
      // checks; a reader who is told nothing believes it.
      ...uncertaintyNote(document, resolution, t),
    ]),
    ...doneLine(document, issue, t),
    ...agentLine(document, issue, t),
    ...replies(document, issue, t),
    ...(check === undefined ? [] : checkBlock(document, issue, t, check)),
    // The author answers a note marked done by its verdict (FRU-603): « Still wrong » opens the field
    // that says what is missing. A second field to reply under it would be two ways to say one thing.
    ...(reply === undefined || (check !== undefined && checkOffered(issue))
      ? []
      : [replyForm(document, issue, t, reply)]),
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
// FRU-605: in a tracker, the new text follows, quoted. The thread shows it as the text of the note,
// so the reply says « Edited the note » alone, as in the worker's own store.
const EDITED =
  /^\*\*([^*\n]+)\*\* via Fruitback · ([^\n]+)\n(?:Edited the note|A modifié la note)(?:\n\n(?:>(?: [^\n]*)?(?:\n|$))+)?$/u;

export function editFromPage(body: string, t: Translator): { name: string; who: string; text: string } | undefined {
  const match = EDITED.exec(body);
  if (match !== null) return { name: match[1] ?? '', who: match[2] ?? '', text: t.text('thread.edited') };
  // FRU-605: the reply of a withdrawal, the same shape, read in the words of the reader.
  const withdrawn = WITHDREW.exec(body);

  return withdrawn === null
    ? undefined
    : { name: withdrawn[1] ?? '', who: withdrawn[2] ?? '', text: t.text('thread.withdrawn') };
}

/** The reply the worker writes when the author withdraws a note (FRU-605, `withdrawText`). */
const WITHDREW = /^\*\*([^*\n]+)\*\* via Fruitback · ([^\n]+)\n(?:Withdrew the note|A retiré la note)$/u;

/**
 * The reply the worker writes for a verdict (FRU-294, `checkText`): the line of who wrote it, the
 * line of the verdict in the language of the team, then what the author typed, quoted. The page shows
 * the name, its own words for the verdict, and the text. Any other comment is `undefined`.
 */
const VERDICT = new RegExp(
  '^\\*\\*([^*\\n]+)\\*\\* via Fruitback · ([^\\n]+)\\n' +
    '(Checked: looks fixed|Vérifié : semble corrigé|Reopened: still wrong|Rouvert : toujours faux)' +
    '(?:\\n\\n((?:>(?: [^\\n]*)?(?:\\n|$))+))?$',
  'u',
);

export function verdictFromPage(
  body: string,
  t: Translator,
): { name: string; who: string; text: string; verdict: CheckVerdict } | undefined {
  const match = VERDICT.exec(body);
  if (match === null) return undefined;
  const verdict: CheckVerdict = match[3]?.startsWith('Checked') || match[3]?.startsWith('Vérifié') ? 'fixed' : 'wrong';
  const typed = (match[4] ?? '')
    .replace(/\n$/u, '')
    .split('\n')
    .map((line) => line.replace(/^> ?/u, ''))
    .join('\n');
  const words = t.text(verdict === 'fixed' ? 'thread.checkedFixed' : 'thread.reopened');

  return { name: match[1] ?? '', who: match[2] ?? '', text: typed === '' ? words : `${words}\n${typed}`, verdict };
}

/** Where focus goes when a thread is built again for a verdict (FRU-603). */
type CheckFocus = 'field' | 'wrong' | 'said' | 'close';

/** What the verdicts of the notes share, by note, as `ReplyFooter` (FRU-603). */
type CheckFooter = {
  seam: CheckSeam;
  /** Answered, and the store said nothing of what it made of it: asked no more until a read. */
  answered: Set<string>;
  writing: Set<string>;
  texts: Map<string, string>;
  inFlight: Map<string, CheckVerdict>;
  said: Map<string, string>;
  settled: (issue: NoteIssue, focus: CheckFocus, kept?: { verdict: CheckVerdict; answer: CheckAnswer }) => void;
};

const CHECK_FAILURES = {
  // The words of a reply that did not go: the text and its cause are the same.
  retry: 'reply.failed',
  wait: 'reply.failedWait',
  'signed-out': 'reply.failedSignedOut',
  refused: 'check.refused',
} as const;

/**
 * Whether the reader is asked for a verdict (FRU-603): the worker says the note is `done`, that the
 * reader left it (`mine`), and that nobody confirmed it yet (`checked`). The worker decides who may
 * (FRU-294): the author it can name, by a session of the workspace. Nothing on the page decides it.
 */
export function checkOffered(issue: NoteIssue): boolean {
  return issue.stage === 'done' && issue.mine === true && issue.checked === undefined;
}

/**
 * Who marked the note done (FRU-603): the author of the newest reply of the team, as the side panel
 * of the extension says it (FRU-300). A reply from the page, an edit or a verdict is not the team's.
 */
export function doneByOf(issue: NoteIssue, t: Translator): string | undefined {
  for (const comment of [...(issue.comments ?? [])].reverse()) {
    const fromPage = replyFromPage(comment.body) ?? editFromPage(comment.body, t) ?? verdictFromPage(comment.body, t);
    if (fromPage === undefined && comment.author !== undefined && comment.author.trim() !== '') return comment.author;
  }

  return undefined;
}

/**
 * « An agent is working on this note », above the replies, when a session of a routine was started
 * for it (FRU-618). The read gives the address of that session to a member of the team only: then
 * « Open the session », in a new tab. Every other reader reads the line alone.
 */
function agentLine(document: Document, issue: NoteIssue, t: Translator): HTMLElement[] {
  if (DRAFTS.has(issue) || issue.agent === undefined) return [];
  const line = element(document, 'p', 'fruitback-thread-agent', t.text('thread.agentWorks'));
  const { url } = issue.agent;
  if (url !== undefined) {
    const open = document.createElement('a');
    open.href = url;
    open.target = '_blank';
    open.rel = 'noreferrer noopener';
    open.textContent = t.text('thread.agentSession');
    line.append(' · ', open);
  }

  return [line];
}

/** « Marc Petit marked it done », above the replies of a note done and not confirmed yet (FRU-603). */
function doneLine(document: Document, issue: NoteIssue, t: Translator): HTMLElement[] {
  if (DRAFTS.has(issue) || issue.stage !== 'done' || issue.checked !== undefined) return [];
  const name = doneByOf(issue, t);
  const line = element(
    document,
    'p',
    'fruitback-thread-done',
    name === undefined ? t.text('check.done') : t.text('check.doneBy', { name }),
  );
  // When: in its title, as the state of the head says since when (FRU-419).
  const since = stateSince(issue, t);
  if (since !== undefined) line.title = since;

  return [line];
}

/**
 * The verdict of the author (FRU-603): « Does it look right to you? », « Looks fixed » and « Still
 * wrong ». « Still wrong » opens a field to say what is missing; « Send » writes the verdict and the
 * text together, as one reply of the store.
 *
 * WARNING: nothing here clears the field but a verdict that the store kept. A failure keeps the text
 * and says why. The text lives in `texts` too, so a thread built again shows it again.
 */
function checkBlock(document: Document, issue: NoteIssue, t: Translator, check: CheckFooter): HTMLElement[] {
  const said = check.said.get(issue.id);
  if (!checkOffered(issue) || check.answered.has(issue.id)) {
    // The answer of a verdict the store kept, said once in the thread it was given in.
    if (said === undefined) return [];
    const line = element(document, 'p', 'fruitback-thread-check-said', said);
    line.setAttribute('role', 'status');
    line.tabIndex = -1;

    return [line];
  }

  const block = document.createElement('div');
  block.className = 'fruitback-thread-check';
  const askId = `fruitback-check-${issue.note.id}`;
  const ask = element(document, 'p', 'fruitback-thread-check-ask', t.text('check.ask'));
  ask.id = askId;

  const sending = check.inFlight.get(issue.id);
  const writing = check.writing.has(issue.id);
  const fixed = document.createElement('button');
  fixed.type = 'button';
  fixed.className = 'fruitback-thread-check-fixed';
  fixed.textContent = sending === 'fixed' ? t.text('reply.sending') : t.text('check.fixed');
  const wrong = document.createElement('button');
  wrong.type = 'button';
  wrong.className = 'fruitback-thread-check-wrong';
  wrong.textContent = t.text('check.wrong');
  wrong.setAttribute('aria-expanded', String(writing));
  fixed.disabled = sending !== undefined;
  wrong.disabled = sending !== undefined;
  const actions = element(document, 'div', 'fruitback-thread-check-actions', [fixed, wrong]);
  actions.setAttribute('role', 'group');
  actions.setAttribute('aria-labelledby', askId);

  const status = document.createElement('span');
  status.className = 'fruitback-thread-check-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent = sending === undefined ? (said ?? '') : t.text('reply.sending');

  const send = (verdict: CheckVerdict, body?: string): void => {
    if (check.inFlight.has(issue.id)) return;
    check.inFlight.set(issue.id, verdict);
    check.said.delete(issue.id);
    check.settled(issue, verdict === 'wrong' ? 'field' : 'said');
    void check.seam
      .send(issue, verdict, body)
      .catch((): CheckFailure => 'retry')
      .then((answer) => {
        check.inFlight.delete(issue.id);
        if (answer === 'kept') {
          // Kept, and the worker said nothing of it: no read, which would close this thread. The
          // question goes, and the next read says where the note is.
          check.answered.add(issue.id);
          check.writing.delete(issue.id);
          check.texts.delete(issue.id);
          check.said.set(issue.id, t.text(verdict === 'fixed' ? 'check.sentFixed' : 'check.sentWrong'));
          check.settled(issue, 'said');

          return;
        }
        if (typeof answer === 'string') {
          check.said.set(issue.id, t.text(CHECK_FAILURES[answer]));
          check.settled(issue, verdict === 'wrong' ? 'field' : 'wrong');

          return;
        }
        applyCheck(issue, verdict, answer);
        check.writing.delete(issue.id);
        check.texts.delete(issue.id);
        check.said.set(issue.id, t.text(verdict === 'fixed' ? 'check.sentFixed' : 'check.sentWrong'));
        check.settled(issue, 'said', { verdict, answer });
      });
  };

  fixed.addEventListener('click', () => send('fixed'));
  wrong.addEventListener('click', () => {
    if (check.writing.has(issue.id)) {
      check.writing.delete(issue.id);
      check.settled(issue, 'wrong');
    } else {
      check.writing.add(issue.id);
      check.settled(issue, 'field');
    }
  });

  block.append(ask, actions);
  if (writing) {
    const form = document.createElement('form');
    form.className = 'fruitback-thread-edit-form fruitback-thread-check-form';
    const field = document.createElement('textarea');
    field.className = 'fruitback-thread-edit-field fruitback-thread-check-field';
    field.rows = 2;
    field.setAttribute('aria-label', t.text('check.wrongLabel'));
    field.placeholder = t.text('check.wrongLabel');
    field.value = check.texts.get(issue.id) ?? '';
    field.readOnly = sending !== undefined;
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'fruitback-thread-edit-save fruitback-thread-check-send';
    submit.textContent = t.text('reply.send');
    // The visible word is in the name: « Send » of a reply and of the composer can be on screen too.
    submit.setAttribute('aria-label', t.text('check.sendLabel'));
    submit.disabled = sending !== undefined;
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'fruitback-thread-check-cancel';
    cancel.textContent = t.text('edit.cancel');
    cancel.disabled = sending !== undefined;
    field.addEventListener('input', () => {
      check.texts.set(issue.id, field.value);
      check.said.delete(issue.id);
      status.textContent = '';
    });
    field.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      form.requestSubmit();
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const typed = field.value.trim();
      send('wrong', typed === '' ? undefined : field.value);
    });
    // The text stays in `texts`: « Still wrong » again gives it back.
    cancel.addEventListener('click', () => {
      check.writing.delete(issue.id);
      check.settled(issue, 'wrong');
    });
    form.append(field, element(document, 'div', 'fruitback-thread-check-form-actions', [submit, cancel]));
    block.append(form);
  }
  block.append(status);

  return [block];
}

/**
 * What a verdict that the store kept changes on the issue on screen (FRU-603), with no read: a read
 * draws the pins again and closes the thread the person is in. The reply goes under the note, the note
 * takes the stage the store answered, and « Looks fixed » marks it confirmed, as the next read will.
 */
export function applyCheck(issue: NoteIssue, verdict: CheckVerdict, answer: CheckAnswer): void {
  if (issue.comments !== undefined) {
    issue.comments = [...(issue.comments ?? []).filter((each) => each.id !== answer.comment.id), answer.comment];
  }
  if (answer.stage !== issue.stage) {
    issue.stage = answer.stage;
    // The store's word was for the stage of before: the stage says it until the next read.
    issue.stateName = '';
  }
  if (verdict === 'fixed') {
    issue.checked = { by: replyAuthor(answer.comment), at: answer.comment.createdAt };
  } else delete issue.checked;
}

/** The name on a reply the worker wrote for the page, or its author as the store keeps it. */
function replyAuthor(comment: NoteComment): string {
  return /^\*\*([^*\n]+)\*\*/u.exec(comment.body)?.[1] ?? comment.author ?? '';
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
  // Two lines, as everywhere a reader replies (FRU-606): the side panel has the same field.
  field.rows = 2;
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
  const date = readDate(issue.updatedAt);
  if (date === undefined) return undefined;

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
  const date = readDate(written);
  const when = date === undefined ? written : t.relative(date);
  const node =
    nameClass === undefined
      ? element(document, tag, className, `${who} · ${when}`)
      : element(document, tag, className, [element(document, 'span', nameClass, who)]);
  if (nameClass !== undefined) node.append(`${qualifier === undefined ? '' : ` · ${qualifier}`} · ${when}`);
  if (date !== undefined) node.title = t.date(date);

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
