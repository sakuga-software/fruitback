import type { BrowserFamily } from './browser-family.ts';
import { msg } from './i18n.ts';

/**
 * « Allow captures on every site », in the preferences (FRU-425).
 *
 * `tabs.captureVisibleTab` needs `activeTab` or `<all_urls>`; a host permission on the origin of the
 * site, or the pattern of every web page, is refused (measured on Chromium 145 and 156). `activeTab` is a gesture on each
 * page (FRU-423). A person who would rather grant it once asks for `<all_urls>` here: it is in
 * `optional_host_permissions`, so nothing is asked at install. Turning it off gives it back to the
 * browser (`permissions.remove`).
 */

/** The permission, as `permissions.request` and `permissions.remove` take it. */
export const CAPTURE_EVERYWHERE = { origins: ['<all_urls>'] } as const;

/**
 * What the browser says when it asks: the words of its prompt, which the row quotes. Chrome's is
 * measured in English with `management.getPermissionWarningsByManifest` (`e2e/capture-everywhere.spec.ts`).
 * Firefox's is the text that Mozilla documents for `<all_urls>`, not measured here.
 */
export const BROWSER_WARNING = {
  chrome: msg('Read and change all your data on all websites'),
  firefox: msg('Access your data for all websites'),
} as const;

/**
 * The browser's prompt for this build. None on Safari (FRU-380): Safari asks per site from its own
 * popover, and its words for `<all_urls>` were not read, so the row quotes nothing.
 */
export function browserWarning(family: BrowserFamily): string | undefined {
  if (family === 'safari') return undefined;

  return family === 'firefox' ? BROWSER_WARNING.firefox : BROWSER_WARNING.chrome;
}

/**
 * Asks for the permission, or gives it back. **Called in the click, before anything is awaited**: a
 * request after an `await` has lost the gesture and is refused. Answers whether the permission is
 * held now.
 */
export function setCaptureEverywhere(
  on: boolean,
  permissions: {
    request: (wanted: typeof CAPTURE_EVERYWHERE) => Promise<boolean>;
    remove: (given: typeof CAPTURE_EVERYWHERE) => Promise<boolean>;
  },
): Promise<boolean> {
  if (on) return permissions.request(CAPTURE_EVERYWHERE);

  return permissions.remove(CAPTURE_EVERYWHERE).then((removed) => !removed);
}
