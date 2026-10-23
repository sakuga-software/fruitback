import { MAX_ATTACHMENTS_PER_NOTE, type SeedReporter } from '@fruitback/shared';
import type { Destination } from './destinations.ts';
import { deepActiveElement, holdFocus } from './focus.ts';
import { createIcon } from './icons.ts';
import { type MessageKey, type Translator, createTranslator, languageOf } from './messages.ts';
import {
  type AttachOffer,
  type AttachRefusal,
  type PickedFile,
  readPicked,
  readableSize,
  refusalBefore,
} from './attachments.ts';

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

export type ComposerState = 'idle' | 'sending' | 'sent' | 'kept' | 'failed';

/** Sent, without the picture the reporter asked for (FRU-238). */
export type SentWithoutPicture = { picture: 'missed' };

/**
 * Sent, and what the worker gave back for it (FRU-305): the identifier in the store, its address when
 * the reader may open it, and the number of its new pin. The card of a sent note shows them.
 */
export type SentAs = {
  sentAs: { identifier?: string | undefined; url?: string | undefined; number?: number | undefined };
  picture?: 'missed';
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
    reporter?: SeedReporter,
    destination?: string,
    /** The ids in transit of the files of the note (FRU-332), in their order. Empty: none. */
    attachments?: readonly string[],
  ) => Promise<boolean | void | SendFailure | SentWithoutPicture | SentAs>;
  onClose?: () => void;
  /**
   * « Pick again » in the head (FRU-305): the host starts a capture over the open composer, which
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
   * Keep the note for later rather than send it (FRU-124). A second action beside « Send », shown
   * at each open while `offered()` says so. « Send » keeps its meaning. Left out: no such action.
   */
  keep?: {
    offered(): boolean;
    onKeep: (
      note: string,
      reporter?: SeedReporter,
      destination?: string,
    ) => Promise<true | SendFailure | SentWithoutPicture>;
  };
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
  capture(kind: 'page' | 'area'): Promise<PickedFile | 'cancelled' | undefined>;
  /** Sends one file on its way. Its id is what the note names. */
  upload(
    file: PickedFile,
    destination: string | undefined,
  ): Promise<{ ok: true; id: string } | { ok: false; refusal: AttachRefusal }>;
};

/** A file of the note in the composer, from the moment it is joined. */
type Held = {
  key: number;
  name: string;
  size: number;
  state: 'sending' | 'ready' | 'refused';
  id?: string;
  refusal?: AttachRefusal;
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

export type Composer = {
  /**
   * `about` is what the note points at, written in the head in mono (FRU-305):
   * « button.add · <AddToCart> ». `name` is what a person reads for the element (FRU-258): the head
   * gives it as its title, for the eye that does not read selectors. Either can be left out.
   */
  open(anchor: { left: number; top: number; bottom: number; right: number }, about?: string, name?: string): void;
  close(): void;
  state(): ComposerState;
  /**
   * The answer of `identified` may be another one now. A closed composer takes it at once. An open
   * one takes it at its next open: a field must not leave under somebody who types in it.
   */
  identityChanged(): void;
  /** The popover's own root, for tests and for whoever needs to measure it. */
  element: HTMLElement;
  destroy(): void;
};

export function createComposer(options: ComposerOptions): Composer {
  const document = options.document ?? globalThis.document;
  const view = document.defaultView;
  const t = options.translator ?? createTranslator({ language: languageOf(document) });

  const style = document.createElement('style');
  style.textContent = STYLES;

  const root = document.createElement('div');
  root.className = 'fruitback-composer';
  root.dataset.fruitbackComposer = '';
  root.hidden = true;
  // Built element by element, never parsed from a string (FRU-389): see `TEMPLATE`.
  root.append(...TEMPLATE.map((markup) => build(document, markup)));
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', t.text('composer.dialog'));

  options.host.append(style, root);
  const focus = holdFocus(root, close);

  const field = root.querySelector('[data-fruitback-note]') as HTMLTextAreaElement;
  const send = root.querySelector('[data-fruitback-send]') as HTMLButtonElement;
  // The drop of the mark and the word, as the mock-up of 2026-10-20 draws it (FRU-305). The drop is
  // appended after the template is built: an SVG made by `createElement` is in the HTML namespace and
  // renders nothing (FRU-36).
  const sendWord = document.createElement('span');
  sendWord.textContent = t.text('composer.send');
  send.append(createIcon(document, 'mark'), sendWord);
  const about = root.querySelector('[data-fruitback-about]') as HTMLElement;
  const pick = root.querySelector('[data-fruitback-pick]') as HTMLButtonElement;
  const noteLabel = root.querySelector('[data-fruitback-note-label]') as HTMLElement;
  const nameLabel = root.querySelector('[data-fruitback-name-label]') as HTMLElement;
  const lands = root.querySelector('[data-fruitback-lands]') as HTMLElement;
  const failedCard = root.querySelector('[data-fruitback-failed]') as HTMLElement;
  const failedTitle = root.querySelector('[data-fruitback-failed-title]') as HTMLElement;
  const failedText = root.querySelector('[data-fruitback-failed-text]') as HTMLElement;
  const sentCard = root.querySelector('[data-fruitback-sent]') as HTMLElement;
  const sentDrop = root.querySelector('[data-fruitback-sent-drop]') as HTMLElement;
  const sentTitle = root.querySelector('[data-fruitback-sent-title]') as HTMLElement;
  const sentText = root.querySelector('[data-fruitback-sent-text]') as HTMLElement;
  const sentOpen = root.querySelector('[data-fruitback-sent-open]') as HTMLAnchorElement;
  const pictureLabel = root.querySelector('[data-fruitback-picture-label]') as HTMLLabelElement;
  const picture = root.querySelector('[data-fruitback-picture]') as HTMLInputElement;
  const cancel = root.querySelector('[data-fruitback-cancel]') as HTMLButtonElement;
  const keep = root.querySelector('[data-fruitback-keep]') as HTMLButtonElement;
  const signIn = root.querySelector('[data-fruitback-sign-in]') as HTMLButtonElement;
  const status = root.querySelector('[data-fruitback-status]') as HTMLElement;
  const who = root.querySelector('[data-fruitback-who]') as HTMLElement;
  const name = root.querySelector('[data-fruitback-name]') as HTMLInputElement;
  const rememberLabel = root.querySelector('[data-fruitback-remember-label]') as HTMLLabelElement;
  const remember = root.querySelector('[data-fruitback-remember]') as HTMLInputElement;
  const destination = root.querySelector('[data-fruitback-destination]') as HTMLButtonElement;
  const placeList = root.querySelector('[data-fruitback-destinations]') as HTMLElement;
  const gone = root.querySelector('[data-fruitback-destination-gone]') as HTMLElement;
  const attach = root.querySelector('[data-fruitback-attach]') as HTMLElement;
  const attachLabel = root.querySelector('[data-fruitback-attach-label]') as HTMLElement;
  const attachWays = root.querySelector('[data-fruitback-attach-ways]') as HTMLElement;
  const attachTrigger = root.querySelector('[data-fruitback-attach-trigger]') as HTMLButtonElement;
  const attachMenu = root.querySelector('[data-fruitback-attach-menu]') as HTMLElement;
  const attachPage = root.querySelector('[data-fruitback-attach-page]') as HTMLButtonElement;
  const attachArea = root.querySelector('[data-fruitback-attach-area]') as HTMLButtonElement;
  const attachFile = root.querySelector('[data-fruitback-attach-file]') as HTMLButtonElement;
  const attachDrop = root.querySelector('[data-fruitback-attach-drop]') as HTMLButtonElement;
  const dropZone = root.querySelector('[data-fruitback-attach-dropzone]') as HTMLElement;
  const dropWords = root.querySelector('[data-fruitback-attach-dropzone-words]') as HTMLElement;
  const dropChoose = root.querySelector('[data-fruitback-attach-dropzone-choose]') as HTMLButtonElement;
  const fileInput = root.querySelector('[data-fruitback-attach-file-input]') as HTMLInputElement;
  const attachNone = root.querySelector('[data-fruitback-attach-none]') as HTMLElement;
  const attachList = root.querySelector('[data-fruitback-attach-list]') as HTMLElement;
  const seam = options.attachments;
  /** The files of the note being written, in the order they were joined. */
  let held: Held[] = [];
  let heldKeys = 0;
  const memory = options.memory;
  const isIdentified = (): boolean =>
    typeof options.identified === 'function' ? options.identified() : options.identified === true;
  let asksForName = true;
  const choice = options.destinations;

  // Set after the build and never part of TEMPLATE: a host translation is text, not markup.
  field.placeholder = t.text('composer.placeholder');
  // Named by the label the mock-up writes above it, « Your comment » (FRU-305).
  noteLabel.textContent = t.text('composer.label');
  pick.textContent = t.text('composer.pickAgain');
  pick.hidden = options.onPickAgain === undefined;
  (pictureLabel.querySelector('span') as HTMLElement).textContent = t.text('composer.picture');
  name.placeholder = t.text('composer.namePlaceholder');
  nameLabel.textContent = t.text('composer.nameLabel');
  failedTitle.textContent = t.text('composer.failedTitle');
  sentText.textContent = t.text('composer.sentFollows');
  sentOpen.textContent = t.text('composer.sentOpen');
  (rememberLabel.querySelector('span') as HTMLElement).textContent = t.text('composer.remember');
  rememberLabel.hidden = memory === undefined;
  askForNameOrNot();
  cancel.textContent = t.text('composer.cancel');
  keep.textContent = t.text('composer.keep');
  signIn.textContent = t.text('composer.signIn');
  placeList.setAttribute('aria-label', t.text('composer.destinations'));
  attachLabel.textContent = t.text('composer.attach');
  attachTrigger.append(document.createTextNode(t.text('composer.attachMenu')), createIcon(document, 'chevron'));
  attachPage.textContent = t.text('composer.attachPage');
  attachArea.textContent = t.text('composer.attachArea');
  attachFile.textContent = t.text('composer.attachFile');
  attachDrop.textContent = t.text('composer.attachDrop');
  dropWords.textContent = t.text('composer.attachDropHere');
  dropChoose.textContent = t.text('composer.attachDropChoose');
  attachNone.textContent = t.text('composer.attachNoTracker');

  /** Whether « Keep for later » is offered at this open. A note with files is sent, never kept. */
  let keepOffered = false;

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
    (attachPage.parentElement as HTMLElement).hidden = !captures;
    (attachArea.parentElement as HTMLElement).hidden = !captures;
    const full = held.filter((each) => each.state !== 'refused').length >= MAX_FILES;
    for (const way of [attachTrigger, attachPage, attachArea, attachFile, attachDrop, dropChoose])
      way.setAttribute('aria-disabled', String(full));
    if (full || offer !== 'offered') {
      closeAttachMenu(false);
      dropZone.hidden = true;
    }
    keep.hidden = !keepOffered || held.length > 0;

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
        item.append(words, remove);

        return item;
      }),
    );
    if (hadFocus) (attachList.querySelector('button') ?? attachTrigger).focus();
  }

  /** What a line of the list says under the name: why it did not go, or its size. */
  function detailOf(each: Held): string {
    if (each.state === 'refused') return t.text(REFUSALS[each.refusal ?? 'retry']);
    const size = readableSize(each.size, t.locale);

    return each.state === 'sending' ? `${size} · ${t.text('composer.attachSending')}` : size;
  }

  /**
   * Whether a file may still join the note: not while it is sent or after (FRU-351, raised in review).
   * A file dropped, picked or captured then would go to the worker and be named by no note.
   */
  function joinable(): boolean {
    return state !== 'sending' && state !== 'sent' && state !== 'kept';
  }

  /** Joins a file: refused at once when the widget can tell, sent on its way otherwise. */
  function join(file: PickedFile): void {
    if (!joinable()) return;
    const key = (heldKeys += 1);
    const refusal = refusalBefore(
      file,
      held.filter((each) => each.state !== 'refused'),
    );
    if (refusal !== undefined) {
      held = [...held, { key, name: file.name, size: file.size, state: 'refused', refusal }];
      drawAttachments();

      return;
    }
    const mine = session;
    const entry: Held = { key, name: file.name, size: file.size, state: 'sending' };
    entry.sent = (seam?.upload(file, selected) ?? Promise.resolve({ ok: false as const, refusal: 'retry' as const }))
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
    held = [...held, entry];
    drawAttachments();
  }

  /** The ways of the menu that are shown now, in their order. */
  function menuItems(): HTMLButtonElement[] {
    return [attachFile, attachArea, attachPage, attachDrop].filter(
      (item) => !(item.parentElement as HTMLElement).hidden,
    );
  }

  /**
   * « Attach » opens a menu of the ways to join a file (FRU-351): the arrows go from one to the next,
   * Home and End to the ends, Enter or Space takes one, Esc closes it and gives the focus back to
   * « Attach », Tab closes it and goes on.
   */
  function openAttachMenu(focus: 'first' | 'last'): void {
    if (attachTrigger.getAttribute('aria-disabled') === 'true' || attachTrigger.disabled) return;
    attachMenu.hidden = false;
    attachTrigger.setAttribute('aria-expanded', 'true');
    const items = menuItems();
    (focus === 'first' ? items[0] : items[items.length - 1])?.focus();
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
    if (taken === undefined) {
      held = [
        ...held,
        { key: (heldKeys += 1), name: CAPTURE_NAME[kind], size: 0, state: 'refused', refusal: 'capture' },
      ];
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
    send.disabled = next === 'sending' || next === 'sent' || next === 'kept';
    keep.disabled = send.disabled;
    // No way to join a file while the note is sent, or after (FRU-373): no note would name it.
    const settled = next === 'sending' || next === 'sent' || next === 'kept';
    for (const way of [attachTrigger, attachPage, attachArea, attachFile, attachDrop, dropChoose])
      way.disabled = settled;
    if (settled) {
      closeAttachMenu(false);
      dropZone.hidden = true;
    }
    field.readOnly = next === 'sending';
    // A failure is a card of its own above the foot (FRU-305): « Did not go through », then what to
    // do. The sentence is the one of its cause (FRU-156).
    failedText.textContent = next === 'failed' ? t.text(FAILURES[failure]) : '';
    failedCard.hidden = next !== 'failed';
    status.textContent = next === 'idle' || next === 'failed' || next === 'sent' ? '' : t.text(STATUS[next]);
    // The one thing that makes this send work again, beside the sentence that says so (FRU-315).
    signIn.hidden = !(next === 'failed' && failure === 'signed-out' && options.onSignIn !== undefined);
    if (next !== 'sent') sentCard.hidden = true;
  }

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
    try {
      // The files still on their way go first: the note names the ones the worker took. Awaited
      // only then: a note with no file in flight is sent in the same turn, as before FRU-332.
      const inFlight = held.filter((each) => each.state === 'sending').map((each) => each.sent);
      if (inFlight.length > 0) {
        await Promise.all(inFlight);
        if (mine !== session) return;
      }
      const ids = held.flatMap((each) => (each.state === 'ready' && each.id !== undefined ? [each.id] : []));
      const result =
        action === 'keep' && options.keep !== undefined
          ? await options.keep.onKeep(field.value, reporterFromFields(), selected)
          : await options.onSubmit(field.value, reporterFromFields(), selected, ids);
      if (result === false) failure = 'retry';
      else if (typeof result === 'string') failure = result;
      else if (typeof result === 'object' && result !== null) {
        withoutPicture = result.picture === 'missed';
        if ('sentAs' in result) sentAs = result.sentAs;
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
    // The card is read where focus is: on its link when there is one, on the card otherwise.
    if (!sentOpen.hidden) sentOpen.focus();
    else sentCard.focus();
    closing = view?.setTimeout(close, SENT_MS) ?? 0;
  }

  /** The typed name is kept, hidden, and not sent: an identity that ends gives the field back with it. */
  function askForNameOrNot(): void {
    asksForName = !isIdentified();
    // « Name (optional) » is a field of the body (FRU-305), where a link opened it before.
    who.hidden = !asksForName;
  }

  /** The box shows the preference as it is now. It is never ticked by anything but its reporter. */
  function showPicture(): void {
    const offered = options.picture?.offered() === true;
    pictureLabel.hidden = !offered;
    picture.checked = offered && options.picture?.get() === true;
  }

  function open(
    anchor: { left: number; top: number; bottom: number; right: number },
    subject = '',
    readable = '',
  ): void {
    if (closing !== 0) {
      view?.clearTimeout(closing);
      closing = 0;
    }

    // As text: it is whatever the page called its element and its component.
    about.textContent = subject;
    about.title = readable;
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
      field.focus();

      return;
    }

    session += 1;
    const restored = options.autosave?.read() ?? '';
    field.value = restored;
    showPicture();
    askForNameOrNot();
    held = [];
    closeAttachMenu(false);
    dropZone.hidden = true;
    keepOffered = options.keep?.offered() === true;
    showRememberedName();
    // Folded at each open, on the place chosen last. The line says where, and that is enough for
    // the many notes that go where the one before went.
    selected = undefined;
    gone.textContent = '';
    foldPlaces(true);
    drawDestinations();
    drawAttachments();
    setState('idle');
    // Said, and quietly: the person finds the text they left, and knows why it is there.
    if (restored !== '') status.textContent = t.text('composer.restored');
    focus.remember();
    root.hidden = false;
    place(anchor);
    field.focus();
  }

  /**
   * Above the element it belongs to, 40 px over its top, as the mock-up draws it (FRU-258): the frame
   * and the name of the component stay in sight under it. Below when there is no room above, and
   * inside the window when there is room on neither side. Aligned on the start edge of the frame:
   * its left in a left-to-right language, its right otherwise. The value stays a physical left,
   * because it is a position against the page (FRU-38).
   *
   * On a narrow screen the rules below take over entirely and pin it to the bottom of the viewport, so
   * the position set here stops mattering — which is why it is set with `style` and overridden by a media query.
   */
  function place(anchor: { left: number; top: number; bottom: number; right: number }): void {
    const width = view?.innerWidth ?? 0;
    const height = view?.innerHeight ?? 0;
    const scrollX = view?.scrollX ?? 0;
    const scrollY = view?.scrollY ?? 0;
    const own = root.getBoundingClientRect();
    const above = anchor.top - RISE - own.height;
    const below = anchor.bottom + FRAME + GAP;
    const fitsAbove = above >= scrollY + GAP;
    const fitsBelow = below + own.height <= scrollY + height;
    const start = t.direction === 'rtl' ? anchor.right + FRAME - WIDTH : anchor.left - FRAME;
    // With room on neither side it stays under the element, as far down as the window lets it.
    const under = fitsBelow ? below : Math.max(scrollY + GAP, scrollY + height - own.height - GAP);
    const top = fitsAbove ? above : under;

    // Where it grows from: the corner nearest to its element.
    root.dataset.fruitbackSide = fitsAbove ? 'above' : 'below';
    // Custom properties rather than inline `left`/`top`: an inline style would beat the media query
    // below and leave the mobile sheet offset by whatever the element's position happened to be.
    // `start` is in document coordinates, so the window it must stay inside starts at `scrollX` (FRU-68).
    root.style.setProperty(
      '--fruitback-composer-left',
      `${Math.max(scrollX + GAP, Math.min(start, scrollX + width - WIDTH - GAP))}px`,
    );
    root.style.setProperty('--fruitback-composer-top', `${top}px`);
  }

  /**
   * What the visitor said about themselves, or nothing at all.
   *
   * Anonymous is the default and stays one click away: the field is behind a disclosure, empty, and
   * an empty one is absent rather than an empty string — the seed round-trip forbids a field nobody
   * provided. One field, and no e-mail (FRU-91): an address is not needed to read a note.
   */
  function reporterFromFields(): SeedReporter | undefined {
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
    destination.textContent =
      place === undefined ? '' : t.text('composer.destination', { destination: nameOf(place, index) });
    // The foot says where the note lands (FRU-305): the one place a member sees, or « to the team ».
    // With several places, the line of the body above says it and lets them choose.
    const only = places.length === 1 ? places[0] : undefined;
    lands.hidden = places.length >= 2;
    lands.textContent =
      only === undefined ? t.text('composer.landsTeam') : t.text('composer.lands', { destination: nameOf(only, 0) });
  }

  const checkedPlace = () => placeList.querySelector('input:checked') as HTMLInputElement | null;

  function close(): void {
    if (closing !== 0) {
      view?.clearTimeout(closing);
      closing = 0;
    }
    session += 1;
    root.hidden = true;
    setState('idle');
    focus.restore();
    options.onClose?.();
  }

  // A click anywhere else closes the card of a sent note at once (FRU-305).
  function onDocumentClick(event: Event): void {
    if (root.hidden || state !== 'sent') return;
    if (event.composedPath().includes(root)) return;
    close();
  }
  document.addEventListener('click', onDocumentClick, true);

  pick.addEventListener('click', () => options.onPickAgain?.());

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
  const stopFollowingOffer = seam?.subscribe(drawAttachments);
  attachPage.addEventListener('click', () => void capture('page', attachTrigger));
  attachArea.addEventListener('click', () => void capture('area', attachTrigger));
  attachDrop.addEventListener('click', () => {
    if (attachDrop.getAttribute('aria-disabled') === 'true') return;
    closeAttachMenu(false);
    dropZone.hidden = false;
    dropZone.focus();
  });
  dropChoose.addEventListener('click', () => {
    if (dropChoose.getAttribute('aria-disabled') !== 'true') fileInput.click();
  });
  dropZone.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    dropZone.hidden = true;
    attachTrigger.focus();
  });
  for (const type of ['dragenter', 'dragover'] as const) {
    dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      dropZone.toggleAttribute('data-fruitback-dragging', true);
    });
  }
  dropZone.addEventListener('dragleave', () => dropZone.toggleAttribute('data-fruitback-dragging', false));
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropZone.toggleAttribute('data-fruitback-dragging', false);
    if (dropZone.getAttribute('aria-disabled') === 'true') return;
    const files = [...((event as DragEvent).dataTransfer?.files ?? [])];
    if (files.length === 0) return;
    dropZone.hidden = true;
    void joinFiles(files, session).then(() => attachTrigger.focus());
  });
  attachTrigger.addEventListener('click', () => {
    if (attachMenu.hidden) openAttachMenu('first');
    else closeAttachMenu(true);
  });
  attachTrigger.addEventListener('keydown', (event) => {
    const key = (event as KeyboardEvent).key;
    if (key !== 'ArrowDown' && key !== 'ArrowUp') return;
    event.preventDefault();
    openAttachMenu(key === 'ArrowDown' ? 'first' : 'last');
  });
  attachMenu.addEventListener('keydown', (event) => {
    const key = (event as KeyboardEvent).key;
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
    closeAttachMenu(true);
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
    const button = (event.target as Element).closest?.('[data-fruitback-file-remove]') as HTMLElement | null;
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

  send.addEventListener('click', () => void submit());
  keep.addEventListener('click', () => void submit('keep'));
  signIn.addEventListener('click', () => options.onSignIn?.());
  cancel.addEventListener('click', close);
  // Each change is saved (FRU-311): a reload, Esc, « Cancel » or the cross no longer loses it. The
  // sentence « Draft restored » has done its job once the person types.
  field.addEventListener('input', () => {
    options.autosave?.write(field.value);
    if (state === 'idle') status.textContent = '';
  });
  field.addEventListener('keydown', (event) => {
    const key = event as KeyboardEvent;
    // ⌘/Ctrl+Enter sends, because a plain Enter belongs to the note.
    if (key.key === 'Enter' && (key.metaKey || key.ctrlKey)) void submit();
  });

  setState('idle');

  return {
    open,
    close,
    state: () => state,
    identityChanged() {
      if (root.hidden) askForNameOrNot();
    },
    element: root,
    destroy() {
      if (closing !== 0) view?.clearTimeout(closing);
      document.removeEventListener('click', onDocumentClick, true);
      document.removeEventListener('click', onMenuOutside, true);
      focus.destroy();
      stopFollowingPlaces?.();
      stopFollowingOffer?.();
      stopFollowingPicture?.();
      root.remove();
      style.remove();
    },
  };
}

/** The measures of the mock-up (FRU-258), kept next to the stylesheet that `place` must agree with. */
const WIDTH = 360;
const GAP = 10;
/**
 * How far above the top of its element the composer ends, and how far the frame stands off the element:
 * a line of 2 px, 3 px off (FRU-303).
 */
const RISE = 40;
const FRAME = 5;

const STATUS = {
  sending: 'composer.sending',
  sent: 'composer.sent',
  kept: 'composer.kept',
} as const satisfies Record<Exclude<ComposerState, 'idle' | 'failed'>, MessageKey>;

/**
 * The sentence of a failed send, for another part of the widget that sends: the list of drafts
 * (FRU-124). It has no title above it, so a send to try again says it all in one sentence.
 */
export function failureText(t: Translator, failure: SendFailure): string {
  return t.text(failure === 'retry' ? 'composer.failed' : FAILURES[failure]);
}

/** What a failed send says under « Did not go through », by its cause (FRU-156, FRU-305). */
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
      [
        'label',
        { class: 'fruitback-composer-field' },
        [
          ['span', { 'data-fruitback-note-label': '', class: 'fruitback-composer-label' }],
          ['textarea', { 'data-fruitback-note': '', rows: '4' }],
        ],
      ],
      [
        'div',
        { 'data-fruitback-who': '', class: 'fruitback-composer-who' },
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
        'label',
        { 'data-fruitback-picture-label': '', class: 'fruitback-composer-check', hidden: '' },
        [
          ['input', { 'data-fruitback-picture': '', type: 'checkbox', name: 'fruitback-picture' }],
          ['span', {}],
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
              class: 'fruitback-composer-label',
            },
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
                  class: 'fruitback-composer-attach-way fruitback-composer-attach-trigger',
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
                          'data-fruitback-attach-file': '',
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
                          'data-fruitback-attach-drop': '',
                          class: 'fruitback-composer-attach-item',
                        },
                      ],
                    ],
                  ],
                ],
              ],
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
            'div',
            {
              'data-fruitback-attach-dropzone': '',
              class: 'fruitback-composer-dropzone',
              tabindex: '-1',
              role: 'group',
              'aria-labelledby': 'fruitback-composer-dropzone-words',
              hidden: '',
            },
            [
              [
                'p',
                {
                  'data-fruitback-attach-dropzone-words': '',
                  id: 'fruitback-composer-dropzone-words',
                  class: 'fruitback-composer-dropzone-words',
                },
              ],
              [
                'button',
                { type: 'button', 'data-fruitback-attach-dropzone-choose': '', class: 'fruitback-composer-attach-way' },
              ],
            ],
          ],
          ['p', { 'data-fruitback-attach-none': '', class: 'fruitback-composer-attach-none', hidden: '' }],
          ['ul', { 'data-fruitback-attach-list': '', class: 'fruitback-composer-files', hidden: '' }],
        ],
      ],
      [
        'button',
        {
          type: 'button',
          'data-fruitback-destination': '',
          class: 'fruitback-composer-identify',
          'aria-expanded': 'false',
          hidden: '',
        },
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
          'data-fruitback-sign-in': '',
          class: 'fruitback-composer-ghost fruitback-composer-sign-in',
          hidden: '',
        },
      ],
      [
        'button',
        {
          type: 'button',
          'data-fruitback-keep': '',
          class: 'fruitback-composer-ghost fruitback-composer-keep',
          hidden: '',
        },
      ],
      ['button', { type: 'button', 'data-fruitback-cancel': '', class: 'fruitback-composer-ghost' }],
      ['button', { type: 'button', 'data-fruitback-send': '', class: 'fruitback-composer-send' }],
    ],
  ],
];

/**
 * The composer of the mock-up of 2026-10-13 (FRU-258): a head, the note, a foot behind a rule.
 * `prefers-reduced-motion` turns the animation off rather than shortening it — a widget that
 * overlays someone else's site is the last thing that should ignore that setting.
 */
const STYLES = `
.fruitback-composer {
  position: absolute;
  border: 1px solid var(--fruitback-color-border);
  /* WIDTH is what place() clamps against, so the rendered box has to be exactly that. Set here
     rather than inherited from the host's reset: this file has to hold up wherever it is mounted. */
  box-sizing: border-box;
  left: var(--fruitback-composer-left, 0px);
  top: var(--fruitback-composer-top, 0px);
  z-index: 2147483300;
  width: ${WIDTH}px;
  border-radius: var(--fruitback-radius-lg);
  background: var(--fruitback-color-surface);
  color: var(--fruitback-color-text);
  font: 14px/1.5 var(--fruitback-font-sans);
  box-shadow: var(--fruitback-shadow-xl);
  /* The curve and the time of the mock-up (FRU-233): it arrives fast and settles, with no overshoot.
     It grows from the corner nearest to its element. */
  animation: fruitback-composer-in var(--fruitback-duration-slow) var(--fruitback-ease-out) both;
  transform-origin: bottom left;
}
.fruitback-composer:dir(rtl) { transform-origin: bottom right; }
.fruitback-composer[data-fruitback-side="below"] { animation-name: fruitback-composer-down; transform-origin: top left; }
.fruitback-composer[data-fruitback-side="below"]:dir(rtl) { transform-origin: top right; }
.fruitback-composer[hidden] { display: none; }
/* A shadow is not drawn in forced colours: the composer then needs an edge of its own. */
@media (forced-colors: active) {
  .fruitback-composer { outline: 1px solid CanvasText; }
}
.fruitback-composer-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-block: 12px;
  padding-inline: 14px 12px;
  border-bottom: 1px solid var(--fruitback-color-border);
  border-start-start-radius: var(--fruitback-radius-lg);
  border-start-end-radius: var(--fruitback-radius-lg);
  background: var(--fruitback-color-surface-warm);
}
/* The drop of a new note, in the colour of « new »: the pin this note will be. */
.fruitback-composer-drop {
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 50% 50% 50% 0;
  transform: rotate(-45deg);
  background: var(--fruitback-stage-new);
  box-shadow: 0 0 0 1px var(--fruitback-color-stage-edge);
}
/* What the note points at, in the mono of a selector, on one line. */
.fruitback-composer-about {
  flex: 1;
  min-width: 0;
  font: 12px/1.5 var(--fruitback-font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* « Pick again »: a word in a chip, 44 px to press, the margins give the difference back to the head. */
.fruitback-composer-pick {
  flex: none;
  margin-block: -9px;
  padding: 4px 6px;
  border: 9px solid transparent;
  border-inline-width: 0;
  border-radius: var(--fruitback-radius-sm);
  background: transparent;
  color: var(--fruitback-color-text-muted);
  font: 600 12px/1.5 var(--fruitback-font-sans);
  cursor: pointer;
}
.fruitback-composer-pick:hover { background: var(--fruitback-color-surface-sunken) padding-box; color: var(--fruitback-color-text); }
.fruitback-composer-pick[hidden] { display: none; }
.fruitback-composer-body { display: flex; flex-direction: column; gap: 12px; padding: 14px; }
/* A label above its field, as the mock-up writes « Your comment » and « Name (optional) ». */
.fruitback-composer-field { display: flex; flex-direction: column; gap: 6px; }
.fruitback-composer-label { font-size: 12px; color: var(--fruitback-color-text-muted); }
.fruitback-composer textarea {
  display: block;
  width: 100%;
  min-height: 96px;
  border: 1px solid var(--fruitback-color-border-strong);
  border-radius: var(--fruitback-radius-sm);
  padding: 10px 12px;
  font: 14px/1.5 var(--fruitback-font-sans);
  resize: vertical;
  background: var(--fruitback-color-surface);
  color: inherit;
  caret-color: var(--fruitback-color-accent);
}
.fruitback-composer textarea:focus-visible { outline: 2px solid var(--fruitback-color-accent); outline-offset: 2px; }
.fruitback-composer-identify {
  display: block;
  border: 0;
  background: none;
  padding: 0;
  color: var(--fruitback-color-text-muted);
  font: inherit;
  font-size: 12px;
  text-decoration: underline;
  cursor: pointer;
}
.fruitback-composer-who { display: flex; flex-direction: column; gap: 8px; }
.fruitback-composer-who[hidden] { display: none; }
.fruitback-composer-identify[hidden] { display: none; }
/* A box and its words: the picture, and the name to remember. */
.fruitback-composer-check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  cursor: pointer;
}
.fruitback-composer-remember { color: var(--fruitback-color-text-muted); }
.fruitback-composer-check[hidden] { display: none; }
.fruitback-composer-check input, .fruitback-composer-place input {
  /* The reset of the host sets appearance to none, and a native box then draws nothing. */
  appearance: auto;
  -webkit-appearance: checkbox;
  flex: none;
  width: 16px;
  height: 16px;
  margin: 0;
  /* The accent of the widget, as the mock-up ticks the box (FRU-305). */
  accent-color: var(--fruitback-color-accent);
  cursor: pointer;
}
/* The files of the note (FRU-332): the ways to join one, then the list, each with its remove button. */
.fruitback-composer-attach { display: flex; flex-direction: column; gap: 6px; }
.fruitback-composer-attach[hidden], .fruitback-composer-attach-ways[hidden], .fruitback-composer-files[hidden],
.fruitback-composer-attach-way[hidden], .fruitback-composer-attach-none[hidden] { display: none; }
.fruitback-composer-attach-ways { display: flex; flex-wrap: wrap; gap: 6px; }
/* The inputs of the disk are opened by their buttons: the reset of a host can show them, so they are hidden here. */
.fruitback-composer-attach input[type="file"] { display: none; }
.fruitback-composer-attach-way {
  min-height: 32px;
  padding: 0 10px;
  border: 1px solid var(--fruitback-color-border-strong);
  border-radius: var(--fruitback-radius-pill);
  background: var(--fruitback-color-surface);
  color: var(--fruitback-color-text);
  font: 600 12px/1 var(--fruitback-font-sans);
  cursor: pointer;
}
.fruitback-composer-attach-way:hover:not([disabled]):not([aria-disabled="true"]) { background: var(--fruitback-color-surface-sunken); }
.fruitback-composer-attach-way:focus-visible { outline: 2px solid var(--fruitback-color-accent); outline-offset: 2px; }
.fruitback-composer-attach-way[disabled], .fruitback-composer-attach-way[aria-disabled="true"] { opacity: 0.55; cursor: default; }
.fruitback-composer-attach-none { margin: 0; font-size: 12px; color: var(--fruitback-color-text-muted); }
/*
  « Attach » and its menu (FRU-351). The menu opens under the button in the flow of the composer, not
  over it: on a phone the composer is a sheet, and a menu laid over it was cut by its foot.
*/
.fruitback-composer-attach-ways { flex-direction: column; align-items: flex-start; }
.fruitback-composer-attach-trigger { display: inline-flex; align-items: center; gap: 4px; }
.fruitback-composer-attach-trigger .fruitback-icon { width: 14px; height: 14px; }
.fruitback-composer-attach-trigger[aria-expanded="true"] .fruitback-icon { transform: rotate(180deg); }
.fruitback-composer-attach-menu {
  box-sizing: border-box;
  min-width: 220px;
  max-width: 100%;
  margin: 0;
  padding: 4px;
  list-style: none;
  border: 1px solid var(--fruitback-color-border);
  border-radius: var(--fruitback-radius-sm);
  background: var(--fruitback-color-surface);
  box-shadow: var(--fruitback-shadow-xl);
}
.fruitback-composer-attach-menu li { display: block; list-style: none; margin: 0; padding: 0; }
.fruitback-composer-attach-menu[hidden], .fruitback-composer-attach-menu li[hidden], .fruitback-composer-dropzone[hidden] { display: none; }
.fruitback-composer-attach-item {
  display: block;
  width: 100%;
  min-height: 36px;
  padding: 6px 10px;
  border: 0;
  border-radius: var(--fruitback-radius-sm);
  background: transparent;
  color: var(--fruitback-color-text);
  font: 500 13px/1.3 var(--fruitback-font-sans);
  text-align: start;
  cursor: pointer;
}
.fruitback-composer-attach-item:hover:not([aria-disabled="true"]), .fruitback-composer-attach-item:focus-visible { background: var(--fruitback-color-surface-sunken); }
.fruitback-composer-attach-item:focus-visible { outline: 2px solid var(--fruitback-color-accent); outline-offset: -2px; }
.fruitback-composer-attach-item[aria-disabled="true"] { opacity: 0.55; cursor: default; }
.fruitback-composer-dropzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 16px;
  border: 2px dashed var(--fruitback-color-border-strong);
  border-radius: var(--fruitback-radius-sm);
  background: var(--fruitback-color-surface-sunken);
  text-align: center;
}
.fruitback-composer-dropzone:focus-visible { outline: 2px solid var(--fruitback-color-accent); outline-offset: 2px; }
.fruitback-composer-dropzone[data-fruitback-dragging] { border-color: var(--fruitback-color-accent); }
.fruitback-composer-dropzone-words { margin: 0; font-size: 13px; color: var(--fruitback-color-text-muted); }
.fruitback-composer-files { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.fruitback-composer-file {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-block: 4px;
  padding-inline: 10px 4px;
  border: 1px solid var(--fruitback-color-border);
  border-radius: var(--fruitback-radius-sm);
  background: var(--fruitback-color-surface-sunken);
}
.fruitback-composer-file-words { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.fruitback-composer-file-name { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fruitback-composer-file-detail { font-size: 11px; color: var(--fruitback-color-text-muted); }
.fruitback-composer-file[data-fruitback-file="refused"] .fruitback-composer-file-detail { color: var(--fruitback-color-accent-strong); }
.fruitback-composer-file-remove {
  flex: none;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: var(--fruitback-radius-sm);
  background: transparent;
  color: var(--fruitback-color-text-muted);
  cursor: pointer;
}
.fruitback-composer-file-remove .fruitback-icon { width: 12px; height: 12px; }
.fruitback-composer-file-remove:hover { background: var(--fruitback-color-surface); color: var(--fruitback-color-text); }
.fruitback-composer-file-remove:focus-visible { outline: 2px solid var(--fruitback-color-accent); outline-offset: 1px; }
/* Where the note goes, when there are several places (FRU-123). */
.fruitback-composer-places { display: flex; flex-direction: column; gap: 6px; }
.fruitback-composer-places[hidden] { display: none; }
.fruitback-composer-place {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--fruitback-color-text-muted);
  cursor: pointer;
}
.fruitback-composer-place input { -webkit-appearance: radio; }
/* A name comes from a tracker and can be one long word. */
.fruitback-composer-place span, .fruitback-composer-identify { overflow-wrap: anywhere; }
/* A button that holds a name: its words wrap, against the rule of the labels (FRU-350). */
.fruitback-composer-identify { text-align: start; white-space: normal; }
/* Always in the tree, because a live region that was hidden announces nothing. Empty, it takes no room. */
.fruitback-composer-notice { font-size: 12px; color: var(--fruitback-color-accent); }
.fruitback-composer-notice:empty { display: none; }
.fruitback-composer-who input[type="text"] {
  min-width: 0;
  height: 36px;
  padding: 0 10px;
  border: 1px solid var(--fruitback-color-border-strong);
  border-radius: var(--fruitback-radius-sm);
  font: 13px/1.4 var(--fruitback-font-sans);
  color: inherit;
  background: var(--fruitback-color-surface);
}
.fruitback-composer-who input[type="text"]:focus-visible { outline: 2px solid var(--fruitback-color-accent); outline-offset: 2px; }
/* « Did not go through », and what to do (FRU-305). The text stays in the field above. */
.fruitback-composer-failed {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 16px;
  border-top: 1px solid var(--fruitback-color-border);
}
.fruitback-composer-failed[hidden] { display: none; }
.fruitback-composer-failed-title { margin: 0; font-size: 13px; font-weight: 600; color: var(--fruitback-color-accent); }
.fruitback-composer-failed-text { margin: 0; font-size: 12px; color: var(--fruitback-color-text-muted); }
/*
  The card of a sent note (FRU-305): it takes the place of the note and of the foot. The drop of the
  new pin with its number, « Sent as DEV-3 », the sentence in green, « Open → ».
*/
.fruitback-composer[data-fruitback-state="sent"] .fruitback-composer-head,
.fruitback-composer[data-fruitback-state="sent"] .fruitback-composer-body,
.fruitback-composer[data-fruitback-state="sent"] .fruitback-composer-foot { display: none; }
.fruitback-composer-sent { display: flex; align-items: center; gap: 12px; padding: 16px; outline: 0; }
.fruitback-composer-sent[hidden] { display: none; }
.fruitback-composer-sent-drop {
  flex: none;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 2px solid var(--fruitback-color-on-stage);
  border-radius: 50% 50% 50% 0;
  transform: rotate(-45deg);
  /* The colour of « new », through the variable every pin is painted with. */
  --fruitback-pin-color: var(--fruitback-stage-new);
  background: var(--fruitback-pin-color);
  color: var(--fruitback-color-on-stage-new, var(--fruitback-color-on-stage));
  font: 700 12px/1 var(--fruitback-font-sans);
  box-shadow: 0 0 0 1px var(--fruitback-color-stage-edge), var(--fruitback-shadow-sm);
}
.fruitback-composer-sent-drop > span { transform: rotate(45deg); }
.fruitback-composer-sent-words { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.fruitback-composer-sent-title { margin: 0; font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.fruitback-composer-sent-text { margin: 0; font-size: 12px; color: var(--fruitback-color-success); }
.fruitback-composer-sent-open {
  flex: none;
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 0 4px;
  color: var(--fruitback-color-text);
  font: 600 12px/1.5 var(--fruitback-font-sans);
  text-decoration: none;
  cursor: pointer;
}
.fruitback-composer-sent-open:hover { color: var(--fruitback-color-accent-strong); }
.fruitback-composer-sent-open[hidden] { display: none; }
/*
  « Send » ends the row, whatever the length of the words (FRU-317). The row is laid out from its end
  (\`row-reverse\`) and its lines from the bottom (\`wrap-reverse\`), in the \`order\` below: « Send »
  first, so it holds the end of the last line, then « Cancel », « Keep for later », the line of where
  the note lands, and the status. When the words do not fit, they go to a line above « Send », never
  the reverse. The source order, which is the order of the keyboard, stays « Keep for later »,
  « Cancel », « Send ». In a language written from the right, the end is the left.
*/
.fruitback-composer-foot {
  display: flex;
  flex-direction: row-reverse;
  flex-wrap: wrap-reverse;
  align-items: center;
  gap: 8px;
  padding-block: 10px 12px;
  padding-inline: 14px 12px;
  border-top: 1px solid var(--fruitback-color-border);
}
.fruitback-composer-status { flex: 1 1 100%; min-width: 0; font-size: 12px; color: var(--fruitback-color-text-muted); }
.fruitback-composer-status:empty { display: none; }
/*
  « Lands in Linear as a new issue »: where the note goes, before the buttons. At least 4.5em wide
  (FRU-350): beside the buttons, which stay on one line, its words wrap; with less room than that,
  they take a line of their own above them, never a column of letters beside them.
*/
.fruitback-composer-lands { flex: 1 1 0; min-width: min(4.5em, 100%); font-size: 12px; color: var(--fruitback-color-text-muted); }
.fruitback-composer-lands[hidden] { display: none; }
.fruitback-composer-send { order: 1; }
.fruitback-composer-foot > .fruitback-composer-ghost:not(.fruitback-composer-keep) { order: 2; }
.fruitback-composer-keep { order: 3; }
.fruitback-composer-lands { order: 4; }
.fruitback-composer-status { order: 5; }
/* 34 px drawn, as the mock-up does, inside a transparent border that makes the target 44 px. */
.fruitback-composer-ghost, .fruitback-composer-send {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 44px;
  margin-block: -5px;
  border: 5px solid transparent;
  border-inline-width: 0;
  border-radius: var(--fruitback-radius-pill);
  font: 600 13px/1 var(--fruitback-font-sans);
  cursor: pointer;
}
.fruitback-composer-ghost { padding: 0 12px; background: transparent; color: var(--fruitback-color-text-muted); }
.fruitback-composer-ghost:hover:not([disabled]) { background: var(--fruitback-color-surface-sunken) padding-box; }
.fruitback-composer-send {
  padding-inline: 12px 14px;
  background: var(--fruitback-color-accent) padding-box;
  color: var(--fruitback-color-on-accent);
  letter-spacing: -0.006em;
}
/* The drop of the mark, 12 px tall. */
.fruitback-composer-send .fruitback-icon { width: 10px; height: 12px; }
.fruitback-composer-send:hover:not([disabled]) { background: var(--fruitback-color-accent-strong) padding-box; }
.fruitback-composer-send[disabled] { opacity: 0.55; cursor: default; }
.fruitback-composer-keep[hidden], .fruitback-composer-sign-in[hidden] { display: none; }
/* « Sign in again » is the way out of the sentence above it: it reads as an action, in the text colour. */
.fruitback-composer-sign-in { color: var(--fruitback-color-text); text-decoration: underline; text-underline-offset: 3px; }
.fruitback-composer-keep[disabled] { opacity: 0.55; cursor: default; }
.fruitback-composer[data-fruitback-state="kept"] .fruitback-composer-status {
  color: var(--fruitback-color-success);
  font-weight: 600;
}
@media (forced-colors: active) {
  .fruitback-composer-ghost, .fruitback-composer-send, .fruitback-composer-pick { border-color: Canvas; }
  .fruitback-composer-send { outline: 1px solid ButtonText; outline-offset: -6px; }
}

/* The « rise » of the mock-up: no fade, it is there at once and settles. */
@keyframes fruitback-composer-in {
  from { transform: translateY(6px) scale(0.96); }
  to { transform: none; }
}
@keyframes fruitback-composer-down {
  from { transform: translateY(-6px) scale(0.96); }
  to { transform: none; }
}

/* Full screen on a phone: a 360px popover anchored to an element is unusable at that width. */
@media (max-width: 640px) {
  .fruitback-composer {
    position: fixed;
    /* Beats the custom properties above, which are only meaningful for the anchored popover. */
    inset: auto 0 0 0;
    left: 0;
    top: auto;
    width: auto;
    border-radius: var(--fruitback-radius-lg) var(--fruitback-radius-lg) 0 0;
    padding-bottom: env(safe-area-inset-bottom);
  }
  .fruitback-composer, .fruitback-composer[data-fruitback-side="below"] {
    animation-name: fruitback-composer-sheet-in;
  }
}

/*
  A thumb, not a pointer (FRU-157). iOS Safari zooms the page into a field under 16 px, and the zoom
  stays after the field loses focus. A box is toggled by its whole row, and the row is tall enough.
*/
@media (pointer: coarse) {
  .fruitback-composer textarea, .fruitback-composer-who input[type="text"] { font-size: 16px; }
  .fruitback-composer-identify { min-height: 36px; }
  .fruitback-composer-check, .fruitback-composer-place { min-height: 36px; }
}

@keyframes fruitback-composer-sheet-in {
  from { transform: translateY(100%); }
  to { transform: none; }
}

@media (prefers-reduced-motion: reduce) {
  .fruitback-composer, .fruitback-composer[data-fruitback-side="below"] { animation: none; }
}
`;
