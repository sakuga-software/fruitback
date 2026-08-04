import { z } from 'zod';

/**
 * Cloudflare's Rate Limiting API binding. Typed here rather than imported so a missing binding is a
 * runtime concern (see `rate-limit.ts`) instead of a compile error.
 */
export interface RateLimiterBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface WorkerEnv {
  /** Linear personal API key. A secret — never a `var`, never sent to the client. */
  LINEAR_API_KEY?: string;
  LINEAR_TEAM_ID?: string;
  LINEAR_PROJECT_ID?: string;
  /** Comma-separated client origins, or `*`. */
  ALLOWED_ORIGINS?: string;
  FEEDBACK_RATE_LIMITER?: RateLimiterBinding;
}

const configSchema = z.object({
  linearApiKey: z.string().min(1),
  linearTeamId: z.string().min(1),
  linearProjectId: z.string().min(1).optional(),
  allowedOrigins: z.array(z.string().min(1)).min(1),
});

export type WorkerConfig = z.infer<typeof configSchema>;

export type ConfigResult = { ok: true; config: WorkerConfig } | { ok: false; missing: string[] };

/**
 * Validate the environment up front, so a missing secret surfaces as one clear 500 instead of an
 * opaque Linear error on every request.
 */
export function readConfig(env: WorkerEnv): ConfigResult {
  const candidate = {
    linearApiKey: env.LINEAR_API_KEY,
    linearTeamId: env.LINEAR_TEAM_ID,
    linearProjectId: env.LINEAR_PROJECT_ID || undefined,
    allowedOrigins: splitOrigins(env.ALLOWED_ORIGINS),
  };

  const result = configSchema.safeParse(candidate);
  if (result.success) return { ok: true, config: result.data };

  const namesByField: Record<string, string> = {
    linearApiKey: 'LINEAR_API_KEY',
    linearTeamId: 'LINEAR_TEAM_ID',
    allowedOrigins: 'ALLOWED_ORIGINS',
  };
  const missing = result.error.issues
    .map((issue) => namesByField[String(issue.path[0])])
    .filter((name): name is string => name !== undefined);

  return { ok: false, missing: [...new Set(missing)] };
}

function splitOrigins(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
