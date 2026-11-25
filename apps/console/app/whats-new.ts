/**
 * « What's new », at the foot of the bar (FRU-684): the releases of Fruitback, on GitHub.
 *
 * The entry has a dot until the person opened it with this version of the console. The version they
 * last opened it with is kept in this browser, as the dismissed release of `release-notice.ts`: the
 * dot comes back with the next version.
 */

/** The releases of Fruitback: the repository is public. */
export const RELEASES = 'https://github.com/sakuga-software/fruitback/releases';

const STORED = 'fruitback:whats-new-seen';

declare const __FRUITBACK_CONSOLE_VERSION__: string | undefined;

/**
 * The version of this console, from its `package.json`, which a release changes. Vite writes it in
 * the build (`define` of `vite.config.ts`). `undefined` where nothing wrote it, as under `node --test`.
 */
export const CONSOLE_VERSION: string | undefined =
  typeof __FRUITBACK_CONSOLE_VERSION__ === 'string' ? __FRUITBACK_CONSOLE_VERSION__ : undefined;

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** The version of the console this browser last opened « What's new » with, or `null`. */
export function seenVersion(): string | null {
  try {
    return storage()?.getItem(STORED) ?? null;
  } catch {
    // Private browsing can refuse storage: the dot shows.
    return null;
  }
}

/** Keeps `version` as seen. A refused storage keeps it for this page only. */
export function markSeen(version: string): void {
  try {
    storage()?.setItem(STORED, version);
  } catch {
    // Not kept: the dot comes back on the next page load.
  }
}

/** Whether the entry has its dot: a version of the console that this browser has not opened it with. */
export function hasNews(version: string | undefined, seen: string | null): boolean {
  return version !== undefined && version !== seen;
}
