/**
 * What a storage area holds, and how it was upgraded to hold it (SKG-602).
 *
 * Split out of `session-browser.ts` so `node --test` reaches the key rules and the upgrade without
 * `browser`. Storage arrives as `StorageArea`, which is the part of `chrome.storage` these need.
 *
 * **Every endpoint has its own key.** One record holding all of them made every write a
 * read-modify-write, and the popup and the background do not share a lock — so a refresh for one
 * worker could write another worker's entry back, and a logout in the popup did not stick.
 */

import type { Area } from './session.ts';

/** The prefix of a key, per area. An endpoint is appended verbatim. */
export const SESSION_PREFIX = 'fruitback:session:';
export const GRANT_PREFIX = 'fruitback:grant:';

/**
 * The keys that held every endpoint at once, before SKG-602.
 *
 * `migrationOf` is the only thing that reads them, and it removes them. They are exported because
 * the test that covers the upgrade has to write one.
 */
export const LEGACY_SESSIONS_KEY = 'sessions';
export const LEGACY_GRANTS_KEY = 'access';

/**
 * One area of `chrome.storage`, as much of it as this file and `session-browser.ts` use.
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

/**
 * The endpoint a key names, or `undefined` when the key belongs to something else.
 *
 * **`slice` by the prefix length, never `split` on a separator.** An endpoint is a URL somebody
 * typed, so `https://a.test/x:session:y` is a legal one and splitting truncates it.
 */
function endpointOf(prefix: string, key: string): string | undefined {
  return key.startsWith(prefix) ? key.slice(prefix.length) : undefined;
}

/** Whether a set of `storage.onChanged` keys holds a session. One key per endpoint, so it is a scan. */
export function touchesASession(keys: string[]): boolean {
  return keys.some((key) => key.startsWith(SESSION_PREFIX));
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

type Migration = {
  write: Record<string, unknown>;
  remove: string;
};

/**
 * The upgrade from the one legacy record to one key per endpoint, from a single snapshot.
 *
 * Returns nothing when there is no legacy record, which is every run after the first. Otherwise the
 * caller writes `write`, then removes `remove` — in that order, so a failure between them leaves the
 * credentials readable by the next attempt rather than gone.
 *
 * **An endpoint that already has its own key is left alone.** The popup and the background both run
 * this at startup, and the other one may have finished first and had a newer value written over it
 * since. Skipping what is already there is what makes the second run write nothing rather than put
 * an older value back.
 *
 * The window this does not close: the other context can read the legacy record, a logout can remove
 * that endpoint's new key, and the read that was already in flight can then write the session back.
 * It needs a log out inside the one storage round trip that separates the read from the write, on
 * the first run after the upgrade only. `chrome.storage` has no transaction and no compare-and-set,
 * so it is narrowed and stated rather than closed — the same limit as the generation marker in
 * `session.ts`.
 */
export function migrationOf<T>(
  snapshot: Record<string, unknown>,
  legacyKey: string,
  prefix: string,
  parse: (value: unknown) => T | undefined,
): Migration | undefined {
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

  return { write, remove: legacyKey };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
