import { fileURLToPath } from 'node:url';
import { defineConfig } from 'wxt';
import { ICON_SIZES, iconPath } from './src/icon-sizes.ts';

/** Where the licence lives in the output, and where it is copied from (SKG-621). */
export const LICENSE_IN_OUTPUT = 'LICENSE';

/**
 * The extension is the private mode (SKG-534): the client's site embeds **nothing**, and an ordinary
 * visitor sees nothing because there is nothing in their page to see.
 *
 * **No host permission is asked for at install.** The obvious build declares its content scripts on
 * `<all_urls>`, which asks a reviewer to let a tool read every page they will ever visit — that is a
 * permission an IT department refuses, and the warning is the first thing anyone reads on a store
 * listing. So nothing is declared: `background.ts` registers the two scripts at runtime, for the
 * origins the reviewer turned on and granted, and unregisters them when they turn one off.
 *
 * MV3 on both browsers. Firefox is not an afterthought here — wxt would default it to MV2, where the
 * main world the widget needs does not exist.
 */
export default defineConfig({
  // **The licence travels with the build.** This extension is AGPL-3.0-only and what a store hands
  // somebody is the archive, not this repository: the AGPL asks for the licence to go with the work.
  // A hook rather than a copy in `public/`, so the text has one home and cannot drift from it.
  hooks: {
    'build:publicAssets': (_wxt, files) => {
      files.push({
        relativeDest: LICENSE_IN_OUTPUT,
        absoluteSrc: fileURLToPath(new URL('LICENSE', import.meta.url)),
      });
    },
  },
  manifestVersion: 3,
  manifest: {
    name: 'Fruitback',
    description: 'Leave visual feedback on any site you are allowed to review.',
    // `activeTab` is what lets the popup read the URL of the tab it was opened on. `tabs.query`
    // answers without it, but withholds `url` — so the popup would decide there is no origin and
    // offer nothing, on every site, forever. Raised in review, and it made a fresh install useless.
    // `alarms` keeps the session's access token fresh from a service worker the browser is free
    // to stop at any moment (SKG-599) — a `setTimeout` would die with it.
    permissions: ['storage', 'scripting', 'activeTab', 'alarms'],
    // Requested per origin by the popup, at the moment somebody switches a site on.
    optional_host_permissions: ['*://*/*'],
    // Without these the browser draws a grey square with an initial, in the toolbar and in the list
    // of extensions, and a store listing is refused for want of a 128px one (SKG-617).
    icons: Object.fromEntries(ICON_SIZES.map((size) => [size, iconPath(size)])),
    action: { default_title: 'Fruitback' },
    browser_specific_settings: {
      gecko: { id: 'fruitback@sakuga-software.com', strict_min_version: '128.0' },
    },
  },
});
