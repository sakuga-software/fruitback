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
 * is a teardrop and the confirmation says *récolté* rather than *sent*.
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
   */
  onSubmit: (note: string) => Promise<boolean | void>;
  onClose?: () => void;
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

  const style = document.createElement('style');
  style.textContent = STYLES;

  const root = document.createElement('div');
  root.className = 'fb-composer';
  root.dataset.fbComposer = '';
  root.hidden = true;
  root.innerHTML = TEMPLATE;

  options.host.append(style, root);

  const field = root.querySelector('[data-fb-note]') as HTMLTextAreaElement;
  const send = root.querySelector('[data-fb-send]') as HTMLButtonElement;
  const cancel = root.querySelector('[data-fb-cancel]') as HTMLButtonElement;
  const status = root.querySelector('[data-fb-status]') as HTMLElement;

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
    root.dataset.fbState = next;
    // Disabled while in flight: a second click would plant the same note twice, and the worker has
    // no way to tell the difference.
    send.disabled = next === 'sending' || next === 'harvested';
    field.readOnly = next === 'sending';
    status.textContent = MESSAGES[next];
  }

  async function submit(): Promise<void> {
    if (state === 'sending') return;

    const mine = session;
    setState('sending');
    try {
      const result = await options.onSubmit(field.value);
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
   * Under the element it belongs to, flipped above when there is no room. On a narrow screen the
   * rules below take over entirely and pin it to the bottom of the viewport, so the position set
   * here stops mattering — which is why it is set with `style` and overridden by a media query.
   */
  function place(anchor: { left: number; top: number; bottom: number; right: number }): void {
    const width = view?.innerWidth ?? 0;
    const height = view?.innerHeight ?? 0;
    const scrollY = view?.scrollY ?? 0;
    const own = root.getBoundingClientRect();
    const below = anchor.bottom + GAP;
    const fitsBelow = below + own.height <= scrollY + height;

    // Custom properties rather than inline `left`/`top`: an inline style would beat the media query
    // below and leave the mobile sheet offset by whatever the element's position happened to be.
    root.style.setProperty('--fb-composer-left', `${Math.max(GAP, Math.min(anchor.left, width - WIDTH - GAP))}px`);
    root.style.setProperty('--fb-composer-top', `${fitsBelow ? below : Math.max(0, anchor.top - own.height - GAP)}px`);
  }

  function close(): void {
    session += 1;
    root.hidden = true;
    setState('idle');
    options.onClose?.();
  }

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

const MESSAGES: Record<ComposerState, string> = {
  idle: '',
  sending: 'on plante…',
  harvested: '🍓 récolté',
  failed: 'pas passé — le texte est gardé, réessayez',
};

const TEMPLATE = `
  <div class="fb-composer-drop" aria-hidden="true"></div>
  <textarea data-fb-note rows="3" placeholder="Qu'est-ce qui ne va pas ici ?" aria-label="Votre commentaire"></textarea>
  <div class="fb-composer-foot">
    <span data-fb-status class="fb-composer-status" role="status" aria-live="polite"></span>
    <button type="button" data-fb-cancel class="fb-composer-ghost">Annuler</button>
    <button type="button" data-fb-send class="fb-composer-send">Planter</button>
  </div>
`;

/**
 * The fruit art direction, in the two places it is load-bearing: the drop that ties the popover to
 * the pin, and the rounding that keeps it from looking like a form. `prefers-reduced-motion` turns
 * the animation off rather than shortening it — a widget that overlays someone else's site is the
 * last thing that should ignore that setting.
 */
const STYLES = `
.fb-composer {
  position: absolute;
  /* WIDTH is what place() clamps against, so the rendered box has to be exactly that — with
     content-box the padding sat outside it and the popover could overhang the viewport. Set here
     rather than inherited from the host's reset: this file has to hold up wherever it is mounted. */
  box-sizing: border-box;
  left: var(--fb-composer-left, 0px);
  top: var(--fb-composer-top, 0px);
  z-index: 2147483300;
  width: ${WIDTH}px;
  padding: 14px;
  border-radius: 18px;
  background: #fffdf9;
  color: #1c1917;
  font: 14px/1.5 -apple-system, system-ui, sans-serif;
  box-shadow: 0 14px 40px rgba(28, 25, 23, 0.22);
  animation: fb-composer-in 220ms cubic-bezier(0.22, 1.2, 0.36, 1);
}
.fb-composer[hidden] { display: none; }
.fb-composer-drop {
  position: absolute;
  top: -7px;
  left: 22px;
  width: 14px;
  height: 14px;
  background: #fffdf9;
  /* A seed rather than a triangle: three round corners and one sharp, turned to point at the pin. */
  border-radius: 50% 50% 50% 0;
  transform: rotate(-45deg);
}
.fb-composer textarea {
  display: block;
  width: 100%;
  border: 1px solid #e7e5e4;
  border-radius: 12px;
  padding: 10px 12px;
  font: inherit;
  resize: vertical;
  background: #fff;
  color: inherit;
}
.fb-composer textarea:focus-visible { outline: 2px solid #e53935; outline-offset: 1px; }
.fb-composer-foot { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.fb-composer-status { flex: 1; font-size: 12px; color: #78716c; }
.fb-composer-ghost, .fb-composer-send {
  border: 0; border-radius: 999px; padding: 8px 14px; font: 600 13px/1 inherit; cursor: pointer;
}
.fb-composer-ghost { background: transparent; color: #78716c; }
.fb-composer-send { background: #e53935; color: #fff; }
.fb-composer-send[disabled] { opacity: 0.55; cursor: default; }
.fb-composer[data-fb-state="harvested"] .fb-composer-status { color: #7cb342; font-weight: 600; }
.fb-composer[data-fb-state="failed"] .fb-composer-status { color: #e53935; }

@keyframes fb-composer-in {
  from { opacity: 0; transform: translateY(-6px) scale(0.96); }
  to { opacity: 1; transform: none; }
}

/* Full screen on a phone: a 320px popover anchored to an element is unusable at that width. */
@media (max-width: 640px) {
  .fb-composer {
    position: fixed;
    /* Beats the custom properties above, which are only meaningful for the anchored popover. */
    inset: auto 0 0 0;
    left: 0;
    top: auto;
    width: auto;
    border-radius: 18px 18px 0 0;
    padding: 18px 16px calc(18px + env(safe-area-inset-bottom));
    animation-name: fb-composer-sheet-in;
  }
  .fb-composer-drop { display: none; }
  .fb-composer textarea { min-height: 96px; }
}

@keyframes fb-composer-sheet-in {
  from { transform: translateY(100%); }
  to { transform: none; }
}

@media (prefers-reduced-motion: reduce) {
  .fb-composer { animation: none; }
}
`;
