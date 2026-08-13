import { z } from 'zod';

/**
 * One worker, several client sites (SKG-504).
 *
 * Until now every seed landed in the same team and the same project, whoever sent it, and a read
 * with no `client` parameter answered with **everything on that URL** — which on a shared worker is
 * one client reading another's feedback. This is the map that fixes both: a `clientId` decides where
 * an issue is created and what a read is allowed to see.
 *
 * Two things it is honest about.
 *
 * **`clientId` is still client-asserted.** The seed says who it is, and nothing yet proves it —
 * SKG-498 is where a signed token makes that a claim worth trusting. So `origins` here is not
 * decoration: binding a client to the sites it may be embedded on turns "I am acme" into something
 * the worker can check against the browser's own `Origin`, which is the same trust level CORS
 * already gives and strictly more than nothing.
 *
 * **Configured or not, never both.** With no map, the worker behaves exactly as it did — one team,
 * one project, `client` optional on a read. With a map, `client` becomes required and an unknown one
 * is refused, because the fallback in a multi-tenant deployment is the leak.
 */

const clientSchema = z.object({
  /** Where this client's issues are created and read. Falls back to `LINEAR_TEAM_ID`. */
  teamId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  /**
   * Sites this client may be embedded on. When present, a request claiming this client from another
   * origin is refused — the cheapest check available before SKG-498 lands.
   */
  origins: z.array(z.string().min(1)).min(1).optional(),
});

export const clientMapSchema = z.record(z.string().min(1), clientSchema);

export type ClientConfig = z.infer<typeof clientSchema>;
export type ClientMap = z.infer<typeof clientMapSchema>;

export type ClientMapResult = { ok: true; clients: ClientMap | undefined } | { ok: false; reason: string };

/**
 * `FRUITBACK_CLIENTS` as JSON, e.g.
 * `{"acme":{"teamId":"team_1","projectId":"proj_1","origins":["https://acme.test"]}}`.
 *
 * Refused rather than ignored when malformed: a typo here silently reverts a multi-tenant worker to
 * pooling every client into one team, which is exactly the failure this file exists to prevent.
 */
export function readClientMap(value: string | undefined): ClientMapResult {
  if (value === undefined || value.trim() === '') return { ok: true, clients: undefined };

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { ok: false, reason: 'not valid JSON' };
  }

  const result = clientMapSchema.safeParse(parsed);
  if (!result.success) return { ok: false, reason: result.error.issues[0]?.message ?? 'invalid shape' };
  if (Object.keys(result.data).length === 0) return { ok: false, reason: 'no client in the map' };

  return { ok: true, clients: result.data };
}

export type Routing = {
  teamId: string;
  projectId: string | undefined;
};

export type ClientResolution =
  | { ok: true; routing: Routing }
  /** The caller named nobody on a worker that serves several clients. */
  | { ok: false; reason: 'client-required' }
  | { ok: false; reason: 'unknown-client' }
  /** The client exists, but not on the site the request came from. */
  | { ok: false; reason: 'origin-not-allowed-for-client' };

export type ResolveClientOptions = {
  clients: ClientMap | undefined;
  clientId: string | undefined;
  /** The browser's `Origin`, or null for a request that is not one (curl, server-to-server). */
  origin: string | null;
  fallback: Routing;
};

export function resolveClient({ clients, clientId, origin, fallback }: ResolveClientOptions): ClientResolution {
  // Single-tenant: the map is what turns this worker multi-client, and without it nothing changes.
  if (clients === undefined) return { ok: true, routing: fallback };

  // Trimmed here rather than at each call site: the query parameter and the seed's own `client.id`
  // both land in this function, and a client whose id came back with a stray space resolving on a
  // read but not on a write is the kind of asymmetry nobody finds by reading.
  const id = clientId?.trim();
  if (id === undefined || id === '') return { ok: false, reason: 'client-required' };

  const client = clients[id];
  if (client === undefined) return { ok: false, reason: 'unknown-client' };

  // A request with no Origin is not a browser request, so there is nothing to check it against —
  // the same reasoning `resolveCors` applies, and the same limit: this binds a claim to a site, it
  // does not authenticate anyone.
  if (client.origins !== undefined && origin !== null && !client.origins.includes(origin)) {
    return { ok: false, reason: 'origin-not-allowed-for-client' };
  }

  return {
    ok: true,
    routing: { teamId: client.teamId ?? fallback.teamId, projectId: client.projectId ?? fallback.projectId },
  };
}

/** Every origin any client may be embedded on — the allowlist a multi-tenant worker actually serves. */
export function originsFromClients(clients: ClientMap | undefined): string[] {
  if (clients === undefined) return [];

  return [...new Set(Object.values(clients).flatMap((client) => client.origins ?? []))];
}
