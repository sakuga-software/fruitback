import { canonicalizePageUrl, type SeedIssue, type SeedReporter, type SeedScreenshot } from '@fruitback/shared';
import { captureSeed } from './capture.ts';
import { type WidgetConfig, createConfigStore } from './config.ts';
import { type CaptureHost, type CaptureTarget, createCaptureHost } from './host.ts';
import { type Composer, createComposer } from './composer.ts';
import { type Overlay, createOverlay } from './overlay.ts';
import { type ConfigPanel, createConfigPanel } from './panel.ts';

/**
 * One call that mounts the whole widget on a page (SKG-505).
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
  /** Shown on the floating button. */
  label?: string;
  /**
   * A short-lived JWT identifying the visitor (SKG-498). Called before every write, so a token that
   * expires mid-session is refreshed rather than rejected. Without it every reporter is
   * self-declared, which is the default and a perfectly good way to run this.
   */
  identityToken?: () => string | undefined | Promise<string | undefined>;
  /**
   * Take a picture of the element the note is about, and return where it now lives (SKG-495).
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
  /** Chrome the page mounts around the widget, which the pointer must skip. */
  ignore?: (element: Element) => boolean;
  /** Off when the reporter has not agreed to send their user agent along. */
  includeEnv?: boolean;
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
   * The settings panel, in case the host wants its own way in — a menu item rather than the gear.
   *
   * The store behind it is deliberately not exposed: a host that could write preferences directly is
   * a host we could never change them under.
   */
  settings: ConfigPanel;
  destroy(): void;
};

/** The panel writes on every keystroke, so a typed endpoint must not become a request per character. */
const REQUERY_DEBOUNCE_MS = 300;

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

  const config = createConfigStore({
    // `screenshot` off at the start: it is the reporter's to turn on, and an image of the page they
    // are looking at is not something to start sending because a default said so.
    defaults: { endpoint: options.endpoint, clientId: options.clientId, hiddenStages: [], screenshot: false },
  });

  let target: CaptureTarget | null = null;
  let composer: Composer;
  let panel: ConfigPanel;

  const host: CaptureHost = createCaptureHost({
    document,
    label: options.label,
    ignore: options.ignore,
    onConfigure: () => panel.toggle(),
    onSelect: (selected) => {
      target = selected;
      const rect = selected.element.getBoundingClientRect();
      composer.open({
        left: rect.left + view.scrollX,
        top: rect.top + view.scrollY,
        bottom: rect.bottom + view.scrollY,
        right: rect.right + view.scrollX,
      });
    },
  });

  const overlay: Overlay = createOverlay({
    document,
    host: host.root,
    shouldShow: (issue) => !config.get().hiddenStages.includes(issue.stage),
  });

  const read = createReader(overlay, view, options);

  composer = createComposer({
    document,
    host: host.panel,
    onSubmit: async (note, reporter) => {
      const planted = await plant({ note, target, reporter, config: config.get(), options });
      if (!planted) return false;

      // Re-read rather than assume: the pin the reporter is about to see is the one the worker gave
      // back, which is also what proves the write landed somewhere the read path can find.
      await read(config.get());

      return true;
    },
  });

  panel = createConfigPanel({
    document,
    host: host.root,
    store: config,
    screenshotSupported: options.captureScreenshot !== undefined,
  });

  // A preference change redraws from the issues already held; only a change of endpoint or client
  // means the pins belong to a different query. Debounced because the panel writes per keystroke —
  // and `createReader`'s generation check is what makes it correct rather than merely cheap.
  let previous = config.get();
  let requery: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = config.subscribe((next) => {
    const requeried = next.endpoint !== previous.endpoint || next.clientId !== previous.clientId;
    previous = next;

    if (!requeried) {
      overlay.refilter();

      return;
    }

    if (requery !== undefined) clearTimeout(requery);
    requery = setTimeout(() => void read(next), REQUERY_DEBOUNCE_MS);
  });

  const stopWatchingUrl = watchUrl(view, () => void read(config.get()));

  void read(config.get());

  return {
    refresh: () => read(config.get()),
    settings: panel,
    destroy() {
      if (requery !== undefined) clearTimeout(requery);
      stopWatchingUrl();
      unsubscribe();
      panel.destroy();
      composer.destroy();
      overlay.destroy();
      host.destroy();
    },
  };
}

/**
 * Reads that ignore their own stale answers.
 *
 * Two can be in flight — a keystroke in the settings, then a navigation — and nothing makes them
 * settle in the order they were sent: a wrong host can take longer to fail than a right one takes to
 * answer. The late one would then draw pins fetched from the old endpoint over the correct ones.
 * Each call takes a generation, and only the newest may touch the screen.
 */
function createReader(
  overlay: Overlay,
  view: Window & typeof globalThis,
  options: FruitbackOptions,
): (config: WidgetConfig) => Promise<void> {
  let generation = 0;

  return async function read(config: WidgetConfig): Promise<void> {
    const mine = ++generation;
    const url = canonicalizePageUrl(view.location.href);

    try {
      // Sent on reads too since SKG-533: a client configured `read: 'authenticated'` answers 401
      // without one. Asked for per read rather than once, for the same reason the write path does —
      // a short-lived token that expired mid-session would otherwise turn every later read into a
      // 401 until the page is reloaded.
      const token = await options.identityToken?.();
      if (mine !== generation) return;

      const response = await fetch(
        `${config.endpoint}/feedback?url=${encodeURIComponent(url)}&client=${encodeURIComponent(config.clientId)}`,
        token === undefined ? undefined : { headers: { Authorization: `Bearer ${token}` } },
      );
      // A 401 lands here like any other failure, and that is deliberate: the pins already on screen
      // are correct, and blanking the page because a token expired would read as "my notes are
      // gone". Same rule as an unreachable worker below.
      if (mine !== generation || !response.ok) return;

      const { issues } = (await response.json()) as { issues: SeedIssue[] };
      if (mine !== generation) return;

      overlay.render(issues);
    } catch {
      // A worker that cannot be reached leaves the pins alone. Blanking the page because a read
      // failed would lose what is already correctly on screen.
    }
  };
}

async function plant({
  note,
  target,
  reporter,
  config,
  options,
}: {
  note: string;
  target: CaptureTarget | null;
  reporter: SeedReporter | undefined;
  config: WidgetConfig;
  options: FruitbackOptions;
}): Promise<boolean> {
  if (target === null) return false;

  const seed = captureSeed({
    element: target.element,
    note,
    client: { id: config.clientId },
    source: target.source,
    reporter,
    includeEnv: options.includeEnv,
    ...optionalScreenshot(await screenshotFor(target.element, config, options)),
  });

  // Asked for per write rather than once at init: a short-lived token that expired mid-session would
  // otherwise turn every later note into a 401.
  const token = await options.identityToken?.();

  const response = await fetch(`${config.endpoint}/feedback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Never in the body: the seed is stored verbatim in a Linear description (SKG-498).
      ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(seed),
  });

  return response.ok;
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
): Promise<SeedScreenshot | undefined> {
  if (!config.screenshot || options.captureScreenshot === undefined) return undefined;

  try {
    const captured = await options.captureScreenshot(element);

    // Checked, not just typed: this package ships to JavaScript too, and a screenshot with no URL is
    // a row in a Linear issue that opens nothing.
    return captured?.url ? captured : undefined;
  } catch {
    return undefined;
  }
}

/** Spread, so an absent screenshot stays absent rather than becoming an empty object. */
function optionalScreenshot(screenshot: SeedScreenshot | undefined): { screenshot?: SeedScreenshot } {
  return screenshot === undefined ? {} : { screenshot };
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
