/**
 * Where a worker can answer, and nowhere else.
 *
 * One rule in one place, because it is asked twice and the two answers must not drift: the popup
 * refuses an endpoint before storing it, and `parseBridgeMessage` refuses one before mounting. When
 * only the second checked — which is how this shipped first — a reporter could type `javascript:…`,
 * be told the site was **On**, and watch nothing appear with no error anywhere. Raised in review.
 */
/**
 * The endpoint as the widget will really use it: no query, no fragment, no trailing slash.
 *
 * `embed.ts` builds its calls by interpolation — `${endpoint}/feedback?url=…` — so a value that
 * carries a query swallows the path: `https://worker.test?tenant=a` asks for `/` with a parameter
 * named `tenant` whose value ends in `/feedback`. The reporter is told the site is **On** and sees
 * no pins, which is the same silent shape as the `javascript:` endpoint below. Raised in review.
 *
 * A path is **kept** on purpose. A worker behind `https://example.com/fruitback` is an ordinary
 * Traefik deployment, and reducing this to an origin would break it while fixing the query.
 */
export function normalizeWorkerEndpoint(value: string): string {
  const url = new URL(value);

  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function isWorkerEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;

  try {
    const { protocol } = new URL(value);

    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}
