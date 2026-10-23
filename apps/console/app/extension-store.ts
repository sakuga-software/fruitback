/**
 * Where a browser installs the extension. Since 0.3.0 it is on the Chrome Web Store, which Chrome and
 * Edge install from on a computer. Firefox is not on AMO yet, and a phone installs no extension: they
 * keep the guide, which walks through the archive of the release.
 */
export const CHROME_WEB_STORE = 'https://chromewebstore.google.com/detail/fruitback/jjjemdloknmggncbickofjgbodplekoa';

/** The page of `reviewing.md` that installs the extension by hand. */
export const EXTENSION_GUIDE = 'https://fruitback.com/reviewing.html#1-install-it';

/**
 * The store for Chrome and Edge on a computer, the guide for every other browser. Read from the user
 * agent: Chrome writes `Chrome/`, Edge adds `Edg/`, and Firefox, Safari, Opera (`OPR/`) and the
 * browsers of a phone are left to the guide.
 */
export function extensionInstallFor(userAgent: string): string {
  if (/Android|iPhone|iPad|Mobile|CriOS|EdgiOS|OPR\/|Firefox\//.test(userAgent)) return EXTENSION_GUIDE;

  return /Chrome\/|Edg\//.test(userAgent) ? CHROME_WEB_STORE : EXTENSION_GUIDE;
}
