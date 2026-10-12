import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { type Seed, parseSeedFromDescription } from '@fruitback/shared';
import { seedFixture } from '@fruitback/shared/seed.fixture';
import { handleRequest } from './app.ts';
import { resetCacheState } from './cache.ts';
import type { WorkerEnv } from './env.ts';
import { type Kv, createMemoryKv, resetSharedKv } from './kv.ts';
import { resetMemoryLinear } from './linear-memory.ts';
import { installLinearStub } from './linear-stub.ts';
import { batchParent } from './linear.ts';
import { chargeRateLimit, checkRateLimit, maxBatch } from './rate-limit.ts';
import { type SeedStore, StoreError } from './store.ts';

/** Several notes in one request (FRU-124): `POST /feedback` with an array of seeds. */

const ORIGIN = 'https://preview.acme.test';
const PAGE = `${ORIGIN}/pricing`;
const MEMORY: WorkerEnv = { FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: ORIGIN } as WorkerEnv;
const LINEAR: WorkerEnv = {
  LINEAR_API_KEY: 'lin_api_test',
  LINEAR_TEAM_ID: 'team_1',
  ALLOWED_ORIGINS: ORIGIN,
} as WorkerEnv;

beforeEach(async () => {
  await resetSharedKv();
  resetCacheState();
  resetMemoryLinear();
});
afterEach(() => mock.restoreAll());

function seeds(count: number): Seed[] {
  return Array.from({ length: count }, (_, index) =>
    seedFixture({
      id: `sd_batch_${index}`,
      note: `Note ${index + 1}`,
      page: { url: PAGE, path: '/pricing', title: 'Pricing' },
    }),
  );
}

type Options = { env?: WorkerEnv; kv?: Kv; store?: SeedStore; ip?: string; query?: string };

function send(body: unknown, options: Options = {}): Promise<Response> {
  return handleRequest(
    new Request(`https://worker.fruitback.dev/feedback${options.query ?? ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify(body),
    }),
    options.env ?? MEMORY,
    {
      clientIp: options.ip ?? '203.0.113.7',
      ...(options.kv === undefined ? {} : { kv: options.kv }),
      ...(options.store === undefined ? {} : { store: options.store }),
    },
  );
}

function read(options: Options = {}): Promise<Response> {
  return handleRequest(
    new Request(`https://worker.fruitback.dev/feedback?url=${encodeURIComponent(PAGE)}&client=acme`, {
      headers: { Origin: ORIGIN },
    }),
    options.env ?? MEMORY,
    { clientIp: options.ip ?? '203.0.113.8', ...(options.kv === undefined ? {} : { kv: options.kv }) },
  );
}

type Results = { results: ({ id: string; issue: { identifier: string } } | { id: string; error: string })[] };

describe('what a worker offers to take in one request', () => {
  it('says the most notes and the most bytes in the envelope of a read', async () => {
    const answer = (await (await read()).json()) as { batch?: unknown };

    assert.deepEqual(answer.batch, { max: 10, maxBytes: 64 * 1024 });
  });

  it('is half the limit of a minute, ten at most, and nothing below two', async () => {
    assert.equal(maxBatch(20), 10);
    assert.equal(maxBatch(2000), 10);
    assert.equal(maxBatch(8), 4);
    assert.equal(maxBatch(4), 2);
    assert.equal(maxBatch(3), 0);
    assert.equal(maxBatch(), 10);

    const low = { ...MEMORY, RATE_LIMIT_PER_MINUTE: '3' } as WorkerEnv;
    assert.equal(((await (await read({ env: low })).json()) as { batch?: unknown }).batch, undefined);
    const refused = await send(seeds(2), { env: low });
    assert.equal(refused.status, 400);
    assert.deepEqual(await refused.json(), { error: 'invalid-batch', max: 0 });
  });
});

describe('a batch of notes (FRU-124)', () => {
  it('keeps each note as its own issue, answers each one in order, and reads them back as pins', async () => {
    const sent = await send(seeds(3));

    assert.equal(sent.status, 201, await sent.clone().text());
    const { results } = (await sent.json()) as Results;
    assert.deepEqual(
      results.map((result) => result.id),
      ['sd_batch_0', 'sd_batch_1', 'sd_batch_2'],
    );
    assert.ok(results.every((result) => 'issue' in result));

    const pins = (await (await read()).json()) as { issues: { seed: { note: string } }[] };
    assert.deepEqual(pins.issues.map((issue) => issue.seed.note).sort(), ['Note 1', 'Note 2', 'Note 3']);
  });

  it('writes a parent in Linear and each note as one of its sub-issues, and the parent is no pin', async () => {
    const linear = installLinearStub();

    const sent = await send(seeds(2), { env: LINEAR });

    assert.equal(sent.status, 201, await sent.clone().text());
    const created = linear.calls.filter((call) => call.operation === 'FruitbackCreateIssue');
    assert.equal(created.length, 3);
    const [parent, ...children] = created.map((call) => call.variables.input as Record<string, unknown>);
    assert.equal(parent?.parentId, undefined);
    assert.equal(parent?.title, '2 notes on preview.acme.test');
    assert.equal(parseSeedFromDescription(String(parent?.description)).ok, false, 'the parent holds a seed');
    for (const child of children) {
      assert.equal(child.parentId, 'issue_1');
      assert.equal(parseSeedFromDescription(String(child.description)).ok, true);
    }
  });

  it('writes the words of the parent in the language of the team', () => {
    assert.match(batchParent(seeds(2), 'fr-FR').title, /^2 notes sur preview\.acme\.test$/);
    assert.match(batchParent(seeds(2)).description, /- .* \(https:\/\/preview\.acme\.test\/pricing\)/);
  });

  it('refuses a batch that is empty, too long, or holds one thing that is not a seed, and writes nothing', async () => {
    for (const [body, status] of [
      [[], 400],
      [seeds(11), 400],
      [[...seeds(2), { note: 'no seed' }], 400],
      [[seeds(1)[0], seeds(1)[0]], 400],
      [[seeds(1)[0], { ...seeds(2)[1], client: { id: 'globex' } }], 400],
    ] as const) {
      assert.equal((await send(body)).status, status, JSON.stringify(body).slice(0, 60));
    }
    const refused = (await (await send([...seeds(2), { note: 'no seed' }])).json()) as { index?: number };
    assert.equal(refused.index, 2);

    const pins = (await (await read()).json()) as { issues: unknown[] };
    assert.deepEqual(pins.issues, []);
  });

  it('costs one request for each note, and refuses the batch whole when that goes over the limit', async () => {
    const kv = createMemoryKv();
    // Ten requests of the minute are spent: a batch of ten more would be twenty, and is refused.
    for (let index = 0; index < 11; index += 1) await read({ kv, ip: '198.51.100.1' });

    const refused = await send(seeds(10), { kv, ip: '198.51.100.1' });

    assert.equal(refused.status, 429);
    const pins = (await (await read()).json()) as { issues: unknown[] };
    assert.deepEqual(pins.issues, [], 'a refused batch wrote a note');

    // The control: the same batch from a caller who spent nothing passes.
    assert.equal((await send(seeds(10), { kv, ip: '198.51.100.2' })).status, 201);
  });

  it('answers the notes another attempt kept, and plants only the others', async () => {
    let fail = true;
    let created = 0;
    const flaky: SeedStore = {
      name: 'flaky',
      scope: () => '',
      findForPage: async () => [],
      async create(seed) {
        if (seed.id === 'sd_batch_1' && fail) throw new StoreError('down');
        created += 1;

        return { id: `id_${seed.id}`, identifier: `FB-${seed.id.slice(-1)}` };
      },
    };
    const kv = createMemoryKv();

    const partial = await send(seeds(3), { kv, store: flaky });
    assert.equal(partial.status, 207);
    assert.deepEqual(((await partial.json()) as Results).results, [
      { id: 'sd_batch_0', issue: { id: 'id_sd_batch_0', identifier: 'FB-0' } },
      { id: 'sd_batch_1', error: 'store-unavailable' },
      { id: 'sd_batch_2', issue: { id: 'id_sd_batch_2', identifier: 'FB-2' } },
    ]);

    // The widget sends the batch again: the two kept notes are not planted a second time.
    fail = false;
    const again = await send(seeds(3), { kv, store: flaky });
    assert.equal(again.status, 201);
    assert.deepEqual(
      ((await again.json()) as Results).results.map((result) => ('issue' in result ? result.issue.identifier : '')),
      ['FB-0', 'FB-1', 'FB-2'],
    );
    assert.equal(created, 3);
  });

  it('plants each note once when two attempts of one batch arrive at the same moment', async () => {
    let created = 0;
    const slow: SeedStore = {
      name: 'slow',
      scope: () => '',
      findForPage: async () => [],
      async create(seed) {
        created += 1;
        await new Promise((done) => setTimeout(done, 20));

        return { id: `id_${seed.id}`, identifier: `FB-${seed.id.slice(-1)}` };
      },
    };
    const kv = createMemoryKv();

    const [first, second] = await Promise.all([
      send(seeds(2), { kv, store: slow }),
      send(seeds(2), { kv, store: slow, ip: '203.0.113.9' }),
    ]);

    assert.equal(created, 2, 'a note was planted twice');
    assert.deepEqual([first.status, second.status].sort(), [201, 502]);
    // The attempt that waited sends again, and reads what the other one kept.
    const again = await send(seeds(2), { kv, store: slow });
    assert.equal(again.status, 201);
    assert.equal(created, 2);
  });

  it('gives a note back when the store did not keep it, so the next attempt plants it at once', async () => {
    let fail = true;
    const store: SeedStore = {
      name: 'once-down',
      scope: () => '',
      findForPage: async () => [],
      async create(seed) {
        if (fail) throw new StoreError('down');

        return { id: seed.id, identifier: 'FB-1' };
      },
    };
    const kv = createMemoryKv();

    assert.equal((await send(seeds(2), { kv, store })).status, 502);
    fail = false;
    assert.equal((await send(seeds(2), { kv, store })).status, 201);
  });

  it('keeps the answers of the notes before one that throws an error nobody expected', async () => {
    let broken = true;
    let created = 0;
    const store: SeedStore = {
      name: 'broken',
      scope: () => '',
      findForPage: async () => [],
      async create(seed) {
        if (broken && seed.id === 'sd_batch_1') throw new TypeError('a defect');
        created += 1;

        return { id: seed.id, identifier: `FB-${seed.id.slice(-1)}` };
      },
    };
    const kv = createMemoryKv();
    mock.method(console, 'error', () => undefined);

    // Not `500`: the first note is kept, and its answer must reach the widget and the `Kv`.
    const partial = await send(seeds(2), { kv, store });
    assert.equal(partial.status, 207);
    broken = false;
    assert.equal((await send(seeds(2), { kv, store })).status, 201);
    assert.equal(created, 2, 'the note that was kept was planted a second time');
  });

  it('gives the notes back when the whole batch throws an error nobody expected', async () => {
    const kv = createMemoryKv();
    const thrower: SeedStore = {
      name: 'thrower',
      scope: () => '',
      findForPage: async () => [],
      create: async () => ({ id: 'x', identifier: 'FB-1' }),
      createBatch: async () => {
        throw new TypeError('a defect');
      },
    };
    const working: SeedStore = { ...thrower, createBatch: undefined as never };
    delete (working as { createBatch?: unknown }).createBatch;

    await assert.rejects(send(seeds(2), { kv, store: thrower }), TypeError);
    // The seeds are not held: the next attempt plants them at once.
    assert.equal((await send(seeds(2), { kv, store: working })).status, 201);
  });

  it('answers 502 when the store kept no note, as for one note', async () => {
    const down: SeedStore = {
      name: 'down',
      scope: () => '',
      findForPage: async () => [],
      create: async () => {
        throw new StoreError('down');
      },
    };

    const answer = await send(seeds(2), { store: down });

    assert.equal(answer.status, 502);
    assert.equal(((await answer.json()) as { error: string }).error, 'store-unavailable');
  });

  it('still takes one note as an object, as before', async () => {
    assert.equal((await send(seeds(1)[0])).status, 201);
  });
});

describe('the limiter counts a batch by its notes', () => {
  it('adds the amount, and a request after it is counted on top', async () => {
    const kv = createMemoryKv();
    const now = 30_000;

    assert.equal(await checkRateLimit(kv, 'ip', { limit: 5, now }), true);
    assert.equal(await chargeRateLimit(kv, 'ip', 4, { limit: 5, now }), true);
    assert.equal(await checkRateLimit(kv, 'ip', { limit: 5, now }), false);
    assert.equal(await chargeRateLimit(kv, 'other', 5, { limit: 5, now }), true);
    assert.equal(await chargeRateLimit(kv, 'other', 1, { limit: 5, now }), false);
    // Nothing more to count for a batch of one note: no count is written.
    assert.equal(await chargeRateLimit(kv, 'third', 0, { limit: 5, now }), true);
    assert.equal(await chargeRateLimit(kv, 'third', 5, { limit: 5, now }), true);
  });

  it('refuses an increment that is not a positive integer', async () => {
    const kv = createMemoryKv();
    await assert.rejects(kv.incr('key', 1000, 0));
    await assert.rejects(kv.incr('key', 1000, 1.5));
    assert.equal(await kv.incr('key', 1000, 3), 3);
    assert.equal(await kv.incr('key', 1000), 4);
  });
});
