/**
 * The address of a site, as somebody types it (FRU-167).
 *
 * An address is said and copied without its scheme, so a host with no scheme is read as `https://`,
 * like the extension reads it (`site-patterns.ts`, and `docs/reviewing.md`). The screens send what
 * this answers, and show their own sentence when it answers nothing: a field of type `url` stopped
 * the form with the browser's bubble, in the browser's language.
 *
 * The worker decides what a site is (`siteOrigin`). This only refuses what cannot be an address.
 */
export function siteAddress(typed: string): string | undefined {
  const value = typed.trim();
  if (value === '' || /\s/.test(value)) return undefined;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  // The worker refuses credentials in an address, and `mailto:ana@acme.dev` would read as some.
  if (url.username !== '' || url.password !== '') return undefined;
  // One word is a typo more often than a host: `staging` alone names nothing a visitor can open.
  const named = url.hostname === 'localhost' || url.hostname.includes('.') || url.hostname.startsWith('[');

  return named ? withScheme : undefined;
}
