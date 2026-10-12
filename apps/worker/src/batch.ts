import type { Seed } from '@fruitback/shared';
import type { ClientConfig, ClientPolicy } from './clients.ts';
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
