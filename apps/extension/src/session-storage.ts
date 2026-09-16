/**
 * What a storage area holds, and how it was upgraded to hold it (SKG-602).
 *
 * Split out of `session-browser.ts` so `node --test` reaches the key rules and the upgrade without
 * `browser`. Storage arrives as `StorageArea`, which is the part of `chrome.storage` these need.
 *
 * **Every endpoint has its own key.** One record holding all of them made every write a
 * read-modify-write, and the popup and the background do not share a lock — so a refresh for one
 * worker could write another worker's entry back, and a logout in the popup did not stick.
 *
 * A key per endpoint makes a write atomic per endpoint. It does not order two writes, and a logout
 * has to beat a refresh that read storage before it. That is the epoch, and `stillOpen` is the rule
 * it is read by (SKG-603).
 *
 * **A session key names its epoch too** (SKG-604). A refresh writes the run of the session it read,
 * so a write that lost the race to a logout and a new pairing lands beside the new pairing, never
 * over it.
 */

import {
  type Area,
  type SessionArea,
  type SessionSeams,
  type Sessions,
  type StoredSession,
  createSessions,
  parseAccessGrant,
  parseStoredSession,
} from './session.ts';

/** The prefix of a key, per area. An endpoint is appended verbatim. */
export const GRANT_PREFIX = 'fruitback:grant:';

/**
 * The prefix of a session key: `fruitback:session-run:<epoch>:<endpoint>` (SKG-604).
 *
 * The epoch is encoded with `encodeURIComponent`, which never writes a colon, so the first colon
 * after the prefix ends it. The endpoint is the rest of the key, colons included. A session with no
 * epoch has an empty segment.
 */
export const RUN_PREFIX = 'fruitback:session-run:';

/**
 * The prefix of a session key from SKG-602 to SKG-604: the endpoint and no epoch.
 *
 * Only `moveToRunKeys` reads one, and it removes it.
 */
export const ENDPOINT_SESSION_PREFIX = 'fruitback:session:';

/**
 * The prefix of an endpoint's epoch, in `local` beside the session it dates (SKG-603).
 *
 * An opaque id, minted when a session starts and when one ends. See `StoredSession.epoch` for what
 * it is for, and `stillOpen` for the rule that reads it.
 */
export const EPOCH_PREFIX = 'fruitback:epoch:';

/**
 * The keys that held every endpoint at once, before SKG-602.
 *
 * `splitLegacyRecord` is the only thing that reads one, and it removes it. They are exported because
 * the test that covers the upgrade has to write one.
 */
export const LEGACY_SESSIONS_KEY = 'sessions';
export const LEGACY_GRANTS_KEY = 'access';

/**
 * One area of `chrome.storage`, as much of it as this file uses.
 *
 * `get(null)` is the whole area, which is how a read finds the endpoints: a key per endpoint means
 * there is no one key left to ask for.
 */
export type StorageArea = {
  get(keys: string | null): Promise<unknown>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string): Promise<void>;
};

export function keyFor(prefix: string, endpoint: string): string {
  return prefix + endpoint;
}

/** The key of one run of an endpoint's session. See `RUN_PREFIX`. */
export function runKeyFor(endpoint: string, epoch: string | undefined): string {
  return `${RUN_PREFIX}${encodeURIComponent(epoch ?? '')}:${endpoint}`;
}

/** A session key, read back: the endpoint and the epoch it names. */
export type RunKey = { key: string; endpoint: string; epoch: string | undefined };

/** The run a key names, or `undefined` when the key is not a session key or its epoch does not decode. */
export function runOf(key: string): RunKey | undefined {
  if (!key.startsWith(RUN_PREFIX)) return undefined;

  const rest = key.slice(RUN_PREFIX.length);
  const end = rest.indexOf(':');
  if (end < 0) return undefined;

  let epoch: string;
  try {
    epoch = decodeURIComponent(rest.slice(0, end));
  } catch {
    return undefined;
  }

  return { key, endpoint: rest.slice(end + 1), epoch: epoch === '' ? undefined : epoch };
}

/** Every session key in a snapshot, whatever its value holds. */
export function runKeysOf(snapshot: Record<string, unknown>): RunKey[] {
  return Object.keys(snapshot).flatMap((key) => runOf(key) ?? []);
}

/**
 * The endpoint a key names, or `undefined` when the key belongs to something else.
 *
 * **`slice` by the prefix length, never `split` on a separator.** An endpoint is a URL somebody
 * typed, so `https://a.test/x:session:y` is a legal one and splitting truncates it.
 */
function endpointOf(prefix: string, key: string): string | undefined {
  return key.startsWith(prefix) ? key.slice(prefix.length) : undefined;
}

/**
 * Whether a set of `storage.onChanged` keys holds a refresh token. One key per endpoint, so it is a
 * scan rather than a lookup.
 *
 * **Grants and epochs are deliberately out.** The listener watches `local`, and a grant lives in
 * `session`; a reader who later widens that listener to both areas has to widen this too. An epoch
 * is in `local`, but nothing writes one on its own: a pairing and a logout each write a session key
 * in the same breath, and that is what wakes the refresh.
 */
export function touchesARefreshToken(keys: string[]): boolean {
  return keys.some((key) => key.startsWith(RUN_PREFIX));
}

/** Every endpoint the snapshot holds under `prefix`, parsed. An entry that fails to parse is dropped. */
export function entriesOf<T>(
  snapshot: Record<string, unknown>,
  prefix: string,
  parse: (value: unknown) => T | undefined,
): Record<string, T> {
  const entries: Record<string, T> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    const endpoint = endpointOf(prefix, key);
    if (endpoint === undefined) continue;

    const parsed = parse(value);
    if (parsed !== undefined) entries[endpoint] = parsed;
  }

  return entries;
}

/** An epoch, read back. An area holds whatever an older version wrote, so this is parsed too. */
export function parseEpoch(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** A session as storage holds it: the run its key names, and the value under that key. */
export type Run = RunKey & { session: StoredSession };

/**
 * Every session in a snapshot, parsed. A value that does not parse is dropped, and so is a value
 * whose epoch is not the one its key names: nothing here writes one, so the entry was changed by
 * something else.
 */
export function runsOf(snapshot: Record<string, unknown>): Run[] {
  return runKeysOf(snapshot).flatMap((run) => {
    const session = parseStoredSession(snapshot[run.key]);

    return session !== undefined && session.epoch === run.epoch ? [{ ...run, session }] : [];
  });
}

/**
 * The sessions still open, out of the sessions storage holds (SKG-603).
 *
 * **A session is honoured only while it agrees with its endpoint's epoch.** `chrome.storage` has no
 * transaction and no compare-and-set, so a write cannot be refused at the moment it lands: a logout
 * in the popup can arrive after a refresh in the background read storage and before it writes, and
 * both of that refresh's writes then agree with each other. What the epoch changes is who decides.
 * The refresh stamps what it writes with the epoch it read, the logout mints a new one, and the
 * entry is then refused by every reader instead of having to be stopped by a writer.
 *
 * Absent on both sides compares equal, so an entry written before this marker existed is kept. That
 * is the rule `matches` already follows for the generation.
 */
export function stillOpen(runs: Run[], epochs: Record<string, string>): Record<string, StoredSession> {
  const open: Record<string, StoredSession> = {};
  for (const { endpoint, epoch, session } of runs) {
    if (epoch === epochs[endpoint]) open[endpoint] = session;
  }

  return open;
}

/**
 * The sessions area: one key per run of an endpoint's session, and the epoch rule over it.
 *
 * The epoch is read from the **same snapshot** as the sessions, so nothing can land between the two
 * halves of the comparison. It is where the rule is enforced rather than at the call sites, because
 * a reader added later would otherwise see a session that was logged out.
 *
 * **A write removes the runs that are over, after it lands** (SKG-604). A refresh that lost the race
 * to a logout writes a run that is over, and nothing reads that key again. The removal is measured
 * against the epoch in its own snapshot, and an epoch never comes back, so it cannot remove a run
 * that is still open or one written after that snapshot. A write that lost the race sees the new
 * epoch in that snapshot, so it removes its own key.
 */
export function createSessionArea(of: () => StorageArea, ready: Promise<void>): SessionArea {
  async function snapshot(): Promise<Record<string, unknown>> {
    await ready;
    const taken = await of().get(null);

    return isRecord(taken) ? taken : {};
  }

  async function removeEach(keys: string[]): Promise<void> {
    for (const key of keys) await of().remove(key);
  }

  return {
    async read() {
      const taken = await snapshot();

      return stillOpen(runsOf(taken), entriesOf(taken, EPOCH_PREFIX, parseEpoch));
    },
    async put(endpoint, value) {
      await ready;
      await of().set({ [runKeyFor(endpoint, value.epoch)]: value });

      const taken = await snapshot();
      const current = entriesOf(taken, EPOCH_PREFIX, parseEpoch)[endpoint];
      await removeEach(
        runKeysOf(taken)
          .filter((run) => run.endpoint === endpoint && run.epoch !== current)
          .map((run) => run.key),
      );
    },
    async drop(endpoint) {
      const taken = await snapshot();
      await removeEach(
        runKeysOf(taken)
          .filter((run) => run.endpoint === endpoint)
          .map((run) => run.key),
      );
    },
    async end(endpoint, spent) {
      const key = runKeyFor(endpoint, spent.epoch);
      const held = parseStoredSession((await snapshot())[key]);
      if (held?.refreshToken === spent.refreshToken) await of().remove(key);
    },
  };
}

/**
 * One `Area` over `chrome.storage`, with a key per endpoint.
 *
 * **Every operation waits on `ready`, which is this area's upgrade.** A `drop` that ran first would
 * remove an endpoint's own key while the endpoint was still in the legacy record, and the upgrade
 * would then write the session back — a logout that does not stick, which is the defect this ticket
 * is named after.
 */
export function createArea<T>(
  of: () => StorageArea,
  prefix: string,
  parse: (value: unknown) => T | undefined,
  ready: Promise<void>,
): Area<T> {
  return {
    async read() {
      await ready;
      const snapshot = await of().get(null);

      return isRecord(snapshot) ? entriesOf(snapshot, prefix, parse) : {};
    },
    async put(endpoint, value) {
      await ready;
      await of().set({ [keyFor(prefix, endpoint)]: value });
    },
    async drop(endpoint) {
      await ready;
      await of().remove(keyFor(prefix, endpoint));
    },
  };
}

/**
 * A `Sessions` over two storage areas: which key holds what, and the upgrade they all wait on.
 *
 * The whole binding, and the only one. `session-browser.ts` calls this with `browser.storage`, and
 * the tests call it with an area in memory — so what a test drives is the wiring that ships, rather
 * than a second copy of it that can be right while the real one is not.
 *
 * The areas arrive as functions because `browser.storage.local` must be read when it is used and not
 * when this module is imported.
 */
export function createStoredSessions(
  local: () => StorageArea,
  session: () => StorageArea,
  post: SessionSeams['post'],
  options: Pick<SessionSeams, 'now' | 'newGeneration' | 'newEpoch'> = {},
): Sessions {
  const ready = upgradeAreas(local(), session());

  return createSessions({
    sessions: createSessionArea(local, ready),
    grants: createArea(session, GRANT_PREFIX, parseAccessGrant, ready),
    epochs: createArea(local, EPOCH_PREFIX, parseEpoch, ready),
    post,
    ...options,
  });
}

/**
 * The upgrade of both areas, as one promise for every `Area` over them to wait on.
 *
 * **A failure is not swallowed, and the gate stays shut.** Releasing it would let every operation
 * run against storage still holding the legacy record: a read answers that the reviewer is paired
 * with nobody while a live credential sits under the old key, and a `drop` removes a key that was
 * never written. A rejection leaves the popup showing the site row with no session block under it,
 * which is the loud half of the same fact, and the next time the context starts it tries again.
 */
export function upgradeAreas(local: StorageArea, session: StorageArea): Promise<void> {
  const upgrade = Promise.all([
    upgradeSessions(local),
    splitLegacyRecord(session, LEGACY_GRANTS_KEY, GRANT_PREFIX, parseAccessGrant),
  ]).then(() => undefined);

  // Nothing awaits this before an operation does, and an unhandled rejection stops a service worker.
  // The handler marks it seen; `upgrade` itself still rejects for whoever waits on it.
  upgrade.catch(() => undefined);

  return upgrade;
}

/**
 * The upgrade of the sessions area, in the order the shapes were written: the legacy record to a key
 * per endpoint, then a key per endpoint to a key per run.
 */
export async function upgradeSessions(local: StorageArea): Promise<void> {
  await splitLegacyRecord(local, LEGACY_SESSIONS_KEY, ENDPOINT_SESSION_PREFIX, parseStoredSession);
  await moveToRunKeys(local);
}

/**
 * The upgrade from a key per endpoint to a key per run (SKG-604).
 *
 * Each entry moves to the run its own epoch names. **A run that already has its key is left
 * alone**: the other context upgraded first, and a refresh can have written a newer value there
 * since. The writes land before the removals, for the reason `splitLegacyRecord` gives.
 *
 * The window this leaves is the one `migrationOf` states: a snapshot taken before the other context
 * wrote the same run. It needs a refresh inside one storage round trip, on the first run after the
 * upgrade only. An entry this moves to a run that is over stays in storage and no reader answers
 * with it. The next write for that endpoint removes it.
 */
export async function moveToRunKeys(of: StorageArea): Promise<void> {
  const snapshot = await of.get(null);
  if (!isRecord(snapshot)) return;

  const moved = Object.keys(snapshot).filter((key) => key.startsWith(ENDPOINT_SESSION_PREFIX));
  if (moved.length === 0) return;

  const write: Record<string, unknown> = {};
  for (const [endpoint, value] of Object.entries(entriesOf(snapshot, ENDPOINT_SESSION_PREFIX, parseStoredSession))) {
    const key = runKeyFor(endpoint, value.epoch);
    if (!(key in snapshot)) write[key] = value;
  }

  if (Object.keys(write).length > 0) await of.set(write);
  for (const key of moved) await of.remove(key);
}

/**
 * The upgrade of one area, read and written.
 *
 * **The write lands before the removal**, so a failure between them leaves the credentials under the
 * legacy key for the next attempt rather than gone. A legacy record that parses to nothing is still
 * removed: it holds no session anybody can use, and leaving it would run this on every startup.
 */
export async function splitLegacyRecord<T>(
  of: StorageArea,
  legacyKey: string,
  prefix: string,
  parse: (value: unknown) => T | undefined,
): Promise<void> {
  const snapshot = await of.get(null);
  if (!isRecord(snapshot)) return;

  const migration = migrationOf(snapshot, legacyKey, prefix, parse);
  if (migration === undefined) return;

  if (Object.keys(migration.write).length > 0) await of.set(migration.write);
  await of.remove(legacyKey);
}

/**
 * The upgrade from the one legacy record to one key per endpoint, from a single snapshot.
 *
 * Returns nothing when there is no legacy record, which is every run after the first. Otherwise the
 * caller writes `write` and then removes the legacy key, in that order.
 *
 * **An endpoint that already has its own key is left alone.** The popup and the background both run
 * this at startup, and the other one may have finished first and had a newer value written over it
 * since. Skipping what is already there is what makes the second run write nothing rather than put
 * an older value back.
 *
 * The window this leaves: the other context can read the legacy record, a logout can remove that
 * endpoint's new key, and the read already in flight can then write the session back. It needs a log
 * out inside the one storage round trip that separates the read from the write, on the first run
 * after the upgrade only. **The epoch answers it** (SKG-603): a legacy record predates the marker, so
 * what is written back carries none while the logout minted one, and `stillOpen` refuses the entry.
 * A pairing made inside the window is kept since SKG-604: the entry written back names a run with no
 * epoch, and the pairing's key names its own.
 */
function migrationOf<T>(
  snapshot: Record<string, unknown>,
  legacyKey: string,
  prefix: string,
  parse: (value: unknown) => T | undefined,
): { write: Record<string, unknown> } | undefined {
  const legacy = snapshot[legacyKey];
  if (legacy === undefined) return undefined;

  const write: Record<string, unknown> = {};
  if (isRecord(legacy)) {
    for (const [endpoint, value] of Object.entries(legacy)) {
      const key = keyFor(prefix, endpoint);
      if (key in snapshot) continue;

      const parsed = parse(value);
      if (parsed !== undefined) write[key] = parsed;
    }
  }

  return { write };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
