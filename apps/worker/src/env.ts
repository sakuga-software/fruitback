import { z } from 'zod';

/**
 * Configuration comes from the process environment — Dokploy injects it, `docker compose` reads it
 * from `.env`. It is passed explicitly rather than read from `process.env` inside the handler so the
 * tests stay hermetic.
 */
export type WorkerEnv = {
  /** Linear personal API key. A secret — never baked into the image, never sent to the client. */
  LINEAR_API_KEY?: string;
  LINEAR_TEAM_ID?: string;
  LINEAR_PROJECT_ID?: string;
  /** Comma-separated client origins, or `*`. */
  ALLOWED_ORIGINS?: string;
  /** How many reverse proxies sit in front of this process. See `resolveClientIp`. */
  TRUSTED_PROXY_HOPS?: string;
  PORT?: string;
  HOST?: string;
};

export const DEFAULT_PORT = 8080;
/** Containers must listen on every interface, or nothing outside the container can reach them. */
export const DEFAULT_HOST = '0.0.0.0';
/** One hop: Dokploy's Traefik. Raise it if another proxy (a CDN, a load balancer) is added upstream. */
export const DEFAULT_TRUSTED_PROXY_HOPS = 1;

const configSchema = z.object({
  linearApiKey: z.string().min(1),
  linearTeamId: z.string().min(1),
  linearProjectId: z.string().min(1).optional(),
  allowedOrigins: z.array(z.string().min(1)).min(1),
  trustedProxyHops: z.number().int().min(0),
});

export type WorkerConfig = z.infer<typeof configSchema>;

export type ConfigResult = { ok: true; config: WorkerConfig } | { ok: false; missing: string[] };

/**
 * Validate the environment up front, so a missing secret surfaces once — at boot and on `/health` —
 * instead of as an opaque Linear error on every request.
 */
export function readConfig(env: WorkerEnv): ConfigResult {
  const candidate = {
    linearApiKey: env.LINEAR_API_KEY,
    linearTeamId: env.LINEAR_TEAM_ID,
    linearProjectId: env.LINEAR_PROJECT_ID || undefined,
    allowedOrigins: splitOrigins(env.ALLOWED_ORIGINS),
    trustedProxyHops: readTrustedProxyHops(env.TRUSTED_PROXY_HOPS),
  };

  const result = configSchema.safeParse(candidate);
  if (result.success) return { ok: true, config: result.data };

  const namesByField: Record<string, string> = {
    linearApiKey: 'LINEAR_API_KEY',
    linearTeamId: 'LINEAR_TEAM_ID',
    allowedOrigins: 'ALLOWED_ORIGINS',
    trustedProxyHops: 'TRUSTED_PROXY_HOPS',
  };
  const missing = result.error.issues
    .map((issue) => namesByField[String(issue.path[0])])
    .filter((name): name is string => name !== undefined);

  return { ok: false, missing: [...new Set(missing)] };
}

/** Exported so the misconfigured-response path can read the allowlist before validation. */
export function splitOrigins(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

function readTrustedProxyHops(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_TRUSTED_PROXY_HOPS;

  const parsed = Number(value);

  // A typo here would silently make the rate limit forgeable, so refuse rather than fall back.
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : Number.NaN;
}

export function readPort(env: WorkerEnv): number {
  const parsed = Number(env.PORT ?? '');

  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
}
