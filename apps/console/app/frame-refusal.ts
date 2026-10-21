/**
 * Why the preview of the setup cannot show a site in its frame (FRU-354), when the console knows it
 * before it tries.
 *
 * The console does not ask the site of the person for its headers: no server request goes there.
 * A browser also does not tell the page around a frame that the site refused it (`X-Frame-Options`,
 * CSP `frame-ancestors`): measured on 2026-10-21 in Chromium, Firefox and WebKit, a refused frame
 * fires `load` like a shown one, and its `location`, `origin` and resource timing read the same. So
 * this answers only what the two addresses alone tell, and the person can ask for the address in
 * place of the frame (`asked`).
 *
 * - `console`: the site is the console itself.
 * - `insecure`: the site is `http` and the console `https`. A browser blocks such a frame as mixed
 *   content, except for a host of this machine, which it trusts.
 */
export type Refusal = 'console' | 'insecure' | 'asked';

/** `site` and `console` are origins, such as `https://staging.acme.dev`. */
export function refusalOf(site: string, console: string): Refusal | undefined {
  let url: URL;
  let here: URL;
  try {
    url = new URL(site);
    here = new URL(console);
  } catch {
    return 'insecure';
  }
  if (url.origin === here.origin) return 'console';
  if (here.protocol === 'https:' && url.protocol === 'http:' && !trusted(url.hostname)) return 'insecure';

  return undefined;
}

/** A host a browser trusts on `http`: this machine (the « potentially trustworthy » origins). */
function trusted(host: string): boolean {
  const name = host.toLowerCase();

  return name === 'localhost' || name.endsWith('.localhost') || /^127(?:\.\d{1,3}){3}$/.test(name) || name === '[::1]';
}
