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

export type ComposerState = 'idle' | 'sending' | 'sent' | 'failed';

export type ComposerOptions = {
  document?: Document;
  /** Inside the widget's Shadow root — `host.panel`. */
  host: Element;
  /**
   * Send the note. Resolving means it was planted; throwing or resolving `false` keeps the popover
   * open with the text intact, because a note lost to a network blip is the one failure this widget
   * cannot afford.
   *
   * `reporter` is what the visitor optionally typed about themselves (FRU-9). It is a **claim**:
   * the worker stores it as self-declared unless the embedder also sends a signed identity token,
   * and it strips any `verified` flag that arrives from a browser.
   *
   * `destination` is the id of the place the line shows (FRU-123). It is absent when the composer
   * shows no line, which is every composer but the one of a member of a site with several places.
   */
  onSubmit: (note: string, reporter?: SeedReporter, destination?: string) => Promise<boolean | void>;
  onClose?: () => void;
  /**
   * Where the name of the reporter is kept between notes, when the reporter asks for it (FRU-91).
   * If left out, the composer offers no box to remember the name.
   */
  memory?: NameMemory;
  /**
   * The worker names the reporter from a signed identity, so the composer asks for no name.
   * A typed name would be replaced by the identity, and the reporter would not know.
   */
  identified?: boolean;
  /**
   * The places this note can go, and where the last choice is kept (FRU-123). If left out, or while
   * it offers fewer than two places, the composer is the one of FRU-89: it holds no line about where
   * the note goes.
   */
  destinations?: DestinationChoice;
  /** The widget's words (FRU-37). Left out: English, with dates in this document's language. */
  translator?: Translator;
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
  open(anchor: { left: number; top: number; bottom: number; right: number }): void;
  close(): void;
  state(): ComposerState;
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
  // Appended after the template is parsed: the seed the button plants, in the shape the page will
  // then show it in. Written here rather than in TEMPLATE because an SVG in an innerHTML string is
  // parsed into the HTML namespace and renders nothing (FRU-36).
  send.append(createIcon(document, 'drop'), t.text('composer.send'));
  const cancel = root.querySelector('[data-fruitback-cancel]') as HTMLButtonElement;
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
  const asksForName = options.identified !== true;
  const choice = options.destinations;

  // Set after parsing and never interpolated into TEMPLATE: a host translation is text, not markup.
  field.placeholder = t.text('composer.placeholder');
  field.setAttribute('aria-label', t.text('composer.label'));
  identify.textContent = t.text('composer.identify');
  name.placeholder = t.text('composer.namePlaceholder');
  name.setAttribute('aria-label', t.text('composer.nameLabel'));
  (rememberLabel.querySelector('span') as HTMLElement).textContent = t.text('composer.remember');
  rememberLabel.hidden = memory === undefined;
  identify.hidden = !asksForName;
  cancel.textContent = t.text('composer.cancel');
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

  function setState(next: ComposerState): void {
    state = next;
    root.dataset.fruitbackState = next;
    // Disabled while in flight: a second click would plant the same note twice, and the worker has
    // no way to tell the difference.
    send.disabled = next === 'sending' || next === 'sent';
    field.readOnly = next === 'sending';
    status.textContent = next === 'idle' ? '' : t.text(STATUS[next]);
  }

  async function submit(): Promise<void> {
    if (state === 'sending') return;

    const mine = session;
    setState('sending');
    // Before the send, so a failed send costs neither the name nor the choice to keep it.
    if (asksForName && remember.checked) memory?.set(typedName());
    try {
      const result = await options.onSubmit(field.value, reporterFromFields(), selected);
      if (result === false) throw new Error('refused');
    } catch {
      // Abandoned mid-flight: say nothing, focus nothing. The note was let go of on purpose.
      if (mine !== session) return;

      // The text stays exactly where it is. Retrying is one more click, not one more typing session.
      setState('failed');
      field.focus();
      return;
    }

    if (mine !== session) return;

    setState('sent');
    closing = view?.setTimeout(close, SENT_MS) ?? 0;
  }

  function open(anchor: { left: number; top: number; bottom: number; right: number }): void {
    if (closing !== 0) {
      view?.clearTimeout(closing);
      closing = 0;
    }

    session += 1;
    field.value = '';
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
   * Under the element it belongs to, flipped above when there is no room. Aligned on the element's
   * start edge: its left in a left-to-right language, its right otherwise. The value stays a physical
   * left, because it is a position against the page (FRU-38).
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
    const below = anchor.bottom + GAP;
    const fitsBelow = below + own.height <= scrollY + height;
    const start = t.direction === 'rtl' ? anchor.right - WIDTH : anchor.left;

    // Custom properties rather than inline `left`/`top`: an inline style would beat the media query
    // below and leave the mobile sheet offset by whatever the element's position happened to be.
    // `start` is in document coordinates, so the window it must stay inside starts at `scrollX` (FRU-68).
    root.style.setProperty(
      '--fruitback-composer-left',
      `${Math.max(scrollX + GAP, Math.min(start, scrollX + width - WIDTH - GAP))}px`,
    );
    root.style.setProperty(
      '--fruitback-composer-top',
      `${fitsBelow ? below : Math.max(0, anchor.top - own.height - GAP)}px`,
    );
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

  send.addEventListener('click', () => void submit());
  cancel.addEventListener('click', close);
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
    element: root,
    destroy() {
      if (closing !== 0) view?.clearTimeout(closing);
      focus.destroy();
      stopFollowingPlaces?.();
      root.remove();
      style.remove();
    },
  };
}

const WIDTH = 320;
const GAP = 10;

const STATUS = {
  sending: 'composer.sending',
  sent: 'composer.sent',
  failed: 'composer.failed',
} as const satisfies Record<Exclude<ComposerState, 'idle'>, MessageKey>;

const TEMPLATE = `
  <div class="fruitback-composer-drop" aria-hidden="true"></div>
  <textarea data-fruitback-note rows="3"></textarea>
  <button type="button" data-fruitback-identify class="fruitback-composer-identify" aria-expanded="false"></button>
  <div data-fruitback-who class="fruitback-composer-who" hidden>
    <input data-fruitback-name type="text" name="fruitback-name" autocomplete="name" />
    <label data-fruitback-remember-label class="fruitback-composer-remember">
      <input data-fruitback-remember type="checkbox" name="fruitback-remember" /><span></span>
    </label>
  </div>
  <button type="button" data-fruitback-destination class="fruitback-composer-identify" aria-expanded="false" hidden></button>
  <div data-fruitback-destinations class="fruitback-composer-places" role="radiogroup" hidden></div>
  <div data-fruitback-destination-gone class="fruitback-composer-notice" role="status" aria-live="polite"></div>
  <div class="fruitback-composer-foot">
    <span data-fruitback-status class="fruitback-composer-status" role="status" aria-live="polite"></span>
    <button type="button" data-fruitback-cancel class="fruitback-composer-ghost"></button>
    <button type="button" data-fruitback-send class="fruitback-composer-send"></button>
  </div>
`;

/**
 * The fruit art direction, in the two places it is load-bearing: the drop that ties the popover to
 * the pin, and the rounding that keeps it from looking like a form. `prefers-reduced-motion` turns
 * the animation off rather than shortening it — a widget that overlays someone else's site is the
 * last thing that should ignore that setting.
 */
const STYLES = `
.fruitback-composer {
  position: absolute;
  /* WIDTH is what place() clamps against, so the rendered box has to be exactly that — with
     content-box the padding sat outside it and the popover could overhang the viewport. Set here
     rather than inherited from the host's reset: this file has to hold up wherever it is mounted. */
  box-sizing: border-box;
  left: var(--fruitback-composer-left, 0px);
  top: var(--fruitback-composer-top, 0px);
  z-index: 2147483300;
  width: ${WIDTH}px;
  padding: 14px;
  border-radius: var(--fruitback-radius-lg);
  background: var(--fruitback-color-surface-raised);
  color: var(--fruitback-color-text);
  font: 14px/1.5 var(--fruitback-font-sans);
  box-shadow: var(--fruitback-shadow-xl);
  animation: fruitback-composer-in var(--fruitback-duration-fast) cubic-bezier(0.22, 1.2, 0.36, 1);
}
.fruitback-composer[hidden] { display: none; }
.fruitback-composer-drop {
  position: absolute;
  top: -7px;
  inset-inline-start: 22px;
  width: 14px;
  height: 14px;
  background: var(--fruitback-color-surface-raised);
  /* A seed rather than a triangle: three round corners and one sharp, turned to point at the pin. */
  border-radius: 50% 50% 50% 0;
  transform: rotate(-45deg);
}
.fruitback-composer textarea {
  display: block;
  width: 100%;
  border: 1px solid var(--fruitback-color-border-strong);
  border-radius: var(--fruitback-radius-md);
  padding: 10px 12px;
  font: inherit;
  resize: vertical;
  background: var(--fruitback-color-surface);
  color: inherit;
}
.fruitback-composer textarea:focus-visible { outline: 2px solid var(--fruitback-color-accent); outline-offset: 1px; }
.fruitback-composer-identify {
  display: block;
  margin-top: 8px;
  border: 0;
  background: none;
  padding: 0;
  color: var(--fruitback-color-text-muted);
  font: inherit;
  font-size: 12px;
  text-decoration: underline;
  cursor: pointer;
}
.fruitback-composer-who { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.fruitback-composer-who[hidden] { display: none; }
.fruitback-composer-identify[hidden] { display: none; }
.fruitback-composer-remember {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--fruitback-color-text-muted);
  cursor: pointer;
}
.fruitback-composer-remember[hidden] { display: none; }
.fruitback-composer-remember input, .fruitback-composer-place input {
  /* The reset of the host sets appearance to none, and a native box then draws nothing. */
  appearance: auto;
  -webkit-appearance: checkbox;
  width: 14px;
  height: 14px;
  accent-color: var(--fruitback-color-accent);
}
/* Where the note goes (FRU-123). No board draws this line, so it is made of what the composer has:
   the disclosure of the name above it, and the row of the box that remembers the name. */
.fruitback-composer-places { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.fruitback-composer-places[hidden] { display: none; }
.fruitback-composer-place {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--fruitback-color-text-muted);
  cursor: pointer;
}
.fruitback-composer-place input { flex: none; -webkit-appearance: radio; }
/* A name comes from a tracker and can be one long word. */
.fruitback-composer-place span, .fruitback-composer-identify { overflow-wrap: anywhere; }
.fruitback-composer-identify { text-align: start; }
/* Always in the tree, because a live region that was hidden announces nothing. Empty, it has no
   height, and the margin comes with the words. */
.fruitback-composer-notice { font-size: 12px; color: var(--fruitback-color-accent); }
.fruitback-composer-notice:not(:empty) { margin-top: 8px; }
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
.fruitback-composer-foot { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.fruitback-composer-status { flex: 1; font-size: 12px; color: var(--fruitback-color-text-muted); }
.fruitback-composer-ghost, .fruitback-composer-send {
  border: 0;
  border-radius: var(--fruitback-radius-pill);
  padding: 8px 14px;
  font: 600 13px/1 var(--fruitback-font-sans);
  cursor: pointer;
}
.fruitback-composer-ghost { background: transparent; color: var(--fruitback-color-text-muted); }
.fruitback-composer-send {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--fruitback-color-accent);
  color: var(--fruitback-color-on-accent);
}
.fruitback-composer-send[disabled] { opacity: 0.55; cursor: default; }
.fruitback-composer[data-fruitback-state="sent"] .fruitback-composer-status {
  color: var(--fruitback-color-success);
  font-weight: 600;
}
.fruitback-composer[data-fruitback-state="failed"] .fruitback-composer-status { color: var(--fruitback-color-accent); }

@keyframes fruitback-composer-in {
  from { opacity: 0; transform: translateY(-6px) scale(0.96); }
  to { opacity: 1; transform: none; }
}

/* Full screen on a phone: a 320px popover anchored to an element is unusable at that width. */
@media (max-width: 640px) {
  .fruitback-composer {
    position: fixed;
    /* Beats the custom properties above, which are only meaningful for the anchored popover. */
    inset: auto 0 0 0;
    left: 0;
    top: auto;
    width: auto;
    border-radius: var(--fruitback-radius-lg) var(--fruitback-radius-lg) 0 0;
    padding: 18px 16px calc(18px + env(safe-area-inset-bottom));
    animation-name: fruitback-composer-sheet-in;
  }
  .fruitback-composer-drop { display: none; }
  .fruitback-composer textarea { min-height: 96px; }
}

@keyframes fruitback-composer-sheet-in {
  from { transform: translateY(100%); }
  to { transform: none; }
}

@media (prefers-reduced-motion: reduce) {
  .fruitback-composer { animation: none; }
}
`;
