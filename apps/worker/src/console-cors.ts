import type { WorkerConfig } from './env.ts';

/**
 * The routes of the console, and who may call them from a browser (FRU-98, FRU-150).
 *
 * The console calls with the cookie of a session of better-auth (FRU-147), so its routes answer one
 * origin, the console's, with credentials.
 */

/** The console's origin, the one origin these routes answer with credentials. */
export function consoleOrigin(config: WorkerConfig): string | undefined {
  return config.consoleUrl === undefined ? undefined : new URL(config.consoleUrl).origin;
}

/** Where the console asks which ways to sign in this worker offers (FRU-135). */
export const SIGN_IN_PROVIDERS = '/auth/providers';

/**
 * CORS for the console routes: the console's origin and no other, with credentials.
 *
 * A request with no `Origin` passes this check, and it **can** carry a cookie: a navigation or a
 * form of a page of the same site as the worker sends the cookie of a session of better-auth. So the
 * routes that read that cookie refuse, each one, a call with no `Origin` that changes something: see
 * `callerOf` of `console-api.ts` and `mutationAllowed` of `auth-routes.ts`.
 */
export function consoleCors(
  request: Request,
  config: WorkerConfig,
): { allowed: boolean; headers: Record<string, string> } {
  const origin = request.headers.get('Origin');
  if (origin === null) return { allowed: true, headers: {} };
  if (origin !== consoleOrigin(config)) return { allowed: false, headers: {} };

  return {
    allowed: true,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      Vary: 'Origin',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  };
}

/** `/auth/` is `/auth/providers` and the way to Linear (`/auth/linear/*`) since FRU-150. */
export function isConsoleRoute(pathname: string): boolean {
  return pathname.startsWith('/auth/') || pathname.startsWith('/console/');
}
