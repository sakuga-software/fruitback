import {
  MAX_ATTACHMENTS_PER_NOTE,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_BYTES_PER_NOTE,
  type NoteReporter,
  attachmentKindOf,
} from '@fruitback/shared';
import type { Destination } from './destinations.ts';
import { isElement } from './dom.ts';
import { deepActiveElement, holdFocus } from './focus.ts';
import { createIcon } from './icons.ts';
import { type MessageKey, type Translator, createTranslator, languageOf } from './messages.ts';
import { framesOf, settle } from './settle.ts';
import {
  type AttachOffer,
  type AttachRefusal,
  type PickedFile,
  readPicked,
  readableSize,
  refusalBefore,
} from './attachments.ts';
import { adoptStyles } from './stylesheet.ts';
import { MENU_GAP, STYLES, WIDTH } from './composer.styles.ts';

/**
 * The note popover: what the reporter actually writes in.
 *
 * It owns the **states**, not the transport. `onSubmit` is handed the note and awaited, so a widget
 * embedded in someone's site can post through whatever the host set up while this file stays
 * ignorant of the worker's URL, of auth, and of retries. What it does own is the part that is easy
 * to get wrong and impossible to test from the outside: the button that must not fire twice, the
 * error that must not eat the text someone just typed, and the confirmation before it closes.
 *
 * The fruit stays in the shape: the pin is a teardrop. The words stay plain, so the button says
 * *Send* and the confirmation says *sent* (FRU-86).
 */

/**
 * How long the card of a sent note stays (FRU-305): long enough to read « Sent as DEV-3 » and to
 * reach « Open → ». A click anywhere else closes it at once. A note kept for later says so in the
 * foot, for the time of the confirmation of before.
 */
const SENT_MS = 4_000;
const KEPT_MS = 1_100;

export type ComposerState = 'idle' | 'sending' | 'sent' | 'kept' | 'failed' | 'receipt';

/** A note of a batch that went (FRU-608): its identifier in the store and its address, when the reader may open it. */
export type BatchSentNote = { id: string; text: string; identifier?: string | undefined; url?: string | undefined };

/**
 * What a send of the batch did (FRU-608). `unsent` are the notes still in the batch: they keep their
 * text there. `inField`: the note of the composer did not leave the field, because its own send
 * failed (a note with files is sent alone, before the batch); the composer then says why, as for a
 * single note.
 */
export type BatchSent = {
  sent: readonly BatchSentNote[];
  unsent: readonly { id: string; text: string }[];
  failure?: SendFailure;
  inField?: boolean;
};

/**
 * The batch of the notes waiting to be sent together (FRU-608, which replaced « Keep for later » of
 * FRU-124). The host keeps the notes; the composer adds one, sends them all, and says what went.
 */
export type BatchSeam = {
  /** Whether a note can wait in a batch here: the worker takes several notes in one request. */
  offered(): boolean;
  /** How many notes wait now. */
  waiting(): number;
  subscribe(listener: () => void): () => void;
  /** Adds the note to the batch rather than sending it. */
  add: (
    note: string,
    reporter?: NoteReporter,
    destination?: string,
  ) => Promise<true | SendFailure | SentWithoutPicture>;
  /**
   * Sends the note with the batch, in as few requests as the worker allows. `progress` is told how
   * many notes went, of how many, after each request.
   */
  sendAll: (
    note: string,
    reporter: NoteReporter | undefined,
    destination: string | undefined,
    attachments: readonly string[],
    progress: (done: number, total: number) => void,
  ) => Promise<BatchSent>;
  /** Sends again the notes left in the batch. */
  resend: (progress: (done: number, total: number) => void) => Promise<BatchSent>;
  /** Opens the list of every note, where a big batch is read whole. Left out: no such button. */
  onShowAll?: () => void;
};

/** Sent, without the picture the reporter asked for (FRU-238). */
export type SentWithoutPicture = { picture: 'missed' };

/**
 * Sent, and what the worker gave back for it (FRU-305): the identifier in the store, its address when
 * the reader may open it, and the number of its new pin. The card of a sent note shows them.
 */
export type SentAs = {
  sentAs: { identifier?: string | undefined; url?: string | undefined; number?: number | undefined };
  picture?: 'missed';
  /** The question « Want to know when it's fixed? », under the card (FRU-604). Absent: not asked. */
  notify?: NotifyOffer;
};

/**
 * What became of an address given for a note done (FRU-604). `sent`: the worker keeps it for this
 * note. `invalid`: not an address it takes. `retry`: no answer. `wait`: too many at once. `gone`:
 * this note takes no address any more (its time ran out, or it has one).
 */
export type NotifyOutcome = 'sent' | 'invalid' | 'retry' | 'wait' | 'gone';

/** The host sends the address, and keeps the answer of the question. */
export type NotifyOffer = {
  send(email: string): Promise<NotifyOutcome>;
  /** « No thanks ». */
  decline(): void;
};

/**
 * Why a send failed, so the composer says what to do next (FRU-156). The text is kept in every case.
 *
 * - `retry`: no answer, or the worker failed. A second try can work.
 * - `wait`: too many notes at once (`429`). A try in a minute can work.
 * - `refused`: the worker does not accept this note from here (`403`). Trying again will not work;
 *   the team of the site can change it.
 * - `signed-out`: the worker wants an identity it did not get (`401`): a session that ended, a token
 *   out of date (FRU-193). The team of the site can do nothing; the reporter signs in again.
 * - `members-only`: the site takes notes from its members only, and this page sent none of their
 *   sessions (`401`, FRU-394). There was no session to end: the reporter signs in from the extension.
 * - `too-large`: the note is too heavy (`413`). It goes once it is shorter, or without its picture.
 * - `attachment-gone`: a file of the note is no longer on its way (`410`, FRU-332). It goes once the
 *   file is removed, or sent again.
 * - `no-tracker`: the place of the note takes no file (`409`). It goes without its files, or to
 *   another place.
 */
export type SendFailure =
  | 'retry'
  | 'wait'
  | 'refused'
  | 'signed-out'
  | 'members-only'
  | 'too-large'
  | 'attachment-gone'
  | 'no-tracker';

export type ComposerOptions = {
  document?: Document;
  /** Inside the widget's Shadow root — `host.panel`. */
  host: Element;
  /**
   * Send the note. Resolving means it was planted; throwing, resolving `false` or resolving a
   * `SendFailure` keeps the popover open with the text intact, because a note lost to a network blip
   * is the one failure this widget cannot afford. A `SendFailure` chooses the words; the others say
   * to try again.
   *
   * `reporter` is what the visitor optionally typed about themselves (FRU-9). It is a **claim**:
   * the worker stores it as self-declared unless the embedder also sends a signed identity token,
   * and it strips any `verified` flag that arrives from a browser.
   *
   * `destination` is the id of the place the line shows (FRU-123). It is absent when the composer
   * shows no line, which is every composer but the one of a member of a site with several places.
   */
  /**
   * `{ picture: 'missed' }`: sent, and the picture asked for did not come (FRU-238). The composer
   * says it, so a note never loses its picture in silence.
   */
  onSubmit: (
    note: string,
    reporter?: NoteReporter,
    destination?: string,
    /** The ids in transit of the files of the note (FRU-332), in their order. Empty: none. */
    attachments?: readonly string[],
  ) => Promise<boolean | void | SendFailure | SentWithoutPicture | SentAs>;
  onClose?: () => void;
  /**
   * « Choose another element » in the head (FRU-305): the host starts a capture over the open composer, which
   * keeps its text and moves to the element chosen. Left out: no such button.
   */
  onPickAgain?: () => void;
  /**
   * Where the name of the reporter is kept between notes, when the reporter asks for it (FRU-91).
   * If left out, the composer offers no box to remember the name.
   */
  memory?: NameMemory;
  /**
   * A name the host suggests for a reporter who kept none (FRU-302). It fills the name field, and the
   * box « remember me » stays as the reporter left it: the site keeps nothing it was not asked to.
   */
  suggestName?: () => string | undefined;
  /**
   * The worker names the reporter from a signed identity, so the composer asks for no name.
   * A typed name would be replaced by the identity, and the reporter would not know.
   *
   * A function is asked at each open, and by `identityChanged` (FRU-112): in team mode the widget
   * learns it from a read, after the composer is built. An open composer keeps the answer it opened
   * with.
   */
  identified?: boolean | (() => boolean);
  /**
   * The places this note can go, and where the last choice is kept (FRU-123). If left out, or while
   * it offers fewer than two places, the composer is the one of FRU-89: it holds no line about where
   * the note goes.
   */
  destinations?: DestinationChoice;
  /**
   * The batch (FRU-608): « Add to batch » beside « Send », and « Send all N » once notes wait, with a
   * menu for « Send only this note ». Shown at each open while `offered()` says so. Left out: no batch.
   */
  batch?: BatchSeam;
  /**
   * The box « Attach a picture of this element » (FRU-258). It is the preference the settings panel
   * holds, shown beside the note it applies to: the composer reads it and writes it, and keeps
   * nothing. Left out, or while `offered()` says no, there is no box: a host that cannot take a
   * picture offers none. **The composer never ticks it**: what it shows is what the reporter chose.
   */
  picture?: PictureChoice;
  /**
   * The files of the note (FRU-332): a capture of the page or of an area, an image, any file. Left
   * out, or while `offer` says `none`, the composer shows nothing of them. `no-tracker`: a sentence
   * says that the note takes no file, and no way to join one is offered.
   */
  attachments?: AttachSeam;
  /** The widget's words (FRU-37). Left out: English, with dates in this document's language. */
  translator?: Translator;
  /**
   * Open the sign-in of the host (FRU-315). Given, a send refused for a session that ended
   * (`signed-out`) offers « Sign in again » beside its sentence. The text stays in the field.
   */
  onSignIn?: () => void;
  /**
   * Whether this reader must sign in before a note can go (FRU-609): a site that takes notes from its
   * team only, and a session that ended. Asked at each open and by `signInChanged`. Then « Send »
   * says « Sign in to send » and waits, under a sentence that says why; the note, its files and the
   * batch stay. Left out: never.
   */
  signInToSend?: () => boolean;
  /**
   * Where the text being written is saved as it is typed (FRU-311). The host knows the element and
   * the page; the composer knows the text. Left out: nothing is saved, as before.
   */
  autosave?: Autosave;
};

/**
 * The text of the element the composer is open on, saved at each change of the field (FRU-311).
 *
 * `read` is asked at each open on a new element: a text found there comes back, and the composer
 * says « Draft restored ». `write` is called with each change of the field. Esc, « Cancel » and the
 * cross write nothing: the text stays saved. The host forgets it once the note is planted or kept
 * for later, for the element it was sent about: the composer may be open on another one by then.
 */
export type Autosave = {
  read(): string | undefined;
  write(text: string): void;
};

/**
 * How a composer joins files to a note (FRU-332). The composer holds the list and its words; the host
 * takes a capture, and sends each file to the worker as soon as it is joined, so a refusal is said
 * while the note is still being written.
 */
export type AttachSeam = {
  /** What the worker said of files, for the place the note goes to now. */
  offer(destination: string | undefined): AttachOffer;
  /** The offer changed: a read answered. */
  subscribe(listener: () => void): () => void;
  /** Whether the host can capture the page: the extension can, a page alone cannot. */
  captures(): boolean;
  /** A capture of the visible page, or of an area the person chooses. `cancelled`: Esc, or « Cancel ». */
  capture(kind: 'page' | 'area'): Promise<PickedFile | 'cancelled' | 'permission' | undefined>;
  /**
   * Sends one file on its way. Its id is what the note names. `progress` is told the part sent, from
   * 0 to 1, by a host that can measure it; one that cannot says nothing, and the line says « Sending… ».
   */
  upload(
    file: PickedFile,
    destination: string | undefined,
    progress?: (fraction: number) => void,
  ): Promise<{ ok: true; id: string } | { ok: false; refusal: AttachRefusal }>;
  /**
   * A capture of the element the note is about, taken when the composer opens (FRU-609), with where
   * the element is in it, in fractions of the picture. Left out, or `undefined`: none is joined.
   */
  captureElement?(): Promise<ElementCapture | undefined>;
};

/** The capture of an element (FRU-609): a picture, and the frame of the element in it, from 0 to 1. */
export type ElementCapture = PickedFile & { frame: { left: number; top: number; width: number; height: number } };

/** A file of the note in the composer, from the moment it is joined. */
type Held = {
  key: number;
  name: string;
  size: number;
  /**
   * `local`: taken here and not sent yet (FRU-609). The capture of the element waits in the composer
   * and leaves only with the note: a person who removes it, or who never sends, sent nothing.
   */
  state: 'local' | 'sending' | 'ready' | 'refused';
  id?: string;
  refusal?: AttachRefusal;
  /** The limit it passed, for « Too large: 48 MB, the limit is 10 MB » (FRU-609). */
  limit?: number;
  /** The bytes of a `local` file, until it is sent. */
  file?: PickedFile;
  /** A picture to show in the field, and the frame of the element in it (FRU-609). */
  preview?: { src: string; frame: ElementCapture['frame'] };
  /** The part sent, from 0 to 1, when the host measures it. */
  progress?: number;
  /** Settles when the worker answered for it. */
  sent?: Promise<void>;
};

export type PictureChoice = {
  offered(): boolean;
  get(): boolean;
  set(attach: boolean): void;
  /** The preference changed somewhere else, in the settings panel for one. */
  subscribe?(listener: () => void): () => void;
};

export type NameMemory = {
  get(): string | undefined;
  /** `undefined` forgets the name. */
  set(name: string | undefined): void;
};

/**
 * A seam like `NameMemory`: the composer does not know who offers the places or where the choice is
 * kept. `offered` is asked again at each change, because a read can change the list under an open
 * popover.
 */
export type DestinationChoice = {
  /** In the order of the worker: the first place is where a note goes when nobody chooses. */
  offered(): readonly Destination[];
  subscribe(listener: () => void): () => void;
  /** The id of the place chosen last, if any. It is followed only while it is offered. */
  remembered(): string | undefined;
  remember(id: string): void;
};

/** The edges of an element, in document coordinates. */
export type ElementBox = { left: number; top: number; bottom: number; right: number };

export type Composer = {
  /**
   * `about` is what the note points at, written in the head in mono (FRU-305):
   * « button.add · <AddToCart> ». `name` is what a person reads for the element (FRU-258): the head
   * gives it as its title, for the eye that does not read selectors. Either can be left out.
   *
   * `anchor` is the element, or its edges in document coordinates. Given the element, the composer
   * follows it when it moves against the document: a fixed sidebar at a scroll, a row in a box that
   * scrolls (FRU-457).
   *
   * `head.selector` says that `about` is a selector, written in mono. Left out, it is the words of
   * the element (FRU-607), in the font of the text.
   */
  open(anchor: Element | ElementBox, about?: string, name?: string, head?: { selector?: boolean }): void;
  close(): void;
  state(): ComposerState;
  /**
   * The answer of `identified` may be another one now. A closed composer takes it at once. An open
   * one takes it at its next open: a field must not leave under somebody who types in it.
   */
  identityChanged(): void;
  /**
   * The answer of `signInToSend` may be another one now (FRU-609). Taken at once, open or not: it
   * removes nothing, so the person who signed in finds their note as they left it, ready to go.
   */
  signInChanged(): void;
  /**
   * Starts « Capture an area », as its item of the menu does (FRU-423): the context menu of the
   * extension. `false`, and nothing happens, when the composer is closed or sent, when the note takes
   * no file, when the host captures nothing, or when the note holds as many files as it can.
   */
  captureArea(): boolean;
  /** The popover's own root, for tests and for whoever needs to measure it. */
  element: HTMLElement;
  destroy(): void;
};

export function createComposer(options: ComposerOptions): Composer {
  const document = options.document ?? globalThis.document;
  const view = document.defaultView;
  const t = options.translator ?? createTranslator({ language: languageOf(document) });

  const root = document.createElement('div');
  root.className = 'fruitback-composer';
  root.dataset.fruitbackComposer = '';
  root.hidden = true;
  // Built element by element, never parsed from a string (FRU-389): see `TEMPLATE`.
  root.append(...TEMPLATE.map((markup) => build(document, markup)));
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', t.text('composer.dialog'));

  /** A part of the markup built above, by its selector. A missing one is a bug of `TEMPLATE`, and says so. */
  function part<T extends HTMLElement = HTMLElement>(selector: string): T {
    const found = root.querySelector<T>(selector);
    if (found === null) throw new Error(`fruitback: the composer has no ${selector}`);

    return found;
  }

  const style = adoptStyles(options.host, STYLES);
  options.host.append(root);
  const focus = holdFocus(root, close);

  const field = part<HTMLTextAreaElement>('[data-fruitback-note]');
  const send = part<HTMLButtonElement>('[data-fruitback-send]');
  // The drop of the mark and the word, as the mock-up of 2026-10-20 draws it (FRU-305). The drop is
  // appended after the template is built: an SVG made by `createElement` is in the HTML namespace and
  // renders nothing (FRU-36).
  const sendWord = document.createElement('span');
  sendWord.textContent = t.text('composer.send');
  send.append(createIcon(document, 'mark'), sendWord);
  const about = part('[data-fruitback-about]');
  const pick = part<HTMLButtonElement>('[data-fruitback-pick]');
  const noteLabel = part('[data-fruitback-note-label]');
  const nameLabel = part('[data-fruitback-name-label]');
  const lands = part('[data-fruitback-lands]');
  const failedCard = part('[data-fruitback-failed]');
  const failedTitle = part('[data-fruitback-failed-title]');
  const failedText = part('[data-fruitback-failed-text]');
  const sentCard = part('[data-fruitback-sent]');
  const sentDrop = part('[data-fruitback-sent-drop]');
  const sentTitle = part('[data-fruitback-sent-title]');
  const sentText = part('[data-fruitback-sent-text]');
  const sentOpen = part<HTMLAnchorElement>('[data-fruitback-sent-open]');
  const notifyForm = part<HTMLFormElement>('[data-fruitback-notify]');
  const notifyTitle = part('[data-fruitback-notify-title]');
  const notifyLabel = part('[data-fruitback-notify-label]');
  const notifyEmail = part<HTMLInputElement>('[data-fruitback-notify-email]');
  const notifyWhy = part('[data-fruitback-notify-why]');
  const notifyError = part('[data-fruitback-notify-error]');
  const notifyNo = part<HTMLButtonElement>('[data-fruitback-notify-no]');
  const notifyYes = part<HTMLButtonElement>('[data-fruitback-notify-yes]');
  const notifyDone = part('[data-fruitback-notify-done]');
  const pictureLabel = part<HTMLLabelElement>('[data-fruitback-picture-label]');
  const picture = part<HTMLInputElement>('[data-fruitback-picture]');
  const cancel = part<HTMLButtonElement>('[data-fruitback-cancel]');
  const keep = part<HTMLButtonElement>('[data-fruitback-keep]');
  const keepCount = document.createElement('span');
  keepCount.className = 'fruitback-composer-badge';
  keepCount.setAttribute('aria-hidden', 'true');
  const keepWords = hiddenWords(document, '');
  keep.append(createIcon(document, 'stackPlus'), keepCount, keepWords);
  const sendMore = part<HTMLButtonElement>('[data-fruitback-send-more]');
  sendMore.append(createIcon(document, 'chevron'), hiddenWords(document, t.text('composer.sendMenu')));
  sendMore.title = t.text('composer.sendMenu');
  const sendMenu = part('[data-fruitback-send-menu]');
  const sendAllItem = part<HTMLButtonElement>('[data-fruitback-send-all]');
  const sendOnlyItem = part<HTMLButtonElement>('[data-fruitback-send-only]');
  sendOnlyItem.textContent = t.text('composer.sendOnly');
  const receipt = part('[data-fruitback-receipt]');
  const receiptTitle = part('[data-fruitback-receipt-title]');
  const receiptTo = part('[data-fruitback-receipt-to]');
  const receiptRegion = part('[data-fruitback-receipt-region]');
  receiptRegion.setAttribute('aria-label', t.text('composer.receiptList'));
  const receiptList = part('[data-fruitback-receipt-list]');
  const receiptAll = part<HTMLButtonElement>('[data-fruitback-receipt-all]');
  receiptAll.textContent = t.text('composer.receiptShowAll');
  const receiptRetry = part<HTMLButtonElement>('[data-fruitback-receipt-retry]');
  receiptRetry.textContent = t.text('composer.receiptRetry');
  const receiptClose = part<HTMLButtonElement>('[data-fruitback-receipt-close]');
  receiptClose.textContent = t.text('composer.receiptClose');
  const receiptStatus = part('[data-fruitback-receipt-status]');
  const lightbox = part('[data-fruitback-lightbox]');
  lightbox.setAttribute('aria-label', t.text('composer.attachShot'));
  const lightboxClose = document.createElement('button');
  lightboxClose.type = 'button';
  lightboxClose.className = 'fruitback-composer-send fruitback-composer-lightbox-close';
  lightboxClose.textContent = t.text('composer.receiptClose');
  lightboxClose.addEventListener('click', () => closeLightbox());
  lightbox.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closeLightbox();
  });
  let lightboxReturn: HTMLElement | undefined;
  const signNeeded = part('[data-fruitback-sign-needed]');
  /** Whether this reader must sign in before a note goes (FRU-609), as `signInToSend` said last. */
  let mustSignIn = false;
  const signIn = part<HTMLButtonElement>('[data-fruitback-sign-in]');
  const status = part('[data-fruitback-status]');
  const who = part('[data-fruitback-who]');
  const name = part<HTMLInputElement>('[data-fruitback-name]');
  const rememberLabel = part<HTMLLabelElement>('[data-fruitback-remember-label]');
  const remember = part<HTMLInputElement>('[data-fruitback-remember]');
  const destination = part<HTMLButtonElement>('[data-fruitback-destination]');
  const placeList = part('[data-fruitback-destinations]');
  const gone = part('[data-fruitback-destination-gone]');
  const attach = part('[data-fruitback-attach]');
  const attachLabel = part('[data-fruitback-attach-label]');
  const attachWays = part('[data-fruitback-attach-ways]');
  const attachTrigger = part<HTMLButtonElement>('[data-fruitback-attach-trigger]');
  const attachMenu = part('[data-fruitback-attach-menu]');
  const attachPage = part<HTMLButtonElement>('[data-fruitback-attach-page]');
  const attachArea = part<HTMLButtonElement>('[data-fruitback-attach-area]');
  const attachFile = part<HTMLButtonElement>('[data-fruitback-attach-file]');
  const box = part('[data-fruitback-box]');
  const tools = part('[data-fruitback-tools]');
  const avatar = part<HTMLButtonElement>('[data-fruitback-avatar]');
  const fileInput = part<HTMLInputElement>('[data-fruitback-attach-file-input]');
  const attachNone = part('[data-fruitback-attach-none]');
  const attachList = part('[data-fruitback-attach-list]');
  const seam = options.attachments;
  /** The files of the note being written, in the order they were joined. */
  let held: Held[] = [];
  let heldKeys = 0;
  const memory = options.memory;
  const isIdentified = (): boolean =>
    typeof options.identified === 'function' ? options.identified() : options.identified === true;
  let asksForName = true;
  let whoOpen = false;
  const choice = options.destinations;

  // Set after the build and never part of TEMPLATE: a host translation is text, not markup.
  field.placeholder = t.text('composer.placeholder');
  // Named by the label the mock-up writes above it, « Your comment » (FRU-305).
  noteLabel.textContent = t.text('composer.label');
  pick.textContent = t.text('composer.pickAgain');
  pick.hidden = options.onPickAgain === undefined;
  part('[data-fruitback-picture-label] span').textContent = t.text('composer.picture');
  name.placeholder = t.text('composer.namePlaceholder');
  nameLabel.textContent = t.text('composer.nameLabel');
  failedTitle.textContent = t.text('composer.failedTitle');
  sentText.textContent = t.text('composer.sentFollows');
  sentOpen.textContent = t.text('composer.sentOpen');
  notifyTitle.textContent = t.text('composer.notifyTitle');
  notifyLabel.textContent = t.text('composer.notifyEmail');
  notifyWhy.textContent = t.text('composer.notifyWhy');
  notifyNo.textContent = t.text('composer.notifyNo');
  notifyYes.textContent = t.text('composer.notifyYes');
  part('[data-fruitback-remember-label] span').textContent = t.text('composer.remember');
  rememberLabel.hidden = memory === undefined;
  askForNameOrNot();
  cancel.textContent = t.text('composer.cancel');
  signIn.textContent = t.text('composer.signIn');
  // A button never wraps (FRU-611, P7): words longer than its room end in « … », and the tooltip
  // gives them whole.
  for (const button of [pick, cancel, signIn]) button.title = button.textContent ?? '';
  placeList.setAttribute('aria-label', t.text('composer.destinations'));
  attachLabel.textContent = t.text('composer.attach');
  // Two icons at the foot of the field (FRU-607): the capture, then the file. Each says its name in
  // a tooltip, and to a screen reader in its own words.
  attachTrigger.append(createIcon(document, 'camera'), hiddenWords(document, t.text('composer.captureMenu')));
  attachTrigger.title = t.text('composer.captureMenu');
  attachPage.textContent = t.text('composer.attachPage');
  attachArea.textContent = t.text('composer.attachArea');
  attachFile.append(createIcon(document, 'paperclip'), hiddenWords(document, t.text('composer.attachFile')));
  // The paste has no button of its own: the tooltip of the file says it (FRU-424).
  attachFile.title = `${t.text('composer.attachFile')} · ${t.text('composer.attachPaste', { keys: pasteKeys(document) })}`;
  part('[data-fruitback-picture-label]').prepend(createIcon(document, 'image'));
  pictureLabel.title = t.text('composer.picture');
  avatar.setAttribute('aria-controls', 'fruitback-composer-who');
  attachNone.textContent = t.text('composer.attachNoTracker');

  /** Whether the batch is offered at this open. A note with files is sent, never added to it. */
  let keepOffered = false;
  const batch = options.batch;

  /**
   * The foot of a batch (FRU-608). None waiting: « Send », and « Add to batch » as an icon. Some
   * waiting: « Send all N », counting this note, the icon with the count, and a menu beside « Send »
   * for « Send only this note », which leaves the batch in place.
   */
  function drawBatch(): void {
    const waiting = keepOffered ? (batch?.waiting() ?? 0) : 0;
    keep.hidden = !keepOffered || held.length > 0;
    keepCount.textContent = waiting > 0 ? String(waiting) : '';
    const named = waiting > 0 ? t.plural('composer.batchAddWaiting', waiting) : t.text('composer.batchAdd');
    keepWords.textContent = named;
    keep.title = named;
    const all = t.text('composer.sendAll', { count: waiting + 1 });
    sendWord.textContent = waiting > 0 ? all : t.text('composer.send');
    if (mustSignIn) sendWord.textContent = t.text('composer.signInToSend');
    send.title = sendWord.textContent;
    sendAllItem.textContent = all;
    sendMore.hidden = waiting === 0 || mustSignIn;
    if (sendMore.hidden) closeSendMenu(false);
  }

  /**
   * « Sign in to send » (FRU-609): « Send » waits, disabled, under « Only the team of this site can
   * send notes here. », with the sign-in of the host beside it. Nothing of the note goes away.
   */
  function drawSignIn(): void {
    mustSignIn = options.signInToSend?.() === true;
    signNeeded.textContent = mustSignIn ? t.text('composer.signInOnlyTeam') : '';
    signNeeded.hidden = !mustSignIn;
    if (state === 'idle' || state === 'failed') {
      send.disabled = mustSignIn;
      signIn.hidden = !(mustSignIn && options.onSignIn !== undefined) && !(state === 'failed' && signInFailure);
    }
    drawBatch();
  }
  /** The last failure asked to sign in again (FRU-315). */
  let signInFailure = false;

  function openSendMenu(): void {
    if (sendMore.disabled) return;
    sendMenu.hidden = false;
    sendMore.setAttribute('aria-expanded', 'true');
    sendAllItem.focus();
  }

  function closeSendMenu(refocus: boolean): void {
    if (sendMenu.hidden) return;
    sendMenu.hidden = true;
    sendMore.setAttribute('aria-expanded', 'false');
    if (refocus) sendMore.focus();
  }

  /** The primary action: « Send all N » while notes wait, « Send » otherwise. */
  function sendPrimary(): void {
    if (keepOffered && (batch?.waiting() ?? 0) > 0) void submitAll();
    else void submit();
  }

  /**
   * The files of the note, and the ways to join one (FRU-332), as the worker offers them now for
   * the place the note goes to. A note with files is not kept for later: a draft waits in the tab,
   * and its files would wait in the worker with no note that sends them.
   */
  function drawAttachments(): void {
    const offer = seam?.offer(selected) ?? 'none';
    attach.hidden = offer === 'none' && held.length === 0;
    attachWays.hidden = offer !== 'offered';
    attachNone.hidden = offer !== 'no-tracker';
    const captures = seam?.captures() === true;
    // The capture is an icon of its own, there only where the host can take one (FRU-607).
    attachTrigger.hidden = !captures;
    const full = held.filter((each) => each.state !== 'refused').length >= MAX_FILES;
    for (const way of [attachTrigger, attachPage, attachArea, attachFile])
      way.setAttribute('aria-disabled', String(full));
    if (full || offer !== 'offered') closeAttachMenu(false);
    drawBatch();
    drawTools();

    const hadFocus = attachList.contains(deepActiveElement(document));
    attachList.hidden = held.length === 0;
    attachList.replaceChildren(
      ...held.map((each) => {
        const item = document.createElement('li');
        item.className = 'fruitback-composer-file';
        item.dataset.fruitbackFile = each.state;
        const words = document.createElement('span');
        words.className = 'fruitback-composer-file-words';
        const named = document.createElement('span');
        named.className = 'fruitback-composer-file-name';
        // The name is the person's file, or the page's: text, never markup.
        named.textContent = each.name;
        const detail = document.createElement('span');
        detail.className = 'fruitback-composer-file-detail';
        detail.textContent = detailOf(each);
        words.append(named, detail);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'fruitback-composer-file-remove';
        remove.dataset.fruitbackFileRemove = String(each.key);
        remove.setAttribute('aria-label', t.text('composer.attachRemove', { name: each.name }));
        remove.append(createIcon(document, 'close'));
        // A refused file says « Remove » in words (FRU-609): it is the one thing to do with it.
        if (each.state === 'refused') {
          remove.classList.add('fruitback-composer-file-remove-words');
          const word = document.createElement('span');
          word.setAttribute('aria-hidden', 'true');
          word.textContent = t.text('composer.attachRemoveShort');
          remove.append(word);
        }
        if (each.preview !== undefined) item.append(thumbOf(each, each.preview));
        if (each.state === 'sending' && each.progress !== undefined) {
          item.style.setProperty('--fruitback-composer-file-progress', `${Math.round(each.progress * 100)}%`);
        }
        item.append(words, remove);

        return item;
      }),
    );
    if (hadFocus) (attachList.querySelector('button') ?? attachTrigger).focus();
  }

  /**
   * What a line of the list says under the name (FRU-609): ready, its size; on its way, the part sent
   * when the host measures it; waiting for the note; or why it did not go, with the sizes for a file
   * too large.
   */
  function detailOf(each: Held): string {
    if (each.state === 'refused') {
      if (each.refusal === 'too-large' && each.limit !== undefined) {
        const limit = readableSize(each.limit, t.locale);
        // Just over the limit, both round to the same words: the size then says its decimals.
        const size = readableSize(each.size, t.locale);

        return t.text('composer.attachTooLargeOf', {
          size: size === limit ? preciseSize(each.size, t.locale) : size,
          limit,
        });
      }

      return t.text(REFUSALS[each.refusal ?? 'retry']);
    }
    const size = readableSize(each.size, t.locale);
    if (each.state === 'local') return `${size} · ${t.text('composer.attachWithNote')}`;
    if (each.state !== 'sending') return size;
    if (each.progress === undefined) return `${size} · ${t.text('composer.attachSending')}`;

    return `${size} · ${t.text('composer.attachPercent', { percent: Math.round(each.progress * 100) })}`;
  }

  /** The picture of a capture, in the field, with its element framed; a click opens it whole. */
  function thumbOf(each: Held, preview: NonNullable<Held['preview']>): HTMLElement {
    const thumb = document.createElement('button');
    thumb.type = 'button';
    thumb.className = 'fruitback-composer-file-thumb';
    thumb.dataset.fruitbackFileThumb = String(each.key);
    thumb.setAttribute('aria-label', t.text('composer.attachOpen', { name: each.name }));
    thumb.append(pictureOf(preview));
    thumb.addEventListener('click', () => openLightbox(preview, thumb));

    return thumb;
  }

  /** The image and the frame of its element over it. An image the page refuses (its CSP) shows nothing. */
  function pictureOf(preview: NonNullable<Held['preview']>): HTMLElement {
    const frame = document.createElement('span');
    frame.className = 'fruitback-composer-shot';
    const image = document.createElement('img');
    image.alt = '';
    image.src = preview.src;
    image.addEventListener('error', () => frame.toggleAttribute('data-fruitback-broken', true));
    const ring = document.createElement('span');
    ring.className = 'fruitback-composer-shot-ring';
    ring.setAttribute('aria-hidden', 'true');
    const { left, top, width, height } = preview.frame;
    ring.style.setProperty('--fruitback-composer-shot-left', `${left * 100}%`);
    ring.style.setProperty('--fruitback-composer-shot-top', `${top * 100}%`);
    ring.style.setProperty('--fruitback-composer-shot-width', `${width * 100}%`);
    ring.style.setProperty('--fruitback-composer-shot-height', `${height * 100}%`);
    frame.append(image, ring);

    return frame;
  }

  /** The capture whole, over the composer. Esc or « Close » gives the focus back to its thumbnail. */
  function openLightbox(preview: NonNullable<Held['preview']>, from: HTMLElement): void {
    lightbox.replaceChildren(pictureOf(preview), lightboxClose);
    lightbox.hidden = false;
    lightboxReturn = from;
    lightboxClose.focus();
  }

  function closeLightbox(): void {
    if (lightbox.hidden) return;
    lightbox.hidden = true;
    lightboxReturn?.focus();
    lightboxReturn = undefined;
  }

  /**
   * Whether a file may still join the note: not while it is sent or after (FRU-351, raised in review).
   * A file dropped, picked or captured then would go to the worker and be named by no note.
   */
  function joinable(): boolean {
    return state !== 'sending' && state !== 'sent' && state !== 'kept' && state !== 'receipt';
  }

  /**
   * Joins a file: refused at once when the widget can tell, sent on its way otherwise. `later`: it
   * waits in the composer and leaves with the note (the capture of the element, FRU-609).
   */
  function join(file: PickedFile, more: { later?: boolean; preview?: Held['preview'] } = {}): void {
    if (!joinable()) return;
    const key = (heldKeys += 1);
    const kept = held.filter((each) => each.state !== 'refused');
    const refusal = refusalBefore(file, kept);
    const shown = more.preview === undefined ? {} : { preview: more.preview };
    if (refusal !== undefined) {
      const limit = refusal === 'too-large' ? limitPassed(file, kept) : undefined;
      held = [
        ...held,
        {
          key,
          name: file.name,
          size: file.size,
          state: 'refused',
          refusal,
          ...(limit === undefined ? {} : { limit }),
          ...shown,
        },
      ];
      drawAttachments();

      return;
    }
    const entry: Held = { key, name: file.name, size: file.size, state: 'local', file, ...shown };
    held = [...held, entry];
    if (more.later !== true) startUpload(entry);
    drawAttachments();
  }

  /** The limit a file too large passed: the one of its kind, or the one of the note (FRU-609). */
  function limitPassed(file: { type: string; size: number }, kept: readonly { size: number }[]): number {
    const ofKind = MAX_ATTACHMENT_BYTES[attachmentKindOf(file.type)];

    return file.size > ofKind ? ofKind : MAX_ATTACHMENT_BYTES_PER_NOTE - kept.reduce((sum, each) => sum + each.size, 0);
  }

  /** Sends a held file on its way, and draws the part sent when the host measures it. */
  function startUpload(entry: Held): void {
    const file = entry.file;
    if (file === undefined || entry.state !== 'local') return;
    const mine = session;
    entry.state = 'sending';
    entry.file = undefined;
    const progress = (fraction: number): void => {
      if (mine !== session || entry.state !== 'sending') return;
      entry.progress = Math.max(0, Math.min(1, fraction));
      drawAttachments();
    };
    entry.sent = (
      seam?.upload(file, selected, progress) ?? Promise.resolve({ ok: false as const, refusal: 'retry' as const })
    )
      .catch(() => ({ ok: false as const, refusal: 'retry' as const }))
      .then((answer) => {
        if (mine !== session) return;
        if (answer.ok) {
          entry.state = 'ready';
          entry.id = answer.id;
        } else {
          entry.state = 'refused';
          entry.refusal = answer.refusal;
        }
        drawAttachments();
      });
  }

  /**
   * The files that wait go first, then the note: « Send » waits for them and says so (FRU-609). A file
   * refused does not stop the note.
   */
  function filesSettled(mine: number): true | Promise<boolean> {
    for (const each of held) if (each.state === 'local') startUpload(each);
    const inFlight = held.filter((each) => each.state === 'sending').map((each) => each.sent);
    // Nothing on its way: the note goes in the same turn, as before FRU-332.
    if (inFlight.length === 0) return true;
    status.textContent = t.plural('composer.attachWaiting', inFlight.length);
    drawAttachments();

    return Promise.all(inFlight).then(() => mine === session);
  }

  /** The ways of the menu that are shown now, in their order. */
  function menuItems(): HTMLButtonElement[] {
    return [attachArea, attachPage];
  }

  /**
   * « Attach » opens a menu of the ways to join a file (FRU-351): the arrows go from one to the next,
   * Home and End to the ends, Enter or Space takes one, Esc closes it and gives the focus back to
   * « Attach », Tab closes it and goes on.
   */
  function openAttachMenu(focus: 'first' | 'last'): void {
    if (attachTrigger.getAttribute('aria-disabled') === 'true' || attachTrigger.disabled) return;
    attachMenu.hidden = false;
    placeAttachMenu();
    attachTrigger.setAttribute('aria-expanded', 'true');
    const items = menuItems();
    (focus === 'first' ? items[0] : items[items.length - 1])?.focus();
  }

  /**
   * Under « Attach », or above it when the menu does not fit below and the window has more room above
   * (FRU-431). The menu is never taller than the room of its side: it scrolls, and stays in the window.
   */
  function placeAttachMenu(): void {
    attachMenu.removeAttribute('data-fruitback-side');
    attachMenu.style.removeProperty('--fruitback-composer-attach-room');
    const button = attachTrigger.getBoundingClientRect();
    const tall = attachMenu.getBoundingClientRect().height;
    const below = (view?.innerHeight ?? 0) - button.bottom - MENU_GAP - GAP;
    const above = button.top - MENU_GAP - GAP;
    const up = tall > below && above > below;
    attachMenu.dataset.fruitbackSide = up ? 'above' : 'below';
    attachMenu.style.setProperty('--fruitback-composer-attach-room', `${Math.max(0, up ? above : below)}px`);
  }

  function closeAttachMenu(refocus: boolean): void {
    if (attachMenu.hidden) return;
    attachMenu.hidden = true;
    attachTrigger.setAttribute('aria-expanded', 'false');
    if (refocus) attachTrigger.focus();
  }

  async function capture(kind: 'page' | 'area', from: HTMLButtonElement): Promise<void> {
    if (seam === undefined || from.getAttribute('aria-disabled') === 'true') return;
    closeAttachMenu(false);
    const mine = session;
    const taken = await seam.capture(kind).catch(() => undefined);
    if (mine !== session) return;
    from.focus();
    if (taken === 'cancelled') return;
    if (taken === undefined || taken === 'permission') {
      // FRU-423: a capture the browser refused for want of a gesture says what grants it.
      const refusal = taken === 'permission' ? 'capture-permission' : 'capture';
      held = [...held, { key: (heldKeys += 1), name: CAPTURE_NAME[kind], size: 0, state: 'refused', refusal }];
      drawAttachments();

      return;
    }
    join(taken);
  }

  async function pickFrom(input: HTMLInputElement): Promise<void> {
    const mine = session;
    const files = [...(input.files ?? [])];
    // Emptied, so the same file chosen again is a change.
    input.value = '';
    await joinFiles(files, mine);
  }

  /** Reads and joins the files the person chose or dropped, one by one, for this open only. */
  async function joinFiles(files: readonly File[], mine: number): Promise<void> {
    if (!joinable()) return;
    for (const file of files) {
      let read: PickedFile;
      try {
        read = await readPicked(file);
      } catch {
        if (mine !== session) return;
        held = [
          ...held,
          { key: (heldKeys += 1), name: file.name, size: file.size, state: 'refused', refusal: 'retry' },
        ];
        drawAttachments();
        continue;
      }
      if (mine !== session) return;
      join(read);
    }
  }

  /** The places as the line was last drawn from them, and the id of the one it shows. */
  let places: readonly Destination[] = [];
  let selected: string | undefined;

  let state: ComposerState = 'idle';
  let closing = 0;
  /**
   * Bumped every time the popover opens or closes. A send is slow and a reporter is not: cancel or
   * Escape mid-flight and the response still arrives, to a popover that is gone or — worse — already
   * reopened on another element. Anything after an `await` checks the token it started with.
   */
  let session = 0;

  function setState(next: ComposerState, failure: SendFailure = 'retry'): void {
    state = next;
    root.dataset.fruitbackState = next;
    // Disabled while in flight: a second click would plant the same note twice, and the worker has
    // no way to tell the difference.
    send.disabled = next === 'sending' || next === 'sent' || next === 'kept' || next === 'receipt';
    keep.disabled = send.disabled;
    sendMore.disabled = send.disabled;
    // Nothing closes while a batch is on its way (FRU-608): its text is frozen, still readable.
    cancel.disabled = next === 'sending' && batchInFlight;
    if (send.disabled) closeSendMenu(false);
    // No way to join a file while the note is sent, or after (FRU-373): no note would name it.
    const settled = next === 'sending' || next === 'sent' || next === 'kept' || next === 'receipt';
    for (const way of [attachTrigger, attachPage, attachArea, attachFile]) way.disabled = settled;
    if (settled) closeAttachMenu(false);
    field.readOnly = next === 'sending';
    // A failure is a card of its own above the foot (FRU-305): « Not sent », then what to
    // do. The sentence is the one of its cause (FRU-156).
    failedText.textContent = next === 'failed' ? t.text(FAILURES[failure]) : '';
    failedCard.hidden = next !== 'failed';
    status.textContent =
      next === 'idle' || next === 'failed' || next === 'sent' || next === 'receipt' ? '' : t.text(STATUS[next]);
    // The one thing that makes this send work again, beside the sentence that says so (FRU-315).
    signInFailure = next === 'failed' && failure === 'signed-out' && options.onSignIn !== undefined;
    signIn.hidden =
      !signInFailure && !(mustSignIn && options.onSignIn !== undefined && (next === 'idle' || next === 'failed'));
    // A reader who must sign in first sends nothing until then (FRU-609).
    if (mustSignIn && (next === 'idle' || next === 'failed')) send.disabled = true;
    if (next !== 'sent') {
      sentCard.hidden = true;
      hideNotify();
    }
    if (next !== 'receipt') receipt.hidden = true;
  }

  /** The question of a note sent (FRU-604), while it waits for an answer. */
  let notifyOffer: NotifyOffer | undefined;
  let notifying = false;

  function hideNotify(): void {
    notifyOffer = undefined;
    notifying = false;
    notifyForm.hidden = true;
    notifyDone.hidden = true;
    notifyDone.textContent = '';
    notifyError.textContent = '';
    notifyEmail.value = '';
    notifyEmail.removeAttribute('aria-invalid');
  }

  /** Asks under the card of the note just sent. The composer stays until the person answers. */
  function showNotify(offer: NotifyOffer): void {
    notifyOffer = offer;
    notifyForm.hidden = false;
    notifyDone.hidden = true;
    notifyEmail.disabled = false;
    notifyYes.disabled = false;
    notifyNo.disabled = false;
    // The question makes the composer taller than when it was placed: placed again, with its height
    // of now, so « Notify me » is not below the bottom of the window.
    if (placedAt !== undefined) place(placedAt);
    notifyEmail.focus();
  }

  const NOTIFY_FAILURES = {
    invalid: 'composer.notifyInvalid',
    retry: 'composer.notifyRetry',
    wait: 'composer.notifyWait',
  } as const;

  async function answerNotify(): Promise<void> {
    const offer = notifyOffer;
    if (offer === undefined || notifying) return;
    const email = notifyEmail.value.trim();
    // The browser says what an address looks like; the worker decides what it takes.
    if (email === '' || !notifyEmail.checkValidity()) {
      notifyError.textContent = t.text('composer.notifyInvalid');
      notifyEmail.setAttribute('aria-invalid', 'true');
      notifyEmail.focus();

      return;
    }
    const mine = session;
    notifying = true;
    notifyYes.disabled = true;
    notifyNo.disabled = true;
    notifyError.textContent = '';
    let outcome: NotifyOutcome;
    try {
      outcome = await offer.send(email);
    } catch {
      outcome = 'retry';
    }
    if (mine !== session || notifyOffer !== offer) return;
    notifying = false;
    notifyYes.disabled = false;
    notifyNo.disabled = false;
    if (outcome === 'sent' || outcome === 'gone') {
      // Said where the question was, then the composer closes as a card of a note sent does.
      notifyForm.hidden = true;
      notifyOffer = undefined;
      notifyDone.textContent = t.text(outcome === 'sent' ? 'composer.notifyDone' : 'composer.notifyGone');
      notifyDone.hidden = false;
      sentCard.focus();
      closing = view?.setTimeout(close, SENT_MS) ?? 0;

      return;
    }
    // The address stays in its field: a second try is one click.
    notifyError.textContent = t.text(NOTIFY_FAILURES[outcome]);
    if (outcome === 'invalid') notifyEmail.setAttribute('aria-invalid', 'true');
    notifyEmail.focus();
  }

  notifyForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void answerNotify();
  });
  notifyEmail.addEventListener('input', () => {
    notifyEmail.removeAttribute('aria-invalid');
    notifyError.textContent = '';
  });
  notifyNo.addEventListener('click', () => {
    if (notifying) return;
    notifyOffer?.decline();
    close();
  });

  /**
   * The card of a sent note (FRU-305): the drop of its new pin with its number, « Sent as DEV-3 », the
   * sentence that says the pin follows the issue, and « Open → » when the reader may open the issue.
   * Without an identifier, « Sent » alone.
   */
  function showSent(sentAs: SentAs['sentAs'] | undefined, withoutPicture: boolean): void {
    const identifier = sentAs?.identifier;
    sentTitle.textContent =
      identifier === undefined || identifier === ''
        ? t.text('composer.sent')
        : t.text('composer.sentAs', { identifier });
    // The identifier stays in the title: the note is planted. The picture it lacks is said under it,
    // in place of the sentence that the pin follows the issue, which the new sentence ends with.
    sentText.textContent = t.text(withoutPicture ? 'composer.sentWithoutPicture' : 'composer.sentFollows');
    // The number rides in its own span, turned back upright, as on a pin.
    const number = document.createElement('span');
    number.textContent = sentAs?.number === undefined ? '' : String(sentAs.number);
    sentDrop.replaceChildren(number);
    sentOpen.hidden = sentAs?.url === undefined;
    if (sentAs?.url !== undefined) sentOpen.href = sentAs.url;
    sentCard.hidden = false;
  }

  /** Send the note, or keep it for later: the same states, and the text kept on any failure. */
  async function submit(action: 'send' | 'keep' = 'send'): Promise<void> {
    if (state === 'sending') return;

    const mine = session;
    setState('sending');
    // Before the send, so a failed send costs neither the name nor the choice to keep it.
    if (asksForName && remember.checked) memory?.set(typedName());
    let failure: SendFailure | undefined;
    let withoutPicture = false;
    let sentAs: SentAs['sentAs'] | undefined;
    let notify: NotifyOffer | undefined;
    try {
      // The files still on their way go first: the note names the ones the worker took. Awaited
      // only then: a note with no file in flight is sent in the same turn, as before FRU-332. A note
      // added to the batch takes no file: the capture waiting in the field stays there.
      if (action === 'send') {
        const ready = filesSettled(mine);
        if (ready !== true && !(await ready)) return;
      }
      const ids = held.flatMap((each) => (each.state === 'ready' && each.id !== undefined ? [each.id] : []));
      const result =
        action === 'keep' && batch !== undefined
          ? await batch.add(field.value, reporterFromFields(), selected)
          : await options.onSubmit(field.value, reporterFromFields(), selected, ids);
      if (result === false) failure = 'retry';
      else if (typeof result === 'string') failure = result;
      else if (typeof result === 'object' && result !== null) {
        withoutPicture = result.picture === 'missed';
        if ('sentAs' in result) {
          sentAs = result.sentAs;
          notify = result.notify;
        }
      }
    } catch {
      failure = 'retry';
    }

    if (failure !== undefined) {
      // Abandoned mid-flight: say nothing, focus nothing. The note was let go of on purpose.
      if (mine !== session) return;

      // The text stays exactly where it is. Retrying is one more click, not one more typing session.
      // A file that is no longer on its way says so under its name: the person removes it.
      if (failure === 'attachment-gone' || failure === 'no-tracker') {
        for (const each of held) {
          if (each.state !== 'ready') continue;
          each.state = 'refused';
          each.refusal = failure === 'no-tracker' ? 'no-tracker' : 'retry';
        }
        drawAttachments();
      }
      setState('failed', failure);
      field.focus();
      return;
    }

    if (mine !== session) return;

    setState(action === 'keep' ? 'kept' : 'sent');
    if (action === 'keep') {
      if (withoutPicture) status.textContent = t.text('composer.keptWithoutPicture');
      closing = view?.setTimeout(close, KEPT_MS) ?? 0;
      return;
    }
    held = [];
    drawAttachments();
    showSent(sentAs, withoutPicture);
    // FRU-604: a question waits for its answer. The composer does not close by itself under it.
    if (notify !== undefined) {
      showNotify(notify);

      return;
    }
    // The card is read where focus is: on its link when there is one, on the card otherwise.
    if (!sentOpen.hidden) sentOpen.focus();
    else sentCard.focus();
    closing = view?.setTimeout(close, SENT_MS) ?? 0;
  }

  /** Set while a batch is on its way: nothing closes the composer then (FRU-608). */
  let batchInFlight = false;
  /** The notes of the receipt that went, kept for a « Send again » that sends the rest. */
  let receiptSent: BatchSentNote[] = [];

  /** « Sending 2 of 3… », counting the note in flight. */
  const progressOf = (mine: number) => (done: number, total: number) => {
    if (mine !== session) return;
    const words = t.text('composer.sendingOf', { done: Math.min(done + 1, total), total });
    status.textContent = words;
    receiptStatus.textContent = words;
  };

  /**
   * « Send all N » (FRU-608): the note and the batch, in as few requests as the worker allows. The
   * host puts the note in the batch first, so a note that does not go stays there with its text. A
   * note with files goes alone first; when it fails, it is still in the field and says why.
   */
  async function submitAll(): Promise<void> {
    if (state === 'sending' || batch === undefined) return;
    const mine = session;
    batchInFlight = true;
    setState('sending');
    if (asksForName && remember.checked) memory?.set(typedName());
    let result: BatchSent;
    try {
      const ready = filesSettled(mine);
      if (ready !== true && !(await ready)) return;
      const ids = held.flatMap((each) => (each.state === 'ready' && each.id !== undefined ? [each.id] : []));
      progressOf(mine)(0, (batch.waiting() ?? 0) + 1);
      result = await batch.sendAll(field.value, reporterFromFields(), selected, ids, progressOf(mine));
    } catch {
      result = { sent: [], unsent: [], failure: 'retry', inField: true };
    } finally {
      batchInFlight = false;
    }
    if (mine !== session) return;
    if (result.inField === true) {
      setState('failed', result.failure ?? 'retry');
      field.focus();

      return;
    }
    // The note left the field: it went, or it waits in the batch with its text.
    held = [];
    drawAttachments();
    receiptSent = [...result.sent];
    showReceipt(result);
  }

  /**
   * The receipt of a batch (FRU-608): « 3 notes sent », where they went, each note with the link of
   * its ticket, and « Close ». A partial send says « 2 sent, 1 not sent »; a note that did not go keeps
   * its text, with « Copy text », and « Send again » sends the rest. The list scrolls past 420 px, in
   * a region the keyboard reaches, and « Show all in the sidebar » opens the list of every note.
   */
  function showReceipt(result: BatchSent): void {
    setState('receipt');
    root.dataset.fruitbackState = 'receipt';
    const whole = result.unsent.length === 0 && result.failure === undefined;
    receiptTitle.textContent = whole
      ? t.plural('composer.receiptSent', receiptSent.length)
      : t.text('composer.receiptPartial', { sent: receiptSent.length, unsent: result.unsent.length });
    receiptTo.textContent = whereItWent();
    receiptStatus.textContent = whole || result.failure === undefined ? '' : failureText(t, result.failure);
    receiptList.replaceChildren(
      ...receiptSent.map((note) => receiptRow(note, 'sent')),
      ...result.unsent.map((note) => receiptRow(note, 'unsent')),
    );
    receiptRetry.hidden = result.unsent.length === 0;
    receiptRetry.disabled = false;
    receiptAll.hidden = batch?.onShowAll === undefined || receiptSent.length + result.unsent.length <= RECEIPT_ROWS;
    receipt.hidden = false;
    fadeReceipt();
    receipt.focus();
  }

  /** « To Linear · Website », or « Sent to the team » when the reader is not told the place. */
  function whereItWent(): string {
    const index = places.findIndex((place) => place.id === selected);
    const place = places[index] ?? (places.length === 1 ? places[0] : undefined);
    if (place === undefined) return t.text('composer.landsTeam');

    return t.text('composer.receiptTo', { destination: nameOf(place, Math.max(index, 0)) });
  }

  function receiptRow(
    note: { id: string; text: string; identifier?: string | undefined; url?: string | undefined },
    kind: 'sent' | 'unsent',
  ): HTMLElement {
    const row = document.createElement('li');
    row.className = 'fruitback-composer-receipt-row';
    row.dataset.fruitbackReceiptRow = kind;
    const head = document.createElement('span');
    head.className = 'fruitback-composer-receipt-id';
    if (kind === 'sent' && note.url !== undefined) {
      const link = document.createElement('a');
      link.href = note.url;
      link.target = '_blank';
      link.rel = 'noreferrer noopener';
      link.textContent = note.identifier ?? t.text('composer.sentOpen');
      head.append(link);
    } else
      head.textContent =
        kind === 'sent' ? (note.identifier ?? t.text('composer.sent')) : t.text('composer.receiptNotSent');
    const words = document.createElement('span');
    words.className = 'fruitback-composer-receipt-text';
    // The note is the reporter's text: text, never markup.
    words.textContent = note.text;
    words.title = note.text;
    row.append(head, words);
    if (kind === 'unsent') {
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'fruitback-composer-ghost fruitback-composer-receipt-copy';
      copy.textContent = t.text('composer.receiptCopy');
      copy.addEventListener('click', () => {
        const clipboard = view?.navigator.clipboard;
        void (clipboard?.writeText(note.text) ?? Promise.reject(new Error('no clipboard'))).then(
          () => (copy.textContent = t.text('composer.receiptCopied')),
          () => {
            // The text stays readable in the row: selected, the person copies it by hand.
            const range = document.createRange();
            range.selectNodeContents(words);
            view?.getSelection()?.removeAllRanges();
            view?.getSelection()?.addRange(range);
          },
        );
      });
      row.append(copy);
    }

    return row;
  }

  /** The fade at the foot of the list, while rows are below. */
  function fadeReceipt(): void {
    const below = receiptRegion.scrollHeight - receiptRegion.clientHeight - receiptRegion.scrollTop;
    receiptRegion.toggleAttribute('data-fruitback-more', below > 1);
  }

  async function resendBatch(): Promise<void> {
    if (batch === undefined || batchInFlight) return;
    const mine = session;
    batchInFlight = true;
    receiptRetry.disabled = true;
    let result: BatchSent;
    try {
      result = await batch.resend(progressOf(mine));
    } catch {
      result = { sent: [], unsent: [], failure: 'retry' };
    } finally {
      batchInFlight = false;
    }
    if (mine !== session) return;
    receiptSent = [...receiptSent, ...result.sent];
    showReceipt(result);
  }

  /** The typed name is kept, hidden, and not sent: an identity that ends gives the field back with it. */
  function askForNameOrNot(): void {
    asksForName = !isIdentified();
    foldWho(whoOpen);
    drawAvatar();
  }

  /**
   * The name and « Remember me » stand behind the avatar (FRU-607): a note is signed « Guest » until
   * somebody opens them. Nothing typed goes when they fold: the name stays in its field.
   */
  function foldWho(open: boolean): void {
    whoOpen = open;
    who.hidden = !(asksForName && open);
    avatar.setAttribute('aria-expanded', String(!who.hidden));
  }

  /**
   * The signature, as an avatar at the end of the field (FRU-607): the initials of the name the note
   * goes with, the whole name in the tooltip, and « Guest » in dashes when it goes with none. A signed
   * reader sees none: the worker names them, and the widget does not know the name (FRU-112).
   */
  function drawAvatar(): void {
    avatar.hidden = !asksForName;
    const signed = typedName();
    avatar.dataset.fruitbackAvatar = signed === undefined ? 'guest' : 'named';
    avatar.textContent = signed === undefined ? t.text('composer.guest') : initialsOf(signed, t.locale);
    avatar.title = signed ?? t.text('composer.guest');
    avatar.setAttribute(
      'aria-label',
      signed === undefined ? t.text('composer.signedGuest') : t.text('composer.signedAs', { name: signed }),
    );
    drawTools();
  }

  /** The row of icons goes when it holds none: a signed reader on a site that takes no file. */
  function drawTools(): void {
    tools.hidden = avatar.hidden && pictureLabel.hidden && attachWays.hidden;
  }

  /** The box shows the preference as it is now. It is never ticked by anything but its reporter. */
  function showPicture(): void {
    const offered = options.picture?.offered() === true;
    pictureLabel.hidden = !offered;
    picture.checked = offered && options.picture?.get() === true;
    drawTools();
  }

  function open(target: Element | ElementBox, subject = '', readable = '', head: { selector?: boolean } = {}): void {
    following = isElement(target) ? target : null;
    const anchor = isElement(target) ? boxOf(target) : target;
    placedAt = anchor;
    if (closing !== 0) {
      view?.clearTimeout(closing);
      closing = 0;
    }

    // As text: it is whatever the page called its element and its component.
    about.textContent = subject;
    about.title = readable;
    about.toggleAttribute('data-fruitback-selector', head.selector === true);
    // Somebody is writing, and points the open composer at another element: a second capture over
    // it does that. **Nothing they set is set again**: the note, the name they typed, the place
    // they chose and the sentence of a failed send all stay. Only what the note is about changes,
    // and where the composer stands. A composer that shows « sent » is not being written in.
    //
    // **Nor is a note on its way**: the session it was sent in stays, so a failure still finds its
    // text and says why. `init` does not even ask while a note is sending; a host that assembles
    // the parts itself might.
    if (!root.hidden && (state === 'idle' || state === 'failed' || state === 'sending')) {
      place(anchor);
      keepInSight(anchor);
      settleOn();
      field.focus();

      return;
    }

    session += 1;
    const restored = options.autosave?.read() ?? '';
    field.value = restored;
    fitField();
    showPicture();
    whoOpen = false;
    askForNameOrNot();
    held = [];
    closeAttachMenu(false);
    box.toggleAttribute('data-fruitback-dragging', false);
    keepOffered = batch?.offered() === true;
    receiptSent = [];
    closeLightbox();
    mustSignIn = options.signInToSend?.() === true;
    showRememberedName();
    drawAvatar();
    // Folded at each open, on the place chosen last. The line says where, and that is enough for
    // the many notes that go where the one before went.
    selected = undefined;
    gone.textContent = '';
    foldPlaces(true);
    drawDestinations();
    drawAttachments();
    setState('idle');
    drawSignIn();
    // Said, and quietly: the person finds the text they left, and knows why it is there.
    if (restored !== '') status.textContent = t.text('composer.restored');
    takeElement();
    focus.remember();
    root.hidden = false;
    place(anchor);
    keepInSight(anchor);
    settleOn();
    field.focus();
  }

  /**
   * The open that asked for the capture of the element. It is asked once per open: a read that comes
   * after it takes no second one, and a capture the person removed does not come back.
   */
  let elementAsked = -1;

  /**
   * The capture of the element, joined at the open (FRU-609), where the host captures and the note
   * takes files. It waits in the field and leaves only with the note. Nothing is said when it does
   * not come: the person did not ask for it, and the camera icon still takes one.
   */
  function takeElement(): void {
    if (elementAsked === session) return;
    if (seam?.captureElement === undefined || !seam.captures() || seam.offer(selected) !== 'offered') return;
    elementAsked = session;
    const mine = session;
    void seam
      .captureElement()
      .catch(() => undefined)
      .then((taken) => {
        if (taken === undefined || mine !== session || !joinable()) return;
        const { frame, ...file } = taken;
        join(file, { later: true, preview: { src: `data:${file.type};base64,${file.base64}`, frame } });
      });
  }

  /**
   * The element is chosen at a click, so maybe on a box that the press made smaller (FRU-489). The
   * composer follows its box for the few frames after, until the box stays the same.
   */
  function settleOn(): void {
    stopSettling();
    const element = following;
    stopSettling = element === null ? () => {} : settle(frames, () => element.getBoundingClientRect(), follow);
  }

  /** The element the open composer follows, and its edges where the composer was placed last. */
  let following: Element | null = null;
  let placedAt: ElementBox | undefined;
  const frames = framesOf(view);
  let stopSettling: () => void = () => {};

  function boxOf(element: Element): ElementBox {
    const rect = element.getBoundingClientRect();
    const x = view?.scrollX ?? 0;
    const y = view?.scrollY ?? 0;

    return { left: rect.left + x, top: rect.top + y, bottom: rect.bottom + y, right: rect.right + x };
  }

  /**
   * Moved by as much as its element moved against the document (FRU-457): a fixed sidebar at a scroll,
   * a row in a box that scrolls. It keeps its side and its offset to the element. Placed again, it
   * would weigh the room above against the window of now, and jump to the other side of an element
   * that only shifted by a pixel as the page scrolled. An element that moves with the document keeps
   * the composer where it is: a scroll does not slide it along the window.
   */
  function follow(): void {
    // An element the page took away measures as a box of nothing at 0, 0: the composer stays.
    if (root.hidden || following === null || !following.isConnected || placedAt === undefined) return;
    // An element the page hides (`display: none`) measures the same way while it stays connected.
    const rect = following.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    const now = boxOf(following);
    // By the edges it was placed against: the start edge across, and the side it opened on. An element
    // that only moved moves them all alike; one that grows back from a press (FRU-489) does not.
    // Beside the element, the edge it stands against; above or below, its start edge.
    const side = root.dataset.fruitbackSide;
    const byRight = side === 'right' || ((side === 'above' || side === 'below') && t.direction === 'rtl');
    const dx = byRight ? now.right - placedAt.right : now.left - placedAt.left;
    const dy = side === 'below' ? now.bottom - placedAt.bottom : now.top - placedAt.top;
    if (dx === 0 && dy === 0) return;
    placedAt = now;
    // Across, it stays inside the window, as `place` keeps it: an element that a box scrolls sideways
    // out of the window must not take the composer out of reach.
    const scrollX = view?.scrollX ?? 0;
    const left = (Number.parseFloat(root.style.getPropertyValue('--fruitback-composer-left')) || 0) + dx;
    const most = scrollX + (view?.innerWidth ?? 0) - WIDTH - GAP;
    root.style.setProperty('--fruitback-composer-left', `${Math.max(scrollX + GAP, Math.min(left, most))}px`);
    const top = (Number.parseFloat(root.style.getPropertyValue('--fruitback-composer-top')) || 0) + dy;
    root.style.setProperty('--fruitback-composer-top', `${top}px`);
  }
  // Capture phase: a scroll event does not bubble, and a box of the page that scrolls must count too.
  view?.addEventListener('scroll', follow, { passive: true, capture: true });
  view?.addEventListener('resize', follow, { passive: true });

  /**
   * Beside the element it belongs to, on the side with room (FRU-607): the end side first (the right
   * in a left-to-right language), then the start side, then below, and above only when nothing else
   * fits. Above, it ends 40 px over the top of the element, so the label of the frame stays in
   * sight (FRU-258). With room nowhere it stays under the element, as far down as the window lets it.
   *
   * A line joins it to the frame (the tether), from its edge to the middle of the element, kept
   * inside its own edge. The values stay physical, because they are positions against the page
   * (FRU-38).
   *
   * On a narrow screen the rules below take over entirely and pin it to the bottom of the viewport, so
   * the position set here stops mattering — which is why it is set with `style` and overridden by a media query.
   */
  /**
   * On a narrow screen the composer is a sheet on the foot of the window (FRU-611, P7): the page
   * scrolls so that its element stands above the sheet, in sight. A page that cannot scroll that far
   * (an element at its very foot) gets the sheet on the top of the window instead, under which the
   * element stays in sight: the page of somebody else is never given a margin. On a wider screen
   * nothing moves.
   */
  function keepInSight(anchor: ElementBox): void {
    delete root.dataset.fruitbackSheet;
    if (view === null || view.matchMedia?.(NARROW).matches !== true) return;
    const covered = (): boolean => {
      const sheet = root.getBoundingClientRect();
      const top = anchor.top - view.scrollY;
      const bottom = anchor.bottom - view.scrollY;

      return bottom + GAP > sheet.top || top < 0;
    };
    if (!covered()) return;
    const sheetTop = root.getBoundingClientRect().top;
    // An element taller than the room over the sheet cannot be in sight whole, nor under a sheet on
    // the top: it stays where it is, as before, the sheet on the foot (thread-side.spec.ts, fallback).
    if (anchor.bottom - anchor.top + 2 * GAP > sheetTop) return;
    // The bottom of the element GAP over the sheet, or its top GAP under the top of the window.
    view.scrollBy({
      top: Math.min(anchor.bottom - view.scrollY + GAP - sheetTop, anchor.top - view.scrollY - GAP),
      behavior: 'instant',
    });
    if (covered()) root.dataset.fruitbackSheet = 'top';
  }

  function place(anchor: ElementBox): void {
    const width = view?.innerWidth ?? 0;
    const height = view?.innerHeight ?? 0;
    const scrollX = view?.scrollX ?? 0;
    const scrollY = view?.scrollY ?? 0;
    const own = root.getBoundingClientRect();
    const minLeft = scrollX + GAP;
    const maxLeft = scrollX + width - WIDTH - GAP;
    const minTop = scrollY + GAP;
    const maxTop = Math.max(minTop, scrollY + height - own.height - GAP);
    const right = anchor.right + FRAME + SIDE;
    const left = anchor.left - FRAME - SIDE - WIDTH;
    const above = anchor.top - RISE - own.height;
    const below = anchor.bottom + FRAME + GAP;
    const start = t.direction === 'rtl' ? anchor.right + FRAME - WIDTH : anchor.left - FRAME;
    const fits: Record<Side, boolean> = {
      right: right <= maxLeft,
      left: left >= minLeft,
      below: below + own.height <= scrollY + height,
      above: above >= minTop,
    };
    const order: readonly Side[] =
      t.direction === 'rtl' ? ['left', 'right', 'below', 'above'] : ['right', 'left', 'below', 'above'];
    const side = order.find((each) => fits[each]) ?? 'below';
    const across = side === 'right' || side === 'left';
    const startLeft = Math.max(minLeft, Math.min(start, maxLeft));
    const sideTop = Math.max(minTop, Math.min(anchor.top - FRAME, maxTop));
    const underTop = fits.below ? below : maxTop;
    // Where it stands on each side, and how long the tether is from its edge to the frame.
    const at: Record<Side, { x: number; y: number; length: number }> = {
      right: { x: right, y: sideTop, length: SIDE },
      left: { x: left, y: sideTop, length: SIDE },
      // With room nowhere it can cover the element: the tether then has no length.
      below: { x: startLeft, y: underTop, length: Math.max(0, underTop - anchor.bottom - FRAME) },
      above: { x: startLeft, y: above, length: RISE - FRAME },
    };
    const { x, y, length } = at[side];

    // Where it grows from: the corner nearest to its element.
    root.dataset.fruitbackSide = side;
    // Custom properties rather than inline `left`/`top`: an inline style would beat the media query
    // below and leave the mobile sheet offset by whatever the element's position happened to be.
    // In document coordinates, so the window it must stay inside starts at `scrollX` (FRU-68).
    root.style.setProperty('--fruitback-composer-left', `${x}px`);
    root.style.setProperty('--fruitback-composer-top', `${y}px`);
    // The tether meets the middle of the element, and stays on the edge of the composer.
    const along = across ? (anchor.top + anchor.bottom) / 2 - y : (anchor.left + anchor.right) / 2 - x;
    const most = (across ? own.height : WIDTH) - TETHER_INSET;
    root.style.setProperty('--fruitback-composer-tether', `${Math.max(TETHER_INSET, Math.min(along, most))}px`);
    root.style.setProperty('--fruitback-composer-tether-length', `${length}px`);
  }

  /**
   * What the visitor said about themselves, or nothing at all.
   *
   * Anonymous is the default and stays one click away: the field is behind a disclosure, empty, and
   * an empty one is absent rather than an empty string — the note round-trip forbids a field nobody
   * provided. One field, and no e-mail (FRU-91): an address is not needed to read a note.
   */
  function reporterFromFields(): NoteReporter | undefined {
    const typed = asksForName ? typedName() : undefined;

    return typed === undefined ? undefined : { name: typed };
  }

  function typedName(): string | undefined {
    const typed = name.value.trim();

    return typed.length > 0 ? typed : undefined;
  }

  /** A reporter who asked to be remembered sees the name the next note is signed with. */
  function showRememberedName(): void {
    const remembered = asksForName ? memory?.get() : undefined;
    if (remembered === undefined) {
      const suggested = asksForName ? options.suggestName?.() : undefined;
      if (suggested === undefined || name.value.trim() !== '') return;
      name.value = suggested;

      return;
    }

    name.value = remembered;
    remember.checked = true;
  }

  /** What a member reads for a place: the name the worker gave, or its rank when it gave none. */
  function nameOf(place: Destination, index: number): string {
    return place.label ?? t.text('composer.destinationUnnamed', { position: index + 1 });
  }

  function foldPlaces(folded: boolean): void {
    placeList.hidden = folded;
    destination.setAttribute('aria-expanded', String(!folded));
  }

  /**
   * Draw the line from what is offered now (FRU-123).
   *
   * With fewer than two places nothing is drawn, and `selected` is nothing, so the send names no
   * place. Otherwise the line shows the place chosen in this popover, then the one remembered, then
   * the first one. A remembered id that is not offered is not followed: the list is the worker's
   * word about this reader now.
   */
  function drawDestinations(): void {
    const shownBefore = places.findIndex((place) => place.id === selected);
    const before = places[shownBefore];
    places = choice?.offered() ?? [];
    const offered = places.length >= 2 ? places : [];

    if (!offered.some((place) => place.id === selected)) {
      // The open popover named a place, and the note will not go there. The line changes under the
      // reporter's eyes or goes away, so words say it: a note in the wrong tracker is found late.
      // A list that kept only that place still sends there: one place is the default.
      if (before !== undefined && !root.hidden && !places.some((place) => place.id === before.id)) {
        gone.textContent = t.text('composer.destinationGone', { destination: nameOf(before, shownBefore) });
      }
      const remembered = choice?.remembered();
      selected = (offered.find((place) => place.id === remembered) ?? offered[0])?.id;
    }

    const hadFocus = placeList.contains(deepActiveElement(document));
    destination.hidden = offered.length === 0;
    if (offered.length === 0) foldPlaces(true);
    placeList.replaceChildren(
      ...offered.map((place, index) => {
        const label = document.createElement('label');
        label.className = 'fruitback-composer-place';
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'fruitback-destination';
        input.value = place.id;
        input.checked = place.id === selected;
        const text = document.createElement('span');
        // The name comes from a tracker, through the worker. It is text, like every word here.
        text.textContent = nameOf(place, index);
        label.append(input, text);

        return label;
      }),
    );
    showSelected();
    if (hadFocus) checkedPlace()?.focus();
  }

  function showSelected(): void {
    const index = places.findIndex((place) => place.id === selected);
    const place = places[index];
    // In icons (FRU-607): the tile of the tool, then the most precise name. The whole path is the
    // tooltip and the accessible name, and the button opens the choice.
    if (place === undefined) destination.replaceChildren();
    else {
      const path = nameOf(place, index);
      destination.replaceChildren(
        ...placeIcons(document, path, t.text('composer.destination', { destination: path })),
        createIcon(document, 'chevron'),
      );
      destination.title = path;
    }
    // The foot says where the note lands (FRU-305): the one place a member sees, or « to the team ».
    // With several places, the button above says it and lets them choose.
    const only = places.length === 1 ? places[0] : undefined;
    lands.hidden = places.length >= 2;
    if (only === undefined) {
      lands.textContent = t.text('composer.landsTeam');
      lands.removeAttribute('title');
    } else {
      const path = nameOf(only, 0);
      lands.replaceChildren(...placeIcons(document, path, t.text('composer.lands', { destination: path })));
      lands.title = path;
    }
  }

  const checkedPlace = () => placeList.querySelector<HTMLInputElement>('input:checked');

  function close(): void {
    // A batch on its way finishes in sight: its receipt says what went (FRU-608).
    if (batchInFlight) return;
    if (closing !== 0) {
      view?.clearTimeout(closing);
      closing = 0;
    }
    session += 1;
    root.hidden = true;
    following = null;
    stopSettling();
    setState('idle');
    focus.restore();
    options.onClose?.();
  }

  // A click anywhere else closes the card of a sent note at once (FRU-305).
  function onDocumentClick(event: Event): void {
    if (root.hidden || state !== 'sent') {
      if (!sendMenu.hidden && !event.composedPath().includes(sendMenu) && !event.composedPath().includes(sendMore))
        closeSendMenu(false);
      return;
    }
    if (event.composedPath().includes(root)) return;
    // A question that waits is answered, or closed with Escape or « No thanks »: a click away from it
    // is no answer (FRU-604).
    if (notifyOffer !== undefined) return;
    close();
  }
  document.addEventListener('click', onDocumentClick, true);

  pick.addEventListener('click', () => options.onPickAgain?.());

  avatar.addEventListener('click', () => {
    foldWho(!whoOpen);
    if (!who.hidden) name.focus();
  });
  name.addEventListener('input', drawAvatar);

  // Unticked, the box forgets at once. The reporter does not have to send a note to be forgotten.
  remember.addEventListener('change', () => {
    if (!remember.checked) memory?.set(undefined);
  });

  destination.addEventListener('click', () => {
    foldPlaces(!placeList.hidden);
    if (!placeList.hidden) checkedPlace()?.focus();
  });

  // Kept at the choice and not at the send, like every preference: a failed send does not lose it.
  placeList.addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement;
    if (!input.checked) return;

    selected = input.value;
    gone.textContent = '';
    showSelected();
    drawAttachments();
    choice?.remember(input.value);
  });

  const stopFollowingPlaces = choice?.subscribe(() => {
    drawDestinations();
    drawAttachments();
  });
  // A composer opened before the first read of the page offers no file yet. When the read says that
  // files go, the capture of the element joins then, as it does at an open after the read.
  const stopFollowingOffer = seam?.subscribe(() => {
    drawAttachments();
    if (!root.hidden) takeElement();
  });
  attachPage.addEventListener('click', () => void capture('page', attachTrigger));
  attachArea.addEventListener('click', () => void capture('area', attachTrigger));
  // A file dropped on the field joins the note (FRU-607): the field is where the files are.
  const takesDrop = (): boolean => seam?.offer(selected) === 'offered' && !attachFile.disabled;
  for (const type of ['dragenter', 'dragover'] as const) {
    box.addEventListener(type, (event) => {
      if (!takesDrop() || ![...(event.dataTransfer?.types ?? [])].includes('Files')) return;
      event.preventDefault();
      box.toggleAttribute('data-fruitback-dragging', true);
    });
  }
  box.addEventListener('dragleave', (event) => {
    // Leaving the field for one of its own children is not leaving it.
    if (isElement(event.relatedTarget) && box.contains(event.relatedTarget)) return;
    box.toggleAttribute('data-fruitback-dragging', false);
  });
  box.addEventListener('drop', (event) => {
    box.toggleAttribute('data-fruitback-dragging', false);
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length === 0) return;
    // A drop of text stays a drop of text, in the field: only files are taken from it.
    event.preventDefault();
    if (!takesDrop() || attachFile.getAttribute('aria-disabled') === 'true') return;
    void joinFiles(files, session);
  });
  // A screenshot pasted anywhere in the composer joins the note (FRU-424), as a file chosen does.
  root.addEventListener('paste', (event) => {
    const images = pastedImages(event.clipboardData);
    if (images.length === 0) return;
    if (seam?.offer(selected) !== 'offered' || attachTrigger.disabled) return;
    event.preventDefault();
    void joinFiles(images, session);
  });
  attachTrigger.addEventListener('click', () => {
    if (attachMenu.hidden) openAttachMenu('first');
    else closeAttachMenu(true);
  });
  attachTrigger.addEventListener('keydown', (event) => {
    const { key } = event;
    if (key !== 'ArrowDown' && key !== 'ArrowUp') return;
    event.preventDefault();
    openAttachMenu(key === 'ArrowDown' ? 'first' : 'last');
  });
  attachMenu.addEventListener('keydown', (event) => {
    const { key } = event;
    const items = menuItems();
    const at = items.indexOf(deepActiveElement(document) as HTMLButtonElement);
    if (key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeAttachMenu(true);

      return;
    }
    if (key === 'Tab') {
      closeAttachMenu(false);

      return;
    }
    const next: Record<string, number> = {
      ArrowDown: (at + 1) % items.length,
      ArrowUp: (at - 1 + items.length) % items.length,
      Home: 0,
      End: items.length - 1,
    };
    if (next[key] === undefined) return;
    event.preventDefault();
    items[next[key]]?.focus();
  });
  attachFile.addEventListener('click', () => {
    if (attachFile.getAttribute('aria-disabled') === 'true') return;
    closeAttachMenu(false);
    fileInput.click();
  });
  // A click out of the menu closes it, as Esc does, and leaves the focus where the click put it.
  function onMenuOutside(event: Event): void {
    if (attachMenu.hidden) return;
    const path = event.composedPath();
    if (path.includes(attachMenu) || path.includes(attachTrigger)) return;
    closeAttachMenu(false);
  }
  document.addEventListener('click', onMenuOutside, true);
  fileInput.addEventListener('change', () => void pickFrom(fileInput));
  attachList.addEventListener('click', (event) => {
    const button = (event.target as Element).closest?.<HTMLElement>('[data-fruitback-file-remove]') ?? null;
    if (button === null) return;
    const key = Number(button.dataset.fruitbackFileRemove);
    // The file stays in the worker until its transit ends: no note names it.
    held = held.filter((each) => each.key !== key);
    drawAttachments();
  });

  // Kept at the tick, like every preference: it is the reporter's, with or without a note sent.
  picture.addEventListener('change', () => options.picture?.set(picture.checked));
  const stopFollowingPicture = options.picture?.subscribe?.(showPicture);
  showPicture();

  send.addEventListener('click', sendPrimary);
  keep.addEventListener('click', () => void submit('keep'));
  sendMore.addEventListener('click', () => (sendMenu.hidden ? openSendMenu() : closeSendMenu(true)));
  sendAllItem.addEventListener('click', () => {
    closeSendMenu(false);
    void submitAll();
  });
  sendOnlyItem.addEventListener('click', () => {
    closeSendMenu(false);
    void submit();
  });
  sendMenu.addEventListener('keydown', (event) => {
    const items = [sendAllItem, sendOnlyItem];
    const at = items.indexOf(deepActiveElement(document) as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeSendMenu(true);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    } else if (event.key === 'Tab') closeSendMenu(false);
  });
  sendMore.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    openSendMenu();
  });
  receiptClose.addEventListener('click', close);
  receiptRetry.addEventListener('click', () => void resendBatch());
  receiptAll.addEventListener('click', () => {
    close();
    batch?.onShowAll?.();
  });
  receiptRegion.addEventListener('scroll', fadeReceipt, { passive: true });
  const stopFollowingBatch = batch?.subscribe(() => {
    if (state === 'idle' || state === 'failed') drawBatch();
  });
  signIn.addEventListener('click', () => options.onSignIn?.());
  cancel.addEventListener('click', close);
  // Each change is saved (FRU-311): a reload, Esc, « Cancel » or the cross no longer loses it. The
  // sentence « Draft restored » has done its job once the person types.
  field.addEventListener('input', () => {
    options.autosave?.write(field.value);
    if (state === 'idle') status.textContent = '';
    fitField();
  });
  field.addEventListener('scroll', fadeField, { passive: true });

  /**
   * The field grows with its text up to 150 px, then scrolls (FRU-611, P7). Its own height is set
   * from its content; the stylesheet keeps the 96 px of the mock-up as the least.
   */
  function fitField(): void {
    field.style.removeProperty('height');
    const tall = field.scrollHeight;
    // No layout (a closed composer, a DOM with no layout): the stylesheet decides.
    if (tall > 0) field.style.setProperty('height', `${Math.min(tall, FIELD_MAX)}px`);
    fadeField();
  }

  /** A fade at the foot of the field says there is more text below, while there is. */
  function fadeField(): void {
    const below = field.scrollHeight - field.clientHeight - field.scrollTop;
    field.toggleAttribute('data-fruitback-more', below > 1);
  }
  field.addEventListener('keydown', (event) => {
    // ⌘/Ctrl+Enter sends, because a plain Enter belongs to the note.
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) sendPrimary();
  });

  setState('idle');

  return {
    open,
    close,
    state: () => state,
    identityChanged() {
      if (root.hidden) askForNameOrNot();
    },
    signInChanged() {
      drawSignIn();
    },
    captureArea() {
      const offered = seam?.offer(selected) === 'offered' && seam.captures();
      if (root.hidden || !joinable() || !offered || attachArea.getAttribute('aria-disabled') === 'true') return false;
      void capture('area', attachTrigger);

      return true;
    },
    element: root,
    destroy() {
      if (closing !== 0) view?.clearTimeout(closing);
      document.removeEventListener('click', onDocumentClick, true);
      document.removeEventListener('click', onMenuOutside, true);
      view?.removeEventListener('scroll', follow, true);
      view?.removeEventListener('resize', follow);
      stopSettling();
      focus.destroy();
      stopFollowingPlaces?.();
      stopFollowingOffer?.();
      stopFollowingPicture?.();
      stopFollowingBatch?.();
      root.remove();
      style.remove();
    },
  };
}

/**
 * Words a screen reader reads and the eye does not: the name of an icon, the whole path of a place.
 */
function hiddenWords(document: Document, words: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'fruitback-composer-sr';
  span.textContent = words;

  return span;
}

/**
 * The initials of a name, as an avatar writes them (FRU-607): the first letter of its first word and
 * of its last, « CD » for « Camille Durand », « C » for « Camille ». By code point, so a letter outside
 * the basic plane is not cut in two.
 */
export function initialsOf(name: string, locale?: string): string {
  const words = name
    .trim()
    .split(/\s+/u)
    .filter((word) => word !== '');
  const first = words[0];
  if (first === undefined) return '';
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  const letter = (word: string | undefined): string => (word === undefined ? '' : (Array.from(word)[0] ?? ''));

  return (letter(first) + letter(last)).toLocaleUpperCase(locale);
}

/**
 * A place in icons (FRU-607): the tile of its tool, then its most precise name. The worker writes
 * the path « Linear · Design · Website », from the tool to the project (FRU-123); the tile takes the
 * first letter of the tool, the name is the last part. A path of one part is its own tool and name.
 */
export function placeParts(path: string): { tool: string; name: string } {
  const parts = path
    .split(' · ')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  const tool = parts[0] ?? path;

  return { tool, name: parts[parts.length - 1] ?? path };
}

/**
 * The tile, then `sentence` with the name in sight and the rest for a screen reader only: « Send to:
 * Linear · » is heard, « Website » is seen and heard. The name a reader hears holds the words they
 * see (WCAG 2.5.3), in the order of any language, because the sentence is split where the name is.
 */
function placeIcons(document: Document, path: string, sentence: string): HTMLElement[] {
  const { tool, name } = placeParts(path);
  const tile = document.createElement('span');
  tile.className = 'fruitback-composer-tile';
  tile.setAttribute('aria-hidden', 'true');
  tile.textContent = Array.from(tool)[0]?.toUpperCase() ?? '';
  const named = document.createElement('span');
  named.className = 'fruitback-composer-place-name';
  named.textContent = name;
  const at = sentence.lastIndexOf(name);
  if (at < 0) return [tile, hiddenWords(document, sentence), named];
  const before = sentence.slice(0, at);
  const after = sentence.slice(at + name.length);

  return [
    tile,
    ...(before === '' ? [] : [hiddenWords(document, before)]),
    named,
    ...(after === '' ? [] : [hiddenWords(document, after)]),
  ];
}

/** A size in megabytes with two decimals, for a size that rounds to its limit (FRU-609). */
function preciseSize(bytes: number, locale: string): string {
  const value = bytes / (1_024 * 1_024);
  try {
    return new Intl.NumberFormat(locale, {
      style: 'unit',
      unit: 'megabyte',
      unitDisplay: 'short',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Math.ceil(value * 100) / 100);
  } catch {
    return `${(Math.ceil(value * 100) / 100).toFixed(2)} MB`;
  }
}

/** The space `place` keeps between the composer and the edge of the window (FRU-258). */
const GAP = 10;
/**
 * How far above the top of its element the composer ends, and how far the frame stands off the element:
 * a line of 2 px, 3 px off (FRU-303).
 */
const RISE = 40;
const FRAME = 5;
/** Where the composer is a sheet on the foot of the window: the media query of its stylesheet. */
const NARROW = '(max-width: 640px)';

/** The tallest the field grows with its text before it scrolls (FRU-611, P7). */
export const FIELD_MAX = 150;
/** How far beside its element the composer stands: the length of the tether across (FRU-607). */
const SIDE = 16;
/** The tether keeps this far from a corner of the composer, so it never meets the rounded edge. */
const TETHER_INSET = 18;

/** The side of its element the composer opens on (FRU-607). */
type Side = 'right' | 'left' | 'below' | 'above';

const STATUS = {
  sending: 'composer.sending',
  sent: 'composer.sent',
  kept: 'composer.kept',
} as const satisfies Record<Exclude<ComposerState, 'idle' | 'failed' | 'receipt'>, MessageKey>;

/** Past this many notes, the receipt offers the list of every note too (FRU-608). */
const RECEIPT_ROWS = 5;

/**
 * The sentence of a failed send, for another part of the widget that sends: the list of drafts
 * (FRU-124). It has no title above it, so a send to try again says it all in one sentence.
 */
export function failureText(t: Translator, failure: SendFailure): string {
  return t.text(failure === 'retry' ? 'composer.failed' : FAILURES[failure]);
}

/** What a failed send says under « Not sent », by its cause (FRU-156, FRU-305). */
const FAILURES = {
  retry: 'composer.failedRetry',
  wait: 'composer.failedWait',
  refused: 'composer.failedRefused',
  'signed-out': 'composer.failedSignedOut',
  'members-only': 'composer.failedMembersOnly',
  'too-large': 'composer.failedTooLarge',
  'attachment-gone': 'composer.failedAttachmentGone',
  'no-tracker': 'composer.failedNoTracker',
} as const satisfies Record<SendFailure, MessageKey>;

/** Why a file did not go, under its name (FRU-332). */
const REFUSALS = {
  'too-large': 'composer.attachTooLarge',
  type: 'composer.attachType',
  'too-many': 'composer.attachTooMany',
  'no-tracker': 'composer.attachNoTrackerShort',
  full: 'composer.attachFull',
  'signed-out': 'composer.attachSignedOut',
  capture: 'composer.attachCapture',
  'capture-permission': 'composer.attachCapturePermission',
  retry: 'composer.attachRetry',
} as const satisfies Record<AttachRefusal, MessageKey>;

/** The name of a capture whose bytes never came, for its line in the list. */
const CAPTURE_NAME = { page: 'page.png', area: 'area.png' } as const;

/** The most files of a note: the ways to join one are off beyond it. */
const MAX_FILES = MAX_ATTACHMENTS_PER_NOTE;

/**
 * An element of the composer: its tag, its attributes, and its children. No text: every word is set
 * after the build, with `textContent`, so a translation of the host is never markup.
 */
type Markup = readonly [tag: string, attributes: Readonly<Record<string, string>>, children?: readonly Markup[]];

/**
 * The element that `markup` describes, made with `createElement` (FRU-389).
 *
 * The composer was a constant string given to `innerHTML`. Nothing typed went into it, but the
 * validator of addons.mozilla.org flags every assignment to `innerHTML`, a reviewer may refuse a
 * version for it, and a page whose CSP asks for Trusted Types refuses the assignment itself. The
 * icons are built the same way (`icons.ts`).
 */
function build(document: Document, [tag, attributes, children = []]: Markup): Element {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  element.append(...children.map((child) => build(document, child)));

  return element;
}

const TEMPLATE: readonly Markup[] = [
  // The line from the composer to the frame of its element (FRU-607). Drawn, never read.
  ['span', { 'data-fruitback-tether': '', class: 'fruitback-composer-tether', 'aria-hidden': 'true' }],
  [
    'div',
    { class: 'fruitback-composer-head' },
    [
      ['span', { class: 'fruitback-composer-drop', 'aria-hidden': 'true' }],
      ['span', { 'data-fruitback-about': '', class: 'fruitback-composer-about' }],
      ['button', { type: 'button', 'data-fruitback-pick': '', class: 'fruitback-composer-pick', hidden: '' }],
    ],
  ],
  [
    'div',
    { class: 'fruitback-composer-body' },
    [
      // The field holds the note, its files and the tools that add them, and the signature (FRU-607).
      [
        'div',
        { 'data-fruitback-box': '', class: 'fruitback-composer-box' },
        [
          [
            'label',
            { class: 'fruitback-composer-field' },
            [
              ['span', { 'data-fruitback-note-label': '', class: 'fruitback-composer-sr' }],
              ['textarea', { 'data-fruitback-note': '', rows: '4' }],
            ],
          ],
          [
            'div',
            {
              'data-fruitback-attach': '',
              class: 'fruitback-composer-attach',
              role: 'group',
              'aria-labelledby': 'fruitback-composer-attach-label',
              hidden: '',
            },
            [
              [
                'span',
                {
                  'data-fruitback-attach-label': '',
                  id: 'fruitback-composer-attach-label',
                  class: 'fruitback-composer-sr',
                },
              ],
              ['p', { 'data-fruitback-attach-none': '', class: 'fruitback-composer-attach-none', hidden: '' }],
              ['ul', { 'data-fruitback-attach-list': '', class: 'fruitback-composer-files', hidden: '' }],
            ],
          ],
          [
            'div',
            { 'data-fruitback-tools': '', class: 'fruitback-composer-tools' },
            [
              [
                'label',
                {
                  'data-fruitback-picture-label': '',
                  class: 'fruitback-composer-tool fruitback-composer-toggle',
                  hidden: '',
                },
                [
                  ['input', { 'data-fruitback-picture': '', type: 'checkbox', name: 'fruitback-picture' }],
                  ['span', { class: 'fruitback-composer-sr' }],
                ],
              ],
              [
                'div',
                { 'data-fruitback-attach-ways': '', class: 'fruitback-composer-attach-ways' },
                [
                  [
                    'button',
                    {
                      type: 'button',
                      'data-fruitback-attach-trigger': '',
                      class: 'fruitback-composer-tool fruitback-composer-attach-trigger',
                      'aria-haspopup': 'menu',
                      'aria-expanded': 'false',
                      'aria-controls': 'fruitback-composer-attach-menu',
                    },
                  ],
                  [
                    'ul',
                    {
                      'data-fruitback-attach-menu': '',
                      id: 'fruitback-composer-attach-menu',
                      class: 'fruitback-composer-attach-menu',
                      role: 'menu',
                      'aria-labelledby': 'fruitback-composer-attach-label',
                      hidden: '',
                    },
                    [
                      [
                        'li',
                        { role: 'none' },
                        [
                          [
                            'button',
                            {
                              type: 'button',
                              role: 'menuitem',
                              tabindex: '-1',
                              'data-fruitback-attach-area': '',
                              class: 'fruitback-composer-attach-item',
                            },
                          ],
                        ],
                      ],
                      [
                        'li',
                        { role: 'none' },
                        [
                          [
                            'button',
                            {
                              type: 'button',
                              role: 'menuitem',
                              tabindex: '-1',
                              'data-fruitback-attach-page': '',
                              class: 'fruitback-composer-attach-item',
                            },
                          ],
                        ],
                      ],
                    ],
                  ],
                  ['button', { type: 'button', 'data-fruitback-attach-file': '', class: 'fruitback-composer-tool' }],
                  [
                    'input',
                    {
                      'data-fruitback-attach-file-input': '',
                      type: 'file',
                      multiple: '',
                      tabindex: '-1',
                      'aria-hidden': 'true',
                      hidden: '',
                    },
                  ],
                ],
              ],
              [
                'button',
                {
                  type: 'button',
                  'data-fruitback-avatar': 'guest',
                  class: 'fruitback-composer-avatar',
                  'aria-expanded': 'false',
                },
              ],
            ],
          ],
        ],
      ],
      [
        'div',
        { 'data-fruitback-who': '', id: 'fruitback-composer-who', class: 'fruitback-composer-who', hidden: '' },
        [
          [
            'label',
            { class: 'fruitback-composer-field' },
            [
              ['span', { 'data-fruitback-name-label': '', class: 'fruitback-composer-label' }],
              ['input', { 'data-fruitback-name': '', type: 'text', name: 'fruitback-name', autocomplete: 'name' }],
            ],
          ],
          [
            'label',
            { 'data-fruitback-remember-label': '', class: 'fruitback-composer-check fruitback-composer-remember' },
            [
              ['input', { 'data-fruitback-remember': '', type: 'checkbox', name: 'fruitback-remember' }],
              ['span', {}],
            ],
          ],
        ],
      ],
      [
        'div',
        { 'data-fruitback-destinations': '', class: 'fruitback-composer-places', role: 'radiogroup', hidden: '' },
      ],
      [
        'div',
        {
          'data-fruitback-destination-gone': '',
          class: 'fruitback-composer-notice',
          role: 'status',
          'aria-live': 'polite',
        },
      ],
    ],
  ],
  // Why « Send » waits for a sign-in (FRU-609): above the foot, where a failure says why.
  ['p', { 'data-fruitback-sign-needed': '', class: 'fruitback-composer-sign-needed', role: 'status', hidden: '' }],
  [
    'div',
    { 'data-fruitback-failed': '', class: 'fruitback-composer-failed', role: 'alert', hidden: '' },
    [
      ['p', { 'data-fruitback-failed-title': '', class: 'fruitback-composer-failed-title' }],
      ['p', { 'data-fruitback-failed-text': '', class: 'fruitback-composer-failed-text' }],
    ],
  ],
  [
    'div',
    { 'data-fruitback-sent': '', class: 'fruitback-composer-sent', tabindex: '-1', hidden: '' },
    [
      ['span', { 'data-fruitback-sent-drop': '', class: 'fruitback-composer-sent-drop', 'aria-hidden': 'true' }],
      [
        'div',
        { class: 'fruitback-composer-sent-words' },
        [
          ['p', { 'data-fruitback-sent-title': '', class: 'fruitback-composer-sent-title', role: 'status' }],
          ['p', { 'data-fruitback-sent-text': '', class: 'fruitback-composer-sent-text' }],
        ],
      ],
      [
        'a',
        {
          'data-fruitback-sent-open': '',
          class: 'fruitback-composer-sent-open',
          target: '_blank',
          rel: 'noreferrer noopener',
          hidden: '',
        },
      ],
    ],
  ],
  [
    'form',
    {
      'data-fruitback-notify': '',
      class: 'fruitback-composer-notify',
      'aria-labelledby': 'fruitback-notify-title',
      novalidate: '',
      hidden: '',
    },
    [
      [
        'p',
        { 'data-fruitback-notify-title': '', id: 'fruitback-notify-title', class: 'fruitback-composer-notify-title' },
      ],
      [
        'label',
        { class: 'fruitback-composer-notify-field' },
        [
          ['span', { 'data-fruitback-notify-label': '', class: 'fruitback-composer-notify-label' }],
          [
            'input',
            {
              'data-fruitback-notify-email': '',
              type: 'email',
              name: 'email',
              autocomplete: 'email',
              inputmode: 'email',
              maxlength: '254',
              spellcheck: 'false',
              'aria-describedby': 'fruitback-notify-why fruitback-notify-error',
            },
          ],
        ],
      ],
      ['p', { 'data-fruitback-notify-why': '', id: 'fruitback-notify-why', class: 'fruitback-composer-notify-why' }],
      [
        'p',
        {
          'data-fruitback-notify-error': '',
          id: 'fruitback-notify-error',
          class: 'fruitback-composer-notify-error',
          role: 'alert',
        },
      ],
      [
        'div',
        { class: 'fruitback-composer-notify-actions' },
        [
          ['button', { type: 'button', 'data-fruitback-notify-no': '', class: 'fruitback-composer-ghost' }],
          ['button', { type: 'submit', 'data-fruitback-notify-yes': '', class: 'fruitback-composer-notify-yes' }],
        ],
      ],
    ],
  ],
  [
    'p',
    {
      'data-fruitback-notify-done': '',
      class: 'fruitback-composer-notify-done',
      role: 'status',
      tabindex: '-1',
      hidden: '',
    },
  ],
  [
    'div',
    { class: 'fruitback-composer-foot' },
    [
      [
        'span',
        { 'data-fruitback-status': '', class: 'fruitback-composer-status', role: 'status', 'aria-live': 'polite' },
      ],
      ['span', { 'data-fruitback-lands': '', class: 'fruitback-composer-lands' }],
      [
        'button',
        {
          type: 'button',
          'data-fruitback-destination': '',
          class: 'fruitback-composer-destination',
          'aria-expanded': 'false',
          hidden: '',
        },
      ],
      [
        'button',
        {
          type: 'button',
          'data-fruitback-sign-in': '',
          class: 'fruitback-composer-ghost fruitback-composer-sign-in',
          hidden: '',
        },
      ],
      ['button', { type: 'button', 'data-fruitback-cancel': '', class: 'fruitback-composer-ghost' }],
      // « Add to batch », an icon with the count of the notes waiting (FRU-608).
      [
        'button',
        {
          type: 'button',
          'data-fruitback-keep': '',
          class: 'fruitback-composer-tool fruitback-composer-keep',
          hidden: '',
        },
      ],
      [
        'span',
        { class: 'fruitback-composer-send-group' },
        [
          ['button', { type: 'button', 'data-fruitback-send': '', class: 'fruitback-composer-send' }],
          [
            'button',
            {
              type: 'button',
              'data-fruitback-send-more': '',
              class: 'fruitback-composer-send fruitback-composer-send-more',
              'aria-haspopup': 'menu',
              'aria-expanded': 'false',
              'aria-controls': 'fruitback-composer-send-menu',
              hidden: '',
            },
          ],
          [
            'ul',
            {
              'data-fruitback-send-menu': '',
              id: 'fruitback-composer-send-menu',
              class: 'fruitback-composer-attach-menu fruitback-composer-send-menu',
              role: 'menu',
              hidden: '',
            },
            [
              [
                'li',
                { role: 'none' },
                [
                  [
                    'button',
                    {
                      type: 'button',
                      role: 'menuitem',
                      tabindex: '-1',
                      'data-fruitback-send-all': '',
                      class: 'fruitback-composer-attach-item',
                    },
                  ],
                ],
              ],
              [
                'li',
                { role: 'none' },
                [
                  [
                    'button',
                    {
                      type: 'button',
                      role: 'menuitem',
                      tabindex: '-1',
                      'data-fruitback-send-only': '',
                      class: 'fruitback-composer-attach-item',
                    },
                  ],
                ],
              ],
            ],
          ],
        ],
      ],
    ],
  ],
  // The capture of the element, whole (FRU-609), over the composer.
  [
    'div',
    { 'data-fruitback-lightbox': '', class: 'fruitback-composer-lightbox', role: 'dialog', tabindex: '-1', hidden: '' },
  ],
  // The receipt of a batch (FRU-608): it takes the place of the composer, like the card of a sent note.
  [
    'div',
    { 'data-fruitback-receipt': '', class: 'fruitback-composer-receipt', tabindex: '-1', hidden: '' },
    [
      ['p', { 'data-fruitback-receipt-title': '', class: 'fruitback-composer-receipt-title', role: 'status' }],
      ['p', { 'data-fruitback-receipt-to': '', class: 'fruitback-composer-receipt-to' }],
      [
        'div',
        {
          'data-fruitback-receipt-region': '',
          class: 'fruitback-composer-receipt-region',
          role: 'region',
          tabindex: '0',
        },
        [['ul', { 'data-fruitback-receipt-list': '', class: 'fruitback-composer-receipt-list' }]],
      ],
      [
        'p',
        {
          'data-fruitback-receipt-status': '',
          class: 'fruitback-composer-receipt-status',
          role: 'status',
          'aria-live': 'polite',
        },
      ],
      [
        'div',
        { class: 'fruitback-composer-receipt-actions' },
        [
          [
            'button',
            { type: 'button', 'data-fruitback-receipt-all': '', class: 'fruitback-composer-ghost', hidden: '' },
          ],
          [
            'button',
            { type: 'button', 'data-fruitback-receipt-retry': '', class: 'fruitback-composer-ghost', hidden: '' },
          ],
          ['button', { type: 'button', 'data-fruitback-receipt-close': '', class: 'fruitback-composer-send' }],
        ],
      ],
    ],
  ],
];

/**
 * The images of a paste (FRU-424): a screenshot of the system (⌘⇧4, Win+⇧+S), then ⌘V or Ctrl+V.
 * A paste that carries text is a paste of text, even with an image beside it: Word and Pages put a
 * picture of the copied words on the clipboard too, and the person meant the words.
 */
export function pastedImages(data: DataTransfer | null): File[] {
  if (data === null || [...data.types].includes('text/plain')) return [];

  return [...data.files].filter((file) => file.type.startsWith('image/'));
}

/** The keys that paste, as the person reads them on their system. */
function pasteKeys(document: Document): string {
  const agent = document.defaultView?.navigator.userAgent ?? '';

  return /Mac|iPhone|iPad/.test(agent) ? '⌘V' : 'Ctrl+V';
}
