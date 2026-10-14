/**
 * The short label of a browser, « Chrome on macOS », read once from the user agent of the request that
 * opens a session (FRU-249, decision of Mathieu on 2026-10-13, Q7).
 *
 * **The label is made of two words of a closed list, never of the text of the user agent**: a family
 * and a system, each from the lists below, so no version, no device model and nothing a browser can
 * write is kept. The user agent itself is not kept (`docs/privacy.md`), unless the operator sets
 * `FRUITBACK_AUTH_TRACK_IP`.
 *
 * Read in order, because user agents copy each other: Edge and Opera say « Chrome » too, Chrome says
 * « Safari », every browser of iOS says « Safari », and Android says « Linux ».
 */

const FAMILIES: readonly (readonly [string, RegExp])[] = [
  ['Edge', /\bEdg(?:e|A|iOS)?\//],
  ['Opera', /\b(?:OPR|Opera)\//],
  ['Samsung Internet', /\bSamsungBrowser\//],
  ['Firefox', /\b(?:Firefox|FxiOS)\//],
  ['Chrome', /\b(?:Chrome|CriOS|Chromium)\//],
  ['Safari', /\bVersion\/[\d.]+.*\bSafari\//],
];

const SYSTEMS: readonly (readonly [string, RegExp])[] = [
  ['iOS', /\b(?:iPhone|iPad|iPod)\b/],
  ['Android', /\bAndroid\b/],
  ['ChromeOS', /\bCrOS\b/],
  ['Windows', /\bWindows\b/],
  ['macOS', /\bMacintosh\b|\bMac OS X\b/],
  ['Linux', /\bLinux\b/],
];

/** What a label says when the family is not one of the list. */
export const UNKNOWN_BROWSER = 'A browser';

/** A user agent longer than this is not read: no browser sends one, and a regular expression does not run on it. */
const MAX_USER_AGENT = 512;

export function browserLabel(userAgent: unknown): string {
  if (typeof userAgent !== 'string' || userAgent.length > MAX_USER_AGENT) return UNKNOWN_BROWSER;
  const family = FAMILIES.find(([, pattern]) => pattern.test(userAgent))?.[0] ?? UNKNOWN_BROWSER;
  const system = SYSTEMS.find(([, pattern]) => pattern.test(userAgent))?.[0];

  return system === undefined ? family : `${family} on ${system}`;
}

/** Every label `browserLabel` can answer: what a column of labels may hold. */
export function everyBrowserLabel(): string[] {
  const families = [...FAMILIES.map(([name]) => name), UNKNOWN_BROWSER];

  return families.flatMap((family) => [family, ...SYSTEMS.map(([system]) => `${family} on ${system}`)]);
}
