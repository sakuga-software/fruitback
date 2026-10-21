import type { Seed } from '@fruitback/shared';
import type { ClientConfig, ClientPolicy } from './clients.ts';
import type { Kv } from './kv.ts';
import { type BatchAnswer, type BatchMemory, type SeedStore, StoreError } from './store.ts';

/**
 * Plants the seeds of a batch (FRU-124): through the store's own `createBatch`, or one `create` for
 * each seed when the store has none. One answer for each seed, in order.
 *
 * A seed that the store did not keep is answered as such, and the others stay: the widget keeps that
 * one as a draft and sends it again. It throws `StoreError` only when no seed was kept, so the request
 * answers `502` as a single note does.
 */
export async function createAll(
  store: SeedStore,
  seeds: readonly Seed[],
  client: ClientConfig | undefined,
  policy: ClientPolicy,
  /** What an earlier attempt left for these seeds (FRU-195). */
  memory?: BatchMemory,
): Promise<BatchAnswer[]> {
  const answers = store.createBatch === undefined ? await oneByOne(store, seeds, client, policy) : undefined;
  const found =
    answers ?? (await (store.createBatch as NonNullable<SeedStore['createBatch']>)(seeds, client, policy, memory));
  if (found.length !== seeds.length) throw new StoreError('The store did not answer for every note of the batch');
  if (found.every((answer) => 'error' in answer)) throw new StoreError('The store kept no note of the batch');

  return found;
}

/** In order, one at a time: a tracker that refuses the first one is not asked the others at once. */
async function oneByOne(
  store: SeedStore,
  seeds: readonly Seed[],
  client: ClientConfig | undefined,
  policy: ClientPolicy,
): Promise<BatchAnswer[]> {
  const answers: BatchAnswer[] = [];
  for (const seed of seeds) {
    try {
      answers.push({ issue: await store.create(seed, client, policy) });
    } catch (error) {
      // WARNING: nothing is thrown from here. The notes before this one are kept: an error that left
      // this loop would answer `500`, lose their answers, and the next attempt would plant them a
      // second time. An error that is not the store's is said in the log.
      if (!(error instanceof StoreError)) console.error('[fruitback] a note of a batch failed', error);
      answers.push({ error: 'store-unavailable' });
    }
  }

  return answers;
}

/** How long a seed that was kept answers its issue again, for a widget that sends it twice. */
export const SENT_TTL_MS = 10 * 60_000;

export function sentKey(clientId: string | undefined, seedId: string): string {
  return `fruitback:sent:${JSON.stringify([clientId ?? null, seedId])}`;
}

/** How long a seed that a request is planting is held from another request. */
const SENDING_TTL_MS = 60_000;

function sendingKey(clientId: string | undefined, seedId: string): string {
  return `fruitback:sending:${JSON.stringify([clientId ?? null, seedId])}`;
}

/**
 * Takes a seed for this request, or says that another request holds it.
 *
 * `incr` is the one atomic call of a `Kv`: the request that reads 1 holds the seed. Two attempts of
 * one batch at the same moment would both read « not kept yet », and both plant it. A `Kv` that does
 * not answer holds nothing: the seed is sent, as before this guard.
 */
export async function hold(kv: Kv, clientId: string | undefined, seedId: string): Promise<boolean> {
  try {
    return (await kv.incr(sendingKey(clientId, seedId), SENDING_TTL_MS)) === 1;
  } catch {
    return true;
  }
}

/** Gives a seed back when it was not kept, so the next attempt can take it at once. */
export async function release(kv: Kv, clientId: string | undefined, seedId: string): Promise<void> {
  await kv.set(sendingKey(clientId, seedId), '0', SENDING_TTL_MS).catch(() => undefined);
}

function parentKey(clientId: string | undefined, scope: string, seedId: string): string {
  return `fruitback:batch-parent:${JSON.stringify([clientId ?? null, scope, seedId])}`;
}

/**
 * The parent of a batch, from one attempt to the next (FRU-195), in the `Kv`: one entry for each seed,
 * for as long as a seed is remembered. An attempt that sends again only some of the notes still
 * finds the parent. The place is in the key: a parent of one team is not used for another.
 *
 * WARNING: nothing throws from here. A `Kv` that does not answer costs a second parent, not a note.
 */
export function batchMemory(
  kv: Kv,
  store: SeedStore,
  clientId: string | undefined,
  target: ClientConfig | undefined,
  seeds: readonly Seed[],
): BatchMemory {
  const keys = (): string[] => {
    const scope = store.scope(target);

    return seeds.map((seed) => parentKey(clientId, scope, seed.id));
  };
  const write = async (value: string): Promise<void> => {
    try {
      await Promise.all(keys().map((key) => kv.set(key, value, SENT_TTL_MS)));
    } catch {
      // Not remembered: the next attempt writes a parent, as before FRU-195.
    }
  };

  return {
    async parent() {
      try {
        const found = await Promise.all(keys().map((key) => kv.get(key)));

        // An entry that was forgotten is empty: the `Kv` has no delete.
        return found.find((id) => id !== undefined && id !== '');
      } catch {
        return undefined;
      }
    },
    keepParent: (id) => write(id),
    forgetParent: () => write(''),
  };
}
