import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DEFAULT_SEED_STAGE, SEED_STAGES, type Seed, type SeedStage, canonicalizePageUrl } from '@fruitback/shared';
import { minimalSeedFixture, seedFixture } from '@fruitback/shared/seed.fixture';
import { handleRequest } from './app.ts';
import { resetCacheState } from './cache.ts';
import type { ClientConfig, ClientPolicy } from './clients.ts';
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

/** Reply `minute`, written that many minutes after the first one. */
function replyAt(minute: number): Reply {
  return { body: `reply ${minute}`, createdAt: new Date(Date.UTC(2026, 8, 1, 10, minute)).toISOString() };
}

/** `count` replies a minute apart, the newest first. */
export function repliesNewestFirst(count: number): Reply[] {
  return Array.from({ length: count }, (_, index) => replyAt(count - 1 - index));
}

export type ConformanceSubject = {
  /** The `provider` of the store's entry in `STORE_SPECS`. */
  provider: string;
  /** Prepare an empty store and its double. Called before each case. */
  open(): SeedStore;
  /** Remove what `open`, `broken` or `unreachable` prepared. Called after each case. */
  close(): void;
  /** The stage of a seed just written. Absent when the store picks it some other way. */
  writtenStage?: SeedStage;
  /** The most replies a read returns on one seed. A case writes more, and `docs/self-hosting.md` gives it. */
  replyCap: number | string;
  /** A client configuration that sends the client's seeds to another tenant than the worker's own. */
  otherTenant: ClientConfig | string;
  /** Give a stored seed a state that the store does not know. */
  unknownState: ((created: CreatedIssue) => void) | string;
  /**
   * Write the seed with the replies of `repliesNewestFirst(count)`. A store that writes its own replies
   * can write another number, but at least two, stored newest first.
   */
  plantReplies(store: SeedStore, seed: Seed, count: number): Promise<void>;
  /** A store whose provider answers every call with an error. It replaces the double of `open`. */
  broken: (() => SeedStore) | string;
  /** A store whose provider cannot be reached, so every call rejects. It replaces the double of `open`. */
  unreachable: (() => SeedStore) | string;
  /** A store whose provider answers with something it cannot read. It replaces the double of `open`. */
  garbled: (() => SeedStore) | string;
};

const POLICY: ClientPolicy = { showComments: true, identitySecret: undefined, read: 'public', locale: 'en' };
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

/** The store rejects with `StoreError`, and the worker answers `502 store-unavailable` on both routes. */
async function assertStoreUnavailable(failing: SeedStore): Promise<void> {
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
}

export function describeStoreConformance(subject: ConformanceSubject): void {
  describe(`the ${subject.provider} store keeps the SeedStore promises`, () => {
    let store: SeedStore;

    beforeEach(() => {
      store = subject.open();
      assert.equal(store.name, subject.provider, 'the subject opened another store');
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
      const stage = found[0]?.stage;
      assert.ok(
        (store.stages ?? SEED_STAGES).some((declared) => declared === stage),
        'a stage the store does not declare',
      );
      if (subject.writtenStage !== undefined) assert.equal(stage, subject.writtenStage);
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

    // Only a worker without FRUITBACK_CLIENTS accepts a read that names no client.
    it('gives a read that names no client every seed on the page', async () => {
      await store.create(seedFor('sd_acme', PAGE, 'acme'), undefined, POLICY);
      await store.create(seedFor('sd_nobody', PAGE, undefined), undefined, POLICY);
      await store.create(seedFor('sd_elsewhere', PAGE_WITH_QUERY, 'acme'), undefined, POLICY);

      const ids = (await find(PAGE, undefined)).map((issue) => issue.seed.id).sort();

      assert.deepEqual(ids, ['sd_acme', 'sd_nobody']);
    });

    it(
      'writes and reads a client in the tenant its configuration names',
      { skip: skipReason(subject.otherTenant) },
      async () => {
        if (typeof subject.otherTenant === 'string') return;
        const tenant = subject.otherTenant;
        // The default tenant is written first, as on a worker that already served it: its labels
        // exist, and a store that looks them up in the wrong tenant finds them.
        await store.create(seedFor('sd_default_tenant', PAGE, 'acme'), undefined, POLICY);
        await store.create(seedFor('sd_other_tenant', PAGE, 'acme'), tenant, POLICY);

        const ids = async (client: typeof tenant | undefined) =>
          (await store.findForPage({ url: PAGE, clientId: 'acme' }, client, POLICY)).map((issue) => issue.seed.id);

        assert.deepEqual(await ids(tenant), ['sd_other_tenant']);
        assert.deepEqual(await ids(undefined), ['sd_default_tenant']);
        assert.notEqual(store.scope(tenant), store.scope(undefined));
      },
    );

    it('draws a state it does not know at the default stage', { skip: skipReason(subject.unknownState) }, async () => {
      const created = await store.create(seedFor('sd_unknown_state', PAGE, 'acme'), undefined, POLICY);
      if (typeof subject.unknownState === 'function') subject.unknownState(created);

      const found = await find(PAGE, 'acme');

      assert.equal(found.length, 1);
      assert.equal(found[0]?.stage, DEFAULT_SEED_STAGE);
    });

    it('returns the replies oldest first', async () => {
      await subject.plantReplies(store, seedFor('sd_replies', PAGE, 'acme'), 2);

      const times = (await find(PAGE, 'acme'))[0]?.comments?.map((comment) => comment.createdAt) ?? [];

      assert.ok(times.length >= 2, 'the seed has fewer than two replies');
      assert.deepEqual(times, [...times].sort());
      assert.notEqual(times[0], times.at(-1));
    });

    it('leaves the replies out when the client hides them', async () => {
      await subject.plantReplies(store, seedFor('sd_hidden_replies', PAGE, 'acme'), 2);

      const [shown] = await find(PAGE, 'acme', POLICY);
      const [hidden] = await find(PAGE, 'acme', QUIET);

      assert.ok((shown?.comments?.length ?? 0) > 0, 'the seed has no replies to hide');
      assert.ok(hidden !== undefined, 'the seed was not found');
      assert.equal('comments' in hidden, false);
    });

    it('returns the newest replies up to its cap', { skip: skipReason(subject.replyCap) }, async () => {
      if (typeof subject.replyCap !== 'number') return;
      const cap = subject.replyCap;
      await subject.plantReplies(store, seedFor('sd_long_thread', PAGE, 'acme'), cap + 2);

      const bodies = (await find(PAGE, 'acme'))[0]?.comments?.map((comment) => comment.body) ?? [];

      // The two oldest replies, at minutes 0 and 1, are the ones left out.
      assert.deepEqual(
        bodies,
        Array.from({ length: cap }, (_, index) => `reply ${index + 2}`),
      );
    });

    it('says empty when a seed has no replies', async () => {
      await store.create(seedFor('sd_no_replies', PAGE, 'acme'), undefined, POLICY);

      const [shown] = await find(PAGE, 'acme', POLICY);

      assert.ok(shown !== undefined, 'the seed was not found');
      assert.deepEqual(shown.comments, []);
    });

    it(
      'reports a provider error as store-unavailable, never as a 500',
      { skip: skipReason(subject.broken) },
      async () => {
        if (typeof subject.broken === 'function') await assertStoreUnavailable(subject.broken());
      },
    );

    it(
      'reports an unreachable provider as store-unavailable, never as a 500',
      { skip: skipReason(subject.unreachable) },
      async () => {
        if (typeof subject.unreachable === 'function') await assertStoreUnavailable(subject.unreachable());
      },
    );

    it(
      'reports an answer it cannot read as store-unavailable, never as a 500',
      { skip: skipReason(subject.garbled) },
      async () => {
        if (typeof subject.garbled === 'function') await assertStoreUnavailable(subject.garbled());
      },
    );
  });
}
