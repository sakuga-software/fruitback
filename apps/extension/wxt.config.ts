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
  zip: {
    // The name of the archive a store takes. Without it wxt builds one from the package name, and
    // `@fruitback/extension` becomes `fruitbackextension-0.1.0-chrome.zip` (SKG-616).
    name: 'fruitback',
    // **The sources archive has to build.** AMO rebuilds the extension from it and compares, and
    // this extension imports two workspace packages: an archive of `apps/extension` alone holds no
    // `@fruitback/widget`, no lockfile and no workspace file, so `pnpm install` fails on the first
    // line. The root is the repository, and what goes in is what a build needs. Raised in review.
    sourcesRoot: '../..',
    includeSources: [
      'apps/extension/**',
      'packages/shared/**',
      'packages/widget/**',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'nx.json',
      '.nvmrc',
      'LICENSE',
    ],
    excludeSources: ['**/node_modules/**', '**/dist/**', '**/.output/**', '**/.wxt/**', '**/.nx/**'],
  },
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
    action: { default_title: 'Fruitback' },
    browser_specific_settings: {
      gecko: { id: 'fruitback@sakuga-software.com', strict_min_version: '128.0' },
    },
  },
});
