import { msg } from './i18n.ts';

/**
 * The three browsers this extension is built for (FRU-380), and what differs between them in the
 * words and the links of a screen. The APIs that differ are read where they are used (`sidePanel`,
 * `commands.openShortcutSettings`): this is only for what the build alone tells.
 *
 * No `browser` and no `import.meta.env` here: `browser-family.test.ts` reads every part under
 * `node --test`. The entrypoints pass `import.meta.env` in.
 */
export type BrowserFamily = 'chromium' | 'firefox' | 'safari';

/**
 * The oldest Safari the build loads in (`browser_specific_settings.safari.strict_min_version`). 16.4
 * brought `scripting.registerContentScripts` with `world`, `storage.session` and
 * `navigator.userActivation`, which the extension needs (`browser-compat-data` 8.1.7).
 */
export const SAFARI_MIN_VERSION = '16.4';

/**
 * The manifest of the Safari build, from the one of the three browsers (FRU-380). Safari reads
 * `safari.strict_min_version` and refuses to load below it; the keys of Firefox are left out. The
 * side panel is not here to remove: `entrypoints/sidepanel/` is excluded from the Safari build, so
 * wxt writes neither `side_panel` nor the `sidePanel` permission, which Safari does not know.
 */
export function safariManifest(manifest: object): void {
  // The types of wxt know `gecko` only, though the key is the same for the three browsers.
  (manifest as { browser_specific_settings?: unknown }).browser_specific_settings = {
    safari: { strict_min_version: SAFARI_MIN_VERSION },
  };
}

/** The family of this build, from the flags wxt sets for `-b firefox` and `-b safari`. */
export function browserFamily(env: { FIREFOX?: boolean; SAFARI?: boolean }): BrowserFamily {
  if (env.FIREFOX === true) return 'firefox';
  if (env.SAFARI === true) return 'safari';

  return 'chromium';
}

/** Where the person removes or turns off an extension, as the popup names it (FRU-397). */
export function extensionsPlace(family: BrowserFamily): string {
  if (family === 'firefox') return 'about:addons';
  if (family === 'safari') return SAFARI_EXTENSIONS;

  return 'chrome://extensions';
}

/**
 * Safari has no address for its settings that an extension may open, and no
 * `commands.openShortcutSettings`. The person changes the key in Safari Settings, Extensions
 * (Safari 26 and later).
 */
export const SAFARI_EXTENSIONS = msg('Safari Settings, Extensions');

/**
 * Whether the build may open the page of the shortcuts of Chromium (`chrome://extensions/shortcuts`)
 * when the browser has no `commands.openShortcutSettings`. Firefox and Safari have no such page.
 */
export function opensChromiumShortcuts(family: BrowserFamily): boolean {
  return family === 'chromium';
}
