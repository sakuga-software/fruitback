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
import { randomId } from './relay-transport.ts';

export type SessionIdentity = {
  subject: string;
  name?: string;
  email?: string;
};

/** What survives the browser closing. */
export type StoredSession = {
  refreshToken: string;
  identity: SessionIdentity;
  /**
   * Which session this is, as a value the access token can carry without being one.
   *
   * The refresh token is the generation marker everywhere else here, and it cannot be this one: the
   * grant lives in the area that survives nothing, and copying a credential into it would undo the
   * split that keeps the refresh token out of it. So a fresh opaque id, minted on pairing and on
   * every refresh. See `matches`.
   *
   * Optional, because an entry stored before SKG-600 has none. Two absent markers compare equal,
   * which is the behaviour that entry already had.
   */
  generation?: string;
  /**
   * Which run of this endpoint's session the entry belongs to (SKG-603).
   *
   * A logout mints a new epoch before it clears, so an entry stamped with the one before it is
   * refused by every reader — see `stillOpen` in `session-storage.ts`. That is what catches a logout
   * landing between a refresh reading storage and writing it back: the write still happens, and it
   * is dead on arrival. The generation cannot do this. It is minted by the refresh itself, so both
   * of that refresh's writes agree with each other and nothing tells them from an ordinary one.
   *
   * Optional, on the same rule as `generation`: absent on both sides compares equal.
   */
  epoch?: string;
};

/** What must not. `expiresAt` is a moment in milliseconds, computed here from the worker's `expiresIn`. */
export type AccessGrant = {
  accessToken: string;
  expiresAt: number;
  identity: SessionIdentity;
  /** The session this token was minted for. See `StoredSession.generation` and `matches`. */
  generation?: string;
};

/**
 * One storage area, keyed by worker endpoint, **one entry per endpoint** (SKG-602).
 *
 * A reviewer can hold a session with more than one worker — two clients, two deployments — and a
 * token is only good against the worker that minted it. The endpoint is what a site in `sites.ts`
 * already points at, so the two maps line up without a third identifier to keep in step.
 *
 * There is no `write(everything)`. That was the whole surface before, and it forced every caller
 * into a read-modify-write over a record holding every worker — so a refresh for one could write
 * another's entry away, from a context no lock of ours reaches. `put` and `drop` name the endpoint
 * they touch, and the browser backing gives each endpoint its own key.
 *
 * `read` stays, because what a reviewer is paired with is a real question.
 */
export type Area<T> = {
  read(): Promise<Record<string, T>>;
  put(endpoint: string, value: T): Promise<void>;
  drop(endpoint: string): Promise<void>;
};

export type SessionResponse = {
  status: number;
  body: unknown;
};

/**
 * Where an endpoint's epoch is written. The read side is not here: it is inside the sessions area,
 * so no reader of a session can forget to ask. See `stillOpen` in `session-storage.ts`.
 */
export type Epochs = Pick<Area<string>, 'put'>;

export type SessionSeams = {
  /** Mints a session generation. Defaulted so only a test has to care. See `StoredSession.generation`. */
  newGeneration?: () => string;
  /** Mints an epoch, the same way and for the same reason. See `StoredSession.epoch`. */
  newEpoch?: () => string;
  sessions: Area<StoredSession>;
  grants: Area<AccessGrant>;
  epochs: Epochs;
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

/**
 * Was this access token minted for the session storage holds now?
 *
 * Freshness alone is not enough. The popup and the background write the same two areas from separate
 * contexts, so a logout can land between a refresh writing the session and the same refresh writing
 * its grant — and the grant is then an orphan over a cleared session, accepted for its remaining ten
 * minutes because nothing looked past its clock. Revoking on the worker does not reach it. Raised in
 * review.
 *
 * It is the second of the two refusals that case gets since SKG-603: the session that grant names is
 * itself stamped with a run that is over, so `stillOpen` already keeps it out of the read this
 * compares against.
 *
 * An entry written before this marker existed has none on either side, and two absent markers
 * compare equal: an upgrade keeps the session it already had rather than signing the reviewer out.
 */
export function matches(grant: AccessGrant, session: StoredSession | undefined): boolean {
  return session !== undefined && grant.generation === session.generation;
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

export function createSessions({
  sessions,
  grants,
  epochs,
  post,
  now = Date.now,
  newGeneration = () => randomId(globalThis),
  newEpoch = () => randomId(globalThis),
}: SessionSeams): Sessions {
  /** Endpoint to the refresh already running for it. See `refreshOnce`. */
  const refreshing = new Map<string, Promise<AccessResult>>();

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

  /**
   * Replaces the session and mints its access token together, while `spent` is still what storage
   * holds.
   *
   * The compare and the write are not one operation and cannot be: `chrome.storage` has no
   * transaction, and the popup and this context share nothing else. **What the write carries is what
   * covers the gap.** It is stamped with the epoch of the very read the comparison was made on
   * (SKG-603), and a logout mints a new epoch before it clears, so a logout landing anywhere around
   * these lines leaves the endpoint logged out:
   *
   * - before the read — the session is gone, so the comparison refuses.
   * - between the read and the session write — the stamp is a run of the session that is over, and
   *   `stillOpen` refuses the entry for good. The grant below then has no session to match.
   * - between the session write and the grant write — the same, and `matches` refuses the orphan
   *   grant as well. That second refusal is the **generation** marker, added on SKG-600.
   *
   * The stamp has to come from **this** read and not from a fresher one, which is why the session is
   * read here rather than handed in: a stamp read after the logout would agree with storage and put
   * the session back.
   *
   * Since SKG-602 the two writes touch only this endpoint's own keys, so nothing here can reach
   * another worker's entry whatever else is running.
   */
  async function keepIfCurrent(
    endpoint: string,
    spent: string,
    session: Omit<StoredSession, 'generation' | 'epoch'>,
    issued: Issued,
  ): Promise<AccessGrant | undefined> {
    const held = (await sessions.read())[endpoint];
    if (held?.refreshToken !== spent) return undefined;

    const generation = newGeneration();
    await sessions.put(endpoint, {
      ...session,
      ...(held.epoch === undefined ? {} : { epoch: held.epoch }),
      generation,
    });

    return writeGrant(endpoint, issued, generation);
  }

  async function writeGrant(endpoint: string, issued: Issued, generation: string): Promise<AccessGrant> {
    const value: AccessGrant = {
      accessToken: issued.accessToken,
      expiresAt: now() + issued.expiresIn * 1000,
      identity: issued.identity,
      generation,
    };
    await grants.put(endpoint, value);

    return value;
  }

  /**
   * Both credentials for one endpoint, gone — and the run they belonged to marked over.
   *
   * **The epoch is minted first, and that order is the whole of SKG-603.** A refresh in the other
   * context can already be holding an answer for this session; dropping the keys does not reach it,
   * and it writes them back. The new epoch is what that write is measured against, so it has to be
   * in storage before anything is removed. Everything stamped with the epoch before it is refused
   * from here on, whenever it lands.
   *
   * The rest is two operations rather than one, because each area owns its own keys. So a logout can
   * leave the session dropped and the grant still there for an instant — and if it fails between
   * them, for longer. That grant is unusable: it carries the generation of a session no longer in
   * storage, and `matches` refuses it.
   *
   * What this does not remove is the entry a refused write leaves behind: a refresh that lost this
   * race still writes its session key, stamped with the epoch before. `stillOpen` keeps it out of
   * every read, and the next pairing writes over it. The refresh token in it is the one the revoke
   * above ended.
   */
  async function forget(endpoint: string): Promise<void> {
    await epochs.put(endpoint, newEpoch());
    await Promise.all([sessions.drop(endpoint), grants.drop(endpoint)]);
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

    // **A refresh without a successor is not a success.** Every refresh rotates since SKG-600, so a
    // `200` carrying no `refreshToken` means the worker spent the stored token and this answer lost
    // the replacement — a body truncated by a proxy, a route that stopped naming the field. Taking
    // it leaves a spent token in storage and a working access token over it, and the session dies
    // silently when the grace runs out. `unavailable` instead, so the retry runs while the
    // predecessor is still good. `pair` asks for the same field in the same way. Raised in review.
    if (answer.status !== 200 || issued?.refreshToken === undefined) {
      return { ok: false, reason: 'unavailable' };
    }

    // **The session may have ended while this request was in the air.** The popup and the background
    // are separate contexts holding separate `Sessions`, and they share only storage: a reviewer can
    // click log out — revoking and clearing — while an alarm is already awaiting this answer. Writing
    // the grant then would put a working access token back into storage under a screen that says
    // signed out, and revocation does not reach an access token already minted.
    //
    // The refresh token is its own generation marker, which is what makes this work across contexts
    // with nothing to keep in step: if the one in storage is not the one this request spent, the
    // session was logged out or re-paired, and this answer is about a session that no longer exists.
    //
    // The check and the write are **not** one operation and cannot be. What closes the gap between
    // them is the epoch the write carries — see `keepIfCurrent`. Rotation made this path run on
    // every refresh rather than on the rare answer that carried a new token. Raised in review,
    // three times.
    //
    // What protects a lost answer is on the worker's side: the token this request spent stays usable
    // until its successor is, so a retry with the old one lands on its feet.
    // No write, no grant. Minting an access token for a session storage no longer holds is the whole
    // failure this guards against, and it outlives a revoke.
    const granted = await keepIfCurrent(
      endpoint,
      stored.refreshToken,
      { refreshToken: issued.refreshToken, identity: issued.identity },
      issued,
    );

    return granted === undefined ? { ok: false, reason: 'not-paired' } : { ok: true, grant: granted };
  }

  /**
   * One refresh in flight per endpoint, shared by whoever asks while it runs.
   *
   * Two callers that each spend the same refresh token are a lockout, not a wasted request. The
   * worker rotates the first into a successor and treats the second as a retry inside the grace:
   * it revokes the first successor and mints another. Both answers then race to write, and if
   * the first lands last the extension is left holding a token the worker has revoked. The next
   * refresh answers `401`, the session ends, and only an operator minting a new pairing code brings
   * the reviewer back.
   *
   * `background.ts` already serialises the **alarm**, which is why this was not visible: the path
   * it does not cover is the relay, and the widget has a read and a write in flight in the ordinary
   * case. The lock lives here rather than in the entrypoint for the reason `bridge.ts` gives — an
   * entrypoint binds `browser` at import and no test could reach it. Raised in review.
   *
   * `get` and `set` must stay on either side of no `await`: `ensureAccess` reads storage before it
   * decides, so two callers can both find the grant stale, and this map is the only thing between
   * them.
   */
  function refreshOnce(endpoint: string): Promise<AccessResult> {
    const running = refreshing.get(endpoint);
    if (running !== undefined) return running;

    const started = refresh(endpoint).finally(() => refreshing.delete(endpoint));
    refreshing.set(endpoint, started);

    return started;
  }

  async function ensureAccess(endpoint: string): Promise<AccessResult> {
    const [storedGrants, storedSessions] = await Promise.all([grants.read(), sessions.read()]);
    const held = storedGrants[endpoint];

    // Fresh **and** minted for the session that is there now. See `matches`.
    if (isFresh(held, now()) && matches(held, storedSessions[endpoint])) return { ok: true, grant: held };

    return refreshOnce(endpoint);
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

      // The epoch is minted here too, and written before the session it stamps. A pairing is the
      // start of a run of this session, the way a logout is the end of one, and the two are the only
      // things that mint one. An endpoint paired again after a logout would otherwise carry the
      // epoch of the logout and read as signed out for ever.
      const epoch = newEpoch();
      await epochs.put(endpoint, epoch);

      const generation = newGeneration();
      await sessions.put(endpoint, {
        refreshToken: issued.refreshToken,
        identity: issued.identity,
        epoch,
        generation,
      });
      await writeGrant(endpoint, issued, generation);

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
 * request, never the extension.
 *
 * `refreshToken` stays optional **here** while both call sites require it: `/session/pair` and
 * `/session/refresh` each mint one since SKG-600, and each says so itself. Requiring it in the
 * parser would put the rule one level away from the failure it prevents, and a third route that
 * issues only an access token would have to work around it.
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

  if (identity === undefined) return undefined;

  return {
    refreshToken: value.refreshToken,
    identity,
    ...(isNonEmptyString(value.generation) ? { generation: value.generation } : {}),
    // Dropped here and the entry reads as belonging to no run at all, so `stillOpen` refuses every
    // session on an endpoint that has an epoch — every endpoint, one logout in.
    ...(isNonEmptyString(value.epoch) ? { epoch: value.epoch } : {}),
  };
}

export function parseAccessGrant(value: unknown): AccessGrant | undefined {
  if (!isRecord(value) || !isNonEmptyString(value.accessToken)) return undefined;
  if (typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)) return undefined;

  const identity = parseIdentity(value.identity);

  if (identity === undefined) return undefined;

  return {
    accessToken: value.accessToken,
    expiresAt: value.expiresAt,
    identity,
    ...(isNonEmptyString(value.generation) ? { generation: value.generation } : {}),
  };
}

/** Whoever a session belongs to, as a person reads it. */
export function describeIdentity(identity: SessionIdentity): string {
  return identity.name ?? identity.email ?? identity.subject;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
