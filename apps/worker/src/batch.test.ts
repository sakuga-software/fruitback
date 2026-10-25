import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { mockMethod } from './mock.fixture.ts';
import assert from 'node:assert/strict';
import { type Note, parseNoteFromDescription } from '@fruitback/shared';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { handleRequest } from './app.ts';
import { resetCacheState } from './cache.ts';
import type { WorkerEnv } from './env.ts';
import { type Kv, createMemoryKv, resetSharedKv } from './kv.ts';
import { resetMemoryLinear } from './linear-memory.ts';
import { installLinearStub } from './linear-stub.ts';
import { batchParent } from './linear.ts';
import { chargeRateLimit, checkRateLimit, maxBatch } from './rate-limit.ts';
import { type NoteStore, StoreError } from './store.ts';
import { beforePostgres } from './before-postgres.fixture.ts';

/** Several notes in one request (FRU-124): `POST /feedback` with an array of notes. */

const ORIGIN = 'https://preview.acme.test';
const PAGE = `${ORIGIN}/pricing`;
const MEMORY: WorkerEnv = beforePostgres({ FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: ORIGIN });
const LINEAR: WorkerEnv = beforePostgres({
  LINEAR_API_KEY: 'lin_api_test',
  LINEAR_TEAM_ID: 'team_1',
  ALLOWED_ORIGINS: ORIGIN,
});

beforeEach(async () => {
  await resetSharedKv();
  resetCacheState();
  resetMemoryLinear();
});
afterEach(() => vi.restoreAllMocks());

function notes(count: number): Note[] {
  return Array.from({ length: count }, (_, index) =>
    noteFixture({
      id: `sd_batch_${index}`,
      text: `Note ${index + 1}`,
      page: { url: PAGE, path: '/pricing', title: 'Pricing' },
    }),
  );
}

type Options = { env?: WorkerEnv; kv?: Kv; store?: NoteStore; ip?: string; query?: string };

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
    const refused = await send(notes(2), { env: low });
    assert.equal(refused.status, 400);
    assert.deepEqual(await refused.json(), { error: 'invalid-batch', max: 0 });
  });
});

describe('a batch of notes (FRU-124)', () => {
  it('keeps each note as its own issue, answers each one in order, and reads them back as pins', async () => {
    const sent = await send(notes(3));

    assert.equal(sent.status, 201, await sent.clone().text());
    const { results } = (await sent.json()) as Results;
    assert.deepEqual(
      results.map((result) => result.id),
      ['sd_batch_0', 'sd_batch_1', 'sd_batch_2'],
    );
    assert.ok(results.every((result) => 'issue' in result));

    const pins = (await (await read()).json()) as { issues: { note: { text: string } }[] };
    assert.deepEqual(pins.issues.map((issue) => issue.note.text).sort(), ['Note 1', 'Note 2', 'Note 3']);
  });

  it('writes a parent in Linear and each note as one of its sub-issues, and the parent is no pin', async () => {
    const linear = installLinearStub();

    const sent = await send(notes(2), { env: LINEAR });

    assert.equal(sent.status, 201, await sent.clone().text());
    const created = linear.calls.filter((call) => call.operation === 'FruitbackCreateIssue');
    assert.equal(created.length, 3);
    const [parent, ...children] = created.map((call) => call.variables.input as Record<string, unknown>);
    assert.equal(parent?.parentId, undefined);
    assert.equal(parent?.title, '2 notes on preview.acme.test');
    assert.equal(parseNoteFromDescription(String(parent?.description)).ok, false, 'the parent holds a note');
    for (const child of children) {
      assert.equal(child.parentId, 'issue_1');
      assert.equal(parseNoteFromDescription(String(child.description)).ok, true);
    }
  });

  it('writes the words of the parent in the language of the team', () => {
    assert.match(batchParent(notes(2), 'fr-FR').title, /^2 notes sur preview\.acme\.test$/);
    assert.match(batchParent(notes(2)).description, /- .* \(https:\/\/preview\.acme\.test\/pricing\)/);
  });

  it('refuses a batch that is empty, too long, or holds one thing that is not a note, and writes nothing', async () => {
    for (const [body, status] of [
      [[], 400],
      [notes(11), 400],
      [[...notes(2), { note: 'no note' }], 400],
      [[notes(1)[0], notes(1)[0]], 400],
      [[notes(1)[0], { ...notes(2)[1], client: { id: 'globex' } }], 400],
    ] as const) {
      assert.equal((await send(body)).status, status, JSON.stringify(body).slice(0, 60));
    }
    const refused = (await (await send([...notes(2), { note: 'no note' }])).json()) as { index?: number };
    assert.equal(refused.index, 2);

    const pins = (await (await read()).json()) as { issues: unknown[] };
    assert.deepEqual(pins.issues, []);
  });

  it('costs one request for each note, and refuses the batch whole when that goes over the limit', async () => {
    const kv = createMemoryKv();
    // Ten requests of the minute are spent: a batch of ten more would be twenty, and is refused.
    for (let index = 0; index < 11; index += 1) await read({ kv, ip: '198.51.100.1' });

    const refused = await send(notes(10), { kv, ip: '198.51.100.1' });

    assert.equal(refused.status, 429);
    const pins = (await (await read()).json()) as { issues: unknown[] };
    assert.deepEqual(pins.issues, [], 'a refused batch wrote a note');

    // The control: the same batch from a caller who spent nothing passes.
    assert.equal((await send(notes(10), { kv, ip: '198.51.100.2' })).status, 201);
  });

  it('answers the notes another attempt kept, and plants only the others', async () => {
    let fail = true;
    let created = 0;
    const flaky: NoteStore = {
      name: 'flaky',
      scope: () => '',
      findForPage: async () => [],
      async create(note) {
        if (note.id === 'sd_batch_1' && fail) throw new StoreError('down');
        created += 1;

        return { id: `id_${note.id}`, identifier: `FB-${note.id.slice(-1)}` };
      },
    };
    const kv = createMemoryKv();

    const partial = await send(notes(3), { kv, store: flaky });
    assert.equal(partial.status, 207);
    assert.deepEqual(((await partial.json()) as Results).results, [
      { id: 'sd_batch_0', issue: { id: 'id_sd_batch_0', identifier: 'FB-0' } },
      { id: 'sd_batch_1', error: 'store-unavailable' },
      { id: 'sd_batch_2', issue: { id: 'id_sd_batch_2', identifier: 'FB-2' } },
    ]);

    // The widget sends the batch again: the two kept notes are not planted a second time.
    fail = false;
    const again = await send(notes(3), { kv, store: flaky });
    assert.equal(again.status, 201);
    assert.deepEqual(
      ((await again.json()) as Results).results.map((result) => ('issue' in result ? result.issue.identifier : '')),
      ['FB-0', 'FB-1', 'FB-2'],
    );
    assert.equal(created, 3);
  });

  it('plants each note once when two attempts of one batch arrive at the same moment', async () => {
    let created = 0;
    const slow: NoteStore = {
      name: 'slow',
      scope: () => '',
      findForPage: async () => [],
      async create(note) {
        created += 1;
        await new Promise((done) => setTimeout(done, 20));

        return { id: `id_${note.id}`, identifier: `FB-${note.id.slice(-1)}` };
      },
    };
    const kv = createMemoryKv();

    const [first, second] = await Promise.all([
      send(notes(2), { kv, store: slow }),
      send(notes(2), { kv, store: slow, ip: '203.0.113.9' }),
    ]);

    assert.equal(created, 2, 'a note was planted twice');
    assert.deepEqual([first.status, second.status].sort(), [201, 502]);
    // The attempt that waited sends again, and reads what the other one kept.
    const again = await send(notes(2), { kv, store: slow });
    assert.equal(again.status, 201);
    assert.equal(created, 2);
  });

  it('gives a note back when the store did not keep it, so the next attempt plants it at once', async () => {
    let fail = true;
    const store: NoteStore = {
      name: 'once-down',
      scope: () => '',
      findForPage: async () => [],
      async create(note) {
        if (fail) throw new StoreError('down');

        return { id: note.id, identifier: 'FB-1' };
      },
    };
    const kv = createMemoryKv();

    assert.equal((await send(notes(2), { kv, store })).status, 502);
    fail = false;
    assert.equal((await send(notes(2), { kv, store })).status, 201);
  });

  it('keeps the answers of the notes before one that throws an error nobody expected', async () => {
    let broken = true;
    let created = 0;
    const store: NoteStore = {
      name: 'broken',
      scope: () => '',
      findForPage: async () => [],
      async create(note) {
        if (broken && note.id === 'sd_batch_1') throw new TypeError('a defect');
        created += 1;

        return { id: note.id, identifier: `FB-${note.id.slice(-1)}` };
      },
    };
    const kv = createMemoryKv();
    mockMethod(console, 'error', () => undefined);

    // Not `500`: the first note is kept, and its answer must reach the widget and the `Kv`.
    const partial = await send(notes(2), { kv, store });
    assert.equal(partial.status, 207);
    broken = false;
    assert.equal((await send(notes(2), { kv, store })).status, 201);
    assert.equal(created, 2, 'the note that was kept was planted a second time');
  });

  it('gives the notes back when the whole batch throws an error nobody expected', async () => {
    const kv = createMemoryKv();
    const thrower: NoteStore = {
      name: 'thrower',
      scope: () => '',
      findForPage: async () => [],
      create: async () => ({ id: 'x', identifier: 'FB-1' }),
      createBatch: async () => {
        throw new TypeError('a defect');
      },
    };
    const working: NoteStore = { ...thrower, createBatch: undefined as never };
    delete (working as { createBatch?: unknown }).createBatch;

    await assert.rejects(send(notes(2), { kv, store: thrower }), TypeError);
    // The notes are not held: the next attempt plants them at once.
    assert.equal((await send(notes(2), { kv, store: working })).status, 201);
  });

  it('keeps the note and holds it when the Kv does not keep its trace', async () => {
    let created = 0;
    const store: NoteStore = {
      name: 'counting',
      scope: () => '',
      findForPage: async () => [],
      async create(note) {
        created += 1;

        return { id: note.id, identifier: 'FB-1' };
      },
    };
    const memory = createMemoryKv();
    // The trace of a kept note is refused, and nothing else is.
    const kv: Kv = {
      ...memory,
      set: (key, value, ttl) =>
        key.startsWith('fruitback:sent:') ? Promise.reject(new Error('refused')) : memory.set(key, value, ttl),
    };

    assert.equal((await send(notes(2), { kv, store })).status, 201);
    // The same batch at once: the notes are still held, so nothing is planted a second time.
    assert.equal((await send(notes(2), { kv, store })).status, 502);
    assert.equal(created, 2);
  });

  it('answers 502 when the store kept no note, as for one note', async () => {
    const down: NoteStore = {
      name: 'down',
      scope: () => '',
      findForPage: async () => [],
      create: async () => {
        throw new StoreError('down');
      },
    };

    const answer = await send(notes(2), { store: down });

    assert.equal(answer.status, 502);
    assert.equal(((await answer.json()) as { error: string }).error, 'store-unavailable');
  });

  it('still takes one note as an object, as before', async () => {
    assert.equal((await send(notes(1)[0])).status, 201);
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
