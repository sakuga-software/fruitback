import {
  canonicalizePageUrl,
  offeredStages,
  offeredStatuses,
  statusOf,
  type Seed,
  type SeedComment,
  type SeedIssue,
  type SeedReporter,
  type SeedScreenshot,
  type SeedSource,
  type SeedStage,
  type SeedStatus,
} from '@fruitback/shared';
import { type CapturedPlace, captureSeed, capturePlace } from './capture.ts';
import { captureAnchor } from './anchor.ts';
import { resolveAnchor } from './resolve.ts';
import { type TypingPlace, createTypingStore } from './typing.ts';
import { type WidgetConfig, createConfigStore } from './config.ts';
import { type FeedbackPlacement, feedbackAsText, placementOf } from './export.ts';
import { type ListState, type ReadState, type Sidebar, type SidebarEntry, createSidebar } from './sidebar.ts';
import {
  type CaptureHost,
  type CaptureTarget,
  aboutTarget,
  createCaptureHost,
  plainHead,
  readableName,
} from './host.ts';
import type { FruitbackTheme } from './theme.ts';
import { type FruitbackTransport, fetchTransport } from './transport.ts';
import { type AttachOffer, type AttachRefusal, type CaptureArea, type PickedFile, refusalOf } from './attachments.ts';
import { pickArea } from './area.ts';
import { type Composer, type SendFailure, type SentWithoutPicture, createComposer } from './composer.ts';
import {
  type BatchOffer,
  type Draft,
  batchBody,
  createDraftStore,
  cutIntoRequests,
  offeredBatch,
  sessionStorageOf,
  withPlacesOfNow,
} from './drafts.ts';
import {
  type Destination,
  type OfferedDestinations,
  createOfferedDestinations,
  destinationToSend,
  offeredDestinations,
} from './destinations.ts';
import { type FruitbackMessages, createTranslator, languageOf } from './messages.ts';
import { type Overlay, type ReplyFailure, createOverlay, replyFromPage } from './overlay.ts';
import { type ConfigPanel, type OfferedStages, createConfigPanel, createOfferedStages } from './panel.ts';
import { linkedNote, withoutLinkedNote } from './page.ts';

/**
 * One call that mounts the whole widget on a page (FRU-16).
 *
 * Everything below this line already existed; what did not was anything that put the pieces
 * together. The playground assembled them by hand — host, overlay, popover, settings, and the two
 * fetches — which meant the product was a set of parts and the integration guide was two hundred
 * lines of someone else's React. This is that assembly, owned here, so a client site writes one
 * call and a `<script>` tag gets an `init` for free.
 *
 * **This is the only file in the widget that knows the worker exists.** `composer.ts` is still handed
 * an `onSubmit` and stays ignorant of URLs and of auth; the transport lives here because this is the
 * layer that was always going to have to know.
 */

export type FruitbackOptions = {
  /** Where the worker answers, e.g. `https://feedback.acme.dev`. */
  endpoint: string;
  /** Which client this site is, as the worker's map knows it. */
  clientId: string;
  /** Shown on the floating button. Wins over `launch.label` in `messages`. */
  label?: string;
  /**
   * The language to show, as a BCP 47 tag (FRU-37). Left out, the widget reads the browser's
   * language. A tag that `Intl` refuses is ignored.
   */
  locale?: string;
  /**
   * The host's own translations, by locale tag: `{ de: { 'launch.label': 'Feedback geben' } }`.
   *
   * The bundle carries English and French (FRU-38). For each key the widget uses the first valid
   * message in this order: the host's exact tag, the bundled exact tag, the host's primary subtag,
   * the bundled primary subtag, then English. A message that is unknown or of the wrong shape is
   * ignored. A plural message has one string per `Intl.PluralRules` category, and `other` is required.
   *
   * `settings.open` and `settings.dialog` must stay different: they name the gear and its dialog.
   */
  messages?: Readonly<Record<string, FruitbackMessages>>;
  /**
   * A short-lived JWT identifying the visitor (FRU-9). Called before every write, so a token that
   * expires mid-session is refreshed rather than rejected. Without it every reporter is
   * self-declared, which is the default and a perfectly good way to run this.
   */
  identityToken?: () => string | undefined | Promise<string | undefined>;
  /**
   * Take a picture of the element the note is about, and return where it now lives (FRU-6).
   *
   * A seam rather than a bundled library, for two reasons. The seed contract stores a **URL**, so
   * something has to host the image, and that is the embedder's storage — they already have some and
   * we would otherwise have to broker an upload with no authentication in front of it. And the only
   * serious way to rasterise a DOM node weighs more than this whole widget: bundling it would undo
   * the promise that a client installs one small thing.
   *
   * `docs/install.md` carries the html2canvas recipe. Absent, the setting is not even offered.
   *
   * Failures are swallowed: the note is worth more than the picture.
   */
  captureScreenshot?: (element: Element) => Promise<CapturedScreenshot | undefined>;
  /**
   * Capture the visible page, or an area of it, as a file of the note (FRU-332): the browser
   * extension does it with `tabs.captureVisibleTab`. `area` is in CSS pixels of the viewport, with the
   * scale of the screen; absent, the whole visible page. The widget is hidden while it is taken.
   *
   * The file goes to the ticket of the tracker, through the worker, which keeps it only while it
   * travels (FRU-331). Without it, « Capture an area » and « Capture the whole page » are not offered. A file
   * of the disk is offered whatever this is, when the worker takes files for this reader.
   */
  captureVisible?: (area?: CaptureArea) => Promise<PickedFile | undefined>;
  /** Chrome the page mounts around the widget, which the pointer must skip. */
  ignore?: (element: Element) => boolean;
  /**
   * Send the user agent, the language and the platform of the reporter with the note. Off by default
   * (FRU-84): a reporter who does nothing is anonymous, and these three narrow down who they are.
   */
  includeEnv?: boolean;
  /**
   * Design tokens, so the widget can be made to look like it belongs (FRU-35).
   *
   * Tokens and not a stylesheet: colours, shadows, the font family and the two animation durations.
   * A host that could write arbitrary CSS into the Shadow root would turn our class names into a
   * contract by accident, which is the one thing the Shadow root exists to prevent.
   *
   * `ThemeToken` is the exhaustive list, and it is exported for exactly this reason — a name outside
   * it is ignored rather than refused, so an override renamed in a later version costs that override
   * and never the mount. Named here rather than pointing at the internal array it comes from: a
   * published doc comment that references a symbol the reader cannot import is a dead end.
   *
   * Left out, the widget follows `prefers-color-scheme` on its own.
   */
  theme?: FruitbackTheme;
  /**
   * Where this instance keeps the reporter's preferences, when the default key is not right.
   *
   * The config store reads `fruitback:config` from `localStorage`, which is correct for one widget
   * on one page and wrong the moment there are two. Two is not exotic: a site that embeds the
   * widget, opened by a reviewer whose extension mounts its own, shares one key, so a stage hidden
   * in one is hidden in the other.
   *
   * Not extension-specific, and named for what it is: a second instance needs a second key.
   * Measured on the playground, which mounts its own widget.
   *
   * The key holds preferences only. `endpoint` and `clientId` are the caller's word, and no stored
   * value replaces them, whatever the key (FRU-89).
   */
  configKey?: string;
  /**
   * Who carries the calls to the worker. Defaults to `fetch`, from this page.
   *
   * The seam exists so a host can put the calls somewhere the page cannot reach. The browser
   * extension relays them through its own session (FRU-56), which is the only way a team token can
   * gate a read without the page's JavaScript being able to read that token.
   *
   * It is also how a mount stays dormant: a site that wants the widget only for a reviewer does not
   * call `init` until it has a transport. A widget that was never built shows nothing and asks for
   * nothing, which is a stronger promise than one that hides itself.
   */
  transport?: FruitbackTransport;
  /**
   * Whether a thread offers a field to reply (FRU-257), when the worker says the reader may. `false`:
   * never. The extension sets it on a site it mounts with no session: the worker cannot tell that
   * reader from a visitor of the site, and the rule of the product says no.
   */
  replies?: boolean;
  /**
   * Open the sign-in of the host (FRU-315). Given, `signedOut(true)` turns the launch button into
   * « Sign in to leave notes », the list says to sign in, and a send refused for a session that ended
   * offers « Sign in again ». The extension passes it for a site of a workspace: it knows when the
   * session of the reviewer ended, before the worker refuses anything.
   */
  onSignIn?: () => void;
  /**
   * The name the host suggests for a reporter who kept none on this site (FRU-302): the extension
   * passes the « Name on my notes » of its preferences. The composer starts with it; a name the
   * reporter typed and kept on this site wins. Never sent unless a note is.
   */
  reporterName?: string;
  /**
   * Show the CSS selector of the element in the thread of a pin (FRU-349). Off by default: the note
   * and the issue in the tracker keep the selector, and only the thread hides it. A developer who
   * wants it on screen turns it on here, or later with `showSelectors`.
   */
  showSelectors?: boolean;
  /**
   * Whether the head of the composer writes the short selector of the element, « button.add ·
   * <AddToCart> » (FRU-411). `always`, the default. `with-selectors`: only while `showSelectors` is on;
   * otherwise the head writes what a person reads for the element, and its component. The extension
   * asks for it, so « Show CSS selectors » of its preferences governs the head too.
   */
  selectorInHead?: 'always' | 'with-selectors';
  document?: Document;
};

/**
 * What a capture has to hand back: somewhere the image now lives.
 *
 * `SeedScreenshot` makes `url` optional — the field was speculative when the contract was written,
 * before anything filled it — so an embedder could return `{ width, height }`, type-check, and store
 * a screenshot nobody can open. Required here, where the promise is actually made.
 */
export type CapturedScreenshot = SeedScreenshot & { url: string };

export type Fruitback = {
  /** Re-read the pins for the current URL. Called for you on navigation. */
  refresh(): Promise<void>;
  /**
   * The feedback on screen as plain text, for a ticket, a message or an agent (FRU-109).
   *
   * It holds what the reviewers wrote and where, and no instruction. It reads the notes the widget
   * already holds, so it makes no request, and it leaves out the stages the reporter hid.
   */
  feedbackAsText(): string;
  /**
   * The settings panel, in case the host wants its own way in — a menu item rather than the gear.
   *
   * The store behind it is deliberately not exposed: a host that could write preferences directly is
   * a host we could never change them under.
   */
  settings: ConfigPanel;
  /**
   * Starts choosing an element, as the launch button does (FRU-254): the extension's popup offers
   * « Leave feedback ». Nothing happens while a note is being written: nothing takes the place of
   * what somebody types, and it answers `false`. A composer that only says « sent » closes. Already
   * choosing, it answers `true` and starts nothing over.
   */
  leaveFeedback(): boolean;
  /** Opens the list of every note of the page, as its button does (FRU-254). */
  showEveryNote(): void;
  /**
   * How many notes of each stage the page shows now (FRU-254), from the last read: no request. The
   * notes of a stage the reporter hid are not shown, so they are not counted. Nothing until a read of
   * this page answered: a count of zero would then say there are no notes.
   */
  pageCounts(): PageCounts | undefined;
  /**
   * The session the host reads and writes with has ended, or is back (FRU-315). Ended, no note can
   * start: the launch button and the list offer `onSignIn` instead, and the composer asks for no
   * name. What is written stays: an open composer stays open, and its text is kept. Back, the widget
   * reads the page again. Without `onSignIn` this does nothing.
   */
  signedOut(ended: boolean): void;
  /**
   * The notes of the page, for a list that is not on the page (FRU-299): the side panel of the
   * extension. The notes the pins show, with their numbers, from the last read: no request. The
   * notes of a stage the reporter hid are left out, as on the page. Nothing until a read of this page
   * answered: an empty list would then say there are no notes.
   */
  pageNotes(): PageNote[] | undefined;
  /**
   * Where the read of the notes of this page is (FRU-299): `pending` until one answers, `read`, or
   * `failed` when none answered. A list outside the page says which, rather than wait.
   */
  notesState(): ReadState;
  /** Scrolls to the pin of a note and opens its thread, as a row of the list does. `false`: not drawn. */
  focusNote(id: string): boolean;
  /**
   * Shows the pin of a note above the others, a fifth bigger: the row open in a list. `undefined`:
   * none. `false`: no pin of that note on the page.
   */
  markNote(id: string | undefined): boolean;
  /**
   * Shows or hides the pins of the page (FRU-307): « Show pins on the page » of the side panel, the
   * same switch as the list of the page (`Overlay.showPins`, FRU-308). The pin of an open thread stays.
   * The notes are still read, and every list still has them.
   */
  showPins(shown: boolean): void;
  /**
   * Shows or hides the CSS selector in the thread of a pin (FRU-349), as the `showSelectors` option
   * does at `init`: « Show CSS selectors » of the extension. An open thread is drawn again.
   */
  showSelectors(shown: boolean): void;
  /**
   * A reply under a note, by the path of its thread (FRU-257), then a read: the pins, the thread
   * and the list say it. `refused`: the worker does not let this reader reply, or the note is not here.
   */
  replyTo(id: string, body: string): Promise<'sent' | ReplyFailure | 'refused'>;
  /**
   * A verdict on a note the team marked done (FRU-294, FRU-300): « Looks fixed » (`fixed`) or « Still
   * wrong » (`wrong`), then a read. The worker decides who may, and when: `refused` is its no.
   */
  checkNote(id: string, verdict: 'fixed' | 'wrong'): Promise<'sent' | ReplyFailure | 'refused'>;
  /**
   * Tells a list outside the page when to read `pageNotes` again (a read, a hidden stage, a note
   * kept) and which note was opened on the page. Answers the way to stop.
   */
  watchNotes(listener: (change: NotesChange) => void): () => void;
  destroy(): void;
};

/** The notes the page shows, by stage. */
export type PageCounts = Record<SeedStage, number>;

/** A note of the page, as `pageNotes` gives it (FRU-299). Plain data: it crosses a `postMessage`. */
export type PageNote = {
  /** The id `focusNote` and `replyTo` take: the id of the seed. */
  id: string;
  /** The number its pin carries. */
  number?: number;
  stage: SeedStage;
  /**
   * The word of its store, Linear's « In Review » (FRU-370). Left out when the store named nothing: a list
   * writes the word of the stage.
   */
  stateName?: string;
  /**
   * Its status, from the `statuses` of the read (FRU-370): its name and the colours a team chose. Always
   * of the note's stage. Left out, the note is drawn by its stage. A colour is `#rrggbb`, as
   * `offeredStatuses` keeps it.
   */
  status?: SeedStatus;
  note: string;
  /** The name the reporter gave, if any. */
  author?: string;
  /** The reader wrote it, with the session of their account (FRU-294). */
  mine?: true;
  createdAt: string;
  updatedAt: string;
  /** Oldest first. */
  /** `fromPage`: written from a page, under a name the page typed (FRU-257); else the tracker's. */
  replies: { author?: string; body: string; createdAt: string; fromPage?: true }[];
  /** Who said it looks fixed, and when (FRU-294): a done note confirmed. */
  checked?: { by: string; at: string };
  /** Whether this reader may reply, as the thread offers it. */
  canReply: boolean;
  placement: FeedbackPlacement;
};

/** What changed for a list outside the page: the notes, or the note opened on the page. */
export type NotesChange = { kind: 'list' } | { kind: 'open'; id: string };

/**
 * The transport this mount uses.
 *
 * One place, so a call site added later cannot quietly take the default and leave a host's relay
 * out of the loop. `embed.test.ts` asserts the default is named nowhere else in this file — and
 * that assertion counts every mention, this comment included, so do not spell it here.
 */
function transportFor(options: FruitbackOptions): FruitbackTransport {
  return options.transport ?? fetchTransport;
}

/**
 * How old the last read must be before a return to the tab reads again (FRU-87).
 *
 * It is the time the worker keeps a read in its cache (`CACHE_TTL_MS` in `apps/worker/src/cache.ts`).
 * A read before that gets the same answer, so it costs a request and shows nothing new.
 */
const REREAD_AFTER_MS = 15_000;

/** How often a page whose notes could not be read is read again, while it fails (FRU-316). */
const READ_RETRY_MS = 30_000;

export function init(options: FruitbackOptions): Fruitback {
  const document = options.document ?? globalThis.document;
  // Named rather than left to fail. This is the published entry point, so the first thing anyone
  // does wrong with it is call it while server-rendering — and `Cannot read properties of undefined`
  // is a stack trace through a bundle, in someone else's app, with no clue what to do about it.
  if (document === undefined) {
    throw new Error(
      'Fruitback.init: no document. The widget is browser-only — mount it in an effect, or after the page loads.',
    );
  }

  const view = document.defaultView ?? globalThis.window;
  const translator = createTranslator({
    locale: options.locale,
    messages: options.messages,
    language: languageOf(document),
  });

  const config = createConfigStore({
    // `screenshot` off at the start: it is the reporter's to turn on, and an image of the page they
    // are looking at is not something to start sending because a default said so.
    defaults: { hiddenStages: [], screenshot: false },
    ...(options.configKey !== undefined ? { key: options.configKey } : {}),
  });

  let target: CaptureTarget | null = null;
  let place: CapturedPlace | undefined;
  /** The element the composer is open on, on its page: where its text is saved (FRU-311). */
  let typingPlace: TypingPlace | undefined;
  // The note being written, per tab, beside the drafts and under the same key (FRU-311).
  const typing = createTypingStore({
    storage: sessionStorageOf(view),
    key: `${options.configKey ?? 'fruitback:config'}:typing`,
  });
  /** The session of the host ended (FRU-315): see `signedOut`. Only with an `onSignIn` to offer. */
  let ended = false;
  const signIn = (): void => options.onSignIn?.();
  let composer: Composer;
  let panel: ConfigPanel;
  let sidebar: Sidebar;

  /** « Show CSS selectors », as the host said it last (FRU-349). The head follows it on request (FRU-411). */
  let selectorsShown = options.showSelectors === true;
  const headOf = (element: Element, source: SeedSource | undefined): string =>
    options.selectorInHead !== 'with-selectors' || selectorsShown
      ? aboutTarget(element, source)
      : plainHead(element, source);
  const host: CaptureHost = createCaptureHost({
    document,
    translator,
    label: options.label,
    // FRU-411: on request, the frame names the element as the head of the composer will.
    ...(options.selectorInHead === 'with-selectors' ? { nameOf: headOf } : {}),
    ignore: options.ignore,
    ...(options.theme !== undefined ? { theme: options.theme } : {}),
    onConfigure: () => panel.toggle(),
    onList: () => sidebar.toggle(),
    onSelect: (selected) => {
      // A note is on its way, about the element chosen before: a choice now would point the
      // composer at another element under a send it cannot change. The choice is let go, and the
      // frame goes back to the element of the note in flight.
      if (composer.state() === 'sending') {
        if (target !== null) host.hold(target.element);

        return;
      }
      // An open composer keeps what is written when it is pointed at another element: the saved text
      // moves with it, or a reload would bring it back on the element of before.
      const keepsText = !composer.element.hidden && (composer.state() === 'idle' || composer.state() === 'failed');
      const before = typingPlace;
      typingPlace = typingPlaceOf(selected.element);
      if (keepsText && before !== undefined && typingPlace !== undefined) {
        const text = typing.get(before)?.text;
        typing.remove(before);
        if (text !== undefined) typing.write(typingPlace, text);
      }
      target = selected;
      place = placeOf(selected);
      // The person chose an element on this visit: a text saved before no longer reopens by itself
      // here, say at a later read that finds its element (review of #372). It comes back on its own
      // element, when the person opens the composer there.
      restoredOn = canonicalizePageUrl(view.location.href);
      // The frame stays on the element for as long as the composer is open on it (FRU-258).
      host.hold(selected.element);
      const rect = selected.element.getBoundingClientRect();
      composer.open(
        {
          left: rect.left + view.scrollX,
          top: rect.top + view.scrollY,
          bottom: rect.bottom + view.scrollY,
          right: rect.right + view.scrollX,
        },
        headOf(selected.element, selected.source),
        readableName(selected.element),
      );
    },
  });

  /**
   * The statuses of the last read that answered (FRU-370). A read with no list, or with one that
   * `offeredStatuses` cannot use, empties it: every pin is then drawn by its stage.
   */
  let readStatuses: SeedStatus[] = [];
  /** The status a note is drawn in, or `undefined` for its stage. A draft has none. */
  const statusFor = (issue: SeedIssue): SeedStatus | undefined =>
    isDraft(issue) ? undefined : statusOf(issue, readStatuses);

  const overlay: Overlay = createOverlay({
    document,
    translator,
    host: host.root,
    dock: host.dock,
    showSelectors: options.showSelectors === true,
    // A draft has no stage yet, so no stage the reporter hid can hide it.
    shouldShow: (issue) => isDraft(issue) || !config.get().hiddenStages.includes(issue.stage),
    isDraft,
    statusOf: statusFor,
    // The page changed under the pins: the list says what each one resolved to now.
    onResolve: () => sidebar.refresh(),
    // A thread opened or closed: the list marks the note that is open. It builds no row again, or
    // the thread would have no row to give focus back to.
    onThread: () => {
      sidebar.mark();
      const open = overlay.openId();
      if (open !== undefined) tellNotes({ kind: 'open', id: open });
    },
    ...(options.replies === false
      ? {}
      : {
          reply: {
            allowed: () => readerIdentity.canReply,
            send: (issue: SeedIssue, body: string) =>
              sendReply(options, view, issue, body, readerIdentity.identified ? undefined : config.get().reporterName),
          },
        }),
  });

  const stages = createOfferedStages();
  const destinations = createOfferedDestinations();
  // The worker's word at the last read that answered (FRU-112): it would sign a note of this reader.
  // And whether it takes several notes in one request (FRU-124).
  const readerIdentity: ReaderIdentity = { identified: false, canReply: false, canWrite: true };
  /** The launch button offers no note (FRU-330): see `closeNotesIfRefused`. */
  let notesClosed = false;
  /** A read answered or failed, so `notesClosed` says what the worker said (FRU-330). */
  let writesKnown = false;
  /** Told after each read that answered: what the worker says of files may have changed (FRU-332). */
  const attachListeners = new Set<() => void>();
  // FRU-299: a list outside the page, told when to read the notes again. A listener that throws is
  // the list's problem, never the page's.
  const notesWatchers = new Set<(change: NotesChange) => void>();
  const tellNotes = (change: NotesChange): void => {
    for (const watcher of notesWatchers) {
      try {
        watcher(change);
      } catch {
        // Swallowed on purpose: see above.
      }
    }
  };
  // The notes kept for later, per tab (FRU-124). Next to the config, under its key.
  const drafts = createDraftStore({
    storage: sessionStorageOf(view),
    key: `${options.configKey ?? 'fruitback:config'}:drafts`,
  });
  /** What the last read answered. The drafts of this page are drawn beside it. */
  let readIssues: SeedIssue[] = [];
  const show = (issues: SeedIssue[], statuses: SeedStatus[]): void => {
    readIssues = issues;
    readStatuses = statuses;
    const here = canonicalizePageUrl(view.location.href);
    overlay.render([
      ...issues,
      ...drafts
        .list()
        .filter((draft) => draft.seed.page.url === here)
        .map((draft) => draftIssue(draft)),
    ]);
  };
  const reader = createReader(show, stages, destinations, readerIdentity, view, options, () => {
    for (const listener of attachListeners) listener();
  });
  let lastReadAt = Number.NEGATIVE_INFINITY;
  // Per page (FRU-153): a navigation starts again at `pending`. A failed read after a good one
  // leaves the state and the pins alone, like it always did.
  let readState: ListState = 'pending';
  const read = (): Promise<void> => {
    lastReadAt = Date.now();

    return reader().then((outcome) => {
      // A stale read touched nothing, and says nothing of who writes either.
      if (outcome !== 'stale') writesKnown = true;
      closeNotesIfRefused();
      if (outcome === 'read') {
        readState = 'read';
        composer.identityChanged();
      } else if (outcome !== 'stale' && readState !== 'read') readState = outcome;
      // FRU-316: said on the page, without the list being opened, and read again by itself.
      // FRU-394: the words of a site that its members read, which no second read changes.
      host.readFailed(
        readState === 'failed' || readState === 'members-only',
        translator.text(readState === 'members-only' ? 'sidebar.membersOnly' : 'sidebar.failed'),
        translator.text(readState === 'members-only' ? 'sidebar.openMembersOnly' : 'sidebar.openFailed'),
      );
      retryWhileFailing();
      sidebar.refresh();
      tellNotes({ kind: 'list' });
      // A link to a note waits for the notes: this is when they are in hand.
      openLinked();
      // A page whose elements came with the read gets its note back now, if the mount was too early.
      restoreTyping();
    });
  };

  /**
   * FRU-330: on a site whose notes are « Members only », a reader with no session is offered no note.
   * A host that signs in (the extension) offers its sign-in instead, through `signedOut`. What is
   * being written is not touched: a draft stays in its store, and an open composer stays open.
   */
  function closeNotesIfRefused(): void {
    if (options.onSignIn !== undefined) return;
    const closed = !readerIdentity.canWrite;
    if (closed === notesClosed) return;
    notesClosed = closed;
    host.closeNotes(
      closed
        ? { label: translator.text('launch.closed'), sentence: translator.text('launch.closedSentence') }
        : undefined,
    );
    sidebar.refresh();
  }

  /**
   * While no read answered for this page and the last one failed (FRU-316), read again every 30 s,
   * and at once when the browser says the network is back. Nothing is shown then, so a read closes
   * no thread and moves no pin. One timer at most; it stops when a read answers.
   */
  let retrying = 0;
  /** A read in flight answers after `destroy` too: a widget that is gone must not read on. */
  let destroyed = false;
  function retryWhileFailing(): void {
    if (retrying !== 0) view.clearTimeout(retrying);
    retrying = failing() && !destroyed ? view.setTimeout(() => void read(), READ_RETRY_MS) : 0;
  }
  // FRU-394: a site that its members read is read again too: an admin can open it meanwhile.
  const failing = (): boolean => readState === 'failed' || readState === 'members-only';
  const onOnline = (): void => {
    if (failing()) void read();
  };
  view.addEventListener('online', onOnline);

  /**
   * Open the composer again on the note left on this page (FRU-311): a reload, a navigation back, a
   * tab that came back. The latest text of the page, on its element, found as a pin is found and
   * only by its identity: a text must not come back on the element that took the place of its own.
   *
   * Once for each visit of a page, and never over somebody who writes, chooses, or reads a thread.
   * A link to a note goes first: the address asked for it.
   */
  let restoredOn: string | undefined;
  function restoreTyping(): void {
    const here = canonicalizePageUrl(view.location.href);
    if (restoredOn === here) return;
    // FRU-330: a text comes back in a composer only where a note can be sent. The first read says
    // it; until then, and while the worker takes no note here, the text waits in its store, and
    // comes back if the site opens again. Not marked as restored, so a later read asks again.
    if (!writesKnown || notesClosed) return;
    if (!composer.element.hidden || host.capturing() || overlay.threadOpen()) return;
    if (linkedNote(view.location.hash) !== undefined) return;
    const latest = typing.latest(here);
    if (latest === undefined) {
      restoredOn = here;

      return;
    }
    // A text whose element cannot be looked for costs the reopening, never the mount.
    let found: ReturnType<typeof resolveAnchor>;
    try {
      found = resolveAnchor(latest.anchor, { document });
    } catch {
      restoredOn = here;

      return;
    }
    if (found.element === null || !found.confident) return;
    restoredOn = here;
    host.choose(found.element);
  }

  /**
   * Open the note the address asks for (FRU-253): `#fruitback-note=<id>`.
   *
   * Only once a read answered for this page: until then the notes are not known, and a read the
   * worker refuses opens nothing, which is what keeps this from showing anything to somebody who
   * cannot read the page. The part of the fragment that is ours is then taken out of the address,
   * found or not, so a reload does not open the note again and the fragment of the site stays.
   *
   * **Nothing takes focus from somebody who writes.** While the composer is open, or a capture
   * runs, the fragment waits in the address: for the composer to close, or for the next read.
   */
  let droppingFragment = false;
  function openLinked(): void {
    const id = linkedNote(view.location.hash);
    if (id === undefined || readState !== 'read') return;
    if (!composer.element.hidden || host.capturing()) return;

    const issue = readIssues.find((each) => each.seed.id === id || each.id === id || each.identifier === id);
    droppingFragment = true;
    try {
      const { pathname, search, hash } = view.location;
      view.history.replaceState(view.history.state, '', `${pathname}${search}${withoutLinkedNote(hash)}`);
    } catch {
      // A page that forbids `replaceState` (a sandboxed frame) keeps its fragment. The note still opens.
    } finally {
      droppingFragment = false;
    }
    if (issue === undefined) return;
    // A note whose element is gone is in « Could not be placed », in the list of the page (FRU-259):
    // the list opens on it, and the thread opens beside it, at the place it was planted.
    const resolution = overlay.resolutions().find((each) => each.issue === issue);
    if (resolution !== undefined && placementOf(resolution) === 'detached') sidebar.open();
    // `false` for a note this page does not draw: one of another page, or of a stage the reporter hid.
    overlay.select(issue.seed.id);
  }

  /**
   * A capture of the page or of an area (FRU-332). The area is chosen on the page, then the widget is
   * hidden for the time of the capture: the file shows the page, not the composer over it.
   *
   * FRU-351: the pins, their tooltips and the frame of the element are hidden from the start, while
   * the area is chosen too (`data-fruitback-shooting`), so the person sees what the file will show.
   * They come back in `finally`: after the capture, a cancel, or a capture that fails or throws.
   */
  async function captureFor(kind: 'page' | 'area'): Promise<PickedFile | 'cancelled' | undefined> {
    const take = options.captureVisible;
    if (take === undefined) return undefined;
    const container = host.root.host as HTMLElement;
    container.toggleAttribute('data-fruitback-shooting', true);
    try {
      let area: CaptureArea | undefined;
      if (kind === 'area') {
        const chosen = await pickArea({ document, host: host.root, translator });
        if (chosen === undefined) return 'cancelled';
        area = { ...chosen, scale: view.devicePixelRatio || 1 };
      }
      const visibility = container.style.visibility;
      container.style.visibility = 'hidden';
      try {
        // Two frames: the page is painted without the widget before the browser takes it.
        await new Promise((resolve) => view.requestAnimationFrame(() => view.requestAnimationFrame(resolve)));

        return await take(area);
      } catch {
        return undefined;
      } finally {
        container.style.visibility = visibility;
      }
    } finally {
      container.toggleAttribute('data-fruitback-shooting', false);
    }
  }

  composer = createComposer({
    document,
    translator,
    host: host.panel,
    // FRU-302: the name the host suggests, for a reporter who kept none here.
    suggestName: () => suggestedName(options.reporterName),
    // The name lives with the other preferences of this browser, under the same key.
    memory: {
      get: () => config.get().reporterName,
      set: (name) => config.set({ reporterName: name }),
    },
    // A host that mints identity tokens names the reporter itself. In team mode the session of the
    // extension does, and only the worker can say so: the widget holds a transport and no token.
    // Signed out (FRU-315), the note is a member's all the same: the name of a visitor would say it
    // can go without a session.
    identified: () => options.identityToken !== undefined || readerIdentity.identified || ended,
    // The places are the worker's word at the last read, and the choice is a preference of this
    // browser on this site, kept with the others (FRU-123).
    destinations: {
      offered: destinations.get,
      subscribe: destinations.subscribe,
      remembered: () => config.get().destination,
      remember: (id) => config.set({ destination: id }),
    },
    // The preference of the settings panel, beside the note (FRU-258). Offered when the host can
    // take a picture, and off until the reporter ticks it: no image leaves the page by default.
    picture: {
      offered: () => options.captureScreenshot !== undefined,
      get: () => config.get().screenshot,
      set: (attach) => config.set({ screenshot: attach }),
      subscribe: (listener) => config.subscribe(() => listener()),
    },
    // FRU-332: the files of a note, when the worker takes them for this reader and this place.
    attachments: {
      offer: (chosen) => attachOffer(readerIdentity, destinations.get(), chosen),
      subscribe: (listener) => {
        attachListeners.add(listener);

        return () => attachListeners.delete(listener);
      },
      captures: () => options.captureVisible !== undefined,
      capture: (kind) => captureFor(kind),
      upload: (file, chosen) => uploadAttachment(options, file, destinationToSend(destinations.get(), chosen)),
    },
    onClose: () => host.release(),
    autosave: {
      read: () => (typingPlace === undefined ? undefined : typing.get(typingPlace)?.text),
      write: (text) => {
        if (typingPlace !== undefined) typing.write(typingPlace, text);
      },
    },
    ...(options.onSignIn === undefined ? {} : { onSignIn: signIn }),
    // Offered only while the worker takes several notes in one request (FRU-124).
    keep: {
      // Signed out too (FRU-315): a text kept for later is sent once the reviewer is back.
      offered: () => readerIdentity.batch !== undefined || ended,
      onKeep: async (note, reporter, chosen) => {
        const destination = destinationToSend(destinations.get(), chosen);
        const about = typingPlace;
        const made = await seedFor({ note, target, place, reporter, config: config.get(), options });
        if (made === undefined) return 'retry';
        drafts.add({ seed: made.seed, ...(destination === undefined ? {} : { destination }) });
        // A draft now: it is in the list, and its text is no longer only being written.
        if (about !== undefined) typing.remove(about);

        return made.missedPicture ? { picture: 'missed' as const } : true;
      },
    },
    onSubmit: async (note, reporter, chosen, attachments = []) => {
      const destination = destinationToSend(destinations.get(), chosen);
      // The element this note is about, as it was sent: the composer may stand on another by the answer.
      const about = typingPlace;
      let seedId: string | undefined;
      const planted = await plant({
        note,
        target,
        place,
        reporter,
        destination,
        attachments,
        config: config.get(),
        options,
        onSeed: (id) => (seedId = id),
      });
      if (typeof planted !== 'string' && about !== undefined) typing.remove(about);
      if (typeof planted === 'string') {
        // The worker refuses a place the site no longer has, or a reader who lost the right to
        // choose. The list on screen is then old, and a second try would be refused like the first.
        // A read brings the list of now, and the composer says what changed.
        if (destination !== undefined) await read();

        return forThisHost(planted);
      }

      // Re-read rather than assume: the pin the reporter is about to see is the one the worker gave
      // back, which is also what proves the write landed somewhere the read path can find.
      await read();

      // The card of a sent note says what the read gave back for it (FRU-305): its identifier, the
      // way to it when the reader may open it, and the number of its pin.
      const shown = overlay.resolutions().find((entry) => entry.issue.seed.id === seedId);
      if (shown === undefined) return planted;

      return {
        sentAs: { identifier: shown.issue.identifier, url: shown.issue.url, number: shown.number },
        ...(planted === true ? {} : { picture: 'missed' as const }),
      };
    },
    // « Pick again » starts a capture over the open composer: it keeps the text, and moves to the
    // element chosen (FRU-258, FRU-305).
    onPickAgain: () => host.start(),
  });

  /** The notes the overlay draws now, with how each one was found. The list and the copied text read it. */
  const entries = (): SidebarEntry[] =>
    overlay
      .resolutions()
      .filter((resolution) => !isDraft(resolution.issue))
      .map((resolution) => {
        const status = statusFor(resolution.issue);

        return {
          issue: resolution.issue,
          placement: placementOf(resolution),
          ...(resolution.number === undefined ? {} : { number: resolution.number }),
          ...(status === undefined ? {} : { status }),
        };
      });

  /**
   * A host that signs in (the extension) holds the sign-in: any `401` is « Your session has ended »
   * with « Sign in again » there, on a note and on the notes kept for later (reviews of #529).
   */
  const forThisHost = (failure: SendFailure): SendFailure =>
    failure === 'members-only' && options.onSignIn !== undefined ? 'signed-out' : failure;

  /** One request after another, then a read: the pins the reviewer sees next are the worker's. */
  let sending = false;
  const sendKept = async (): Promise<{ sent: number; failure?: SendFailure }> => {
    if (sending) return { sent: 0 };
    sending = true;
    try {
      const outcome = await sendDrafts({
        drafts: withPlacesOfNow(drafts.list(), destinations.get()),
        offer: readerIdentity.batch,
        options,
      });
      drafts.remove(outcome.kept);
      // After a failure too: the worker refuses a place the site no longer has, and the list of
      // places on screen is then old. The read brings the list of now, and the next try follows it.
      if (outcome.kept.length > 0 || outcome.failure !== undefined) await read();

      const failure = outcome.failure === undefined ? undefined : forThisHost(outcome.failure);

      return { sent: outcome.kept.length, ...(failure === undefined ? {} : { failure }) };
    } finally {
      sending = false;
    }
  };

  const asText = (): string =>
    feedbackAsText(entries(), { pageUrl: canonicalizePageUrl(view.location.href), translator });

  sidebar = createSidebar({
    document,
    translator,
    host: host.root,
    entries,
    drafts: () => drafts.list(),
    onSendDrafts: sendKept,
    // The thread goes in the column of the list, in place of its rows (FRU-312).
    onSelect: (id, home) => overlay.select(id, home),
    onBack: () => overlay.closeThread(),
    current: () => overlay.openId(),
    below: (id) => overlay.below(id),
    // The dock stands aside while the list is open, so the list holds the way to a new note.
    leave: { label: options.label ?? translator.text('launch.label'), onLeave: () => host.start() },
    // FRU-330: no way to a new note from the list where the worker takes none.
    closed: () => notesClosed,
    // « Show pins on the page » (FRU-308): the switch hides them while the list is open.
    pins: { show: (on) => overlay.showPins(on) },
    readState: () => (ended ? 'signed-out' : readState),
    onSignIn: signIn,
    onRetry: () => {
      readState = 'pending';
      sidebar.refresh();
      void read();
    },
  });

  panel = createConfigPanel({
    document,
    translator,
    host: host.root,
    store: config,
    stages,
    exportText: asText,
    screenshotSupported: options.captureScreenshot !== undefined,
  });

  // A note kept, or sent: the pins of the page and the list say it at once, with no request.
  const stopFollowingDrafts = drafts.subscribe(() => {
    show(readIssues, readStatuses);
    sidebar.refresh();
    tellNotes({ kind: 'list' });
  });

  // A preference change redraws from the issues already held, so it costs no request.
  const unsubscribe = config.subscribe(() => {
    overlay.refilter();
    sidebar.refresh();
    tellNotes({ kind: 'list' });
  });

  let page = canonicalizePageUrl(view.location.href);
  const stopWatchingUrl = watchUrl(view, () => {
    // Our own edit of the address, which takes the link to a note out of it: nothing to read.
    if (droppingFragment) return;
    const now = canonicalizePageUrl(view.location.href);
    // The same page, and a link to a note in its fragment: the notes are in hand, and a read would
    // only close the thread somebody reads.
    if (now === page && linkedNote(view.location.hash) !== undefined) {
      openLinked();

      return;
    }
    page = now;
    readState = 'pending';
    restoredOn = undefined;
    void read();
  });
  // A fragment typed in the address bar, or a link of the page to itself. `popstate` says it too in
  // the browsers of today; this is the event that is about the fragment.
  const onHashChange = (): void => openLinked();
  view.addEventListener('hashchange', onHashChange);
  // A link that waited for somebody to finish a note is followed when the composer closes. The
  // composer says so by hiding itself, sent or given up, and that is what this reads.
  const composerClosed =
    typeof view.MutationObserver === 'function'
      ? new view.MutationObserver(() => {
          if (composer.element.hidden) openLinked();
        })
      : undefined;
  composerClosed?.observe(composer.element, { attributes: true, attributeFilter: ['hidden'] });

  // The team changes the state of an issue while the reviewer is in another tab. `render` closes an
  // open thread, and somebody who comes back to a thread is reading it: that return reads nothing,
  // and the next one does.
  const stopWatchingReturn = watchReturn(document, () => {
    if (overlay.threadOpen() || Date.now() - lastReadAt < REREAD_AFTER_MS) return;

    void read();
  });

  void read();
  restoreTyping();

  return {
    refresh: () => read(),
    feedbackAsText: asText,
    settings: panel,
    leaveFeedback() {
      // A note would be refused (FRU-315): what was asked leads to the sign-in.
      if (ended) {
        signIn();

        return true;
      }
      // Already choosing: what was asked is on the page.
      if (host.capturing()) return true;
      // No note can start here (FRU-330): the launch button says why.
      if (notesClosed) return false;
      // A composer that shows « sent » or « kept » is not being written in: it closes. Any other
      // open composer holds somebody's typing.
      if (!composer.element.hidden) {
        if (composer.state() !== 'sent' && composer.state() !== 'kept') return false;
        composer.close();
      }
      sidebar.close();
      host.start();

      return true;
    },
    showEveryNote: () => sidebar.open(),
    pageNotes() {
      if (readState !== 'read') return undefined;
      const replies = options.replies !== false && readerIdentity.canReply;

      return entries()
        .filter(({ issue }) => !config.get().hiddenStages.includes(issue.stage))
        .map(({ issue, placement, number, status }) => ({
          id: issue.seed.id,
          ...(number === undefined ? {} : { number }),
          stage: issue.stage,
          // The read is cast, not parsed: only a word is passed on.
          ...(typeof issue.stateName === 'string' && issue.stateName !== '' ? { stateName: issue.stateName } : {}),
          ...(status === undefined ? {} : { status }),
          note: issue.seed.note,
          ...(issue.seed.reporter?.name === undefined ? {} : { author: issue.seed.reporter.name }),
          ...(issue.mine === true ? { mine: true as const } : {}),
          createdAt: issue.seed.createdAt,
          updatedAt: issue.updatedAt,
          // A reply written from a page reads as the thread shows it: its name, and its text unquoted.
          replies: (issue.comments ?? []).map((comment) => {
            const fromPage = replyFromPage(comment.body);
            const author = fromPage?.name ?? comment.author;

            return {
              ...(author === undefined ? {} : { author }),
              body: fromPage?.text ?? comment.body,
              createdAt: comment.createdAt,
              ...(fromPage === undefined ? {} : { fromPage: true as const }),
            };
          }),
          ...(issue.checked === undefined ? {} : { checked: { by: issue.checked.by, at: issue.checked.at } }),
          canReply: replies,
          placement,
        }));
    },
    // The list says `members-only` apart; the side panel of the extension knows `failed` (FRU-394).
    notesState: () => (readState === 'members-only' ? 'failed' : readState),
    focusNote: (id) => overlay.select(id),
    markNote: (id) => overlay.mark(id),
    showPins: (shown) => overlay.showPins(shown),
    showSelectors: (shown) => {
      selectorsShown = shown;
      overlay.showSelectors(shown);
    },
    async replyTo(id, body) {
      const issue = readIssues.find((each) => each.seed.id === id);
      if (issue === undefined || options.replies === false || !readerIdentity.canReply || body.trim() === '') {
        return 'refused';
      }
      const sent = await sendReply(
        options,
        view,
        issue,
        body.trim(),
        readerIdentity.identified ? undefined : config.get().reporterName,
      ).catch((): ReplyFailure => 'retry');
      if (typeof sent === 'string') return sent;
      // The reply as the store wrote it is in the next read: the pins, the thread and the lists.
      await read();

      return 'sent';
    },
    async checkNote(id, verdict) {
      const issue = readIssues.find((each) => each.seed.id === id);
      if (issue === undefined) return 'refused';
      const sent = await sendCheck(options, view, issue, verdict).catch((): ReplyFailure => 'retry');
      if (sent !== 'sent') return sent;
      // The store moved the note, or wrote the verdict: the next read says it, never a guess here.
      await read();

      return 'sent';
    },
    watchNotes(listener) {
      notesWatchers.add(listener);

      return () => notesWatchers.delete(listener);
    },
    pageCounts() {
      if (readState !== 'read') return undefined;
      const counts: PageCounts = { new: 0, todo: 0, progress: 0, done: 0, closed: 0 };
      for (const { issue } of entries()) {
        if (config.get().hiddenStages.includes(issue.stage)) continue;
        counts[issue.stage] += 1;
      }

      return counts;
    },
    signedOut(endedNow) {
      if (options.onSignIn === undefined || endedNow === ended) return;
      ended = endedNow;
      host.offerSignIn(ended ? { label: translator.text('launch.signIn'), onSignIn: signIn } : undefined);
      composer.identityChanged();
      sidebar.refresh();
      // Signed in again, the notes this session can read come from a read, not from what was held.
      if (!ended) {
        readState = 'pending';
        void read();
      }
    },
    destroy() {
      destroyed = true;
      notesWatchers.clear();
      if (retrying !== 0) view.clearTimeout(retrying);
      view.removeEventListener('online', onOnline);
      stopWatchingUrl();
      view.removeEventListener('hashchange', onHashChange);
      composerClosed?.disconnect();
      stopFollowingDrafts();
      stopWatchingReturn();
      unsubscribe();
      panel.destroy();
      sidebar.destroy();
      composer.destroy();
      overlay.destroy();
      host.destroy();
    },
  };
}

/** The element of a note on the page of now, as a seed would anchor it (FRU-311). */
function typingPlaceOf(element: Element): TypingPlace | undefined {
  const view = element.ownerDocument.defaultView;
  if (view === null) return undefined;
  try {
    return { page: canonicalizePageUrl(view.location.href), anchor: captureAnchor(element) };
  } catch {
    // Nothing to save the text under: it is still in the field, as before FRU-311.
    return undefined;
  }
}

/**
 * Reads that ignore their own stale answers.
 *
 * Two can be in flight — a return to the tab, then a navigation — and nothing makes them settle in
 * the order they were sent. The late one would then draw the pins of the old page over the correct
 * ones.
 * Each call takes a generation, and only the newest may touch the screen.
 */
function createReader(
  show: (issues: SeedIssue[], statuses: SeedStatus[]) => void,
  stages: OfferedStages,
  destinations: OfferedDestinations,
  identity: ReaderIdentity,
  view: Window & typeof globalThis,
  options: FruitbackOptions,
  /** Called after a read that answered, once the reader identity is set. */
  onRead: () => void = () => undefined,
): () => Promise<ReadOutcome> {
  let generation = 0;

  return async function read(): Promise<ReadOutcome> {
    const mine = ++generation;
    const url = canonicalizePageUrl(view.location.href);

    try {
      // Sent on reads too since FRU-40: a client configured `read: 'authenticated'` answers 401
      // without one. Asked for per read rather than once, for the same reason the write path does —
      // a short-lived token that expired mid-session would otherwise turn every later read into a
      // 401 until the page is reloaded.
      const token = await options.identityToken?.();
      if (mine !== generation) return 'stale';

      const response = await transportFor(options)({
        url: `${options.endpoint}/feedback?url=${encodeURIComponent(url)}&client=${encodeURIComponent(options.clientId)}`,
        method: 'GET',
        headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
      });
      // A 401 lands here like any other failure, and that is deliberate: the pins already on screen
      // are correct, and blanking the page because a token expired would read as "my notes are
      // gone". Same rule as an unreachable worker below.
      if (mine !== generation) return 'stale';
      // FRU-330: a refused read says whether a note would be refused too. Only a `401` says it: a
      // worker that is down or slow says nothing of who writes, and changes nothing.
      if (response.status === 401) identity.canWrite = refusesNotes(response.body) ? false : true;
      // FRU-394: a site that its members read says so, rather than « could not be read ».
      // Not for a host that signs in: its list offers the sign-in, by `signedOut` (review of #529).
      if (response.status === 401 && options.onSignIn === undefined && membersOnly(response.body)) {
        return 'members-only';
      }
      if (!response.ok) return 'failed';

      const body = JSON.parse(response.body) as {
        issues: SeedIssue[];
        stages?: unknown;
        statuses?: unknown;
        destinations?: unknown;
        identified?: unknown;
        batch?: unknown;
        canReply?: unknown;
        canWrite?: unknown;
        canAttach?: unknown;
      };
      if (mine !== generation) return 'stale';

      stages.set(offeredStages(body.stages));
      // Set from every answer, an answer without the field included: that is how a reader who left
      // the team stops seeing the names of its tracker.
      destinations.set(offeredDestinations(body.destinations));
      // Like the places: an answer without the field takes it back, so a reviewer whose session
      // ended is asked for a name again. A failed read changes nothing.
      identity.identified = body.identified === true;
      // The same rule: a worker that stops offering a batch is sent one note at a time (FRU-124).
      identity.batch = offeredBatch(body.batch);
      // The same rule (FRU-257): a reader the worker no longer lets reply gets no field.
      identity.canReply = body.canReply === true;
      // The same rule, the other way (FRU-330): only `false` takes the note away.
      identity.canWrite = body.canWrite !== false;
      // The same rule (FRU-332): absent, this reader sends no file; `false`, the note has no tracker.
      identity.canAttach = typeof body.canAttach === 'boolean' ? body.canAttach : undefined;
      // Like the stages: an answer with no list draws every pin by its stage (FRU-370).
      show(body.issues, offeredStatuses(body.statuses));
      onRead();

      return 'read';
    } catch {
      // A worker that cannot be reached leaves the pins alone. Blanking the page because a read
      // failed would lose what is already correctly on screen.
      return mine === generation ? 'failed' : 'stale';
    }
  };
}

/** Whether the body of a refused read says `canWrite: false` (FRU-330). A body that is not JSON says nothing. */
function refusesNotes(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);

    return typeof parsed === 'object' && parsed !== null && (parsed as { canWrite?: unknown }).canWrite === false;
  } catch {
    return false;
  }
}

/**
 * `stale`: a newer read was sent, and this one touched nothing. `members-only`: refused for want of a
 * session of a member (FRU-394).
 */
type ReadOutcome = 'read' | 'failed' | 'members-only' | 'stale';

/**
 * Exported for its tests, never from `public.ts`.
 *
 * The composer reaches this through a hit test happy-dom cannot do, so the write path had no unit
 * cover at all: a regression in its method, headers or body would have passed. What it needs is a
 * target, and a target is an element — which happy-dom does have. Raised in review.
 */
export async function plant({
  note,
  target,
  place,
  reporter,
  destination,
  config,
  options,
  onSeed,
  attachments = [],
}: {
  note: string;
  target: CaptureTarget | null;
  /** Where the element was when the reporter chose it (FRU-152). Left out, it is read at the send. */
  place?: CapturedPlace | undefined;
  reporter: SeedReporter | undefined;
  /** The opaque id of the place a member chose, when it is not the first one (FRU-123). */
  destination?: string | undefined;
  config: WidgetConfig;
  options: FruitbackOptions;
  /** The id of the seed about to be sent, so the caller finds its pin after the read (FRU-305). */
  onSeed?: (id: string) => void;
  /** The ids in transit of the files of the note (FRU-332). */
  attachments?: readonly string[];
}): Promise<true | SentWithoutPicture | SendFailure> {
  const made = await seedFor({ note, target, place, reporter, config, options });
  if (made === undefined) return 'retry';
  const { seed, missedPicture } = made;
  onSeed?.(seed.id);

  // Asked for per write rather than once at init: a short-lived token that expired mid-session would
  // otherwise turn every later note into a 401.
  const token = await options.identityToken?.();

  const response = await transportFor(options)({
    // The choice is in the query and nowhere else. The body stays the seed, and the relay of the
    // extension carries a query, and no header but the two below.
    url: feedbackUrl(options, destination, attachments),
    method: 'POST',
    headers: writeHeaders(token),
    body: JSON.stringify(seed),
  });

  if (!response.ok) return failureOf(response);

  return missedPicture ? { picture: 'missed' } : true;
}

/**
 * The seed of a note, as the click and the page give it now: sent at once, or kept for later
 * (FRU-124). `undefined` when there is no element to anchor it to.
 */
async function seedFor({
  note,
  target,
  place,
  reporter,
  config,
  options,
}: {
  note: string;
  target: CaptureTarget | null;
  place?: CapturedPlace | undefined;
  reporter: SeedReporter | undefined;
  config: WidgetConfig;
  options: FruitbackOptions;
}): Promise<{ seed: Seed; missedPicture: boolean } | undefined> {
  if (target === null) return undefined;
  const picture = stillThere(target.element, place) ? await screenshotFor(target.element, config, options) : undefined;
  const seed = captureSeed({
    element: target.element,
    note,
    client: { id: options.clientId },
    source: target.source,
    reporter,
    includeEnv: options.includeEnv,
    ...(place === undefined ? {} : { place }),
    ...optionalScreenshot(picture === 'missed' ? undefined : picture),
  });

  return { seed, missedPicture: picture === 'missed' };
}

/**
 * `?destination=` carries the choice, and nothing else does: the body stays the seed (FRU-123). The
 * files of the note travel the same way, as `?attachments=` (FRU-332): their ids are no part of a seed.
 */
function feedbackUrl(
  options: FruitbackOptions,
  destination: string | undefined,
  attachments: readonly string[] = [],
): string {
  const query = new URLSearchParams();
  if (destination !== undefined) query.set('destination', destination);
  if (attachments.length > 0) query.set('attachments', attachments.join(','));
  const search = query.toString();

  return search === '' ? `${options.endpoint}/feedback` : `${options.endpoint}/feedback?${search}`;
}

/** What the last read of the page said of this reader. */
type ReaderIdentity = {
  identified: boolean;
  batch?: BatchOffer | undefined;
  canReply: boolean;
  /**
   * `canWrite` (FRU-330): `false` when the worker said that it takes no note of this reader here, in a
   * read or in the refusal of one. Absent from the answer, `true`: every worker of before took notes.
   */
  canWrite: boolean;
  /** FRU-332: `true` the worker takes files of this reader, `false` the note has no tracker. */
  canAttach?: boolean | undefined;
};

/**
 * What the composer offers of files, for the place the note goes to (FRU-332). A place the worker
 * names says it for itself; the site says it for its first place, and for a note that names none.
 */
export function attachOffer(
  identity: ReaderIdentity,
  places: readonly Destination[],
  chosen: string | undefined,
): AttachOffer {
  if (identity.canAttach === undefined) return 'none';
  const place = places.find((each) => each.id === chosen);
  const takes = place?.canAttach ?? identity.canAttach;

  return takes ? 'offered' : 'no-tracker';
}

/**
 * One file on its way to the worker (FRU-332), through the transport of the host like every call:
 * `POST /attachments`, its bytes in base64 for the transport, its type in `Content-Type`. The answer
 * is its id in transit, which the note names, or why it did not go.
 */
export async function uploadAttachment(
  options: FruitbackOptions,
  file: PickedFile,
  destination: string | undefined,
): Promise<{ ok: true; id: string } | { ok: false; refusal: AttachRefusal }> {
  const query = new URLSearchParams({ client: options.clientId, name: file.name });
  if (destination !== undefined) query.set('destination', destination);
  try {
    const token = await options.identityToken?.();
    const response = await transportFor(options)({
      url: `${options.endpoint}/attachments?${query.toString()}`,
      method: 'POST',
      headers: { 'Content-Type': file.type, ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) },
      body: file.base64,
      encoding: 'base64',
    });
    if (!response.ok) return { ok: false, refusal: refusalOf(response) };
    const { id } = JSON.parse(response.body) as { id?: unknown };

    return typeof id === 'string' && /^att_[0-9a-f]{32}$/.test(id) ? { ok: true, id } : { ok: false, refusal: 'retry' };
  } catch {
    return { ok: false, refusal: 'retry' };
  }
}

/**
 * A reply under a note (FRU-257), through the transport of the host like every call. The name is
 * the one the reporter asked the widget to remember, and only for a reader the worker does not name.
 */
async function sendReply(
  options: FruitbackOptions,
  view: Window & typeof globalThis,
  issue: SeedIssue,
  body: string,
  name: string | undefined,
): Promise<SeedComment | ReplyFailure> {
  const token = await options.identityToken?.();
  const response = await transportFor(options)({
    url: `${options.endpoint}/feedback/${encodeURIComponent(issue.id)}/replies?client=${encodeURIComponent(options.clientId)}`,
    method: 'POST',
    headers: writeHeaders(token),
    body: JSON.stringify({
      url: canonicalizePageUrl(view.location.href),
      body,
      ...(name === undefined ? {} : { name }),
    }),
  });
  if (response.status === 429) return 'wait';
  if (response.status === 401) return 'signed-out';
  if (!response.ok) return 'retry';
  const comment = (JSON.parse(response.body) as { comment?: SeedComment }).comment;

  return comment === undefined ? 'retry' : comment;
}

/**
 * A verdict on a note (FRU-294), through the transport of the host. `refused`: the worker said no for
 * this reader or this note (`403`, `404`, a `409` of a note not done or checked already); nothing
 * moved, and trying again does not change it. `409 check-in-progress` is `retry`.
 */
async function sendCheck(
  options: FruitbackOptions,
  view: Window & typeof globalThis,
  issue: SeedIssue,
  verdict: 'fixed' | 'wrong',
): Promise<'sent' | ReplyFailure | 'refused'> {
  const token = await options.identityToken?.();
  const response = await transportFor(options)({
    url: `${options.endpoint}/feedback/${encodeURIComponent(issue.id)}/check?client=${encodeURIComponent(options.clientId)}`,
    method: 'POST',
    headers: writeHeaders(token),
    body: JSON.stringify({ url: canonicalizePageUrl(view.location.href), verdict }),
  });
  if (response.status === 429) return 'wait';
  if (response.status === 401) return 'signed-out';
  // Another verdict on this note is being written (FRU-294): it is the moment, not a refusal, and a
  // second try once it is written is answered (raised in review).
  if (response.status === 409 && errorOf(response.body) === 'check-in-progress') return 'retry';
  if (response.status === 403 || response.status === 404 || response.status === 409) return 'refused';

  return response.ok ? 'sent' : 'retry';
}

/** The name a host suggests, trimmed, or nothing for an empty one. */
function suggestedName(name: string | undefined): string | undefined {
  const trimmed = name?.trim();

  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/** Never the token in the body: the seed is stored verbatim in a Linear description (FRU-9). */
function writeHeaders(token: string | undefined): Record<string, string> {
  return { 'Content-Type': 'application/json', ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}) };
}

/** A draft drawn on its page: no issue yet, so no identifier, no state and no link. */
const DRAFT_PREFIX = 'draft:';

function draftIssue(draft: Draft): SeedIssue {
  return {
    id: `${DRAFT_PREFIX}${draft.seed.id}`,
    identifier: draft.seed.id,
    title: '',
    stage: 'new',
    stateName: '',
    updatedAt: draft.seed.createdAt,
    seed: draft.seed,
  };
}

function isDraft(issue: SeedIssue): boolean {
  return issue.id.startsWith(DRAFT_PREFIX);
}

/**
 * Exported for its tests, never from `public.ts`. Sends the drafts, as few requests as the worker
 * allows (FRU-124), and says which ones it kept.
 *
 * - **Only the notes answered « kept » leave the drafts.** After a `207` the others are sent again,
 *   never the whole batch: the worker protects a note against a second copy for ten minutes, and
 *   for one only when its `Kv` refuses the trace.
 * - A request that fails stops the others: a `429` or a `401` would refuse them the same way, and the
 *   reviewer reads one sentence. Nothing is lost, the drafts stay.
 * - The token is asked for at each request, like a single note.
 */
export async function sendDrafts({
  drafts,
  offer,
  options,
}: {
  drafts: readonly Draft[];
  offer: BatchOffer | undefined;
  options: FruitbackOptions;
}): Promise<{ kept: string[]; failure?: SendFailure }> {
  const kept: string[] = [];
  let partial = false;

  for (const request of cutIntoRequests(drafts, offer)) {
    const first = request[0];
    if (first === undefined) continue;
    let response: { ok: boolean; status: number; body: string };
    try {
      const token = await options.identityToken?.();
      response = await transportFor(options)({
        url: feedbackUrl(options, first.destination),
        method: 'POST',
        headers: writeHeaders(token),
        body: offer === undefined ? JSON.stringify(first.seed) : batchBody(request),
      });
    } catch {
      return { kept, failure: 'retry' };
    }

    if (offer === undefined) {
      if (!response.ok) return { kept, failure: failureOf(response) };
      kept.push(first.seed.id);
      continue;
    }

    const ids = request.map((draft) => draft.seed.id);
    if (response.ok && response.status !== 207) {
      // Every note was kept: that is what a success that is not a `207` says. Not read from the
      // body: an answer the widget cannot read would leave notes the worker holds in the drafts, and
      // the next click would plant them a second time.
      kept.push(...ids);
      continue;
    }

    const answered = keptIn(response.body);
    kept.push(...ids.filter((id) => answered.has(id)));
    if (response.status === 207) partial = true;
    else return { kept, failure: failureOf(response) };
  }

  return partial ? { kept, failure: 'retry' } : { kept };
}

/** The ids the worker answered with an issue, in a `201`, a `207` or a `502` of a batch. */
function keptIn(body: string): Set<string> {
  try {
    const { results } = JSON.parse(body) as { results?: unknown };
    if (!Array.isArray(results)) return new Set();

    return new Set(
      results.flatMap((result: unknown) => {
        const { id, issue } = (typeof result === 'object' && result !== null ? result : {}) as {
          id?: unknown;
          issue?: unknown;
        };

        return typeof id === 'string' && issue !== undefined ? [id] : [];
      }),
    );
  } catch {
    return new Set();
  }
}

/**
 * The place of the element, read at the click (FRU-152).
 *
 * The page stays live while the popover is open. A link of a single-page app or the back button
 * changes the address, and can remove the element. A note sent then must go to the page where it
 * was written, with the element of that page.
 *
 * A place that cannot be read here is read again at the send, where a failure keeps the note: the
 * click must not fail because of it.
 */
function placeOf(target: CaptureTarget): CapturedPlace | undefined {
  try {
    return capturePlace(target.element, target.source === undefined ? {} : { source: target.source });
  } catch {
    return undefined;
  }
}

/**
 * What a refused write means for the reporter (FRU-156): try again, wait, sign in again, or tell the
 * team.
 *
 * A place the worker refuses (`destination-not-allowed`) is a `403` that a second try can pass: the
 * read that follows brings the list of now, and the composer says which place is gone (FRU-123).
 */
export function failureOf(response: { status: number; body: string }): SendFailure {
  if (response.status === 429) return 'wait';
  if (response.status === 413) return 'too-large';
  // FRU-332: a file of the note is no longer on its way, or the place takes no file.
  if (response.status === 410) return 'attachment-gone';
  if (response.status === 409 && errorOf(response.body) === 'attachments-not-taken') return 'no-tracker';
  // Not « try again »: a host that mints a bad token mints it again at the next send (FRU-193).
  if (response.status === 401) return membersOnly(response.body) ? 'members-only' : 'signed-out';
  if (response.status === 403) {
    return errorOf(response.body) === 'destination-not-allowed' ? 'retry' : 'refused';
  }

  return 'retry';
}

/**
 * Whether a `401` says that the site takes its members only, and that no session of a member came
 * (FRU-394): the worker's `identity-required`. A token that the worker refused (`invalid-identity`),
 * a session that ended, and a body it did not write are `signed-out`, as before.
 */
function membersOnly(body: string): boolean {
  return errorOf(body) === 'identity-required';
}

function errorOf(body: string): unknown {
  try {
    return (JSON.parse(body) as { error?: unknown }).error;
  } catch {
    return undefined;
  }
}

/**
 * Whether the element is still on the page where it was chosen (FRU-152).
 *
 * The picture is taken at the send. After a navigation it would show the page of now, or nothing of
 * the element, beside a place and an anchor of the page before. A note with no picture is better
 * than a picture of another page.
 */
function stillThere(element: Element, place: CapturedPlace | undefined): boolean {
  if (!element.isConnected) return false;
  if (place === undefined) return true;
  const view = element.ownerDocument.defaultView;

  return view !== null && canonicalizePageUrl(view.location.href) === place.page.url;
}

/**
 * The picture, or nothing, and never an error.
 *
 * Every way this fails is ordinary: a canvas tainted by a cross-origin image, a font that will not
 * load, storage refusing the upload, a browser that ran out of memory on a long page. None of them
 * is a reason to lose what someone just wrote — the note is the feedback and the image is a
 * convenience — so this returns `undefined` and the seed goes without one.
 */
async function screenshotFor(
  element: Element,
  config: WidgetConfig,
  options: FruitbackOptions,
): Promise<SeedScreenshot | 'missed' | undefined> {
  if (!config.screenshot || options.captureScreenshot === undefined) return undefined;

  try {
    const captured = await options.captureScreenshot(element);

    // Checked, not just typed: this package ships to JavaScript too, and a screenshot with no URL is
    // a row in a Linear issue that opens nothing. Asked for and not there: the composer says so.
    return captured?.url ? captured : 'missed';
  } catch {
    return 'missed';
  }
}

/** Spread, so an absent screenshot stays absent rather than becoming an empty object. */
function optionalScreenshot(screenshot: SeedScreenshot | undefined): { screenshot?: SeedScreenshot } {
  return screenshot === undefined ? {} : { screenshot };
}

/**
 * Tell the widget that the reporter came back to the tab.
 *
 * Nothing pushes a change of state to an open page, and a webhook would need a secret for each store
 * and a connection for each visitor. A page that somebody looks at again is the moment a stale pin
 * is seen, so that is when to read.
 */
function watchReturn(document: Document, onReturn: () => void): () => void {
  const check = (): void => {
    if (document.visibilityState === 'visible') onReturn();
  };
  document.addEventListener('visibilitychange', check);

  return () => document.removeEventListener('visibilitychange', check);
}

/**
 * Notice that the page changed, on a site with no framework to ask.
 *
 * `popstate` covers back and forward and nothing else: a single-page app navigating with
 * `pushState` fires no event at all, and a pin belongs to a URL. So the two history methods are
 * wrapped — restored on `destroy`, because a widget that permanently rewrites the host's `history`
 * is one they turn off.
 *
 * The alternative was polling `location.href`, which trades a patched method for a timer that never
 * stops. This costs nothing while the page is idle.
 */
function watchUrl(view: Window & typeof globalThis, onChange: () => void): () => void {
  const history = view.history;
  const original = { pushState: history.pushState, replaceState: history.replaceState };
  let last = view.location.href;

  const check = (): void => {
    if (view.location.href === last) return;

    last = view.location.href;
    onChange();
  };

  history.pushState = function patched(...args: Parameters<History['pushState']>) {
    original.pushState.apply(this, args);
    check();
  };
  history.replaceState = function patched(...args: Parameters<History['replaceState']>) {
    original.replaceState.apply(this, args);
    check();
  };
  view.addEventListener('popstate', check);

  return () => {
    history.pushState = original.pushState;
    history.replaceState = original.replaceState;
    view.removeEventListener('popstate', check);
  };
}
