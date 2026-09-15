import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DEFAULT_SEED_STAGE, SEED_STAGES, type Seed, canonicalizePageUrl } from '@fruitback/shared';
import { minimalSeedFixture, seedFixture } from '@fruitback/shared/seed.fixture';
import { handleRequest } from './app.ts';
import { resetCacheState } from './cache.ts';
import type { ClientPolicy } from './clients.ts';
import type { WorkerEnv } from './env.ts';
import { createMemoryKv } from './kv.ts';
import { type CreatedIssue, type SeedStore, StoreError } from './store.ts';

/**
 * What every `SeedStore` promises, whatever holds the seeds (SKG-527).
 *
 * `store-conformance.test.ts` runs this suite once for each entry in `STORE_SPECS`. A remote store
 * runs against a double that keeps what it receives, so that a read finds what a write stored.
 *
 * A connector that cannot do one of the steps below gives the reason as a string. The case is then
 * reported as skipped with that reason, never as passed.
 */

export type Reply = { body: string; createdAt: string };

export type ConformanceSubject = {
  /** The `provider` of the store's entry in `STORE_SPECS`. */
  provider: string;
  /** Prepare an empty store and its double. Called before each case. */
  open(): SeedStore;
  /** Remove what `open` or `broken` prepared. Called after each case. */
  close(): void;
  /** Give a stored seed a state that the store does not know. */
  unknownState: ((created: CreatedIssue) => void) | string;
  /** Store replies on a seed, in the order given. */
  reply: ((created: CreatedIssue, replies: Reply[]) => void) | string;
  /** A store whose provider fails every call. */
  broken: (() => SeedStore) | string;
};

const POLICY: ClientPolicy = { showComments: true, identitySecret: undefined, read: 'public' };
const QUIET: ClientPolicy = { ...POLICY, showComments: false };

const ORIGIN = 'https://preview.acme.test';
const ENV: WorkerEnv = {
  LINEAR_API_KEY: 'lin_api_test',
  LINEAR_TEAM_ID: 'team_1',
  ALLOWED_ORIGINS: ORIGIN,
};

const PAGE = canonicalizePageUrl('https://preview.acme.test/pricing');
const PAGE_WITH_QUERY = canonicalizePageUrl('https://preview.acme.test/pricing?tab=annual');

function seedFor(id: string, url: string, client: string | undefined): Seed {
  const page = { url, path: '/pricing', title: 'Pricing — Acme' };

  return client === undefined
    ? minimalSeedFixture({ id, page })
    : seedFixture({ id, page, client: { id: client, name: client } });
}

function skipReason(step: unknown): string | false {
  return typeof step === 'string' ? step : false;
}

export function describeStoreConformance(subject: ConformanceSubject): void {
  describe(`the ${subject.provider} store keeps the SeedStore promises`, () => {
    let store: SeedStore;

    beforeEach(() => {
      store = subject.open();
    });

    afterEach(() => {
      subject.close();
      resetCacheState();
    });

    const find = (url: string, clientId: string | undefined, policy = POLICY) =>
      store.findForPage({ url, clientId }, undefined, policy);

    it('reads a written seed back as the same seed', async () => {
      const seed = seedFor('sd_round_trip', PAGE, 'acme');
      const created = await store.create(seed, undefined, POLICY);

      const found = await find(PAGE, 'acme');

      assert.equal(found.length, 1);
      assert.deepEqual(found[0]?.seed, seed);
      assert.equal(found[0]?.id, created.id);
      assert.equal(found[0]?.identifier, created.identifier);
      assert.ok(
        (store.stages ?? SEED_STAGES).includes(found[0]?.stage ?? 'unknown'),
        'a stage the store does not declare',
      );
    });

    it('keeps a page apart from the same page with a query string', async () => {
      await store.create(seedFor('sd_page', PAGE, 'acme'), undefined, POLICY);
      await store.create(seedFor('sd_page_with_query', PAGE_WITH_QUERY, 'acme'), undefined, POLICY);

      const ids = async (url: string) => (await find(url, 'acme')).map((issue) => issue.seed.id);

      assert.deepEqual(await ids(PAGE), ['sd_page']);
      assert.deepEqual(await ids(PAGE_WITH_QUERY), ['sd_page_with_query']);
    });

    it('never gives one client the seeds of another, or a seed that names no client', async () => {
      await store.create(seedFor('sd_acme', PAGE, 'acme'), undefined, POLICY);
      await store.create(seedFor('sd_globex', PAGE, 'globex'), undefined, POLICY);
      await store.create(seedFor('sd_nobody', PAGE, undefined), undefined, POLICY);

      const ids = async (clientId: string) => (await find(PAGE, clientId)).map((issue) => issue.seed.id);

      assert.deepEqual(await ids('acme'), ['sd_acme']);
      assert.deepEqual(await ids('globex'), ['sd_globex']);
    });

    it('draws a state it does not know at the default stage', { skip: skipReason(subject.unknownState) }, async () => {
      const created = await store.create(seedFor('sd_unknown_state', PAGE, 'acme'), undefined, POLICY);
      if (typeof subject.unknownState === 'function') subject.unknownState(created);

      const found = await find(PAGE, 'acme');

      assert.equal(found.length, 1);
      assert.equal(found[0]?.stage, DEFAULT_SEED_STAGE);
    });

    it('returns the replies oldest first', { skip: skipReason(subject.reply) }, async () => {
      const created = await store.create(seedFor('sd_replies', PAGE, 'acme'), undefined, POLICY);
      if (typeof subject.reply === 'function') {
        subject.reply(created, [
          { body: 'second', createdAt: '2026-09-02T10:00:00.000Z' },
          { body: 'first', createdAt: '2026-09-01T10:00:00.000Z' },
        ]);
      }

      const found = await find(PAGE, 'acme');

      assert.deepEqual(
        found[0]?.comments?.map((comment) => comment.body),
        ['first', 'second'],
      );
    });

    it('leaves the replies out when the client hides them, and says empty when there are none', async () => {
      await store.create(seedFor('sd_no_replies', PAGE, 'acme'), undefined, POLICY);

      const [hidden] = await find(PAGE, 'acme', QUIET);
      const [shown] = await find(PAGE, 'acme', POLICY);

      assert.ok(hidden !== undefined && shown !== undefined, 'the seed was not found');
      assert.equal('comments' in hidden, false);
      assert.deepEqual(shown.comments, []);
    });

    it(
      'reports a provider failure as store-unavailable, never as a 500',
      { skip: skipReason(subject.broken) },
      async () => {
        if (typeof subject.broken !== 'function') return;
        const failing = subject.broken();
        const seed = seedFor('sd_outage', PAGE, 'acme');

        await assert.rejects(failing.create(seed, undefined, POLICY), StoreError);
        await assert.rejects(failing.findForPage({ url: PAGE, clientId: 'acme' }, undefined, POLICY), StoreError);

        const context = () => ({ clientIp: '203.0.113.1', store: failing, kv: createMemoryKv() });
        const write = await handleRequest(
          new Request('https://worker.fruitback.dev/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
            body: JSON.stringify(seed),
          }),
          ENV,
          context(),
        );
        const read = await handleRequest(
          new Request(`https://worker.fruitback.dev/feedback?url=${encodeURIComponent(PAGE)}&client=acme`, {
            headers: { Origin: ORIGIN },
          }),
          ENV,
          context(),
        );

        for (const response of [write, read]) {
          assert.equal(response.status, 502);
          assert.equal(((await response.json()) as { error?: string }).error, 'store-unavailable');
        }
      },
    );
  });
}
