import { defineConfig } from 'wxt';

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
  manifestVersion: 3,
  manifest: {
    name: 'Fruitback',
    description: 'Leave visual feedback on any site you are allowed to review.',
    permissions: ['storage', 'scripting'],
    // Requested per origin by the popup, at the moment somebody switches a site on.
    optional_host_permissions: ['*://*/*'],
    action: { default_title: 'Fruitback' },
    browser_specific_settings: {
      gecko: { id: 'fruitback@sakuga-software.com', strict_min_version: '128.0' },
    },
  },
});
