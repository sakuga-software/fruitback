import type { FruitbackTransport } from '@fruitback/widget';

/**
 * What the extension puts on a team-mode page, and how the site finds it (SKG-596).
 *
 * The site's widget is dormant: it has no way to reach the worker until a reviewer with the
 * extension opens the page. This is that way — a transport the site passes straight to `init`.
 *
 * Two ways to find it, because neither content scripts nor the site's own bundle can be ordered
 * against the other: the property is there for a site that looks after the announcement, the event
 * for one that looked before it. A site reads the property in both cases.
 *
 * ```js
 * const mount = () => {
 *   const extension = window.fruitbackExtension;
 *   if (extension !== undefined) init({ endpoint, clientId, transport: extension.transport });
 * };
 * window.addEventListener('fruitback:extension', mount);
 * mount();
 * ```
 */
export const EXTENSION_GLOBAL = 'fruitbackExtension';

export const EXTENSION_EVENT = 'fruitback:extension';

/** Bumped when the shape below changes, so a site can refuse a version it does not know. */
export const EXTENSION_API_VERSION = 1;

export type FruitbackExtensionApi = {
  version: typeof EXTENSION_API_VERSION;
  transport: FruitbackTransport;
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

/** The same guard for the isolated world, where it is on that world's own global. */
export const BRIDGE_SCRIPT_FLAG = '__fruitbackBridgeScript';

declare global {
  interface Window {
    fruitbackExtension?: FruitbackExtensionApi;
    __fruitbackPageScript?: true;
  }
}
