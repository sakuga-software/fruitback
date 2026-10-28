import { fileURLToPath } from 'node:url';
import { defineConfig } from 'wxt';
import { ICON_SIZES, iconPath } from './src/icon-sizes.ts';
import { DATA_COLLECTION_PERMISSIONS, FIREFOX_MIN_VERSION } from './src/data-collection.ts';
import { MANIFEST_COMMANDS } from './src/shortcut.ts';
import { noEval } from './src/no-eval.ts';
import { safariManifest } from './src/browser-family.ts';

/** Where the licence lives in the output, and where it is copied from (FRU-82). */
export const LICENSE_IN_OUTPUT = 'LICENSE';

/**
 * The extension is the private mode (FRU-41): the client's site embeds **nothing**, and an ordinary
 * visitor sees nothing because there is nothing in their page to see.
 *
 * **No host permission is asked for at install.** The obvious build declares its content scripts on
 * `<all_urls>`, which asks a reviewer to let a tool read every page they will ever visit — that is a
 * permission an IT department refuses, and the warning is the first thing anyone reads on a store
 * listing. So nothing is declared: `background.ts` registers the two scripts at runtime, for the
 * origins the reviewer turned on and granted, and unregisters them when they turn one off.
 *
 * MV3 on every browser. Firefox is not an afterthought here — wxt would default it to MV2, where the
 * main world the widget needs does not exist. Safari takes the same build, `wxt build -b safari`
 * (FRU-380), wrapped in an app by Xcode: see `safari-xcode.ts`.
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
    // FRU-380: Safari is told its own minimum, and not Firefox's. See `src/browser-family.ts`.
    'build:manifestGenerated': (wxt, manifest) => {
      if (wxt.config.browser === 'safari') safariManifest(manifest);
    },
  },
  manifestVersion: 3,
  // FRU-389: zod with no `Function` constructor, which the validator of AMO calls eval. See
  // `src/no-eval.ts`. The build only: the tests run zod as it is.
  vite: () => ({ plugins: [noEval()] }),
  zip: {
    // The name of the archive a store takes. Without it wxt builds one from the package name, and
    // `@fruitback/extension` becomes `fruitbackextension-0.1.0-chrome.zip` (FRU-77).
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
    // to stop at any moment (FRU-60) — a `setTimeout` would die with it.
    // FRU-296: wxt adds `sidePanel` on Chrome, with `side_panel.default_path`, because
    // `entrypoints/sidepanel/` exists; on Firefox it writes `sidebar_action`, which asks for no
    // permission. `sidePanel` adds no warning at install: `e2e/side-panel.spec.ts` asks Chrome.
    // FRU-423: `contextMenus` for « Capture with Fruitback »: a click on it grants `activeTab`, which a
    // capture needs in team mode, where nobody clicked the icon. It adds no warning at install.
    permissions: ['storage', 'scripting', 'activeTab', 'alarms', 'contextMenus'],
    // Requested per origin by the popup, at the moment somebody switches a site on.
    // FRU-425: `<all_urls>`, requested only by « Allow captures on every site » of the options page:
    // `tabs.captureVisibleTab` takes it, and refuses `*://*/*`. Optional, so nothing changes at install.
    optional_host_permissions: ['*://*/*', '<all_urls>'],
    // Without these the browser draws a grey square with an initial, in the toolbar and in the list
    // of extensions, and a store listing is refused for want of a 128px one (FRU-78).
    icons: Object.fromEntries(ICON_SIZES.map((size) => [size, iconPath(size)])),
    action: { default_title: 'Fruitback' },
    // FRU-291: the key that starts a note. A command asks for no permission and adds no warning at
    // install. The browser owns the key, so the page never sees it: see `src/shortcut.ts`.
    commands: MANIFEST_COMMANDS,
    browser_specific_settings: {
      gecko: {
        id: 'fruitback@sakuga-software.com',
        strict_min_version: FIREFOX_MIN_VERSION,
        data_collection_permissions: DATA_COLLECTION_PERMISSIONS,
      },
    },
  },
});
