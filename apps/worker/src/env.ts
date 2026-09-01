import { z } from 'zod';
import { type ClientMap, originsFromClients, readClientMap, unreadableClients } from './clients.ts';
import { DEFAULT_LIMIT } from './rate-limit.ts';

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
  /** Requests per minute per client IP. Defaults to 20; the E2E suite raises it. */
  RATE_LIMIT_PER_MINUTE?: string;
  PORT?: string;
  HOST?: string;
  /**
   * Dev only: serve the playground off an in-memory Linear instead of the real API, so the whole
   * capture → issue → pins loop runs with no key and writes to nobody's workspace. Ignored when
   * `NODE_ENV=production` — which the Dockerfile sets — so it cannot be talked into a deploy.
   */
  FRUITBACK_FAKE_LINEAR?: string;
  NODE_ENV?: string;
  /**
   * Multi-tenant routing as JSON, e.g.
   * `{"acme":{"teamId":"team_1","projectId":"proj_1","origins":["https://acme.test"]}}`.
   * Absent means one client, which is how this worker has always behaved. See `clients.ts`.
   */
  FRUITBACK_CLIENTS?: string;
  /** Shared with the client site so it can mint identity tokens (SKG-498). */
  FRUITBACK_IDENTITY_SECRET?: string;
  /** `1` keeps Linear comments out of the read path (SKG-502). */
  FRUITBACK_HIDE_COMMENTS?: string;
  /**
   * Who may read pins: `public` (the default, and what this worker has always done) or
   * `authenticated` (SKG-533). A mapped client's own `read` overrides this.
   */
  FRUITBACK_READ?: string;
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
  /**
   * Shared with the client site so it can mint identity tokens (SKG-498). Absent — the default —
   * means every reporter is self-declared, which is a perfectly good way to run this.
   *
   * **This is the single-client key.** A worker with a client map ignores it: each client declares
   * its own `identitySecret` or has none, because one signing key shared across tenants lets a
   * compromised tenant mint verified identities on anyone else's issues.
   *
   * 32 characters minimum, because a short HMAC secret is a guessable one.
   */
  identitySecret: z.string().min(32).optional(),
  /**
   * Show the team's Linear replies inside the pin (SKG-502). On unless `FRUITBACK_HIDE_COMMENTS` is
   * set. A mapped client's own `showComments` overrides this.
   */
  showComments: z.boolean(),
  /**
   * Who may read pins when a client does not say for itself (SKG-533).
   *
   * **`public` by default, and that is a compatibility decision rather than a security one.** Every
   * deployment before this change served reads to anyone, so defaulting to `authenticated` would
   * make pins vanish from every upgraded worker with no error anywhere — the operator would learn
   * about it from users. The exposure is instead made *sayable*: the boot log names every client
   * whose pins anyone can read, and `/health` counts them. Loud beats silent, in both directions.
   *
   * An unrecognised value is refused rather than defaulted, like `TRUSTED_PROXY_HOPS`: a typo here
   * would quietly leave the read path open.
   */
  read: z.enum(['public', 'authenticated']),
  allowedOrigins: z.array(z.string().min(1)).min(1),
  trustedProxyHops: z.number().int().min(0),
  rateLimitPerMinute: z.number().int().positive(),
  /**
   * Absent on a single-client worker. Present, a client has to be named on **both** paths: on a read
   * to decide what may be seen, and on a write to decide where the issue is created — the default
   * team would be the leak in either direction.
   */
  clients: z.custom<ClientMap | undefined>().optional(),
  /** True only in the dev loop — see `FRUITBACK_FAKE_LINEAR`. Surfaced on `/health`. */
  fakeLinear: z.boolean(),
});

export type WorkerConfig = z.infer<typeof configSchema>;

export type ConfigResult = { ok: true; config: WorkerConfig } | { ok: false; missing: string[] };

/**
 * Validate the environment up front, so a missing secret surfaces once — at boot and on `/health` —
 * instead of as an opaque Linear error on every request.
 */
export function readConfig(env: WorkerEnv): ConfigResult {
  const fakeLinear = usesFakeLinear(env);
  const clients = readClientMap(env.FRUITBACK_CLIENTS);
  const candidate = {
    // In fake mode nothing ever reaches Linear, so the credentials are stand-ins rather than
    // optional: every downstream type stays exactly as it is in production.
    linearApiKey: fakeLinear ? FAKE_LINEAR_VALUE : env.LINEAR_API_KEY,
    linearTeamId: fakeLinear ? FAKE_LINEAR_VALUE : env.LINEAR_TEAM_ID,
    linearProjectId: env.LINEAR_PROJECT_ID || undefined,
    identitySecret: env.FRUITBACK_IDENTITY_SECRET || undefined,
    showComments: env.FRUITBACK_HIDE_COMMENTS !== '1',
    read: readAccess(env.FRUITBACK_READ),
    // A client's own `origins` are sites that must be able to reach this worker, so they join the
    // allowlist rather than having to be repeated in `ALLOWED_ORIGINS` — two lists to keep in step
    // is one list that drifts.
    allowedOrigins: [
      ...new Set([
        ...splitOrigins(env.ALLOWED_ORIGINS),
        ...originsFromClients(clients.ok ? clients.clients : undefined),
      ]),
    ],
    trustedProxyHops: readTrustedProxyHops(env.TRUSTED_PROXY_HOPS),
    rateLimitPerMinute: readRateLimit(env.RATE_LIMIT_PER_MINUTE),
    // A malformed map is a misconfiguration, not a reason to quietly pool every client into one
    // team — which is precisely the leak the map exists to prevent.
    clients: clients.ok ? clients.clients : Number.NaN,
    fakeLinear,
  };

  const result = configSchema.safeParse(candidate);

  if (result.success && clients.ok) {
    // Refused at boot rather than served as a permanent 401 (SKG-533). A client that requires a
    // verified reader and has no key to verify one with answers nobody, for ever, and the symptom —
    // a widget showing no pins — points at the browser rather than at this line of configuration.
    const unreadable = unreadableClients({
      read: result.data.read,
      clients: result.data.clients,
      identitySecret: result.data.identitySecret,
    });

    if (unreadable.length > 0) {
      return {
        ok: false,
        missing: [`FRUITBACK_IDENTITY_SECRET (read is "authenticated" but ${unreadable.join(', ')} has no key)`],
      };
    }

    return { ok: true, config: result.data };
  }

  if (!clients.ok) {
    return { ok: false, missing: [...missingFrom(result), `FRUITBACK_CLIENTS (${clients.reason})`] };
  }

  return { ok: false, missing: missingFrom(result) };
}

/**
 * Absent means `public`, which is what every worker did before SKG-533. Anything else is passed
 * through verbatim so the enum refuses it — a misspelt `FRUITBACK_READ=authenticaed` must not fall
 * back to the open setting it was written to close.
 */
function readAccess(value: string | undefined): string {
  return value === undefined || value.trim() === '' ? 'public' : value.trim();
}

const NAMES_BY_FIELD: Record<string, string> = {
  linearApiKey: 'LINEAR_API_KEY',
  linearTeamId: 'LINEAR_TEAM_ID',
  allowedOrigins: 'ALLOWED_ORIGINS',
  trustedProxyHops: 'TRUSTED_PROXY_HOPS',
  rateLimitPerMinute: 'RATE_LIMIT_PER_MINUTE',
  read: 'FRUITBACK_READ',
};

function missingFrom(result: z.ZodSafeParseResult<unknown>): string[] {
  if (result.success) return [];

  const missing = result.error.issues
    .map((issue) => NAMES_BY_FIELD[String(issue.path[0])])
    .filter((name): name is string => name !== undefined);

  return [...new Set(missing)];
}

/** Obvious in a log line, and impossible to mistake for a real key someone forgot to rotate. */
const FAKE_LINEAR_VALUE = 'fake-linear-dev';

/**
 * Whether this process runs on the in-memory Linear.
 *
 * The production guard is the point: `NODE_ENV=production` is set in the Dockerfile, so a container
 * that somehow inherits the flag ignores it and reports itself misconfigured — loudly, on `/health`
 * — instead of quietly accepting feedback into a store that disappears on restart.
 */
export function usesFakeLinear(env: WorkerEnv): boolean {
  const asked = env.FRUITBACK_FAKE_LINEAR === '1' || env.FRUITBACK_FAKE_LINEAR?.toLowerCase() === 'true';

  return asked && env.NODE_ENV !== 'production';
}

/** True when the flag was set but refused — worth saying out loud at boot. */
export function fakeLinearRefused(env: WorkerEnv): boolean {
  return env.FRUITBACK_FAKE_LINEAR !== undefined && env.FRUITBACK_FAKE_LINEAR !== '' && !usesFakeLinear(env);
}

/**
 * Every origin this worker serves: `ALLOWED_ORIGINS` plus the sites declared per client in
 * `FRUITBACK_CLIENTS`, so a client's origins are written once instead of twice.
 *
 * Exported and used **both** by the validated config and by the misconfigured-response path, which
 * has no validated config to read. Computing it in two places is how a client reachable only through
 * the map lost its CORS headers on the 500 — turning the diagnostic the browser was meant to read
 * into an opaque failure, which is the one thing that branch exists to prevent.
 */
export function readAllowedOrigins(env: WorkerEnv): string[] {
  const clients = readClientMap(env.FRUITBACK_CLIENTS);

  return [
    ...new Set([...splitOrigins(env.ALLOWED_ORIGINS), ...originsFromClients(clients.ok ? clients.clients : undefined)]),
  ];
}

/** Exported so the misconfigured-response path can read the allowlist before validation. */
export function splitOrigins(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/**
 * Requests per minute per client IP. Left alone in production; raised for the E2E suite, where every
 * request comes from the same loopback address and the default ceiling would be reached mid-run.
 */
function readRateLimit(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_LIMIT;

  const parsed = Number(value);

  // Refused rather than defaulted, like the hop count: a typo must not silently widen the ceiling.
  return Number.isInteger(parsed) && parsed > 0 ? parsed : Number.NaN;
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
