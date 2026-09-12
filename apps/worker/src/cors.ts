const ALLOW_ANY_ORIGIN = '*';

/**
 * The schemes a browser extension's own pages and service worker send as their `Origin` (SKG-596).
 *
 * Named one by one rather than as "anything that is not http", because a scheme list fails closed:
 * `null`, `file://` and whatever a browser adds next fall through to the allowlist, where they
 * belong. One predicate for the whole worker — `resolveCors` and `resolveClient` both ask it, and
 * two copies of this rule would drift apart in silence.
 */
const EXTENSION_SCHEMES = ['chrome-extension:', 'moz-extension:', 'safari-web-extension:'];

/**
 * True for the extension's own origin, which no operator can put on an allowlist.
 *
 * The id differs between an unpacked build and a store build, so `ALLOWED_ORIGINS` cannot name it.
 * Admitting it grants exactly what a request with no `Origin` already has — `curl` is served today,
 * and CORS was never what decides who may read a pin. Under `read: 'authenticated'` the token still
 * is.
 */
export function isExtensionOrigin(origin: string): boolean {
  return EXTENSION_SCHEMES.some((scheme) => origin.startsWith(`${scheme}//`));
}

export type CorsDecision = {
  /** False only when a browser sent an `Origin` we do not serve. */
  allowed: boolean;
  headers: Record<string, string>;
};

/**
 * The widget runs on client sites, so every request is cross-origin by design.
 *
 * A request with no `Origin` is not a browser request (curl, a health check, server-to-server) and
 * is allowed: there is no cookie or session auth here, so there is nothing for a forged
 * cross-site request to escalate. What the allowlist protects is quota — it stops an unrelated site
 * from posting into your Linear through your Worker.
 *
 * An extension origin is allowed for the same reason, and it is the one this batch needed: the
 * extension relays a client site's call from its own service worker (SKG-596), which sends
 * `chrome-extension://<id>` on the POST, and no allowlist can name that id.
 */
export function resolveCors(request: Request, allowedOrigins: string[]): CorsDecision {
  const origin = request.headers.get('Origin');
  if (origin === null) return { allowed: true, headers: {} };

  const allowAny = allowedOrigins.includes(ALLOW_ANY_ORIGIN);
  const allowed = allowAny || isExtensionOrigin(origin) || allowedOrigins.some((candidate) => candidate === origin);
  if (!allowed) return { allowed: false, headers: {} };

  return {
    allowed: true,
    headers: {
      'Access-Control-Allow-Origin': origin,
      // The response differs per origin; without this a shared cache would serve the wrong header.
      Vary: 'Origin',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      // `Authorization` is not optional here, and leaving it out made the identity feature
      // unreachable from a browser (SKG-518). `embed.ts` sends `Authorization: Bearer …` on both the
      // read and the write when a host mints a token. That header is not CORS-safelisted, so the
      // request is preflighted, and a preflight that does not list it is refused by the browser
      // before the worker sees anything — `read: 'authenticated'` answered nobody, and a verified
      // reporter could never be posted cross-origin. Raised in review; nothing server-side could
      // have noticed, because the request never arrived.
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  };
}

/**
 * CORS for the extension's session routes, which are **not** bound to the site allowlist (SKG-535).
 *
 * `ALLOWED_ORIGINS` lists the client *sites* the widget is embedded on. An extension is not one of
 * them: its origin is `chrome-extension://<id>`, and that id differs between an unpacked build and a
 * store build — so asking an operator to add it is a rule that breaks on the day they publish.
 * Measured before this was written: an MV3 service worker posting JSON sends that origin and
 * triggers a preflight, and both answered `403` against a normal allowlist.
 *
 * Echoing any origin is safe on these three routes because they carry no ambient authority. There is
 * no cookie to ride on, the pairing code is a secret the caller must already hold, and the refresh
 * token lives in extension storage no page can read. What protects the pairing endpoint from being
 * guessed at is the rate limiter, which is why it runs above the path dispatch.
 */
export function openCors(request: Request): CorsDecision {
  const origin = request.headers.get('Origin');
  if (origin === null) return { allowed: true, headers: {} };

  return {
    allowed: true,
    headers: {
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  };
}

/**
 * Headers for the one response that has to be readable even when there is no allowlist to check
 * against: `500 misconfigured`. Echoing the origin is safe here — the body says only that the Worker
 * is missing a variable, and carries no user or client data.
 */
export function diagnosticCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin');
  if (origin === null) return {};

  return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
}
