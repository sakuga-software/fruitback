import type { CaptureArea, FruitbackTransport, PickedFile } from '@fruitback/widget';
import type { PageHolder } from './copy.ts';

/**
 * What the extension puts on a team-mode page, and how the site finds it (FRU-57).
 *
 * The site's widget is dormant: it has no way to reach the worker until a reviewer with the
 * extension opens the page. This is that way — a transport the site passes straight to `init`.
 *
 * Two ways to find it, because neither content scripts nor the site's own bundle can be ordered
 * against the other: the property is there for a site that looks after the announcement, the event
 * for one that looked before it. A site reads the property in both cases.
 *
 * **The event fires again when the property goes away** — the reviewer switched this site off, or to
 * private mode. Nothing here can destroy a widget the site owns, so the site is told and destroys
 * its own. One event, read the property, act on what it says:
 *
 * ```js
 * const sync = () => {
 *   const extension = window.fruitbackExtension;
 *   if (extension === undefined) return destroyMyWidget();
 *   if (notMountedYet()) mountWith(extension.transport);
 * };
 * window.addEventListener('fruitback:extension', sync);
 * sync();
 * ```
 */
export const EXTENSION_GLOBAL = 'fruitbackExtension';

export const EXTENSION_EVENT = 'fruitback:extension';

/** Bumped when the shape below changes, so a site can refuse a version it does not know. */
export const EXTENSION_API_VERSION = 1;

export type FruitbackExtensionApi = {
  version: typeof EXTENSION_API_VERSION;
  transport: FruitbackTransport;
  /**
   * A capture of the visible page or of an area of it (FRU-332), which the site passes to `init` as
   * `captureVisible`, beside the transport. A new field: a site that does not pass it offers no
   * capture, and joins the files of the disk all the same. The version does not move.
   */
  captureVisible?: (area?: CaptureArea) => Promise<PickedFile | undefined>;
};

/**
 * Set by the main-world script on the window it has already claimed.
 *
 * The popup injects both content scripts into the open tab on every save, because registering one
 * reaches the *next* page load and not this one. A tab that is already running them then gets a
 * second copy, a second listener, and — on the next mount — a second widget beside the first. The
 * second copy steps aside instead; the first is still correct.
 *
 * A page can set this and keep the widget out. It can already post an `unmount` and get the same
 * result, so this adds nothing a page did not have.
 */
export const PAGE_SCRIPT_FLAG = '__fruitbackPageScript';

/**
 * Beside the flag, since FRU-397: the tag and the proof of the copy that holds the page, and its
 * version. The flag stays `true`, which is what a copy of before steps aside on. A page script finds
 * here whether the page is held by its own copy or by another one: see `holderOf` in `copy.ts`.
 */
export const PAGE_HOLDER = '__fruitbackPageHolder';

/** The same guard for the isolated world, where it is on that world's own global. */
export const BRIDGE_SCRIPT_FLAG = '__fruitbackBridgeScript';

declare global {
  interface Window {
    fruitbackExtension?: FruitbackExtensionApi;
    __fruitbackPageScript?: true;
    __fruitbackPageHolder?: PageHolder;
  }
}
