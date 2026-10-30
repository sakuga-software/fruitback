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

/**
 * A site as the Sites screen names it (FRU-408): its origin with no scheme, when the scheme is the
 * one `siteAddress` gives the host typed alone. `https://acme.dev` is `acme.dev`, and
 * `http://localhost:3000` is `localhost:3000`. The other scheme is kept, `http://acme.dev` or
 * `https://localhost:3000`, so two sites that differ by their scheme alone still read as two, and
 * the name typed again gives the same site.
 */
export function siteName(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return origin;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return url.origin;

  return url.protocol.slice(0, -1) === defaultScheme(url.host) ? url.host : url.origin;
}

/**
 * The second-level labels under which a country code sells names (FRU-547): `acme.co.uk` is the
 * domain, not `co.uk`. A short list, not the public suffix list: a name it does not know reads with
 * two labels, `shop.acme.example` as `acme.example`.
 */
const SECOND_LEVELS = new Set(['ac', 'co', 'com', 'edu', 'gov', 'net', 'org', 'ne', 'or', 'gob', 'gouv']);

/**
 * The domain of a site as the column « Site » of the notes shows it (FRU-547): the name and its
 * extension, with no subdomain, no scheme and no port. `https://app.fruitback.com` is
 * `fruitback.com`, `https://staging.acme.co.uk` is `acme.co.uk`. A host that has no domain stays
 * whole: `localhost:5177` is `localhost`, an address IP is itself.
 */
export function domainOf(origin: string): string {
  let hostname: string;
  try {
    hostname = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(origin) ? origin : `https://${origin}`).hostname;
  } catch {
    return origin;
  }
  if (hostname.startsWith('[') || /^\d+(\.\d+){3}$/.test(hostname)) return hostname;
  const labels = hostname.replace(/\.$/, '').split('.');
  if (labels.length <= 2) return labels.join('.');
  const [second = '', top = ''] = labels.slice(-2);
  const kept = top.length === 2 && SECOND_LEVELS.has(second) ? 3 : 2;

  return labels.slice(-kept).join('.');
}
