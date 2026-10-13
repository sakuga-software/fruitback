import type { SeedReporter } from '@fruitback/shared';
import type { Destination } from './destinations.ts';
import { deepActiveElement, holdFocus } from './focus.ts';
import { createIcon } from './icons.ts';
import { type MessageKey, type Translator, createTranslator, languageOf } from './messages.ts';

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

/** Long enough to read the confirmation, short enough not to be in the way. */
const SENT_MS = 1_100;

export type ComposerState = 'idle' | 'sending' | 'sent' | 'kept' | 'failed';

/**
 * Why a send failed, so the composer says what to do next (FRU-156). The text is kept in every case.
 *
 * - `retry`: no answer, or the worker failed. A second try can work.
 * - `wait`: too many notes at once (`429`). A try in a minute can work.
 * - `refused`: the worker does not accept this note from here (`403`). Trying again will not work;
 *   the team of the site can change it.
 * - `signed-out`: the worker wants an identity it did not get (`401`): a session that ended, a token
 *   out of date (FRU-193). The team of the site can do nothing; the reporter signs in again.
 * - `too-large`: the note is too heavy (`413`). It goes once it is shorter, or without its picture.
 */
export type SendFailure = 'retry' | 'wait' | 'refused' | 'signed-out' | 'too-large';

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
  onSubmit: (note: string, reporter?: SeedReporter, destination?: string) => Promise<boolean | void | SendFailure>;
  onClose?: () => void;
  /**
   * Where the name of the reporter is kept between notes, when the reporter asks for it (FRU-91).
   * If left out, the composer offers no box to remember the name.
   */
  memory?: NameMemory;
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
    onKeep: (note: string, reporter?: SeedReporter, destination?: string) => Promise<true | SendFailure>;
  };
  /**
   * The box « Attach a picture of this element » (FRU-258). It is the preference the settings panel
   * holds, shown beside the note it applies to: the composer reads it and writes it, and keeps
   * nothing. Left out, or while `offered()` says no, there is no box: a host that cannot take a
   * picture offers none. **The composer never ticks it**: what it shows is what the reporter chose.
   */
  picture?: PictureChoice;
  /** The widget's words (FRU-37). Left out: English, with dates in this document's language. */
  translator?: Translator;
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
   * `about` is a name a person reads for the element, written after « on » in the head (FRU-258).
   * Left out or empty, the head holds the title alone.
   */
  open(anchor: { left: number; top: number; bottom: number; right: number }, about?: string): void;
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
  root.innerHTML = TEMPLATE;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', t.text('composer.dialog'));

  options.host.append(style, root);
  const focus = holdFocus(root, close);

  const field = root.querySelector('[data-fruitback-note]') as HTMLTextAreaElement;
  const send = root.querySelector('[data-fruitback-send]') as HTMLButtonElement;
  // The word alone, as the mock-up writes it (FRU-258): the drop that stood before it is the mark of
  // the launch button now, and of the pins.
  send.textContent = t.text('composer.send');
  const title = root.querySelector('[data-fruitback-title]') as HTMLElement;
  const about = root.querySelector('[data-fruitback-about]') as HTMLElement;
  const shut = root.querySelector('[data-fruitback-close]') as HTMLButtonElement;
  // Appended after the template is parsed: an SVG in an innerHTML string is parsed into the HTML
  // namespace and renders nothing (FRU-36).
  shut.append(createIcon(document, 'close'));
  const pictureLabel = root.querySelector('[data-fruitback-picture-label]') as HTMLLabelElement;
  const picture = root.querySelector('[data-fruitback-picture]') as HTMLInputElement;
  const cancel = root.querySelector('[data-fruitback-cancel]') as HTMLButtonElement;
  const keep = root.querySelector('[data-fruitback-keep]') as HTMLButtonElement;
  const status = root.querySelector('[data-fruitback-status]') as HTMLElement;
  const identify = root.querySelector('[data-fruitback-identify]') as HTMLButtonElement;
  const who = root.querySelector('[data-fruitback-who]') as HTMLElement;
  const name = root.querySelector('[data-fruitback-name]') as HTMLInputElement;
  const rememberLabel = root.querySelector('[data-fruitback-remember-label]') as HTMLLabelElement;
  const remember = root.querySelector('[data-fruitback-remember]') as HTMLInputElement;
  const destination = root.querySelector('[data-fruitback-destination]') as HTMLButtonElement;
  const placeList = root.querySelector('[data-fruitback-destinations]') as HTMLElement;
  const gone = root.querySelector('[data-fruitback-destination-gone]') as HTMLElement;
  const memory = options.memory;
  const isIdentified = (): boolean =>
    typeof options.identified === 'function' ? options.identified() : options.identified === true;
  let asksForName = true;
  const choice = options.destinations;

  // Set after parsing and never interpolated into TEMPLATE: a host translation is text, not markup.
  field.placeholder = t.text('composer.placeholder');
  field.setAttribute('aria-label', t.text('composer.label'));
  title.textContent = t.text('composer.dialog');
  shut.setAttribute('aria-label', t.text('composer.close'));
  (pictureLabel.querySelector('span') as HTMLElement).textContent = t.text('composer.picture');
  identify.textContent = t.text('composer.identify');
  name.placeholder = t.text('composer.namePlaceholder');
  name.setAttribute('aria-label', t.text('composer.nameLabel'));
  (rememberLabel.querySelector('span') as HTMLElement).textContent = t.text('composer.remember');
  rememberLabel.hidden = memory === undefined;
  askForNameOrNot();
  cancel.textContent = t.text('composer.cancel');
  keep.textContent = t.text('composer.keep');
  placeList.setAttribute('aria-label', t.text('composer.destinations'));

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
    field.readOnly = next === 'sending';
    status.textContent = next === 'idle' ? '' : t.text(next === 'failed' ? FAILURES[failure] : STATUS[next]);
  }

  /** Send the note, or keep it for later: the same states, and the text kept on any failure. */
  async function submit(action: 'send' | 'keep' = 'send'): Promise<void> {
    if (state === 'sending') return;

    const mine = session;
    setState('sending');
    // Before the send, so a failed send costs neither the name nor the choice to keep it.
    if (asksForName && remember.checked) memory?.set(typedName());
    let failure: SendFailure | undefined;
    try {
      const result =
        action === 'keep' && options.keep !== undefined
          ? await options.keep.onKeep(field.value, reporterFromFields(), selected)
          : await options.onSubmit(field.value, reporterFromFields(), selected);
      if (result === false) failure = 'retry';
      else if (typeof result === 'string') failure = result;
    } catch {
      failure = 'retry';
    }

    if (failure !== undefined) {
      // Abandoned mid-flight: say nothing, focus nothing. The note was let go of on purpose.
      if (mine !== session) return;

      // The text stays exactly where it is. Retrying is one more click, not one more typing session.
      setState('failed', failure);
      field.focus();
      return;
    }

    if (mine !== session) return;

    setState(action === 'keep' ? 'kept' : 'sent');
    closing = view?.setTimeout(close, SENT_MS) ?? 0;
  }

  /** The typed name is kept, hidden, and not sent: an identity that ends gives the field back with it. */
  function askForNameOrNot(): void {
    asksForName = !isIdentified();
    identify.hidden = !asksForName;
    if (asksForName) return;

    who.hidden = true;
    identify.setAttribute('aria-expanded', 'false');
  }

  /** The box shows the preference as it is now. It is never ticked by anything but its reporter. */
  function showPicture(): void {
    const offered = options.picture?.offered() === true;
    pictureLabel.hidden = !offered;
    picture.checked = offered && options.picture?.get() === true;
  }

  function open(anchor: { left: number; top: number; bottom: number; right: number }, subject = ''): void {
    if (closing !== 0) {
      view?.clearTimeout(closing);
      closing = 0;
    }

    session += 1;
    field.value = '';
    // As text: it is whatever the page wrote in its element.
    about.textContent = subject === '' ? '' : t.text('composer.about', { element: subject });
    about.hidden = subject === '';
    showPicture();
    askForNameOrNot();
    keep.hidden = options.keep?.offered() !== true;
    showRememberedName();
    // Folded at each open, on the place chosen last. The line says where, and that is enough for
    // the many notes that go where the one before went.
    selected = undefined;
    gone.textContent = '';
    foldPlaces(true);
    drawDestinations();
    setState('idle');
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
    if (remembered === undefined) return;

    name.value = remembered;
    remember.checked = true;
    who.hidden = false;
    identify.setAttribute('aria-expanded', 'true');
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
  }

  const checkedPlace = () => placeList.querySelector('input:checked') as HTMLInputElement | null;

  function close(): void {
    session += 1;
    root.hidden = true;
    setState('idle');
    focus.restore();
    options.onClose?.();
  }

  identify.addEventListener('click', () => {
    const shown = who.hidden;
    who.hidden = !shown;
    identify.setAttribute('aria-expanded', String(shown));
    if (shown) name.focus();
  });

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
    choice?.remember(input.value);
  });

  const stopFollowingPlaces = choice?.subscribe(drawDestinations);

  // Kept at the tick, like every preference: it is the reporter's, with or without a note sent.
  picture.addEventListener('change', () => options.picture?.set(picture.checked));
  const stopFollowingPicture = options.picture?.subscribe?.(showPicture);
  showPicture();

  send.addEventListener('click', () => void submit());
  keep.addEventListener('click', () => void submit('keep'));
  cancel.addEventListener('click', close);
  // The cross and « Cancel » do the same thing: the head holds a way out wherever the eye is.
  shut.addEventListener('click', close);
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
      focus.destroy();
      stopFollowingPlaces?.();
      stopFollowingPicture?.();
      root.remove();
      style.remove();
    },
  };
}

/** The measures of the mock-up (FRU-258), kept next to the stylesheet that `place` must agree with. */
const WIDTH = 360;
const GAP = 10;
/** How far above the top of its element the composer ends, and how far the frame stands off the element. */
const RISE = 40;
const FRAME = 6;

const STATUS = {
  sending: 'composer.sending',
  sent: 'composer.sent',
  kept: 'composer.kept',
} as const satisfies Record<Exclude<ComposerState, 'idle' | 'failed'>, MessageKey>;

/** The sentence of a failed send, for another part of the widget that sends: the list of drafts (FRU-124). */
export function failureText(t: Translator, failure: SendFailure): string {
  return t.text(FAILURES[failure]);
}

/** What a failed send says, by its cause (FRU-156). */
const FAILURES = {
  retry: 'composer.failed',
  wait: 'composer.failedWait',
  refused: 'composer.failedRefused',
  'signed-out': 'composer.failedSignedOut',
  'too-large': 'composer.failedTooLarge',
} as const satisfies Record<SendFailure, MessageKey>;

const TEMPLATE = `
  <div class="fruitback-composer-head">
    <span data-fruitback-title class="fruitback-composer-title"></span>
    <span data-fruitback-about class="fruitback-composer-about" hidden></span>
    <button type="button" data-fruitback-close class="fruitback-composer-close"></button>
  </div>
  <div class="fruitback-composer-body">
    <textarea data-fruitback-note rows="3"></textarea>
    <label data-fruitback-picture-label class="fruitback-composer-check" hidden>
      <input data-fruitback-picture type="checkbox" name="fruitback-picture" /><span></span>
    </label>
    <button type="button" data-fruitback-identify class="fruitback-composer-identify" aria-expanded="false"></button>
    <div data-fruitback-who class="fruitback-composer-who" hidden>
      <input data-fruitback-name type="text" name="fruitback-name" autocomplete="name" />
      <label data-fruitback-remember-label class="fruitback-composer-check fruitback-composer-remember">
        <input data-fruitback-remember type="checkbox" name="fruitback-remember" /><span></span>
      </label>
    </div>
    <button type="button" data-fruitback-destination class="fruitback-composer-identify" aria-expanded="false" hidden></button>
    <div data-fruitback-destinations class="fruitback-composer-places" role="radiogroup" hidden></div>
    <div data-fruitback-destination-gone class="fruitback-composer-notice" role="status" aria-live="polite"></div>
  </div>
  <div class="fruitback-composer-foot">
    <span data-fruitback-status class="fruitback-composer-status" role="status" aria-live="polite"></span>
    <button type="button" data-fruitback-keep class="fruitback-composer-ghost fruitback-composer-keep" hidden></button>
    <button type="button" data-fruitback-cancel class="fruitback-composer-ghost"></button>
    <button type="button" data-fruitback-send class="fruitback-composer-send"></button>
  </div>
`;

/**
 * The composer of the mock-up of 2026-10-13 (FRU-258): a head, the note, a foot behind a rule.
 * `prefers-reduced-motion` turns the animation off rather than shortening it — a widget that
 * overlays someone else's site is the last thing that should ignore that setting.
 */
const STYLES = `
.fruitback-composer {
  position: absolute;
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
  gap: 10px;
  padding-block: 8px;
  padding-inline: 16px 8px;
}
.fruitback-composer-title { flex: none; font-weight: 600; font-size: 13px; letter-spacing: -0.006em; }
/* One line: what the element says can be a paragraph. */
.fruitback-composer-about {
  min-width: 0;
  font-size: 12px;
  color: var(--fruitback-color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fruitback-composer-about[hidden] { display: none; }
.fruitback-composer-close {
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
  color: var(--fruitback-color-text-muted);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}
.fruitback-composer-close:hover { background: var(--fruitback-color-surface-sunken); }
.fruitback-composer-body { display: flex; flex-direction: column; padding: 0 16px 12px; }
.fruitback-composer textarea {
  display: block;
  width: 100%;
  border: 1px solid var(--fruitback-color-border-strong);
  border-radius: var(--fruitback-radius-field);
  padding: 9px 12px;
  font: inherit;
  resize: vertical;
  background: var(--fruitback-color-surface);
  color: inherit;
  caret-color: var(--fruitback-color-accent);
}
.fruitback-composer textarea:focus-visible { outline: 2px solid var(--fruitback-color-accent); outline-offset: 1px; }
.fruitback-composer-identify {
  display: block;
  margin-top: 10px;
  border: 0;
  background: none;
  padding: 0;
  color: var(--fruitback-color-text-muted);
  font: inherit;
  font-size: 12px;
  text-decoration: underline;
  cursor: pointer;
}
.fruitback-composer-who { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
.fruitback-composer-who[hidden] { display: none; }
.fruitback-composer-identify[hidden] { display: none; }
/* A box and its words: the picture, and the name to remember. 10 px under what is above, as the
   mock-up spaces the parts of the body. */
.fruitback-composer-check {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  font-size: 12px;
  cursor: pointer;
}
.fruitback-composer-remember { margin-top: 0; color: var(--fruitback-color-text-muted); }
.fruitback-composer-check[hidden] { display: none; }
.fruitback-composer-check input, .fruitback-composer-place input {
  /* The reset of the host sets appearance to none, and a native box then draws nothing. */
  appearance: auto;
  -webkit-appearance: checkbox;
  flex: none;
  width: 16px;
  height: 16px;
  margin: 0;
  /* The ink of the mock-up, which is the colour of the text: it follows the scheme. */
  accent-color: var(--fruitback-color-text);
  cursor: pointer;
}
/* Where the note goes (FRU-123). No board draws this line, so it is made of what the composer has:
   the disclosure of the name above it, and the row of a box. */
.fruitback-composer-places { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
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
.fruitback-composer-identify { text-align: start; }
/* Always in the tree, because a live region that was hidden announces nothing. Empty, it has no
   height, and the margin comes with the words. */
.fruitback-composer-notice { font-size: 12px; color: var(--fruitback-color-accent); }
.fruitback-composer-notice:not(:empty) { margin-top: 10px; }
.fruitback-composer-who input[type="text"] {
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid var(--fruitback-color-border-strong);
  border-radius: var(--fruitback-radius-sm);
  font: inherit;
  font-size: 12px;
  color: inherit;
  background: var(--fruitback-color-surface);
}
.fruitback-composer-who input[type="text"]:focus-visible { outline: 2px solid var(--fruitback-color-accent); outline-offset: 1px; }
.fruitback-composer-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-block: 10px 12px;
  padding-inline: 16px 12px;
  border-top: 1px solid var(--fruitback-color-border);
}
.fruitback-composer-status { flex: 1; min-width: 0; font-size: 12px; color: var(--fruitback-color-text-muted); }
.fruitback-composer-ghost, .fruitback-composer-send {
  display: inline-flex;
  align-items: center;
  height: 36px;
  border: 0;
  border-radius: var(--fruitback-radius-pill);
  font: 600 13px/1 var(--fruitback-font-sans);
  cursor: pointer;
}
.fruitback-composer-ghost { padding: 0 12px; background: transparent; color: var(--fruitback-color-text-muted); }
.fruitback-composer-ghost:hover:not([disabled]) { background: var(--fruitback-color-surface-sunken); }
.fruitback-composer-send {
  padding: 0 18px;
  background: var(--fruitback-color-accent);
  color: var(--fruitback-color-on-accent);
  letter-spacing: -0.006em;
}
.fruitback-composer-send:hover:not([disabled]) { background: var(--fruitback-color-accent-strong); }
.fruitback-composer-send[disabled] { opacity: 0.55; cursor: default; }
.fruitback-composer-keep[hidden] { display: none; }
.fruitback-composer-keep[disabled] { opacity: 0.55; cursor: default; }
.fruitback-composer[data-fruitback-state="sent"] .fruitback-composer-status,
.fruitback-composer[data-fruitback-state="kept"] .fruitback-composer-status {
  color: var(--fruitback-color-success);
  font-weight: 600;
}
.fruitback-composer[data-fruitback-state="failed"] .fruitback-composer-status { color: var(--fruitback-color-accent); }
/* A failure says what to do in a sentence: it takes the whole line above the buttons (FRU-156). */
.fruitback-composer[data-fruitback-state="failed"] .fruitback-composer-status { flex-basis: 100%; }
/* The first button of the row is pushed to the end: Keep for later when it is there, Cancel otherwise. */
.fruitback-composer[data-fruitback-state="failed"] .fruitback-composer-keep:not([hidden]),
.fruitback-composer[data-fruitback-state="failed"] .fruitback-composer-keep[hidden] + .fruitback-composer-ghost {
  margin-inline-start: auto;
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
  .fruitback-composer textarea { min-height: 96px; }
}

/*
  A thumb, not a pointer (FRU-157). iOS Safari zooms the page into a field under 16 px, and the zoom
  stays after the field loses focus. A box is toggled by its whole row, and the row is tall enough.
  The cross grows to 44 px, and gives the extra size back to the padding of the head.
*/
@media (pointer: coarse) {
  .fruitback-composer textarea, .fruitback-composer-who input[type="text"] { font-size: 16px; }
  .fruitback-composer-who input[type="text"] { padding-block: 8px; }
  .fruitback-composer-identify { min-height: 36px; }
  .fruitback-composer-check, .fruitback-composer-place { min-height: 36px; }
  .fruitback-composer-ghost, .fruitback-composer-send { min-height: 44px; padding-inline: 18px; }
  .fruitback-composer-close { min-width: 44px; min-height: 44px; margin-block: -6px; margin-inline-end: -6px; }
}

@keyframes fruitback-composer-sheet-in {
  from { transform: translateY(100%); }
  to { transform: none; }
}

@media (prefers-reduced-motion: reduce) {
  .fruitback-composer, .fruitback-composer[data-fruitback-side="below"] { animation: none; }
}
`;
