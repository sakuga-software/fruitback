import type { WorkerConfig } from './env';

const ALLOW_ANY_ORIGIN = '*';

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
 */
export function resolveCors(request: Request, config: WorkerConfig): CorsDecision {
  const origin = request.headers.get('Origin');
  if (origin === null) return { allowed: true, headers: {} };

  const allowAny = config.allowedOrigins.includes(ALLOW_ANY_ORIGIN);
  const allowed = allowAny || config.allowedOrigins.some((candidate) => candidate === origin);
  if (!allowed) return { allowed: false, headers: {} };

  return {
    allowed: true,
    headers: {
      'Access-Control-Allow-Origin': origin,
      // The response differs per origin; without this a shared cache would serve the wrong header.
      Vary: 'Origin',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  };
}
