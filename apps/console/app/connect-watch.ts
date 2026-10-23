import type { Answer, ExtensionBrowser } from './api';

/**
 * How often `/connect` reads the browsers of the extension while its tab is shown (FRU-410). Six
 * reads a minute, of the twenty that the worker takes from one address by default
 * (`RATE_LIMIT_PER_MINUTE`): the popup and the tab of « Connect » ask it from the same address.
 * The read that matters is the one made when the tab is shown again.
 */
export const CONNECTED_EVERY_MS = 10_000;

/**
 * How far the clock of the worker and the clock of this browser can be apart. It applies only when
 * the first read was refused (nobody signed in yet): the page then has no list to compare with.
 */
export const CLOCK_MARGIN_MS = 2 * 60_000;

/**
 * The browser that connected since the page opened, if one did. `known`: the browsers of the first
 * read, when it was answered; a browser not in it connected after. With no first list, a browser
 * counts when its `connectedAt` is after the opening of the page, less the margin of the clocks.
 */
export function newlyConnected(
  browsers: readonly ExtensionBrowser[],
  known: ReadonlySet<string> | undefined,
  openedAt: number,
): ExtensionBrowser | undefined {
  if (known !== undefined) return browsers.find((each) => !known.has(each.id));

  return browsers.find((each) => Date.parse(each.connectedAt) >= openedAt - CLOCK_MARGIN_MS);
}

/** What `watchConnection` needs of the document: whether the tab is shown, and when that changes. */
export type ShownPage = {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener: (type: 'visibilitychange', listener: () => void) => void;
  removeEventListener: (type: 'visibilitychange', listener: () => void) => void;
};

export type ConnectionWatch = {
  read: () => Promise<Answer<ExtensionBrowser[]>>;
  page: ShownPage;
  now: () => number;
  onConnected: (browser: ExtensionBrowser) => void;
};

/**
 * Reads the browsers of the extension until one connects, then calls `onConnected` once (FRU-410).
 * The console cannot talk to the extension: the worker is the only one that knows. A hidden tab asks
 * nothing; shown again, it asks at once, because the person comes back from the tab where they
 * pressed « Connect ». A read that fails changes nothing, and the next one is made at its time.
 * Returns the function that stops it.
 */
export function watchConnection({ read, page, now, onConnected }: ConnectionWatch): () => void {
  const openedAt = now();
  let known: Set<string> | undefined;
  let first = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let asking = false;
  let stopped = false;

  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    if (stopped || asking || timer !== undefined || page.visibilityState !== 'visible') return;
    timer = setTimeout(() => void ask(), CONNECTED_EVERY_MS);
  };
  const ask = async () => {
    timer = undefined;
    if (stopped || asking || page.visibilityState !== 'visible') return;
    asking = true;
    // A read that throws is a read that failed: the next one is made at its time.
    const answer = await read().catch((): undefined => undefined);
    asking = false;
    if (stopped) return;
    const wasFirst = first;
    first = false;
    if (answer?.ok === true) {
      // The first list is what was there before: nothing in it connected from this page.
      if (wasFirst) known = new Set(answer.data.map((each) => each.id));
      const found = wasFirst ? undefined : newlyConnected(answer.data, known, openedAt);
      if (found !== undefined) {
        stopped = true;

        return onConnected(found);
      }
    }
    schedule();
  };
  const shown = () => {
    if (page.visibilityState !== 'visible') return cancel();
    cancel();
    void ask();
  };

  page.addEventListener('visibilitychange', shown);
  void ask();

  return () => {
    stopped = true;
    cancel();
    page.removeEventListener('visibilitychange', shown);
  };
}
