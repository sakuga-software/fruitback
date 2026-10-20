/**
 * The address of a site, as somebody types it (FRU-167).
 *
 * An address is said and copied without its scheme. The scheme then follows the host (FRU-314): a
 * host of this machine or of the local network is `http://`, every other host is `https://`. The
 * extension reads a pattern with no scheme by the same rule (`site-patterns.ts`, and
 * `docs/reviewing.md`). The screens send what this answers, and show their own sentence when it
 * answers nothing: a field of type `url` stopped the form with the browser's bubble, in the
 * browser's language.
 *
 * The worker decides what a site is (`siteOrigin`). This only refuses what cannot be an address.
 */
export function siteAddress(typed: string): string | undefined {
  const value = typed.trim();
  if (value === '' || /\s/.test(value)) return undefined;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `${defaultScheme(value)}://${value}`;
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

/**
 * The scheme of an address typed with none (FRU-314). `http` for a host of this machine or of the
 * local network, where a dev server or an internal staging has no certificate; `https` for every
 * other host.
 *
 * Local: `localhost` and `*.localhost`, `127.0.0.0/8`, `[::1]`, `*.local`, and the private ranges
 * `10/8`, `172.16/12`, `192.168/16`. A copy of this rule is in `apps/extension/src/site-patterns.ts`,
 * and both tests hold the same table.
 */
export function defaultScheme(withoutScheme: string): 'http' | 'https' {
  let hostname: string;
  try {
    hostname = new URL(`http://${withoutScheme.trim()}`).hostname;
  } catch {
    return 'https';
  }

  return isLocalHost(hostname.replace(/^\*\./, '').replace(/\.$/, '')) ? 'http' : 'https';
}

function isLocalHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) return true;
  if (hostname === '[::1]') return true;

  const ip = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(hostname);
  if (ip === null) return false;
  const [first, second] = [Number(ip[1]), Number(ip[2])];

  return (
    first === 127 ||
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

/**
 * A site as the console writes it: its origin, scheme included (FRU-314). Two sites that differ by
 * their scheme alone must not read as one, so no screen drops it.
 */
export function siteLabel(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return origin;
  }
}
