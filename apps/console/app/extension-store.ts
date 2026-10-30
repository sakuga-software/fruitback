/**
 * Where a browser installs the extension. Since 0.3.0 it is on the Chrome Web Store, which Chrome and
 * Edge install from on a computer, and it is public on addons.mozilla.org, which Firefox on a computer
 * installs from (FRU-536). A phone and the other browsers keep the guide, which walks through the
 * archive of the release.
 */
export const CHROME_WEB_STORE = 'https://chromewebstore.google.com/detail/fruitback/jjjemdloknmggncbickofjgbodplekoa';

/** The listing of the extension on addons.mozilla.org, the address `reviewing.md` gives (FRU-521). */
export const FIREFOX_ADDONS = 'https://addons.mozilla.org/en-US/firefox/addon/fruitback/';

/** The page of `reviewing.md` that installs the extension by hand. */
export const EXTENSION_GUIDE = 'https://fruitback.com/reviewing.html#1-install-it';

/**
 * The store of this browser on a computer: the Chrome Web Store for Chrome and Edge, AMO for Firefox;
 * the guide for every other browser. Read from the user agent: Chrome writes `Chrome/`, Edge adds
 * `Edg/`, Firefox writes `Firefox/`; Safari, Opera (`OPR/`) and the browsers of a phone are left to
 * the guide.
 */
export function extensionInstallFor(userAgent: string): string {
  if (/Android|iPhone|iPad|Mobile|CriOS|EdgiOS|FxiOS|OPR\//.test(userAgent)) return EXTENSION_GUIDE;
  if (/Firefox\//.test(userAgent)) return FIREFOX_ADDONS;

  return /Chrome\/|Edg\//.test(userAgent) ? CHROME_WEB_STORE : EXTENSION_GUIDE;
}
