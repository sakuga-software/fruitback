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
   * origin is refused. Cheap, and independent of whether the visitor is identified.
   */
  origins: z.array(z.string().min(1)).min(1).optional(),
  /**
   * Shared with this client's site so it can mint identity tokens (SKG-498). Without one, this
   * client's reporters are always self-declared — a perfectly good mode, and the default.
   *
   * **Deliberately not inherited from `FRUITBACK_IDENTITY_SECRET`**, unlike `teamId` and
   * `projectId`. Those are routing; this is a signing key. One secret shared across tenants means a
   * compromised tenant can mint a *verified* identity on any other tenant's issues — the same
   * reasoning as the fallback team above, and the same answer: on a multi-tenant worker the default
   * is the leak.
   */
  identitySecret: z.string().min(32).optional(),
  /**
   * Show the team's Linear replies inside the pin (SKG-502). **On by default**, because closing that
   * loop is the point of the feature.
   *
   * Since SKG-533 this is an editorial switch again rather than an access control: under
   * `read: 'authenticated'` the reader is someone this worker checked, so the comments are already
   * only reaching people entitled to them. Under `read: 'public'` it is still the only thing standing
   * between an issue thread and anyone who can load the page.
   */
  showComments: z.boolean().optional(),
  /**
   * Who may read this client's pins (SKG-533).
   *
   * `public` is what this worker has always done: `GET /feedback?url=…&client=…` answers anyone who
   * can build the URL, so the notes, their authors and the team's replies are readable by every
   * visitor of the client's site — and by `curl`, which no amount of hiding in the widget changes.
   * Right for anonymous feedback on a public site, wrong for internal review.
   *
   * `authenticated` requires a valid identity token, the same HS256 JWT the write path takes, and
   * answers `401` without one. It needs this client's `identitySecret`; a client asking for it
   * without one is refused at boot rather than left permanently unreadable.
   */
  read: z.enum(['public', 'authenticated']).optional(),
});

export const clientMapSchema = z.record(z.string().min(1), clientSchema);

export type ClientConfig = z.infer<typeof clientSchema>;
export type ClientMap = z.infer<typeof clientMapSchema>;

/** Who may read a client's pins. See `read` on the client, and `FRUITBACK_READ` for the fallback. */
export type ReadAccess = 'public' | 'authenticated';

/**
 * Clients that could never be read, because they ask for a verified reader and have no key to
 * verify one with.
 *
 * Computed here rather than checked per client, because the trap is **inheritance**: a client with
 * no `read` of its own takes the worker's `FRUITBACK_READ`, while `identitySecret` is deliberately
 * never inherited (one signing key across tenants lets a compromised tenant mint identities on
 * another's issues). So flipping the worker-wide default to `authenticated` can render a client
 * unreadable without that client's own entry changing at all — a permanent `401` that looks like a
 * bug in the widget. Named at boot instead.
 */
export function unreadableClients(options: {
  read: ReadAccess;
  clients: ClientMap | undefined;
  identitySecret: string | undefined;
}): string[] {
  const { read, clients, identitySecret } = options;

  if (clients === undefined) {
    return read === 'authenticated' && identitySecret === undefined ? ['<single client>'] : [];
  }

  return Object.entries(clients)
    .filter(([, client]) => (client.read ?? read) === 'authenticated' && client.identitySecret === undefined)
    .map(([id]) => id);
}

/**
 * Clients whose pins anyone can read, for the boot log.
 *
 * `public` stays the default, so an upgrade never silently blanks a working deployment — but an
 * operator should not have to infer their own exposure from the absence of a field.
 */
export function openReadClients(options: { read: ReadAccess; clients: ClientMap | undefined }): string[] {
  const { read, clients } = options;

  if (clients === undefined) return read === 'public' ? ['<single client>'] : [];

  return Object.entries(clients)
    .filter(([, client]) => (client.read ?? read) === 'public')
    .map(([id]) => id);
}

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

/**
 * Per-client decisions the **worker** makes, whatever store is behind it (SKG-522).
 *
 * This is the half of the old `Routing` that was never about Linear: whether replies come back
 * (SKG-502), whose word an identity is (SKG-498), and who may read at all (SKG-533). The other half
 * — `teamId` and `projectId` — went to the Linear connector, where a team and a project mean
 * something. They meant nothing to SQLite, and the worker was reading `teamId` to build its cache
 * key, which is how the read path came to know that stores route by team.
 */
export type ClientPolicy = {
  /** Whether the read path returns the team's replies — see `showComments` on the client. */
  showComments: boolean;
  /** Set when this client can mint identity tokens (SKG-498). Absent means self-declared only. */
  identitySecret: string | undefined;
  /** Who may read this client's pins (SKG-533). `authenticated` answers 401 without a valid token. */
  read: ReadAccess;
};

/**
 * What a request resolved to: the worker's decisions, and the client entry itself.
 *
 * The entry is handed on rather than picked apart because **each store reads its own fields from
 * it** — `teamId` and `projectId` for Linear, an `owner/repo` for GitHub, nothing for SQLite. That
 * keeps the worker from having to name any of them.
 */
export type ClientResolution =
  | { ok: true; policy: ClientPolicy; client: ClientConfig | undefined }
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
  fallback: ClientPolicy;
};

/**
 * One normalisation, and the normalised value is what flows on.
 *
 * Trimming only for the map lookup was not enough, and the way it failed is worth keeping in mind:
 * routing succeeded on a padded id while the **label** written to Linear kept the spaces, so a seed
 * posted as `'  acme  '` landed in the right team under `fruitback:  acme  ` and the client's own
 * clean read — filtering on `fruitback:acme` — found nothing. Authorised at both ends, invisible in
 * between. The id has to be normalised before it is used for anything: the route, the label, and the
 * cache key alike.
 */
export function normalizeClientId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();

  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

export function resolveClient({ clients, clientId, origin, fallback }: ResolveClientOptions): ClientResolution {
  // Single-tenant: the map is what turns this worker multi-client, and without it nothing changes.
  // `client: undefined` is what the store reads as "no per-client entry, use your own defaults".
  if (clients === undefined) return { ok: true, policy: fallback, client: undefined };

  // Normalised again here rather than trusted: this is the boundary, and a caller that forgets is
  // how the label and the route drifted apart in the first place.
  const id = normalizeClientId(clientId);
  if (id === undefined) return { ok: false, reason: 'client-required' };

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
    policy: {
      // No `?? fallback.identitySecret` — see the field's own note. A mapped client that wants
      // verified identities declares its own key.
      identitySecret: client.identitySecret,
      showComments: client.showComments ?? fallback.showComments,
      // Inherited, unlike `identitySecret`: this is a posture, not a key. `unreadableClients`
      // is what stops the inheritance from producing a client nobody can ever read.
      read: client.read ?? fallback.read,
    },
    // `teamId` and `projectId` are not resolved here any more: falling back to the worker's team is
    // the Linear connector's rule, and it is the one that owns those fields now.
    client,
  };
}

/** Every origin any client may be embedded on — the allowlist a multi-tenant worker actually serves. */
export function originsFromClients(clients: ClientMap | undefined): string[] {
  if (clients === undefined) return [];

  return [...new Set(Object.values(clients).flatMap((client) => client.origins ?? []))];
}
