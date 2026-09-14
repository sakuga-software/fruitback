import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { SEED_STAGES, type SeedIssue, canonicalizePageUrl, parseSeedFromDescription } from '@fruitback/shared';
import { minimalSeedFixture, seedFixture } from '@fruitback/shared/seed.fixture';
import { handleRequest } from './app.ts';
import type { WorkerEnv } from './env.ts';
import { installLinearStub, storedIssueFromSeed } from './linear-stub.ts';
import { signIdentityToken } from './identity.ts';
import type { SeedStore } from './store.ts';
import { type Kv, KvError, createMemoryKv, resetSharedKv } from './kv.ts';
import { resetCacheState } from './cache.ts';
import { resetMemoryLinear } from './linear-memory.ts';

const ORIGIN = 'https://preview.acme.test';

const env: WorkerEnv = {
  LINEAR_API_KEY: 'lin_api_test',
  LINEAR_TEAM_ID: 'team_1',
  LINEAR_PROJECT_ID: 'project_1',
  ALLOWED_ORIGINS: `${ORIGIN},http://localhost:5173`,
};

type RequestOverrides = {
  origin?: string | null;
  env?: WorkerEnv;
  headers?: Record<string, string>;
  /** Already resolved by the transport in production — see `resolveClientIp`. */
  clientIp?: string;
  /** Built once by the transport in production — see `RequestContext.store` (SKG-522). */
  store?: SeedStore;
  /** Built once by the transport in production — see `RequestContext.kv` (SKG-542). */
  kv?: Kv;
};

function post(body: unknown, init: RequestOverrides = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json', ...(init.headers ?? {}) });
  if (init.origin !== null) headers.set('Origin', init.origin ?? ORIGIN);

  const request = new Request('https://worker.fruitback.dev/feedback', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

  return handleRequest(request, init.env ?? env, {
    clientIp: init.clientIp ?? '203.0.113.1',
    ...(init.store ? { store: init.store } : {}),
    ...(init.kv ? { kv: init.kv } : {}),
  });
}

function get(path: string, init: RequestOverrides = {}) {
  const headers = new Headers(init.headers ?? {});
  if (init.origin !== null) headers.set('Origin', init.origin ?? ORIGIN);

  return handleRequest(new Request(`https://worker.fruitback.dev${path}`, { headers }), init.env ?? env, {
    clientIp: init.clientIp ?? '203.0.113.1',
    ...(init.store ? { store: init.store } : {}),
    ...(init.kv ? { kv: init.kv } : {}),
  });
}

beforeEach(async () => {
  await resetSharedKv();
  resetCacheState();
});

afterEach(() => {
  mock.restoreAll();
});

describe('POST /feedback', () => {
  it('creates a Linear issue and returns its identifier and URL', async () => {
    const stub = installLinearStub({ existingLabels: { fruitback: 'label_existing' } });

    const response = await post(seedFixture());

    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
      issue: { id: 'issue_1', identifier: 'SKG-999', url: 'https://linear.app/sakuga-software/issue/SKG-999' },
    });
    assert.equal(stub.issueInput().teamId, 'team_1');
    assert.equal(stub.issueInput().projectId, 'project_1');
  });

  it('stores a description the widget can parse back into the exact same seed', async () => {
    // The whole read path depends on this. If it breaks, pins can never be re-planted.
    const stub = installLinearStub();
    const seed = seedFixture();

    await post(seed);

    assert.deepEqual(parseSeedFromDescription(stub.issueInput().description), { ok: true, seed });
  });

  it("titles the issue with the visitor's own words", async () => {
    const stub = installLinearStub();

    await post(seedFixture({ note: 'Le CTA est trop petit' }));

    assert.equal(stub.issueInput().title, 'Le CTA est trop petit');
  });

  it('applies the fruitback label and the client label, creating what is missing', async () => {
    const stub = installLinearStub({ existingLabels: { fruitback: 'label_existing' } });

    await post(seedFixture());

    assert.deepEqual(stub.createdLabels(), ['fruitback:acme']);
    assert.deepEqual(stub.issueInput().labelIds, ['label_existing', 'label_1']);
  });

  it('still plants the seed when a label cannot be created', async () => {
    // Losing a label is a triage annoyance; losing the client's feedback is a bug.
    const stub = installLinearStub({ failLabelCreation: true });

    const response = await post(seedFixture());

    assert.equal(response.status, 201);
    assert.deepEqual(stub.issueInput().labelIds, []);
  });

  it('normalizes the page URL server-side', async () => {
    // A client that skipped normalization would otherwise plant a pin the read path cannot find.
    const stub = installLinearStub();
    const raw = 'https://preview.acme.test/pricing/?utm_source=ads&tab=annual#cta';

    await post(seedFixture({ page: { url: raw, path: '/pricing' } }));

    const result = parseSeedFromDescription(stub.issueInput().description);
    assert.ok(result.ok);
    assert.equal(result.seed.page.url, canonicalizePageUrl(raw));
  });

  it('rejects a payload that is not a seed', async () => {
    installLinearStub();

    const response = await post({ hello: 'world' });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid-seed', reason: 'not-found' });
  });

  it('rejects malformed JSON', async () => {
    installLinearStub();

    const response = await post('{ not json');

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid-json' });
  });

  it('rejects an oversized body', async () => {
    installLinearStub();
    // Built as raw JSON: the schema caps a note at 5 000 chars, so `createSeed` would refuse this.
    const oversized = JSON.stringify({ ...seedFixture(), note: 'x'.repeat(70_000) });

    const response = await post(oversized);

    assert.equal(response.status, 413);
  });

  it('stops reading an oversized body instead of buffering it whole', async () => {
    installLinearStub();
    // A forged Content-Length must not buy the caller a free 10 MB of process memory.
    let pulled = 0;
    const chunk = new TextEncoder().encode('x'.repeat(8 * 1_024));
    const body = new ReadableStream({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
    });

    const response = await handleRequest(
      new Request('https://worker.fruitback.dev/feedback', {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Length': '10' },
        body,
        duplex: 'half',
      } as RequestInit),
      env,
      { clientIp: '203.0.113.1' },
    );

    assert.equal(response.status, 413);
    // 64 KB cap over 8 KB chunks: it must give up around the ninth pull, not keep draining.
    assert.ok(pulled <= 10, `read ${pulled} chunks before giving up`);
  });

  it('reports a Linear outage as 502 so the widget can keep the note and retry', async () => {
    installLinearStub({ failIssueCreation: true });

    const response = await post(seedFixture());

    assert.equal(response.status, 502);
    assert.partialDeepStrictEqual(await response.json(), { error: 'store-unavailable' });
  });
});

describe('CORS', () => {
  it('echoes an allowed origin and varies on it', async () => {
    installLinearStub();

    const response = await post(seedFixture());

    assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.equal(response.headers.get('Vary'), 'Origin');
  });

  it('refuses an origin that is not on the allowlist', async () => {
    installLinearStub();

    const response = await post(seedFixture(), { origin: 'https://evil.test' });

    assert.equal(response.status, 403);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  });

  it('allows any origin when configured with a wildcard', async () => {
    installLinearStub();

    const response = await post(seedFixture(), {
      origin: 'https://anything.test',
      env: { ...env, ALLOWED_ORIGINS: '*' },
    });

    assert.equal(response.status, 201);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://anything.test');
  });

  it('answers the preflight without touching Linear', async () => {
    const stub = installLinearStub();
    const request = new Request('https://worker.fruitback.dev/feedback', {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN },
    });

    const response = await handleRequest(request, env, { clientIp: '203.0.113.1' });

    assert.equal(response.status, 204);
    assert.ok(response.headers.get('Access-Control-Allow-Methods')?.includes('POST'));
    assert.deepEqual(stub.calls, []);
  });

  it('serves a request with no Origin at all (curl, health check)', async () => {
    installLinearStub();

    const response = await post(seedFixture(), { origin: null });

    assert.equal(response.status, 201);
  });

  /**
   * The extension relays a client site's call from its own service worker (SKG-596), which sends
   * `chrome-extension://<id>` on the POST. No operator can put that id on an allowlist — it differs
   * between an unpacked build and a store build — and a `403` here is the whole of team mode not
   * working, with nothing in a browser to say why.
   *
   * It grants exactly what the line above already grants `curl`. CORS was never what decides who may
   * read a pin; under `read: 'authenticated'` the token still is.
   */
  it('serves the extension, whose origin no allowlist can name', async () => {
    installLinearStub();

    const response = await post(seedFixture(), { origin: 'chrome-extension://ekjmfoaibpceoc' });

    assert.equal(response.status, 201);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'chrome-extension://ekjmfoaibpceoc');
  });

  /** A list of schemes, so everything else falls through to the allowlist rather than past it. */
  it('refuses a scheme that only looks like an extension', async () => {
    installLinearStub();

    for (const origin of ['file://', 'null', 'chrome-extension:', 'https://chrome-extension.evil.dev']) {
      const response = await post(seedFixture(), { origin });
      assert.equal(response.status, 403, origin);
    }
  });
});

describe('guard rails', () => {
  it('rate-limits a client hammering the endpoint', async () => {
    installLinearStub();

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 21; attempt += 1) {
      statuses.push((await post(seedFixture(), { clientIp: '203.0.113.7' })).status);
    }

    assert.ok(statuses.slice(0, 20).every((status) => status === 201));
    assert.equal(statuses[20], 429);
  });

  it('counts each client separately', async () => {
    installLinearStub();

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await post(seedFixture(), { clientIp: '203.0.113.7' });
    }
    const other = await post(seedFixture(), { clientIp: '203.0.113.8' });

    assert.equal(other.status, 201);
  });

  it('says what is missing when the service is misconfigured', async () => {
    installLinearStub();

    const response = await post(seedFixture(), { env: { ALLOWED_ORIGINS: ORIGIN } });

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: 'misconfigured',
      missing: ['LINEAR_API_KEY', 'LINEAR_TEAM_ID'],
    });
    // Without CORS headers the browser turns this into an opaque failure and the widget never
    // gets to read which variable is missing.
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  });

  it('still answers readably when even the allowlist is missing', async () => {
    installLinearStub();

    const response = await post(seedFixture(), { env: {} });

    assert.equal(response.status, 500);
    assert.partialDeepStrictEqual(await response.json(), { missing: ['ALLOWED_ORIGINS'] });
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  });
});

describe('GET /feedback', () => {
  const PAGE = 'https://preview.acme.test/pricing?tab=annual';

  type ReadResponse = { url: string; issues: SeedIssue[] };

  function read(page: string, query = '') {
    return get(`/feedback?url=${encodeURIComponent(page)}${query}`);
  }

  async function readBody(page: string, query = ''): Promise<ReadResponse> {
    return (await read(page, query)).json() as Promise<ReadResponse>;
  }

  it('returns the seeds of a page with the Linear state that colours the pin', async () => {
    const seed = seedFixture();
    installLinearStub({ storedIssues: [storedIssueFromSeed(seed)] });

    const response = await read(PAGE);

    assert.equal(response.status, 200);
    const body = (await response.json()) as ReadResponse;
    assert.equal(body.url, PAGE);
    assert.partialDeepStrictEqual(body.issues, [
      {
        id: `issue_${seed.id}`,
        identifier: 'SKG-901',
        url: 'https://linear.app/sakuga-software/issue/SKG-901',
        stage: 'ripening',
        stateName: 'In Progress',
        updatedAt: '2026-08-05T10:00:00.000Z',
      },
    ]);
    // The point of the whole read path: the pin comes back exactly as it was planted.
    assert.deepEqual(body.issues[0]?.seed, seed);
  });

  it('says which stages the store can report, so the panel offers only those (SKG-525)', async () => {
    installLinearStub({ storedIssues: [] });
    const linear = (await readBody(PAGE)) as ReadResponse & { stages?: unknown };
    assert.deepEqual(linear.stages, [...SEED_STAGES]);

    const partial: SeedStore = {
      name: 'partial',
      stages: ['seeded', 'ripe'],
      scope: () => 'partial',
      create: async () => ({ id: 'x', identifier: 'X-1' }),
      findForPage: async () => [],
    };
    const response = await get(`/feedback?url=${encodeURIComponent(PAGE)}`, { store: partial });

    assert.deepEqual(((await response.json()) as { stages?: unknown }).stages, ['seeded', 'ripe']);
  });

  it('asks Linear for the fruitback label, the client label and that exact page', async () => {
    const stub = installLinearStub({ storedIssues: [] });

    await read(PAGE, '&client=acme');

    assert.deepEqual(stub.issueFilter(), {
      team: { id: { eq: 'team_1' } },
      // Two clauses, not one `in`: an issue must carry *both* labels, or one client's pins would
      // surface on another client's site.
      and: [
        { labels: { some: { name: { eq: 'fruitback' } } } },
        { labels: { some: { name: { eq: 'fruitback:acme' } } } },
      ],
      description: { contains: PAGE },
    });
  });

  it('narrows on the fruitback label alone when no client is given', async () => {
    const seed = minimalSeedFixture();
    const stub = installLinearStub({ storedIssues: [storedIssueFromSeed(seed)] });

    const body = await readBody(seed.page.url);

    assert.partialDeepStrictEqual(stub.issueFilter(), { and: [{ labels: { some: { name: { eq: 'fruitback' } } } }] });
    assert.equal(body.issues.length, 1);
  });

  it('canonicalizes the requested URL before matching', async () => {
    // Same reason as the write path: the filter matches this string verbatim inside the description.
    const stub = installLinearStub({ storedIssues: [] });
    const raw = 'https://preview.acme.test/pricing/?utm_source=ads&tab=annual#cta';

    const body = await readBody(raw);

    assert.partialDeepStrictEqual(stub.issueFilter(), { description: { contains: canonicalizePageUrl(raw) } });
    assert.equal(body.url, canonicalizePageUrl(raw));
  });

  it('drops an issue whose seed belongs to a neighbouring page', async () => {
    // Linear's `contains` is a substring match, so `/pricing` also brings back `/pricing?tab=annual`.
    const page = 'https://preview.acme.test/pricing';
    const mine = seedFixture({ id: 'sd_here', page: { url: page, path: '/pricing' } });
    const neighbour = seedFixture({ id: 'sd_elsewhere' });
    installLinearStub({ storedIssues: [storedIssueFromSeed(mine), storedIssueFromSeed(neighbour)] });

    const body = await readBody(page);

    assert.deepEqual(
      body.issues.map((issue) => issue.seed.id),
      ['sd_here'],
    );
  });

  it('skips an issue whose seed block someone edited away', async () => {
    // A pin we cannot place is worse than a pin we do not show.
    installLinearStub({ storedIssues: [storedIssueFromSeed(seedFixture(), { description: 'Just prose now.' })] });

    const body = await readBody(PAGE);

    assert.deepEqual(body.issues, []);
  });

  it('walks every page of results', async () => {
    const seeds = ['sd_1', 'sd_2', 'sd_3'].map((id) => seedFixture({ id }));
    const stub = installLinearStub({ storedIssues: seeds.map((seed) => storedIssueFromSeed(seed)), issuesPageSize: 2 });

    const body = await readBody(PAGE);

    assert.deepEqual(
      body.issues.map((issue) => issue.seed.id),
      ['sd_1', 'sd_2', 'sd_3'],
    );
    assert.equal(stub.calls.filter((call) => call.operation === 'FruitbackIssues').length, 2);
  });

  it('serves a repeated read from cache instead of spending Linear quota again', async () => {
    const stub = installLinearStub({ storedIssues: [storedIssueFromSeed(seedFixture())] });

    const first = await read(PAGE);
    const second = await read(PAGE);

    assert.equal(stub.calls.length, 1);
    assert.deepEqual(await second.json(), await first.json());
    // Not a browser cache: the widget must never be served its own stale copy of a page it just
    // planted a pin on. The read cache in the Kv is what protects the Linear quota.
    assert.equal(second.headers.get('Cache-Control'), 'no-store');
  });

  it('keys the cache per client, so one client is never served another one’s pins', async () => {
    const stub = installLinearStub({ storedIssues: [] });

    await read(PAGE, '&client=acme');
    await read(PAGE, '&client=globex');

    assert.equal(stub.calls.length, 2);
  });

  it('refuses a request that names no page', async () => {
    installLinearStub();

    const response = await get('/feedback');

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'missing-url' });
  });

  it('refuses a page that is not an absolute http(s) URL', async () => {
    installLinearStub();

    const response = await read('/pricing');

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid-url' });
  });

  it('reports a Linear outage as 502 rather than an empty page', async () => {
    // Answering `200 []` would tell the widget the client's pins are gone.
    installLinearStub({ failIssueQuery: true });

    const response = await read(PAGE);

    assert.equal(response.status, 502);
    assert.partialDeepStrictEqual(await response.json(), { error: 'store-unavailable' });
  });
});

describe('the in-memory Linear (dev loop)', () => {
  const fakeEnv: WorkerEnv = { ALLOWED_ORIGINS: ORIGIN, FRUITBACK_FAKE_LINEAR: '1' };

  beforeEach(() => {
    resetMemoryLinear();
  });

  it('serves the whole loop with no API key at all', async () => {
    // The point of the playground: capture → issue → the pin comes back, without a Linear workspace.
    installLinearStub(); // installed to prove it is never called
    const seed = seedFixture();

    const created = await post(seed, { env: fakeEnv });
    const read = await get(`/feedback?url=${encodeURIComponent(seed.page.url)}&client=acme`, { env: fakeEnv });

    assert.equal(created.status, 201);
    assert.equal(read.status, 200);
    const body = (await read.json()) as { issues: SeedIssue[] };
    assert.equal(body.issues.length, 1);
    // Stored as a description and parsed back, exactly like the real path — so a broken round trip
    // breaks the dev loop too, instead of being papered over by a mock that returns objects.
    assert.deepEqual(body.issues[0]?.seed, seed);
  });

  it('never reaches the network', async () => {
    const stub = installLinearStub();

    await post(seedFixture(), { env: fakeEnv });
    await get(`/feedback?url=${encodeURIComponent(seedFixture().page.url)}`, { env: fakeEnv });

    assert.deepEqual(stub.calls, []);
  });

  it('says so on /health, rather than reporting a plain green check', async () => {
    const response = await get('/health', { env: fakeEnv });

    assert.equal(response.status, 200);
    // `openRead: 1` because this dev worker serves one client and its reads are public — the
    // default, and what every worker did before SKG-533.
    assert.deepEqual(await response.json(), { ok: true, store: 'memory', openRead: 1 });
  });

  it('refuses the flag in production and reports itself misconfigured', async () => {
    // The Dockerfile sets NODE_ENV=production, so this is what a container inheriting the flag does.
    // The flag *degrades* to the real store, which then has no credentials — so the diagnostic names
    // Linear's variables rather than the flag. An explicit FRUITBACK_STORE=memory is refused outright
    // instead; see the SKG-526 suite.
    const response = await get('/health', { env: { ...fakeEnv, NODE_ENV: 'production' } });

    assert.equal(response.status, 503);
    assert.partialDeepStrictEqual(await response.json(), { missing: ['LINEAR_API_KEY', 'LINEAR_TEAM_ID'] });
  });
});

describe('cache invalidation', () => {
  it('shows a pin planted a moment ago instead of the cached answer', async () => {
    // Otherwise posting feedback and reloading reads as "my note was lost" for a whole TTL.
    const seed = seedFixture();
    const stored = storedIssueFromSeed(seed);
    installLinearStub({ storedIssues: [] });

    const before = await get(`/feedback?url=${encodeURIComponent(seed.page.url)}`);
    assert.deepEqual(((await before.json()) as { issues: SeedIssue[] }).issues, []);

    // The stub answers from the same array, so a cached read would still report zero.
    installLinearStub({ storedIssues: [stored] });
    await post(seed);

    const after = await get(`/feedback?url=${encodeURIComponent(seed.page.url)}`);
    assert.equal(((await after.json()) as { issues: SeedIssue[] }).issues.length, 1);
  });
});

/** A Kv whose calls all reject, the way a store that went away rejects them. */
function unreachableKv(): Kv {
  const down = async () => {
    throw new KvError('connection failed: connect ECONNREFUSED');
  };

  return { ...createMemoryKv(), get: down, set: down, incr: down };
}

describe('the Kv the transport hands over (SKG-542)', () => {
  const CACHED_PAGE = 'https://preview.acme.test/pricing?tab=annual';

  it('holds one rate limit for two replicas on one Kv', async () => {
    // Two handlers on one `Kv` share one count. A store shared between replicas (SKG-606) relies on it.
    installLinearStub();
    const kv = createMemoryKv();
    const replicas = [{ kv }, { kv: { ...kv } }];
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 21; attempt += 1) {
      statuses.push((await post(seedFixture(), { clientIp: '203.0.113.7', ...replicas[attempt % 2] })).status);
    }

    assert.equal(statuses.filter((status) => status === 201).length, 20);
    assert.equal(statuses[20], 429);
  });

  it('counts through the Kv the transport handed it', async () => {
    installLinearStub();
    const kv = createMemoryKv();
    const counted: string[] = [];
    const recording: Kv = { ...kv, incr: (key, ttl) => (counted.push(key), kv.incr(key, ttl)) };

    await post(seedFixture(), { kv: recording });

    assert.equal(counted.length, 1, 'the handler counted somewhere else');
  });

  it('serves a second replica the answer the first one cached', async () => {
    const stub = installLinearStub({ storedIssues: [storedIssueFromSeed(seedFixture())] });
    const kv = createMemoryKv();

    await get(`/feedback?url=${encodeURIComponent(CACHED_PAGE)}`, { kv });
    // The in-flight promise is what a second process does not have. The answer it stored is.
    resetCacheState();
    await get(`/feedback?url=${encodeURIComponent(CACHED_PAGE)}`, { kv: { ...kv } });

    assert.equal(stub.calls.length, 1);
  });

  it('refuses a metered call with 503 when the Kv does not answer, and keeps its CORS headers', async () => {
    const stub = installLinearStub();
    mock.method(console, 'error', () => {});

    const response = await post(seedFixture(), { kv: unreachableKv() });

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'limiter-unavailable' });
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.deepEqual(stub.calls, [], 'the call reached the store with no rate limit');
  });

  it('answers /health when the Kv does not', async () => {
    // A readiness probe that depends on the `Kv` takes every replica out at once.
    const response = await handleRequest(new Request('https://worker.fruitback.dev/health'), env, {
      clientIp: '203.0.113.1',
      kv: unreachableKv(),
    });

    assert.equal(response.status, 200);
  });

  it('answers 201 when the write lands and the cache cannot be told', async () => {
    // A 502 tells the widget to retry, and the retry would plant the same note twice.
    installLinearStub();
    mock.method(console, 'error', () => {});
    const kv = createMemoryKv();
    const refusingWrites: Kv = {
      ...kv,
      set: async () => {
        throw new KvError('connection failed');
      },
    };

    const response = await post(seedFixture(), { kv: refusingWrites });

    assert.equal(response.status, 201);
  });
});

describe('one worker, several clients', () => {
  const CLIENTS = JSON.stringify({
    acme: { teamId: 'team_acme', projectId: 'project_acme', origins: [ORIGIN] },
    globex: { teamId: 'team_globex' },
  });
  const multi: WorkerEnv = { ...env, FRUITBACK_CLIENTS: CLIENTS };
  const fakeMulti: WorkerEnv = {
    ALLOWED_ORIGINS: `${ORIGIN},https://globex.test`,
    FRUITBACK_FAKE_LINEAR: '1',
    FRUITBACK_CLIENTS: CLIENTS,
  };

  beforeEach(() => {
    resetMemoryLinear();
  });

  it('creates a client’s issue on that client’s team and project', async () => {
    const stub = installLinearStub();

    await post(seedFixture({ client: { id: 'acme', name: 'Acme' } }), { env: multi });

    assert.equal(stub.issueInput().teamId, 'team_acme');
    assert.equal(stub.issueInput().projectId, 'project_acme');
  });

  it('narrows a read to the team its client routes to', async () => {
    const stub = installLinearStub({ storedIssues: [] });

    await get(`/feedback?url=${encodeURIComponent(seedFixture().page.url)}&client=acme`, { env: multi });

    assert.partialDeepStrictEqual(stub.issueFilter(), { team: { id: { eq: 'team_acme' } } });
  });

  it('refuses to create an issue for a seed that names nobody', async () => {
    // The other direction of the same leak: with a map configured, the default team is not a place
    // to put a note whose owner is unknown.
    installLinearStub();

    const response = await post(seedFixture({ client: undefined }), { env: multi });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'client-required' });
  });

  it('reads back a note whose client id arrived padded', async () => {
    // The test the previous version of this one should have been. Asserting the *route* passed while
    // the label kept the spaces: the issue landed in the right team as `fruitback:  acme  `, and the
    // client's own clean read — filtering `fruitback:acme` — came back empty. Authorised at both
    // ends, invisible in between. So this asserts the round trip, not the routing.
    installLinearStub();
    const url = seedFixture().page.url;

    const created = await post(seedFixture({ id: 'sd_padded', client: { id: '  acme  ' } }), { env: fakeMulti });
    const read = await get(`/feedback?url=${encodeURIComponent(url)}&client=acme`, { env: fakeMulti });

    assert.equal(created.status, 201);
    assert.deepEqual(
      ((await read.json()) as { issues: SeedIssue[] }).issues.map((issue) => issue.seed.id),
      ['sd_padded'],
    );
  });

  it('stores the normalised client id, so the label matches what a read asks for', async () => {
    const stub = installLinearStub();

    await post(seedFixture({ client: { id: '  acme  ' } }), { env: multi });

    assert.equal(stub.issueInput().teamId, 'team_acme');
    assert.deepEqual(stub.createdLabels(), ['fruitback', 'fruitback:acme']);
  });

  it('refuses to answer a read that names nobody', async () => {
    // Answering the default was how one client read another's feedback.
    installLinearStub({ storedIssues: [] });

    const response = await get(`/feedback?url=${encodeURIComponent(seedFixture().page.url)}`, { env: multi });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'client-required' });
  });

  it('refuses a client it has never heard of', async () => {
    installLinearStub({ storedIssues: [] });

    const response = await get(`/feedback?url=${encodeURIComponent(seedFixture().page.url)}&client=nobody`, {
      env: multi,
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'unknown-client' });
  });

  it('refuses a client claimed from a site it is not embedded on', async () => {
    installLinearStub({ storedIssues: [] });

    const response = await get(`/feedback?url=${encodeURIComponent(seedFixture().page.url)}&client=acme`, {
      env: { ...multi, ALLOWED_ORIGINS: '*' },
      origin: 'https://evil.test',
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'origin-not-allowed-for-client' });
  });

  it('keeps two clients on the same page from seeing each other', async () => {
    // The test this ticket exists for. Both plant a note on the same URL; each read returns one pin.
    installLinearStub();
    const url = seedFixture().page.url;
    await post(seedFixture({ id: 'sd_acme', client: { id: 'acme' } }), { env: fakeMulti });
    await post(seedFixture({ id: 'sd_globex', client: { id: 'globex' } }), {
      env: fakeMulti,
      origin: 'https://globex.test',
    });

    const acme = await (await get(`/feedback?url=${encodeURIComponent(url)}&client=acme`, { env: fakeMulti })).json();
    const globex = await (
      await get(`/feedback?url=${encodeURIComponent(url)}&client=globex`, {
        env: fakeMulti,
        origin: 'https://globex.test',
      })
    ).json();

    assert.deepEqual(
      (acme as { issues: SeedIssue[] }).issues.map((issue) => issue.seed.id),
      ['sd_acme'],
    );
    assert.deepEqual(
      (globex as { issues: SeedIssue[] }).issues.map((issue) => issue.seed.id),
      ['sd_globex'],
    );
  });

  it('serves a client from its own site without repeating it in ALLOWED_ORIGINS', async () => {
    // Two lists to keep in step is one list that drifts, so a client's `origins` join the allowlist.
    installLinearStub({ storedIssues: [] });
    const onlyTheMap: WorkerEnv = { ...env, ALLOWED_ORIGINS: 'https://elsewhere.test', FRUITBACK_CLIENTS: CLIENTS };

    const response = await get(`/feedback?url=${encodeURIComponent(seedFixture().page.url)}&client=acme`, {
      env: onlyTheMap,
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  });

  it('still tells a client-map-only site what is misconfigured', async () => {
    // The diagnostic exists so the widget can read which variable is missing. Without CORS headers
    // the browser turns the 500 into an opaque failure and it never gets that far — and the origins
    // that only exist in the client map are exactly the ones this feature asks operators to stop
    // repeating in ALLOWED_ORIGINS.
    installLinearStub();
    const broken: WorkerEnv = {
      ALLOWED_ORIGINS: 'https://elsewhere.test',
      FRUITBACK_CLIENTS: CLIENTS,
      TRUSTED_PROXY_HOPS: 'not-a-number',
    };

    const response = await get(`/feedback?url=${encodeURIComponent(seedFixture().page.url)}&client=acme`, {
      env: broken,
    });

    assert.equal(response.status, 500);
    assert.partialDeepStrictEqual(await response.json(), { error: 'misconfigured' });
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  });

  it('says which variable is wrong when the map is malformed', async () => {
    // Silently ignoring it would pool every client into the default team — the leak, again.
    const response = await get('/health', { env: { ...env, FRUITBACK_CLIENTS: '{ not json' } });

    assert.equal(response.status, 503);
    const body = (await response.json()) as { missing: string[] };
    assert.ok(
      body.missing.some((name) => name.startsWith('FRUITBACK_CLIENTS')),
      `expected FRUITBACK_CLIENTS in ${body.missing.join(', ')}`,
    );
  });
});

describe('routing', () => {
  it('404s an unknown path', async () => {
    const response = await get('/nope');

    assert.equal(response.status, 404);
  });
});

describe('GET /health', () => {
  it('is ready when the service can actually serve', async () => {
    const response = await get('/health');

    assert.equal(response.status, 200);
    // Compared exactly rather than partially, on purpose: this endpoint is public, so a field
    // appearing here should have to be written down. `openRead` is one such field (SKG-533), and
    // `store` is the other (SKG-526) — it replaced `fakeLinear: true`, which only one provider could
    // ever say.
    assert.deepEqual(await response.json(), { ok: true, store: 'linear', openRead: 1 });
  });

  it('stops counting open reads once they need an identity', async () => {
    const response = await get('/health', {
      env: {
        ...env,
        FRUITBACK_READ: 'authenticated',
        // 32 characters minimum — a short HMAC secret is a guessable one, and the config refuses it.
        FRUITBACK_IDENTITY_SECRET: 'a-secret-that-is-long-enough-to-be-one',
      },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, store: 'linear' });
  });

  it('is not ready when a required variable is missing, and names it', async () => {
    // Dokploy must not route traffic to a container that cannot reach Linear.
    const response = await get('/health', { env: { ALLOWED_ORIGINS: ORIGIN } });

    assert.equal(response.status, 503);
    assert.partialDeepStrictEqual(await response.json(), {
      ok: false,
      missing: ['LINEAR_API_KEY', 'LINEAR_TEAM_ID'],
    });
  });

  it('answers without an Origin, the way a container healthcheck calls it', async () => {
    const response = await get('/health', { origin: null });

    assert.equal(response.status, 200);
  });

  it('refuses to report ready on a malformed TRUSTED_PROXY_HOPS', async () => {
    // Silently defaulting would make the rate-limit key caller-controlled without anyone noticing.
    const response = await get('/health', { env: { ...env, TRUSTED_PROXY_HOPS: 'two' } });

    assert.equal(response.status, 503);
    assert.partialDeepStrictEqual(await response.json(), { missing: ['TRUSTED_PROXY_HOPS'] });
  });
});

describe('attribution', () => {
  const SECRET = 'a-secret-long-enough-to-not-be-guessed';
  const identityEnv: WorkerEnv = { ...env, FRUITBACK_IDENTITY_SECRET: SECRET };
  const inAnHour = () => Math.floor((Date.now() + 3_600_000) / 1000);

  it('keeps an anonymous submission anonymous', async () => {
    const stub = installLinearStub();

    const response = await post(seedFixture({ reporter: undefined }));

    assert.equal(response.status, 201);
    const stored = parseSeedFromDescription(stub.issueInput().description);
    assert.ok(stored.ok);
    assert.equal(stored.seed.reporter, undefined);
  });

  it('stores a typed name as the claim it is', async () => {
    const stub = installLinearStub();

    await post(seedFixture({ reporter: { name: 'Alice', email: 'alice@acme.test' } }));

    const stored = parseSeedFromDescription(stub.issueInput().description);
    assert.ok(stored.ok);
    assert.deepEqual(stored.seed.reporter, { name: 'Alice', email: 'alice@acme.test' });
    assert.match(stub.issueInput().description, /Reported by.*unverified — self-declared/);
  });

  it('refuses to let a client call itself verified', async () => {
    // The one that matters. Without the strip, this reads in Linear exactly like an identity the
    // worker checked — which is a way to put a colleague's name on a complaint.
    const stub = installLinearStub();

    await post(seedFixture({ reporter: { name: 'CEO', verified: true } }));

    const stored = parseSeedFromDescription(stub.issueInput().description);
    assert.ok(stored.ok);
    assert.deepEqual(stored.seed.reporter, { name: 'CEO' });
    assert.doesNotMatch(stub.issueInput().description, /\(verified\)/);
  });

  it('vouches for a reporter behind a valid token', async () => {
    const stub = installLinearStub();
    const token = await signIdentityToken({ sub: 'user_42', name: 'Alice', exp: inAnHour() }, SECRET);

    const response = await post(seedFixture({ reporter: undefined }), {
      env: identityEnv,
      headers: { Authorization: `Bearer ${token}` },
    });

    assert.equal(response.status, 201);
    const stored = parseSeedFromDescription(stub.issueInput().description);
    assert.ok(stored.ok);
    assert.deepEqual(stored.seed.reporter, { id: 'user_42', name: 'Alice', verified: true });
    assert.match(stub.issueInput().description, /Reported by\*\* · Alice \(verified\)/);
  });

  it('lets the token overrule a name claimed alongside it', async () => {
    const stub = installLinearStub();
    const token = await signIdentityToken({ sub: 'user_42', name: 'Alice', exp: inAnHour() }, SECRET);

    await post(seedFixture({ reporter: { name: 'Someone Else', verified: true } }), {
      env: identityEnv,
      headers: { Authorization: `Bearer ${token}` },
    });

    const stored = parseSeedFromDescription(stub.issueInput().description);
    assert.ok(stored.ok);
    assert.deepEqual(stored.seed.reporter, { id: 'user_42', name: 'Alice', verified: true });
  });

  it('refuses a token that does not verify rather than downgrading it', async () => {
    // A site that meant to identify someone and got it wrong should hear about it. Silently storing
    // the note as anonymous is how a broken integration goes unnoticed for a month.
    const token = await signIdentityToken({ sub: 'user_42', exp: inAnHour() }, 'a-different-secret-of-good-length');

    const response = await post(seedFixture(), { env: identityEnv, headers: { Authorization: `Bearer ${token}` } });

    assert.equal(response.status, 401);
    assert.partialDeepStrictEqual(await response.json(), { error: 'invalid-identity', reason: 'bad-signature' });
  });

  it('refuses an expired token', async () => {
    const token = await signIdentityToken({ sub: 'user_42', exp: Math.floor(Date.now() / 1000) - 60 }, SECRET);

    const response = await post(seedFixture(), { env: identityEnv, headers: { Authorization: `Bearer ${token}` } });

    assert.equal(response.status, 401);
    assert.partialDeepStrictEqual(await response.json(), { reason: 'expired' });
  });

  it('refuses a token when no secret is configured, rather than ignoring it', async () => {
    const token = await signIdentityToken({ sub: 'user_42', exp: inAnHour() }, SECRET);

    const response = await post(seedFixture(), { headers: { Authorization: `Bearer ${token}` } });

    assert.equal(response.status, 401);
    assert.partialDeepStrictEqual(await response.json(), { reason: 'identity-not-configured' });
  });

  it('uses the client’s own secret ahead of the worker’s', async () => {
    const clientSecret = 'the-acme-secret-which-is-long-enough';
    const mapped: WorkerEnv = {
      ...identityEnv,
      FRUITBACK_CLIENTS: JSON.stringify({ acme: { teamId: 'team_acme', identitySecret: clientSecret } }),
    };
    const stub = installLinearStub();
    const token = await signIdentityToken({ sub: 'user_7', exp: inAnHour() }, clientSecret);

    const response = await post(seedFixture({ client: { id: 'acme' } }), {
      env: mapped,
      headers: { Authorization: `Bearer ${token}` },
    });

    assert.equal(response.status, 201);
    const stored = parseSeedFromDescription(stub.issueInput().description);
    assert.ok(stored.ok);
    assert.partialDeepStrictEqual(stored.seed.reporter, { id: 'user_7', verified: true });
  });
});

describe('the team’s replies on the read path', () => {
  it('returns them oldest first, whatever order Linear gave', async () => {
    // Linear answers newest-first by default. The order is settled once, in the worker, so the
    // widget renders what it is handed rather than sorting it again on the other side.
    const seed = seedFixture();
    installLinearStub({
      storedIssues: [
        storedIssueFromSeed(seed, {
          comments: {
            nodes: [
              { id: 'c2', body: 'Puis celui-ci.', createdAt: '2026-08-02T10:00:00.000Z', user: { name: 'Bruno' } },
              { id: 'c1', body: 'Celui-ci d’abord.', createdAt: '2026-08-01T10:00:00.000Z', user: { name: 'Alice' } },
            ],
          },
        }),
      ],
    });

    const response = await get(`/feedback?url=${encodeURIComponent(seed.page.url)}`);
    const { issues } = (await response.json()) as { issues: SeedIssue[] };

    assert.deepEqual(
      issues[0]?.comments?.map((comment) => comment.body),
      ['Celui-ci d’abord.', 'Puis celui-ci.'],
    );
    assert.equal(issues[0]?.comments?.[0]?.author, 'Alice');
  });

  it('keeps a comment whose author Linear no longer knows', async () => {
    // An integration, or a deleted account. Dropping the comment would lose the reply; inventing a
    // name would be worse.
    const seed = seedFixture();
    installLinearStub({
      storedIssues: [
        storedIssueFromSeed(seed, {
          comments: { nodes: [{ id: 'c1', body: 'Sans auteur.', createdAt: '2026-08-01T10:00:00.000Z', user: null }] },
        }),
      ],
    });

    const response = await get(`/feedback?url=${encodeURIComponent(seed.page.url)}`);
    const { issues } = (await response.json()) as { issues: SeedIssue[] };

    assert.equal(issues[0]?.comments?.length, 1);
    assert.equal(issues[0]?.comments?.[0]?.author, undefined);
  });

  it('says nothing rather than empty when a client turned replies off', async () => {
    // Absent and empty mean different things to the widget: one is "not asked", the other is "asked,
    // none". A client with comments off must not read as a team that never answered.
    const seed = seedFixture({ client: { id: 'acme' } });
    const hidden: WorkerEnv = {
      ...env,
      FRUITBACK_CLIENTS: JSON.stringify({ acme: { teamId: 'team_1', showComments: false } }),
    };
    installLinearStub({
      storedIssues: [
        storedIssueFromSeed(seed, {
          comments: { nodes: [{ id: 'c1', body: 'Interne.', createdAt: '2026-08-01T10:00:00.000Z', user: null }] },
        }),
      ],
    });

    const response = await get(`/feedback?url=${encodeURIComponent(seed.page.url)}&client=acme`, { env: hidden });
    const { issues } = (await response.json()) as { issues: SeedIssue[] };

    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.comments, undefined);
  });
});

describe('who may read a pin (SKG-533)', () => {
  const SECRET = 'a-read-secret-long-enough-to-not-be-guessed';
  const inAnHour = () => Math.floor((Date.now() + 3_600_000) / 1000);
  const closed: WorkerEnv = { ...env, FRUITBACK_READ: 'authenticated', FRUITBACK_IDENTITY_SECRET: SECRET };

  function planted() {
    const seed = seedFixture();
    installLinearStub({ storedIssues: [storedIssueFromSeed(seed)] });

    return `/feedback?url=${encodeURIComponent(seed.page.url)}`;
  }

  it('answers an anonymous read where reads are public, which stays the default', async () => {
    const response = await get(planted());

    assert.equal(response.status, 200);
    const { issues } = (await response.json()) as { issues: SeedIssue[] };
    assert.equal(issues.length, 1);
  });

  it('refuses an anonymous read where reads need an identity', async () => {
    // The leak this ticket closes: before it, this request answered with every note on the page,
    // its author and the team's replies, to anyone who could build the URL.
    const response = await get(planted(), { env: closed });

    assert.equal(response.status, 401);
    assert.partialDeepStrictEqual(await response.json(), { error: 'identity-required' });
  });

  it('answers the same read behind a valid token', async () => {
    const token = await signIdentityToken({ sub: 'user_42', exp: inAnHour() }, SECRET);

    const response = await get(planted(), { env: closed, headers: { Authorization: `Bearer ${token}` } });

    assert.equal(response.status, 200);
    const { issues } = (await response.json()) as { issues: SeedIssue[] };
    assert.equal(issues.length, 1);
  });

  it('refuses a token signed with someone else’s secret', async () => {
    const token = await signIdentityToken({ sub: 'user_42', exp: inAnHour() }, 'a-different-secret-of-good-length');

    const response = await get(planted(), { env: closed, headers: { Authorization: `Bearer ${token}` } });

    assert.equal(response.status, 401);
  });

  it('refuses an expired token', async () => {
    const token = await signIdentityToken({ sub: 'user_42', exp: Math.floor(Date.now() / 1000) - 60 }, SECRET);

    const response = await get(planted(), { env: closed, headers: { Authorization: `Bearer ${token}` } });

    assert.equal(response.status, 401);
  });

  it('never serves a warm authenticated answer to an anonymous caller', async () => {
    // The cache entry is per (team, client, page) and holds the same answer for every entitled
    // reader, so it is shared — safe only because an unauthorised caller never gets one.
    //
    // What this catches is a **cache-hit fast path**: an early return that answers from a warm entry
    // before reaching the gate. It does **not** catch the gate merely moving below `cached` — that
    // still returns 401, and this test was measured passing against exactly that mutation. The test
    // above, asserting no Linear call, is what pins the position.
    const path = planted();
    const token = await signIdentityToken({ sub: 'user_42', exp: inAnHour() }, SECRET);

    const warmed = await get(path, { env: closed, headers: { Authorization: `Bearer ${token}` } });
    assert.equal(warmed.status, 200, 'the authenticated read should have filled the cache');

    const anonymous = await get(path, { env: closed });

    assert.equal(anonymous.status, 401);
    const body = await anonymous.text();
    assert.doesNotMatch(body, /issues/, 'a cached answer reached a caller who was never authorised');
  });

  it('turns an unauthorised read away before it costs a Linear call', async () => {
    // This is what actually pins the gate's *position*. A 401 returned after the fetch looks
    // identical from outside, so asserting the status cannot tell the two apart — but it lets an
    // anonymous caller spend the worker's Linear quota by hammering a closed endpoint.
    const seed = seedFixture();
    const stub = installLinearStub({ storedIssues: [storedIssueFromSeed(seed)] });

    const response = await get(`/feedback?url=${encodeURIComponent(seed.page.url)}`, { env: closed });

    assert.equal(response.status, 401);
    assert.deepEqual(stub.calls, [], 'an unauthorised read reached Linear');
  });

  it('lets one client keep its reads open while another closes them', async () => {
    const seed = seedFixture({ client: { id: 'acme' } });
    installLinearStub({ storedIssues: [storedIssueFromSeed(seed)] });
    const mixed: WorkerEnv = {
      ...env,
      FRUITBACK_CLIENTS: JSON.stringify({
        acme: { teamId: 'team_1', read: 'public' },
        globex: { teamId: 'team_2', read: 'authenticated', identitySecret: SECRET },
      }),
    };
    const url = encodeURIComponent(seed.page.url);

    assert.equal((await get(`/feedback?url=${url}&client=acme`, { env: mixed })).status, 200);
    assert.equal((await get(`/feedback?url=${url}&client=globex`, { env: mixed })).status, 401);
  });
});

describe('a read nobody could ever satisfy', () => {
  it('refuses at boot when reads need a token and no key can verify one', async () => {
    // A permanent 401 is indistinguishable from a broken widget. Said once, at boot, instead.
    const response = await get('/health', { env: { ...env, FRUITBACK_READ: 'authenticated' } });

    assert.equal(response.status, 503);
    const body = (await response.json()) as { missing: string[] };
    assert.ok(
      body.missing.some((name) => name.startsWith('FRUITBACK_IDENTITY_SECRET')),
      `expected the missing key to be named, got ${body.missing.join(', ')}`,
    );
  });

  it('names the client that inherited the requirement with no key of its own', async () => {
    // The subtle one. `identitySecret` is deliberately never inherited — one signing key across
    // tenants lets a compromised tenant mint identities on another's issues — so flipping the
    // worker-wide default to `authenticated` can render a client unreadable without that client's
    // own entry changing at all.
    const response = await get('/health', {
      env: {
        ...env,
        FRUITBACK_READ: 'authenticated',
        FRUITBACK_IDENTITY_SECRET: 'a-worker-wide-secret-long-enough-here',
        FRUITBACK_CLIENTS: JSON.stringify({ acme: { teamId: 'team_1' } }),
      },
    });

    assert.equal(response.status, 503);
    const body = (await response.json()) as { missing: string[] };
    assert.ok(
      body.missing.some((name) => name.includes('acme')),
      `expected acme to be named, got ${body.missing}`,
    );
  });

  it('refuses a misspelt FRUITBACK_READ rather than leaving reads open', async () => {
    // Defaulting on a typo would silently keep the setting someone wrote it to close.
    const response = await get('/health', { env: { ...env, FRUITBACK_READ: 'authenticaed' } });

    assert.equal(response.status, 503);
    const body = (await response.json()) as { missing: string[] };
    assert.ok(body.missing.includes('FRUITBACK_READ'), `expected FRUITBACK_READ, got ${body.missing.join(', ')}`);
  });

  it('counts open reads on /health, without naming the clients', async () => {
    // `/health` needs no authentication either, so the count is the useful half and the ids are the
    // half that would hand over the map. The boot log names them, where only an operator looks.
    const response = await get('/health', {
      env: { ...env, FRUITBACK_CLIENTS: JSON.stringify({ acme: { teamId: 'team_1' }, globex: { teamId: 'team_2' } }) },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, store: 'linear', openRead: 2 });
  });
});

describe('one store per process, not one per request (SKG-522)', () => {
  /** Records what it was asked, so a test can tell it apart from a store the handler built itself. */
  function countingStore() {
    const seen = { reads: 0, writes: 0 };

    return {
      seen,
      store: {
        name: 'counting',
        scope: () => 'counting',
        create: async () => {
          seen.writes += 1;

          return { id: 'issue_x', identifier: 'X-1', url: 'https://example.test/x' };
        },
        findForPage: async () => {
          seen.reads += 1;

          return [];
        },
      },
    };
  }

  it('reads through the store the transport handed it, and builds none of its own', async () => {
    // The stub is what a Linear store would reach for. It staying untouched is the assertion: the
    // handler used what it was given rather than constructing a second store from the config.
    const stub = installLinearStub();
    const { seen, store } = countingStore();

    const response = await get(`/feedback?url=${encodeURIComponent('https://preview.acme.test/pricing')}`, { store });

    assert.equal(response.status, 200);
    assert.equal(seen.reads, 1);
    assert.deepEqual(stub.calls, [], 'the handler built its own store instead of using the transport’s');
  });

  it('writes through it too', async () => {
    const stub = installLinearStub();
    const { seen, store } = countingStore();

    const response = await post(seedFixture(), { store });

    assert.equal(response.status, 201);
    assert.equal(seen.writes, 1);
    assert.deepEqual(stub.calls, []);
  });

  it('serves several requests from the same instance', async () => {
    // The property that matters, and the one a per-call `storeFor` broke: a store holding a
    // resource — a SQLite connection, once SKG-524 lands — is opened once and reused.
    //
    // Two *different* pages on purpose. The first version of this asked for the same URL twice and
    // counted one read, which is the read cache doing exactly its job (`cache.ts`) rather than a
    // defect — a reminder that a store call and a request are not the same thing.
    const { seen, store } = countingStore();

    await get(`/feedback?url=${encodeURIComponent('https://preview.acme.test/pricing')}`, { store });
    await get(`/feedback?url=${encodeURIComponent('https://preview.acme.test/features')}`, { store });

    assert.equal(seen.reads, 2);
  });
});
