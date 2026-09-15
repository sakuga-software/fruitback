import type { SeedReporter } from '@fruitback/shared';
import { createIcon } from './icons.ts';
import { type MessageKey, type Translator, createTranslator, languageOf } from './messages.ts';

/**
 * The note popover: what the reporter actually writes in.
 *
 * It owns the **states**, not the transport. `onSubmit` is handed the note and awaited, so a widget
 * embedded in someone's site can post through whatever the host set up while this file stays
 * ignorant of the worker's URL, of auth, and of retries. What it does own is the part that is easy
 * to get wrong and impossible to test from the outside: the button that must not fire twice, the
 * error that must not eat the text someone just typed, and the "harvested" beat before it closes.
 *
 * Its shape is the product's, not a framework's: a drop of fruit. That is the whole reason the pin
 * is a teardrop and the confirmation says *harvested* rather than *sent*.
 */

/** Long enough to read the confirmation, short enough not to be in the way. */
const HARVESTED_MS = 1_100;

export type ComposerState = 'idle' | 'sending' | 'harvested' | 'failed';

export type ComposerOptions = {
  document?: Document;
  /** Inside the widget's Shadow root — `host.panel`. */
  host: Element;
  /**
   * Send the note. Resolving means it was planted; throwing or resolving `false` keeps the popover
   * open with the text intact, because a note lost to a network blip is the one failure this widget
   * cannot afford.
   *
   * `reporter` is what the visitor optionally typed about themselves (SKG-498). It is a **claim**:
   * the worker stores it as self-declared unless the embedder also sends a signed identity token,
   * and it strips any `verified` flag that arrives from a browser.
   */
  onSubmit: (note: string, reporter?: SeedReporter) => Promise<boolean | void>;
  onClose?: () => void;
  /** The widget's words (SKG-530). Left out: English, with dates in this document's language. */
  translator?: Translator;
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

  options.host.append(style, root);

  const field = root.querySelector('[data-fruitback-note]') as HTMLTextAreaElement;
  const send = root.querySelector('[data-fruitback-send]') as HTMLButtonElement;
  // Appended after the template is parsed: the seed the button plants, in the shape the page will
  // then show it in. Written here rather than in TEMPLATE because an SVG in an innerHTML string is
  // parsed into the HTML namespace and renders nothing (SKG-529).
  send.append(createIcon(document, 'drop'), t.text('composer.send'));
  const cancel = root.querySelector('[data-fruitback-cancel]') as HTMLButtonElement;
  const status = root.querySelector('[data-fruitback-status]') as HTMLElement;
  const identify = root.querySelector('[data-fruitback-identify]') as HTMLButtonElement;
  const who = root.querySelector('[data-fruitback-who]') as HTMLElement;
  const name = root.querySelector('[data-fruitback-name]') as HTMLInputElement;
  const email = root.querySelector('[data-fruitback-email]') as HTMLInputElement;

  // Set after parsing and never interpolated into TEMPLATE: a host translation is text, not markup.
  field.placeholder = t.text('composer.placeholder');
  field.setAttribute('aria-label', t.text('composer.label'));
  identify.textContent = t.text('composer.identify');
  name.placeholder = t.text('composer.namePlaceholder');
  name.setAttribute('aria-label', t.text('composer.nameLabel'));
  email.placeholder = t.text('composer.emailPlaceholder');
  email.setAttribute('aria-label', t.text('composer.emailLabel'));
  cancel.textContent = t.text('composer.cancel');

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
    send.disabled = next === 'sending' || next === 'harvested';
    field.readOnly = next === 'sending';
    status.textContent = next === 'idle' ? '' : t.text(STATUS[next]);
  }

  async function submit(): Promise<void> {
    if (state === 'sending') return;

    const mine = session;
    setState('sending');
    try {
      const result = await options.onSubmit(field.value, reporterFromFields());
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

    setState('harvested');
    closing = view?.setTimeout(close, HARVESTED_MS) ?? 0;
  }

  function open(anchor: { left: number; top: number; bottom: number; right: number }): void {
    if (closing !== 0) {
      view?.clearTimeout(closing);
      closing = 0;
    }

    session += 1;
    field.value = '';
    setState('idle');
    root.hidden = false;
    place(anchor);
    field.focus();
  }

  /**
   * Under the element it belongs to, flipped above when there is no room. Aligned on the element's
   * start edge: its left in a left-to-right language, its right otherwise. The value stays a physical
   * left, because it is a position against the page (SKG-531).
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
    // `start` is in document coordinates, so the window it must stay inside starts at `scrollX` (SKG-607).
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
   * Anonymous is the default and stays one click away: these fields are behind a disclosure, empty,
   * and an empty one is absent rather than an empty string — the seed round-trip forbids a field
   * nobody provided.
   */
  function reporterFromFields(): SeedReporter | undefined {
    const reporter = {
      ...(name.value.trim().length > 0 ? { name: name.value.trim() } : {}),
      ...(email.value.trim().length > 0 ? { email: email.value.trim() } : {}),
    };

    return Object.keys(reporter).length > 0 ? reporter : undefined;
  }

  function close(): void {
    session += 1;
    root.hidden = true;
    setState('idle');
    options.onClose?.();
  }

  identify.addEventListener('click', () => {
    const shown = who.hidden;
    who.hidden = !shown;
    identify.setAttribute('aria-expanded', String(shown));
    if (shown) name.focus();
  });

  send.addEventListener('click', () => void submit());
  cancel.addEventListener('click', close);
  field.addEventListener('keydown', (event) => {
    const key = event as KeyboardEvent;
    // ⌘/Ctrl+Enter sends, because a plain Enter belongs to the note.
    if (key.key === 'Enter' && (key.metaKey || key.ctrlKey)) void submit();
    if (key.key === 'Escape') close();
  });

  setState('idle');

  return {
    open,
    close,
    state: () => state,
    element: root,
    destroy() {
      if (closing !== 0) view?.clearTimeout(closing);
      root.remove();
      style.remove();
    },
  };
}

const WIDTH = 320;
const GAP = 10;

const STATUS = {
  sending: 'composer.sending',
  harvested: 'composer.harvested',
  failed: 'composer.failed',
} as const satisfies Record<Exclude<ComposerState, 'idle'>, MessageKey>;

const TEMPLATE = `
  <div class="fruitback-composer-drop" aria-hidden="true"></div>
  <textarea data-fruitback-note rows="3"></textarea>
  <button type="button" data-fruitback-identify class="fruitback-composer-identify" aria-expanded="false"></button>
  <div data-fruitback-who class="fruitback-composer-who" hidden>
    <input data-fruitback-name type="text" name="fruitback-name" autocomplete="name" />
    <input data-fruitback-email type="email" name="fruitback-email" autocomplete="email" />
  </div>
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
  border: 1px solid var(--fruitback-color-border);
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
.fruitback-composer-who { display: flex; gap: 6px; margin-top: 8px; }
.fruitback-composer-who[hidden] { display: none; }
.fruitback-composer-who input {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid var(--fruitback-color-border-strong);
  border-radius: var(--fruitback-radius-sm);
  font: inherit;
  font-size: 12px;
  color: inherit;
  background: var(--fruitback-color-surface);
}
.fruitback-composer-who input:focus-visible { outline: 2px solid var(--fruitback-color-accent); outline-offset: 1px; }
.fruitback-composer-foot { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.fruitback-composer-status { flex: 1; font-size: 12px; color: var(--fruitback-color-text-muted); }
.fruitback-composer-ghost, .fruitback-composer-send {
  border: 0;
  border-radius: var(--fruitback-radius-pill);
  padding: 8px 14px;
  font: 600 13px/1 inherit;
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
.fruitback-composer[data-fruitback-state="harvested"] .fruitback-composer-status {
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
