/**
 * « Bot check » (FRU-704): Cloudflare Turnstile, drawn in the composer when the worker answers a note
 * with `403 bot-check` and the site key of its instance. The widget loads Turnstile only then, from
 * the address the host gives (`turnstileScript` of `init`, `TURNSTILE_SCRIPT` by default), draws the
 * check in a part of the composer, and gives the token to the note sent again.
 *
 * - **Nothing here knows the worker.** `plant` of `embed.ts` reads the answer and calls this module;
 *   the composer gives the part of its markup the check is drawn in.
 * - **The text stays.** A check that fails, or a script that does not load, is a `SendFailure` of its
 *   own, said under « Not sent »; the field is never cleared.
 * - Cloudflare documents the script and `turnstile.render` in « Client-side rendering », read
 *   2026-11-27: https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/.
 */

/** Explicit rendering: the script draws nothing by itself, the widget calls `turnstile.render`. */
export const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** The header the note sent again carries its token in. `cors.ts` of the worker lists it. */
export const TURNSTILE_HEADER = 'X-Fruitback-Turnstile';

/** How long the script may take to load before the check is said not to load. */
export const TURNSTILE_LOAD_MS = 15_000;

/** What `window.turnstile` gives, the part the widget calls. */
type TurnstileApi = {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      'error-callback': () => void;
      'expired-callback': () => void;
    },
  ): string | null | undefined;
  remove(widget: string): void;
};

/** `failed`: Turnstile said no, or the token ran out. `unavailable`: the script did not load. */
export type BotCheckOutcome = { token: string } | 'failed' | 'unavailable';

/** The one load of the script for a document, shared by every check of the page. */
const loads = new WeakMap<Document, Promise<TurnstileApi | undefined>>();

function apiOf(view: Window | null): TurnstileApi | undefined {
  const api = (view as (Window & { turnstile?: TurnstileApi }) | null)?.turnstile;

  return typeof api?.render === 'function' ? api : undefined;
}

/**
 * Loads Turnstile in the page, once, and answers its API, or `undefined` when the script does not
 * load: blocked by a CSP, by an extension, by the network, or `timeoutMs` passed. The script goes in
 * the `<head>` of the page: Turnstile draws an iframe, which a Shadow root holds as well as a page.
 * A load that failed is tried again at the next check.
 */
export function loadTurnstile(
  document: Document,
  src: string = TURNSTILE_SCRIPT,
  timeoutMs: number = TURNSTILE_LOAD_MS,
): Promise<TurnstileApi | undefined> {
  const ready = apiOf(document.defaultView);
  if (ready !== undefined) return Promise.resolve(ready);
  const known = loads.get(document);
  if (known !== undefined) return known;

  const script = document.createElement('script');
  script.src = src;
  script.async = true;
  script.dataset.fruitbackTurnstile = '';
  const load = new Promise<TurnstileApi | undefined>((resolve) => {
    const timer = document.defaultView?.setTimeout(() => done(), timeoutMs);
    const done = () => {
      if (timer !== undefined) document.defaultView?.clearTimeout(timer);
      const api = apiOf(document.defaultView);
      if (api === undefined) {
        loads.delete(document);
        script.remove();
      }
      resolve(api);
    };
    script.addEventListener('load', done, { once: true });
    script.addEventListener('error', done, { once: true });
  });
  // Kept before the script goes in: a page may answer its load, or its error, at once.
  loads.set(document, load);
  (document.head ?? document.documentElement).append(script);

  return load;
}

/**
 * Draws the check in `slot` and answers its token, or why there is none. `signal` ends it: the
 * composer closed, and the check is taken out. The check is always taken out when it ends, so a
 * second note draws a new one.
 */
export async function solveTurnstile(
  slot: HTMLElement,
  siteKey: string,
  options: { src?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<BotCheckOutcome> {
  const api = await loadTurnstile(slot.ownerDocument, options.src, options.timeoutMs);
  if (api === undefined) return 'unavailable';
  if (options.signal?.aborted === true) return 'failed';

  return new Promise<BotCheckOutcome>((resolve) => {
    let widget: string | null | undefined;
    let settled = false;
    const end = (outcome: BotCheckOutcome) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', abandon);
      try {
        if (typeof widget === 'string') api.remove(widget);
      } catch {
        // A widget Turnstile removed already: nothing more to take out.
      }
      slot.replaceChildren();
      resolve(outcome);
    };
    const abandon = () => end('failed');
    options.signal?.addEventListener('abort', abandon, { once: true });
    try {
      widget = api.render(slot, {
        sitekey: siteKey,
        callback: (token) => end(typeof token === 'string' && token !== '' ? { token } : 'failed'),
        'error-callback': () => end('failed'),
        'expired-callback': () => end('failed'),
      });
    } catch {
      end('unavailable');
    }
  });
}
