/**
 * The reviewer's session with a worker, kept where the page cannot reach it (SKG-599).
 *
 * SKG-535 built the worker half — pairing codes, tokens, revocation. This is the other half, and it
 * carries the constraint that shaped both: **the token never goes into the page's world.** The
 * widget runs there, `window.postMessage` is the only channel it shares with us, and the page is on
 * that channel too. So nothing here is ever posted; the isolated content script asks the background
 * to make the call, and SKG-596 adds that relay. `worlds.test.ts` is what keeps it true.
 *
 * Written against two storage seams and one `post`, so all of it runs under `node --test`. The real
 * `browser.storage` and the real world boundary are `session-browser.ts` and SKG-538.
 *
 * **Two areas, on purpose.** The refresh token is worth weeks and goes in `local`; the access token
 * is worth ten minutes and goes in `session`, which the browser empties when it closes. Both in
 * `session` would make a reviewer pair again every morning, and somebody who has to do that keeps
 * their pairing code in a text file — a worse place than the one we were protecting.
 */

/** Who the worker says this session speaks for. Its word, from the pairing an operator created. */
import { isSecureWorkerEndpoint } from './endpoint.ts';

export type SessionIdentity = {
  subject: string;
  name?: string;
  email?: string;
};

/** What survives the browser closing. */
export type StoredSession = {
  refreshToken: string;
  identity: SessionIdentity;
};

/** What must not. `expiresAt` is epoch milliseconds, computed here from the worker's `expiresIn`. */
export type AccessGrant = {
  accessToken: string;
  expiresAt: number;
  identity: SessionIdentity;
};

/**
 * One storage area, keyed by worker endpoint.
 *
 * A reviewer can hold a session with more than one worker — two clients, two deployments — and a
 * token is only good against the worker that minted it. The endpoint is what a site in `sites.ts`
 * already points at, so the two maps line up without a third identifier to keep in step.
 */
export type Area<T> = {
  read(): Promise<Record<string, T>>;
  write(entries: Record<string, T>): Promise<void>;
};

export type SessionResponse = {
  status: number;
  body: unknown;
};

export type SessionSeams = {
  sessions: Area<StoredSession>;
  grants: Area<AccessGrant>;
  post(url: string, body: Record<string, unknown>): Promise<SessionResponse>;
  now?: () => number;
};

/**
 * How early an access token is replaced.
 *
 * Refreshing before expiry rather than after a `401` is the difference between a reviewer waiting
 * for a round trip and not noticing there was one. Two minutes out of ten also absorbs the clock
 * skew the worker's verifier allows, so a token this side still believes in is never one it refuses.
 */
export const REFRESH_MARGIN_MS = 2 * 60 * 1000;

/**
 * How long to wait before trying a refresh that failed.
 *
 * Without it the alarm is a one-minute loop with no end: a refresh that cannot reach the worker
 * leaves the grant stale, `nextWakeAt` then asks for a time already past, and the service worker
 * wakes up to fail again every minute for as long as the worker is unreachable — a decommissioned
 * staging endpoint, or a laptop shut on a train. Nothing is lost by waiting: a browser restart, a
 * pairing and a logout each ask for a refresh directly rather than through the alarm.
 */
export const RETRY_DELAY_MS = 5 * 60 * 1000;

/** The one freshness rule, so the three places that need it cannot drift apart. */
export function isFresh(grant: AccessGrant | undefined, now: number): grant is AccessGrant {
  return grant !== undefined && grant.expiresAt - REFRESH_MARGIN_MS > now;
}

/** A code that never existed and one already spent answer the same, because the worker does. */
export type PairFailure = 'code-spent-or-expired' | 'unavailable' | 'insecure-endpoint';

export type AccessFailure = 'not-paired' | 'session-revoked-or-expired' | 'unavailable' | 'insecure-endpoint';

export type PairResult = { ok: true; identity: SessionIdentity } | { ok: false; reason: PairFailure };
export type AccessResult = { ok: true; grant: AccessGrant } | { ok: false; reason: AccessFailure };

export type Sessions = {
  list(): Promise<Record<string, StoredSession>>;
  /** When the next access token has to be replaced, for whoever owns the timer. */
  dueAt(): Promise<number | undefined>;
  pair(endpoint: string, code: string): Promise<PairResult>;
  ensureAccess(endpoint: string): Promise<AccessResult>;
  refreshDue(): Promise<void>;
  logout(endpoint: string): Promise<void>;
};

export function createSessions({ sessions, grants, post, now = Date.now }: SessionSeams): Sessions {
  /**
   * A request that answered, or nothing.
   *
   * Every caller has to tell "the worker refused this" from "the worker said nothing", because only
   * the first is a reason to throw a session away. A rejection here is the second.
   */
  async function ask(url: string, body: Record<string, unknown>): Promise<SessionResponse | undefined> {
    try {
      return await post(url, body);
    } catch {
      return undefined;
    }
  }

  async function keep(endpoint: string, session: StoredSession): Promise<void> {
    const all = await sessions.read();

    await sessions.write({ ...all, [endpoint]: session });
  }

  async function grant(endpoint: string, issued: Issued): Promise<AccessGrant> {
    const all = await grants.read();
    const value: AccessGrant = {
      accessToken: issued.accessToken,
      expiresAt: now() + issued.expiresIn * 1000,
      identity: issued.identity,
    };
    await grants.write({ ...all, [endpoint]: value });

    return value;
  }

  async function forget(endpoint: string): Promise<void> {
    const [storedSessions, storedGrants] = await Promise.all([sessions.read(), grants.read()]);

    await Promise.all([
      sessions.write(without(storedSessions, endpoint)),
      grants.write(without(storedGrants, endpoint)),
    ]);
  }

  async function refresh(endpoint: string): Promise<AccessResult> {
    // Checked before storage rather than after, because it is a rule about this endpoint and not
    // about what is held for it. See `pair` for what it protects.
    if (!isSecureWorkerEndpoint(endpoint)) return { ok: false, reason: 'insecure-endpoint' };

    const stored = (await sessions.read())[endpoint];
    if (stored === undefined) return { ok: false, reason: 'not-paired' };

    const answer = await ask(`${endpoint}/session/refresh`, { refreshToken: stored.refreshToken });
    if (answer === undefined) return { ok: false, reason: 'unavailable' };

    // **Only a refusal ends a session.** An outage, a `502` from a store nobody mounted, a laptop on
    // a train: all of those keep the refresh token, because throwing it away logs the reviewer out
    // of something the worker still considers open, and only a new pairing code brings them back.
    if (answer.status === 401) {
      await forget(endpoint);

      return { ok: false, reason: 'session-revoked-or-expired' };
    }

    const issued = parseIssued(answer.body);
    if (answer.status !== 200 || issued === undefined) return { ok: false, reason: 'unavailable' };

    // **The session may have ended while this request was in the air.** The popup and the background
    // are separate contexts holding separate `Sessions`, and they share only storage: a reviewer can
    // click log out — revoking and clearing — while an alarm is already awaiting this answer. Writing
    // the grant then would put a working access token back into storage under a screen that says
    // signed out, and revocation does not reach an access token already minted.
    //
    // The refresh token is its own generation marker, which is what makes this work across contexts
    // with nothing to keep in step: if the one in storage is not the one this request spent, the
    // session was logged out or re-paired, and this answer is about a session that no longer exists.
    // `chrome.storage` has no transaction, so the window is not closed, only narrowed from a network
    // round trip to two storage operations. Raised in review.
    if ((await sessions.read())[endpoint]?.refreshToken !== stored.refreshToken) {
      return { ok: false, reason: 'not-paired' };
    }

    // The worker does not rotate refresh tokens today, and this is the half that has to exist before
    // it can: a rotation whose response is lost leaves this side holding a token the worker has
    // already retired, and the reviewer locked out with nothing to retry. Closing that needs a
    // replay window on the worker — it accepts the retired token for a while — and the window is
    // only worth what this side does with the new one. So a rotated token is stored when it arrives,
    // and the worker half is a ticket of its own (SKG-600).
    if (issued.refreshToken !== undefined && issued.refreshToken !== stored.refreshToken) {
      await keep(endpoint, { refreshToken: issued.refreshToken, identity: issued.identity });
    }

    return { ok: true, grant: await grant(endpoint, issued) };
  }

  async function ensureAccess(endpoint: string): Promise<AccessResult> {
    const held = (await grants.read())[endpoint];

    return isFresh(held, now()) ? { ok: true, grant: held } : refresh(endpoint);
  }

  return {
    list: () => sessions.read(),

    async dueAt() {
      const [storedSessions, storedGrants] = await Promise.all([sessions.read(), grants.read()]);

      return nextWakeAt(storedSessions, storedGrants, now());
    },

    async pair(endpoint, code) {
      /**
       * Nothing here crosses a plain `http://` connection, and this is the larger half of that rule.
       *
       * A pairing code is spent for a **refresh token worth thirty days**; a refresh spends that
       * token again on every renewal. Both would be readable by anyone on the path. The popup says
       * so earlier and louder, and this is the rule itself rather than its warning — `refresh` and
       * the revoke below keep it too, so a session stored before the rule existed cannot leak one.
       * Loopback is excepted: it is the dev loop and is not on a wire.
       */
      if (!isSecureWorkerEndpoint(endpoint)) return { ok: false, reason: 'insecure-endpoint' };

      const answer = await ask(`${endpoint}/session/pair`, { code });
      if (answer === undefined) return { ok: false, reason: 'unavailable' };

      const issued = parseIssued(answer.body);
      if (answer.status !== 200 || issued?.refreshToken === undefined) {
        // A `429` and a `502` are not a bad code, and telling a reviewer their code is spent when
        // the worker was merely busy sends them to an operator for a new one they do not need.
        const refused = answer.status === 400 || answer.status === 401;

        return { ok: false, reason: refused ? 'code-spent-or-expired' : 'unavailable' };
      }

      await keep(endpoint, { refreshToken: issued.refreshToken, identity: issued.identity });
      await grant(endpoint, issued);

      return { ok: true, identity: issued.identity };
    },

    ensureAccess,

    async refreshDue() {
      for (const endpoint of Object.keys(await sessions.read())) await ensureAccess(endpoint);
    },

    /**
     * End the session on the worker, then here.
     *
     * That order, because the other one leaves a live refresh token on a worker nobody can revoke it
     * from any more. The local clear happens **whatever the call answers**: a reviewer who clicks
     * log out on a flaky network must not be left holding a working credential under a screen that
     * says they are signed out. The cost is stated rather than avoided — a revoke that never
     * arrived leaves the token live on the worker until it expires, which is what the 30-day limit
     * is for.
     */
    async logout(endpoint) {
      const stored = (await sessions.read())[endpoint];
      // The token does not cross plain http even to be revoked. Clearing here still happens, which
      // is the outcome the reviewer asked for and the only one this side can guarantee anyway.
      if (stored !== undefined && isSecureWorkerEndpoint(endpoint)) {
        await ask(`${endpoint}/session/revoke`, { refreshToken: stored.refreshToken });
      }

      await forget(endpoint);
    },
  };
}

/**
 * When the background should next wake up, or `undefined` when there is nothing to keep alive.
 *
 * A session whose token is missing or already stale asks for `RETRY_DELAY_MS` rather than for now.
 * Both cases mean the last attempt did not leave a usable token, and an alarm in the past is an
 * alarm every minute. The first token after a browser restart does not come from here: the service
 * worker refreshes once as it starts.
 */
export function nextWakeAt(
  sessions: Record<string, StoredSession>,
  grants: Record<string, AccessGrant>,
  now: number,
): number | undefined {
  let earliest: number | undefined;

  for (const endpoint of Object.keys(sessions)) {
    const held = grants[endpoint];
    const due = isFresh(held, now) ? held.expiresAt - REFRESH_MARGIN_MS : now + RETRY_DELAY_MS;
    if (earliest === undefined || due < earliest) earliest = due;
  }

  return earliest;
}

type Issued = {
  accessToken: string;
  expiresIn: number;
  identity: SessionIdentity;
  refreshToken?: string;
};

/**
 * What the worker answered, parsed rather than cast.
 *
 * The same rule as every seed and every stored site: a body that is not what it claims costs this
 * request, never the extension. `refreshToken` is optional because two routes share this shape —
 * `/session/pair` mints one and `/session/refresh` does not.
 */
export function parseIssued(body: unknown): Issued | undefined {
  if (!isRecord(body)) return undefined;

  const identity = parseIdentity(body.identity);
  const { accessToken, expiresIn, refreshToken } = body;
  if (identity === undefined) return undefined;
  if (!isNonEmptyString(accessToken)) return undefined;
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) return undefined;

  return {
    accessToken,
    expiresIn,
    identity,
    ...(isNonEmptyString(refreshToken) ? { refreshToken } : {}),
  };
}

/** Tolerant field by field, like `parseSite`: `subject` is the only one a session is nothing without. */
export function parseIdentity(value: unknown): SessionIdentity | undefined {
  if (!isRecord(value) || !isNonEmptyString(value.subject)) return undefined;

  const { subject, name, email } = value;

  return {
    subject,
    ...(isNonEmptyString(name) ? { name } : {}),
    ...(isNonEmptyString(email) ? { email } : {}),
  };
}

export function parseStoredSession(value: unknown): StoredSession | undefined {
  if (!isRecord(value) || !isNonEmptyString(value.refreshToken)) return undefined;

  const identity = parseIdentity(value.identity);

  return identity === undefined ? undefined : { refreshToken: value.refreshToken, identity };
}

export function parseAccessGrant(value: unknown): AccessGrant | undefined {
  if (!isRecord(value) || !isNonEmptyString(value.accessToken)) return undefined;
  if (typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)) return undefined;

  const identity = parseIdentity(value.identity);

  return identity === undefined ? undefined : { accessToken: value.accessToken, expiresAt: value.expiresAt, identity };
}

/** Whoever a session belongs to, as a person reads it. */
export function describeIdentity(identity: SessionIdentity): string {
  return identity.name ?? identity.email ?? identity.subject;
}

function without<T>(entries: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(entries).filter(([name]) => name !== key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
