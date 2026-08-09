import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { type SeedIssue, canonicalizePageUrl, parseSeedFromDescription } from '@fruitback/shared';
import { minimalSeedFixture, seedFixture } from '@fruitback/shared/seed.fixture';
import { handleRequest } from './app.ts';
import type { WorkerEnv } from './env.ts';
import { installLinearStub, storedIssueFromSeed } from './linear-stub.ts';
import { resetRateLimitState } from './rate-limit.ts';
import { resetCacheState } from './cache.ts';

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
};

function post(body: unknown, init: RequestOverrides = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json', ...(init.headers ?? {}) });
  if (init.origin !== null) headers.set('Origin', init.origin ?? ORIGIN);

  const request = new Request('https://worker.fruitback.dev/feedback', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

  return handleRequest(request, init.env ?? env, { clientIp: init.clientIp ?? '203.0.113.1' });
}

function get(path: string, init: RequestOverrides = {}) {
  const headers = new Headers(init.headers ?? {});
  if (init.origin !== null) headers.set('Origin', init.origin ?? ORIGIN);

  return handleRequest(new Request(`https://worker.fruitback.dev${path}`, { headers }), init.env ?? env, {
    clientIp: init.clientIp ?? '203.0.113.1',
  });
}

beforeEach(() => {
  resetRateLimitState();
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
    assert.partialDeepStrictEqual(await response.json(), { error: 'linear-unavailable' });
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

  it('asks Linear for the fruitback label, the client label and that exact page', async () => {
    const stub = installLinearStub({ storedIssues: [] });

    await read(PAGE, '&client=acme');

    assert.deepEqual(stub.issueFilter(), {
      team: { id: { eq: 'team_1' } },
      // Two clauses, not one `in`: an issue must carry *both* labels, or one client's pins would
      // surface on another client's site.
      and: [{ labels: { name: { eq: 'fruitback' } } }, { labels: { name: { eq: 'fruitback:acme' } } }],
      description: { contains: PAGE },
    });
  });

  it('narrows on the fruitback label alone when no client is given', async () => {
    const seed = minimalSeedFixture();
    const stub = installLinearStub({ storedIssues: [storedIssueFromSeed(seed)] });

    const body = await readBody(seed.page.url);

    assert.partialDeepStrictEqual(stub.issueFilter(), { and: [{ labels: { name: { eq: 'fruitback' } } }] });
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
    assert.equal(second.headers.get('Cache-Control'), 'private, max-age=15');
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
    assert.partialDeepStrictEqual(await response.json(), { error: 'linear-unavailable' });
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
    assert.deepEqual(await response.json(), { ok: true });
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
