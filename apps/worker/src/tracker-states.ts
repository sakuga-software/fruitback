import { SEED_STAGES, STATUS_COLOR } from '@fruitback/shared';
import type { ClientConfig } from './clients.ts';
import { type Kv, KvError } from './kv.ts';
import { placedAt } from './note-helpers.ts';
import type { TrackerSource } from './site-statuses.ts';
import type { SeedStore, TrackerState } from './store.ts';

/**
 * The states of the trackers a site sends to (FRU-368), for the statuses of its read.
 *
 * Linear sends no webhook when a workflow state is added, renamed or recoloured, so the states are read
 * again: each team's list is kept in the `Kv` for `TRACKER_STATES_TTL_MS`, and the first read after
 * that asks Linear again. The statuses page of the console reads them fresh and writes them here, so a
 * change shows on the pins as soon as somebody opens it. A tracker that does not answer takes nothing
 * from the read: its pins keep their stage, as before. docs/decisions/statuses.md, « Linear ».
 */

/** How long the states of one team are kept before they are read again. */
export const TRACKER_STATES_TTL_MS = 10 * 60 * 1000;

/** The key of the states of one team of one connector. */
export function trackerStatesKey(connector: string, team: string | undefined): string {
  return `fruitback:tracker-states:${JSON.stringify([connector, team ?? null])}`;
}

/** Keeps the states of one team, as the console just read them. A `Kv` that does not answer keeps nothing. */
export async function rememberTrackerStates(
  kv: Kv | undefined,
  connector: string,
  team: string | undefined,
  states: readonly TrackerState[],
): Promise<void> {
  if (kv === undefined) return;
  try {
    await kv.set(trackerStatesKey(connector, team), JSON.stringify(states), TRACKER_STATES_TTL_MS);
  } catch (error) {
    if (!(error instanceof KvError)) throw error;
  }
}

/**
 * Lets the states of one team go, so the next read asks the tracker again: what the read keeps carries
 * the exceptions of the connector, which have just changed. A `Kv` has no delete: an empty value is no
 * list of states, and it ends at once.
 */
export async function forgetTrackerStates(
  kv: Kv | undefined,
  connector: string,
  team: string | undefined,
): Promise<void> {
  if (kv === undefined) return;
  try {
    await kv.set(trackerStatesKey(connector, team), '', 1);
  } catch (error) {
    if (!(error instanceof KvError)) throw error;
  }
}

/** The states a `Kv` holds, or `undefined` for none, or for a value that is not a list of states. */
function statesOf(value: string | undefined): TrackerState[] | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    const kept = parsed.filter(
      (each): each is TrackerState =>
        typeof each === 'object' &&
        each !== null &&
        typeof each.id === 'string' &&
        typeof each.name === 'string' &&
        (SEED_STAGES as readonly unknown[]).includes(each.stage) &&
        (each.color === undefined || (typeof each.color === 'string' && STATUS_COLOR.test(each.color))),
    );

    return kept.length === parsed.length ? kept : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The states of each tracker of the client, one list per connector and team, from the `Kv` or from the
 * store. A place whose store says no states (an address, GitHub) has none; a tracker that fails is
 * left out, and said in the log only.
 */
export async function trackerSourcesOf(
  kv: Kv | undefined,
  store: SeedStore,
  client: ClientConfig | undefined,
): Promise<TrackerSource[]> {
  if (client === undefined || store.trackerStatesFor === undefined) return [];
  const seen = new Set<string>();
  const places = (client.destinations ?? []).filter((place) => {
    const key = trackerStatesKey(place.connector, place.teamId);
    if (seen.has(key)) return false;
    seen.add(key);

    return true;
  });
  const read = await Promise.all(
    places.map(async (place): Promise<TrackerSource | undefined> => {
      const key = trackerStatesKey(place.connector, place.teamId);
      let hit: string | undefined;
      try {
        hit = await kv?.get(key);
      } catch (error) {
        if (!(error instanceof KvError)) throw error;
      }
      const kept = statesOf(hit);
      if (kept !== undefined) return { source: place.connector, states: kept };
      try {
        const states = await store.trackerStatesFor?.(placedAt(client, place));
        if (states === undefined) return undefined;
        await rememberTrackerStates(kv, place.connector, place.teamId, states);

        return { source: place.connector, states };
      } catch (error) {
        console.error(
          `[fruitback] the states of a tracker did not answer: ${error instanceof Error ? error.message : String(error)}`,
        );

        return undefined;
      }
    }),
  );

  return read.filter((each): each is TrackerSource => each !== undefined);
}
