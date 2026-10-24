import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { mockMethod } from './mock.fixture.ts';
import assert from 'node:assert/strict';
import { NOTE_STAGES, type NoteIssue, canonicalizePageUrl, parseNoteFromDescription } from '@fruitback/shared';
import { minimalNoteFixture, noteFixture } from '@fruitback/shared/note.fixture';
import { handleRequest } from './app.ts';
import { DATABASE_REQUIRED, type WorkerEnv } from './env.ts';
import { beforePostgres } from './before-postgres.fixture.ts';
import { installLinearStub, storedIssueFromNote } from './linear-stub.ts';
import { signIdentityToken } from './identity.ts';
import type { NoteStore } from './store.ts';
import { type Kv, KvError, createMemoryKv, resetSharedKv } from './kv.ts';
import { resetCacheState } from './cache.ts';
import { memoryIssues, resetMemoryLinear } from './linear-memory.ts';

const ORIGIN = 'https://preview.acme.test';

const env: WorkerEnv = beforePostgres({
  LINEAR_API_KEY: 'lin_api_test',
  LINEAR_TEAM_ID: 'team_1',
  LINEAR_PROJECT_ID: 'project_1',
  ALLOWED_ORIGINS: `${ORIGIN},http://localhost:5173`,
});

type RequestOverrides = {
  origin?: string | null;
  env?: WorkerEnv;
  /**
   * The environment as a process gets it. Absent, the worker of before (FRU-225): these cases hold
   * its code, with no database. See `beforePostgres`.
   */
  asDeployed?: boolean;
  headers?: Record<string, string>;
  /** Already resolved by the transport in production — see `resolveClientIp`. */
  clientIp?: string;
  /** Built once by the transport in production — see `RequestContext.store` (FRU-29). */
  store?: NoteStore;
  /** Built once by the transport in production — see `RequestContext.kv` (FRU-49). */
  kv?: Kv;
};

function asGiven(init: RequestOverrides): WorkerEnv {
  return init.asDeployed === true ? (init.env ?? env) : beforePostgres(init.env ?? env);
}

function post(body: unknown, init: RequestOverrides = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json', ...(init.headers ?? {}) });
  if (init.origin !== null) headers.set('Origin', init.origin ?? ORIGIN);

  const request = new Request('https://worker.fruitback.dev/feedback', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

  return handleRequest(request, asGiven(init), {
    clientIp: init.clientIp ?? '203.0.113.1',
    ...(init.store ? { store: init.store } : {}),
    ...(init.kv ? { kv: init.kv } : {}),
  });
}

function get(path: string, init: RequestOverrides = {}) {
  const headers = new Headers(init.headers ?? {});
  if (init.origin !== null) headers.set('Origin', init.origin ?? ORIGIN);

  return handleRequest(new Request(`https://worker.fruitback.dev${path}`, { headers }), asGiven(init), {
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
  vi.restoreAllMocks();
});

describe('POST /feedback', () => {
  it('creates a Linear issue and returns its identifier and URL', async () => {
    const stub = installLinearStub({ existingLabels: { fruitback: 'label_existing' } });

    const response = await post(noteFixture());

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
    const seed = noteFixture();

    await post(seed);

    assert.deepEqual(parseNoteFromDescription(stub.issueInput().description), { ok: true, note: seed });
  });

  /**
   * The team that triages reads this description, and the reporter never does (FRU-39). So the
   * words follow the worker's own `FRUITBACK_TEAM_LOCALE` and never the browser: a note written in
   * Tokyo must not file a Japanese issue into a team that reads English.
   */
  it('writes the description in the language the worker was configured with', async () => {
    const stub = installLinearStub();
    const seed = noteFixture({ note: 'Le CTA est trop petit' });

    await post(seed, { env: { ...env, FRUITBACK_TEAM_LOCALE: 'fr' } });

    const description = stub.issueInput().description;
    assert.match(description, /\*\*Signalé par\*\*/);
    assert.match(description, /\*\*Élément\*\*/);
    assert.equal(description.includes('**Reported by**'), false);
    // The note is the reporter's own word, and the block is the machine's half. Neither is translated.
    assert.ok(description.includes('Le CTA est trop petit'));
    assert.deepEqual(parseNoteFromDescription(description), { ok: true, note: seed });
  });

  it('writes it in English when nothing says otherwise, as every worker did before', async () => {
    const stub = installLinearStub();

    await post(noteFixture());

    assert.match(stub.issueInput().description, /\*\*Reported by\*\*/);
  });

  it("titles the issue with the visitor's own words", async () => {
    const stub = installLinearStub();

    await post(noteFixture({ note: 'Le CTA est trop petit' }));

    assert.equal(stub.issueInput().title, 'Le CTA est trop petit');
  });

  it('applies the fruitback label and the client label, creating what is missing', async () => {
    const stub = installLinearStub({ existingLabels: { fruitback: 'label_existing' } });

    await post(noteFixture());

    assert.deepEqual(stub.createdLabels(), ['fruitback:acme']);
    assert.deepEqual(stub.issueInput().labelIds, ['label_existing', 'label_1']);
  });

  it('still plants the seed when a label cannot be created', async () => {
    // Losing a label is a triage annoyance; losing the client's feedback is a bug.
    const stub = installLinearStub({ failLabelCreation: true });

    const response = await post(noteFixture());

    assert.equal(response.status, 201);
    assert.deepEqual(stub.issueInput().labelIds, []);
  });

  it('normalizes the page URL server-side', async () => {
    // A client that skipped normalization would otherwise plant a pin the read path cannot find.
    const stub = installLinearStub();
    const raw = 'https://preview.acme.test/pricing/?utm_source=ads&tab=annual#cta';

    await post(noteFixture({ page: { url: raw, path: '/pricing' } }));

    const result = parseNoteFromDescription(stub.issueInput().description);
    assert.ok(result.ok);
    assert.equal(result.note.page.url, canonicalizePageUrl(raw));
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
    // Built as raw JSON: the schema caps a note at 5 000 chars, so `createNote` would refuse this.
    const oversized = JSON.stringify({ ...noteFixture(), note: 'x'.repeat(70_000) });

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

    const response = await post(noteFixture());

    assert.equal(response.status, 502);
    assert.partialDeepStrictEqual(await response.json(), { error: 'store-unavailable' });
  });
});

describe('CORS', () => {
  it('echoes an allowed origin and varies on it', async () => {
    installLinearStub();

    const response = await post(noteFixture());

    assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.equal(response.headers.get('Vary'), 'Origin');
  });

  it('refuses an origin that is not on the allowlist', async () => {
    installLinearStub();

    const response = await post(noteFixture(), { origin: 'https://evil.test' });

    assert.equal(response.status, 403);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  });

  it('allows any origin when configured with a wildcard', async () => {
    installLinearStub();

    const response = await post(noteFixture(), {
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

    const response = await post(noteFixture(), { origin: null });

    assert.equal(response.status, 201);
  });

  /**
   * The extension relays a client site's call from its own service worker (FRU-57), which sends
   * `chrome-extension://<id>` on the POST. No operator can put that id on an allowlist — it differs
   * between an unpacked build and a store build — and a `403` here is the whole of team mode not
   * working, with nothing in a browser to say why.
   *
   * It grants exactly what the line above already grants `curl`. CORS was never what decides who may
   * read a pin; under `read: 'authenticated'` the token still is.
   */
  it('serves the extension, whose origin no allowlist can name', async () => {
    installLinearStub();

    const response = await post(noteFixture(), { origin: 'chrome-extension://ekjmfoaibpceoc' });

    assert.equal(response.status, 201);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'chrome-extension://ekjmfoaibpceoc');
  });

  /** A list of schemes, so everything else falls through to the allowlist rather than past it. */
  it('refuses a scheme that only looks like an extension', async () => {
    installLinearStub();

    for (const origin of ['file://', 'null', 'chrome-extension:', 'https://chrome-extension.evil.dev']) {
      const response = await post(noteFixture(), { origin });
      assert.equal(response.status, 403, origin);
    }
  });
});

describe('guard rails', () => {
  it('rate-limits a client hammering the endpoint', async () => {
    installLinearStub();

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 21; attempt += 1) {
      statuses.push((await post(noteFixture(), { clientIp: '203.0.113.7' })).status);
    }

    assert.ok(statuses.slice(0, 20).every((status) => status === 201));
    assert.equal(statuses[20], 429);
  });

  it('counts each client separately', async () => {
    installLinearStub();

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await post(noteFixture(), { clientIp: '203.0.113.7' });
    }
    const other = await post(noteFixture(), { clientIp: '203.0.113.8' });

    assert.equal(other.status, 201);
  });

  it('says what is missing when the service is misconfigured', async () => {
    installLinearStub();

    const response = await post(noteFixture(), { env: { ALLOWED_ORIGINS: ORIGIN } });

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

    const response = await post(noteFixture(), { env: {} });

    assert.equal(response.status, 500);
    assert.partialDeepStrictEqual(await response.json(), { missing: ['ALLOWED_ORIGINS'] });
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  });
});

describe('GET /feedback', () => {
  const PAGE = 'https://preview.acme.test/pricing?tab=annual';

  type ReadResponse = { url: string; issues: NoteIssue[] };

  function read(page: string, query = '') {
    return get(`/feedback?url=${encodeURIComponent(page)}${query}`);
  }

  async function readBody(page: string, query = ''): Promise<ReadResponse> {
    return (await read(page, query)).json() as Promise<ReadResponse>;
  }

  it('returns the seeds of a page with the Linear state that colours the pin', async () => {
    const seed = noteFixture();
    installLinearStub({ storedIssues: [storedIssueFromNote(seed)] });

    const response = await read(PAGE);

    assert.equal(response.status, 200);
    const body = (await response.json()) as ReadResponse;
    assert.equal(body.url, PAGE);
    assert.partialDeepStrictEqual(body.issues, [
      {
        id: `issue_${seed.id}`,
        identifier: 'SKG-901',
        url: 'https://linear.app/sakuga-software/issue/SKG-901',
        stage: 'progress',
        stateName: 'In Progress',
        updatedAt: '2026-08-05T10:00:00.000Z',
      },
    ]);
    // The point of the whole read path: the pin comes back exactly as it was planted.
    assert.deepEqual(body.issues[0]?.seed, seed);
  });

  it('says which stages the store can report, so the panel offers only those (FRU-32)', async () => {
    installLinearStub({ storedIssues: [] });
    const linear = (await readBody(PAGE)) as ReadResponse & { stages?: unknown };
    assert.deepEqual(linear.stages, [...NOTE_STAGES]);

    const partial: NoteStore = {
      name: 'partial',
      stages: ['new', 'done'],
      scope: () => 'partial',
      create: async () => ({ id: 'x', identifier: 'X-1' }),
      findForPage: async () => [],
    };
    const response = await get(`/feedback?url=${encodeURIComponent(PAGE)}`, { store: partial });

    assert.deepEqual(((await response.json()) as { stages?: unknown }).stages, ['new', 'done']);
  });

  it('asks Linear for the team and that exact page, and for no label', async () => {
    const stub = installLinearStub({ storedIssues: [] });

    await read(PAGE, '&client=acme');

    // No clause on the labels (FRU-138): a team can refuse them, and a note found by its labels
    // only was a note no page showed again. The client is read from each seed.
    assert.deepEqual(stub.issueFilter(), {
      team: { id: { eq: 'team_1' } },
      // The client narrows what Linear sends: the notes of another client of the team must not fill
      // the pages this read walks.
      and: [{ description: { contains: PAGE } }, { description: { contains: 'acme' } }],
    });
  });

  it('reads every seed of the page when no client is given', async () => {
    const seed = minimalNoteFixture();
    const stub = installLinearStub({ storedIssues: [storedIssueFromNote(seed)] });

    const body = await readBody(seed.page.url);

    assert.deepEqual((stub.issueFilter() as { and: unknown }).and, [{ description: { contains: seed.page.url } }]);
    assert.equal(body.issues.length, 1);
  });

  it('canonicalizes the requested URL before matching', async () => {
    // Same reason as the write path: the filter matches this string verbatim inside the description.
    const stub = installLinearStub({ storedIssues: [] });
    const raw = 'https://preview.acme.test/pricing/?utm_source=ads&tab=annual#cta';

    const body = await readBody(raw);

    assert.partialDeepStrictEqual(stub.issueFilter(), {
      and: [{ description: { contains: canonicalizePageUrl(raw) } }],
    });
    assert.equal(body.url, canonicalizePageUrl(raw));
  });

  it('drops an issue whose seed belongs to a neighbouring page', async () => {
    // Linear's `contains` is a substring match, so `/pricing` also brings back `/pricing?tab=annual`.
    const page = 'https://preview.acme.test/pricing';
    const mine = noteFixture({ id: 'sd_here', page: { url: page, path: '/pricing' } });
    const neighbour = noteFixture({ id: 'sd_elsewhere' });
    installLinearStub({ storedIssues: [storedIssueFromNote(mine), storedIssueFromNote(neighbour)] });

    const body = await readBody(page);

    assert.deepEqual(
      body.issues.map((issue) => issue.seed.id),
      ['sd_here'],
    );
  });

  it('skips an issue whose seed block someone edited away', async () => {
    // A pin we cannot place is worse than a pin we do not show.
    installLinearStub({ storedIssues: [storedIssueFromNote(noteFixture(), { description: 'Just prose now.' })] });

    const body = await readBody(PAGE);

    assert.deepEqual(body.issues, []);
  });

  it('walks every page of results', async () => {
    const seeds = ['sd_1', 'sd_2', 'sd_3'].map((id) => noteFixture({ id }));
    const stub = installLinearStub({ storedIssues: seeds.map((seed) => storedIssueFromNote(seed)), issuesPageSize: 2 });

    const body = await readBody(PAGE);

    assert.deepEqual(
      body.issues.map((issue) => issue.seed.id),
      ['sd_1', 'sd_2', 'sd_3'],
    );
    assert.equal(stub.calls.filter((call) => call.operation === 'FruitbackIssues').length, 2);
  });

  it('serves a repeated read from cache instead of spending Linear quota again', async () => {
    const stub = installLinearStub({ storedIssues: [storedIssueFromNote(noteFixture())] });

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

  it('writes its descriptions in the team locale too, so the dev loop shows what production writes', async () => {
    const seed = noteFixture();

    await post(seed, { env: { ...fakeEnv, FRUITBACK_TEAM_LOCALE: 'fr' } });

    const description = memoryIssues()[0]?.description ?? '';
    assert.match(description, /\*\*Signalé par\*\*/);
    assert.deepEqual(parseNoteFromDescription(description), { ok: true, note: seed });
  });

  it('serves the whole loop with no API key at all', async () => {
    // The point of the playground: capture → issue → the pin comes back, without a Linear workspace.
    installLinearStub(); // installed to prove it is never called
    const seed = noteFixture();

    const created = await post(seed, { env: fakeEnv });
    const read = await get(`/feedback?url=${encodeURIComponent(seed.page.url)}&client=acme`, { env: fakeEnv });

    assert.equal(created.status, 201);
    assert.equal(read.status, 200);
    const body = (await read.json()) as { issues: NoteIssue[] };
    assert.equal(body.issues.length, 1);
    // Stored as a description and parsed back, exactly like the real path — so a broken round trip
    // breaks the dev loop too, instead of being papered over by a mock that returns objects.
    assert.deepEqual(body.issues[0]?.seed, seed);
  });

  it('gives the notes of one page their states and replies by their rank on that page (FRU-268)', async () => {
    // The E2E specs run side by side, each on its own page: the notes another page receives in
    // between change nothing on this one.
    const here = 'https://preview.acme.test/rank-here';
    const elsewhere = 'https://preview.acme.test/rank-elsewhere';
    for (let index = 0; index < 5; index += 1) {
      await post(noteFixture({ id: `sd_here_${index}`, page: { url: here, path: '/rank-here' } }), { env: fakeEnv });
      await post(noteFixture({ id: `sd_else_${index}`, page: { url: elsewhere, path: '/rank-elsewhere' } }), {
        env: fakeEnv,
      });
    }

    const read = await get(`/feedback?url=${encodeURIComponent(here)}&client=acme`, { env: fakeEnv });
    const issues = ((await read.json()) as { issues: NoteIssue[] }).issues;
    const byRank = [0, 1, 2, 3, 4].map((index) => issues.find((issue) => issue.seed.id === `sd_here_${index}`));

    assert.equal(new Set(byRank.map((issue) => issue?.stage)).size, 5);
    assert.deepEqual(
      byRank.map((issue) => (issue?.comments ?? []).length > 0),
      [false, false, true, false, false],
    );
  });

  it('never reaches the network', async () => {
    const stub = installLinearStub();

    await post(noteFixture(), { env: fakeEnv });
    await get(`/feedback?url=${encodeURIComponent(noteFixture().page.url)}`, { env: fakeEnv });

    assert.deepEqual(stub.calls, []);
  });

  it('says so on /health, rather than reporting a plain green check', async () => {
    const response = await get('/health', { env: fakeEnv });

    assert.equal(response.status, 200);
    // `openRead: 1` because this dev worker serves one client and its reads are public — the
    // default, and what every worker did before FRU-40.
    assert.deepEqual(await response.json(), { ok: true, store: 'memory', openRead: 1 });
  });

  it('refuses the flag in production and reports itself misconfigured', async () => {
    // The Dockerfile sets NODE_ENV=production, so this is what a container inheriting the flag does.
    // The flag *degrades* to the default store, which then has no database (FRU-225; it was Linear
    // and its credentials before) — so the diagnostic names the database rather than the flag. An
    // explicit FRUITBACK_STORE=memory is refused outright instead; see the FRU-33 suite.
    const response = await get('/health', { env: { ...fakeEnv, NODE_ENV: 'production' }, asDeployed: true });

    assert.equal(response.status, 503);
    const { missing } = (await response.json()) as { missing: string[] };
    assert.ok(missing.includes(DATABASE_REQUIRED), missing.join('\n'));
    assert.ok(!missing.some((line) => line.includes('FAKE_LINEAR')), missing.join('\n'));
  });
});

describe('cache invalidation', () => {
  it('shows a pin planted a moment ago instead of the cached answer', async () => {
    // Otherwise posting feedback and reloading reads as "my note was lost" for a whole TTL.
    const seed = noteFixture();
    const stored = storedIssueFromNote(seed);
    installLinearStub({ storedIssues: [] });

    const before = await get(`/feedback?url=${encodeURIComponent(seed.page.url)}`);
    assert.deepEqual(((await before.json()) as { issues: NoteIssue[] }).issues, []);

    // The stub answers from the same array, so a cached read would still report zero.
    installLinearStub({ storedIssues: [stored] });
    await post(seed);

    const after = await get(`/feedback?url=${encodeURIComponent(seed.page.url)}`);
    assert.equal(((await after.json()) as { issues: NoteIssue[] }).issues.length, 1);
  });
});

/** A Kv whose calls all reject, the way a store that went away rejects them. */
function unreachableKv(): Kv {
  const down = async () => {
    throw new KvError('connection failed: connect ECONNREFUSED');
  };

  return { ...createMemoryKv(), get: down, set: down, incr: down };
}

describe('the Kv the transport hands over (FRU-49)', () => {
  const CACHED_PAGE = 'https://preview.acme.test/pricing?tab=annual';

  it('holds one rate limit for two replicas on one Kv', async () => {
    // Two handlers on one `Kv` share one count. A store shared between replicas (FRU-67) relies on it.
    installLinearStub();
    const kv = createMemoryKv();
    const replicas = [{ kv }, { kv: { ...kv } }];
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 21; attempt += 1) {
      statuses.push((await post(noteFixture(), { clientIp: '203.0.113.7', ...replicas[attempt % 2] })).status);
    }

    assert.equal(statuses.filter((status) => status === 201).length, 20);
    assert.equal(statuses[20], 429);
  });

  it('counts through the Kv the transport handed it', async () => {
    installLinearStub();
    const kv = createMemoryKv();
    const counted: string[] = [];
    const recording: Kv = { ...kv, incr: (key, ttl) => (counted.push(key), kv.incr(key, ttl)) };

    await post(noteFixture(), { kv: recording });

    assert.equal(counted.length, 1, 'the handler counted somewhere else');
  });

  it('serves a second replica the answer the first one cached', async () => {
    const stub = installLinearStub({ storedIssues: [storedIssueFromNote(noteFixture())] });
    const kv = createMemoryKv();

    await get(`/feedback?url=${encodeURIComponent(CACHED_PAGE)}`, { kv });
    // The in-flight promise is what a second process does not have. The answer it stored is.
    resetCacheState();
    await get(`/feedback?url=${encodeURIComponent(CACHED_PAGE)}`, { kv: { ...kv } });

    assert.equal(stub.calls.length, 1);
  });

  it('refuses a metered call with 503 when the Kv does not answer, and keeps its CORS headers', async () => {
    const stub = installLinearStub();
    mockMethod(console, 'error', () => {});

    const response = await post(noteFixture(), { kv: unreachableKv() });

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
    mockMethod(console, 'error', () => {});
    const kv = createMemoryKv();
    const refusingWrites: Kv = {
      ...kv,
      set: async () => {
        throw new KvError('connection failed');
      },
    };

    const response = await post(noteFixture(), { kv: refusingWrites });

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

    await post(noteFixture({ client: { id: 'acme', name: 'Acme' } }), { env: multi });

    assert.equal(stub.issueInput().teamId, 'team_acme');
    assert.equal(stub.issueInput().projectId, 'project_acme');
  });

  it('narrows a read to the team its client routes to', async () => {
    const stub = installLinearStub({ storedIssues: [] });

    await get(`/feedback?url=${encodeURIComponent(noteFixture().page.url)}&client=acme`, { env: multi });

    assert.partialDeepStrictEqual(stub.issueFilter(), { team: { id: { eq: 'team_acme' } } });
  });

  it('refuses to create an issue for a seed that names nobody', async () => {
    // The other direction of the same leak: with a map configured, the default team is not a place
    // to put a note whose owner is unknown.
    installLinearStub();

    const response = await post(noteFixture({ client: undefined }), { env: multi });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'client-required' });
  });

  it('reads back a note whose client id arrived padded', async () => {
    // The test the previous version of this one should have been. Asserting the *route* passed while
    // the label kept the spaces: the issue landed in the right team as `fruitback:  acme  `, and the
    // client's own clean read — filtering `fruitback:acme` — came back empty. Authorised at both
    // ends, invisible in between. So this asserts the round trip, not the routing.
    installLinearStub();
    const url = noteFixture().page.url;

    const created = await post(noteFixture({ id: 'sd_padded', client: { id: '  acme  ' } }), { env: fakeMulti });
    const read = await get(`/feedback?url=${encodeURIComponent(url)}&client=acme`, { env: fakeMulti });

    assert.equal(created.status, 201);
    assert.deepEqual(
      ((await read.json()) as { issues: NoteIssue[] }).issues.map((issue) => issue.seed.id),
      ['sd_padded'],
    );
  });

  it('stores the normalised client id, so the label matches what a read asks for', async () => {
    const stub = installLinearStub();

    await post(noteFixture({ client: { id: '  acme  ' } }), { env: multi });

    assert.equal(stub.issueInput().teamId, 'team_acme');
    assert.deepEqual(stub.createdLabels(), ['fruitback', 'fruitback:acme']);
  });

  it('refuses to answer a read that names nobody', async () => {
    // Answering the default was how one client read another's feedback.
    installLinearStub({ storedIssues: [] });

    const response = await get(`/feedback?url=${encodeURIComponent(noteFixture().page.url)}`, { env: multi });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'client-required' });
  });

  it('refuses a client it has never heard of', async () => {
    installLinearStub({ storedIssues: [] });

    const response = await get(`/feedback?url=${encodeURIComponent(noteFixture().page.url)}&client=nobody`, {
      env: multi,
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'unknown-client' });
  });

  it('refuses a client claimed from a site it is not embedded on', async () => {
    installLinearStub({ storedIssues: [] });

    const response = await get(`/feedback?url=${encodeURIComponent(noteFixture().page.url)}&client=acme`, {
      env: { ...multi, ALLOWED_ORIGINS: '*' },
      origin: 'https://evil.test',
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'origin-not-allowed-for-client' });
  });

  it('keeps two clients on the same page from seeing each other', async () => {
    // The test this ticket exists for. Both plant a note on the same URL; each read returns one pin.
    installLinearStub();
    const url = noteFixture().page.url;
    await post(noteFixture({ id: 'sd_acme', client: { id: 'acme' } }), { env: fakeMulti });
    await post(noteFixture({ id: 'sd_globex', client: { id: 'globex' } }), {
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
      (acme as { issues: NoteIssue[] }).issues.map((issue) => issue.seed.id),
      ['sd_acme'],
    );
    assert.deepEqual(
      (globex as { issues: NoteIssue[] }).issues.map((issue) => issue.seed.id),
      ['sd_globex'],
    );
  });

  it('serves a client from its own site without repeating it in ALLOWED_ORIGINS', async () => {
    // Two lists to keep in step is one list that drifts, so a client's `origins` join the allowlist.
    installLinearStub({ storedIssues: [] });
    const onlyTheMap: WorkerEnv = { ...env, ALLOWED_ORIGINS: 'https://elsewhere.test', FRUITBACK_CLIENTS: CLIENTS };

    const response = await get(`/feedback?url=${encodeURIComponent(noteFixture().page.url)}&client=acme`, {
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

    const response = await get(`/feedback?url=${encodeURIComponent(noteFixture().page.url)}&client=acme`, {
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
    // appearing here should have to be written down. `openRead` is one such field (FRU-40), and
    // `store` is the other (FRU-33) — it replaced `fakeLinear: true`, which only one provider could
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

  /**
   * A value that is not a locale tag is refused and named (FRU-39), like the hops above. Prose in a
   * language nobody chose would otherwise be the only symptom.
   */
  it('refuses to report ready on a FRUITBACK_TEAM_LOCALE that is not a locale', async () => {
    const response = await get('/health', { env: { ...env, FRUITBACK_TEAM_LOCALE: 'français' } });

    assert.equal(response.status, 503);
    assert.partialDeepStrictEqual(await response.json(), { missing: ['FRUITBACK_TEAM_LOCALE'] });
  });

  /** A valid tag with no words in this build is the other case: the worker serves, in English. */
  it('starts on a locale it has no words for', async () => {
    const response = await get('/health', { env: { ...env, FRUITBACK_TEAM_LOCALE: 'de-AT' } });

    assert.equal(response.status, 200);
  });
});

describe('attribution', () => {
  const SECRET = 'a-secret-long-enough-to-not-be-guessed';
  const identityEnv: WorkerEnv = { ...env, FRUITBACK_IDENTITY_SECRET: SECRET };
  const inAnHour = () => Math.floor((Date.now() + 3_600_000) / 1000);

  it('keeps an anonymous submission anonymous', async () => {
    const stub = installLinearStub();

    const response = await post(noteFixture({ reporter: undefined }));

    assert.equal(response.status, 201);
    const stored = parseNoteFromDescription(stub.issueInput().description);
    assert.ok(stored.ok);
    assert.equal(stored.note.reporter, undefined);
  });

  it('stores a typed name as the claim it is', async () => {
    const stub = installLinearStub();

    await post(noteFixture({ reporter: { name: 'Alice', email: 'alice@acme.test' } }));

    const stored = parseNoteFromDescription(stub.issueInput().description);
    assert.ok(stored.ok);
    assert.deepEqual(stored.note.reporter, { name: 'Alice', email: 'alice@acme.test' });
    assert.match(stub.issueInput().description, /Reported by.*unverified — self-declared/);
  });

  it('refuses to let a client call itself verified', async () => {
    // The one that matters. Without the strip, this reads in Linear exactly like an identity the
    // worker checked — which is a way to put a colleague's name on a complaint.
    const stub = installLinearStub();

    await post(noteFixture({ reporter: { name: 'CEO', verified: true } }));

    const stored = parseNoteFromDescription(stub.issueInput().description);
    assert.ok(stored.ok);
    assert.deepEqual(stored.note.reporter, { name: 'CEO' });
    assert.doesNotMatch(stub.issueInput().description, /\(verified\)/);
  });

  it('vouches for a reporter behind a valid token', async () => {
    const stub = installLinearStub();
    const token = await signIdentityToken({ sub: 'user_42', name: 'Alice', exp: inAnHour() }, SECRET);

    const response = await post(noteFixture({ reporter: undefined }), {
      env: identityEnv,
      headers: { Authorization: `Bearer ${token}` },
    });

    assert.equal(response.status, 201);
    const stored = parseNoteFromDescription(stub.issueInput().description);
    assert.ok(stored.ok);
    assert.deepEqual(stored.note.reporter, { id: 'user_42', name: 'Alice', verified: true });
    assert.match(stub.issueInput().description, /Reported by\*\* · Alice \(verified\)/);
  });

  it('lets the token overrule a name claimed alongside it', async () => {
    const stub = installLinearStub();
    const token = await signIdentityToken({ sub: 'user_42', name: 'Alice', exp: inAnHour() }, SECRET);

    await post(noteFixture({ reporter: { name: 'Someone Else', verified: true } }), {
      env: identityEnv,
      headers: { Authorization: `Bearer ${token}` },
    });

    const stored = parseNoteFromDescription(stub.issueInput().description);
    assert.ok(stored.ok);
    assert.deepEqual(stored.note.reporter, { id: 'user_42', name: 'Alice', verified: true });
  });

  it('refuses a token that does not verify rather than downgrading it', async () => {
    // A site that meant to identify someone and got it wrong should hear about it. Silently storing
    // the note as anonymous is how a broken integration goes unnoticed for a month.
    const token = await signIdentityToken({ sub: 'user_42', exp: inAnHour() }, 'a-different-secret-of-good-length');

    const response = await post(noteFixture(), { env: identityEnv, headers: { Authorization: `Bearer ${token}` } });

    assert.equal(response.status, 401);
    assert.partialDeepStrictEqual(await response.json(), { error: 'invalid-identity', reason: 'bad-signature' });
  });

  it('refuses an expired token', async () => {
    const token = await signIdentityToken({ sub: 'user_42', exp: Math.floor(Date.now() / 1000) - 60 }, SECRET);

    const response = await post(noteFixture(), { env: identityEnv, headers: { Authorization: `Bearer ${token}` } });

    assert.equal(response.status, 401);
    assert.partialDeepStrictEqual(await response.json(), { reason: 'expired' });
  });

  it('refuses a token when no secret is configured, rather than ignoring it', async () => {
    const token = await signIdentityToken({ sub: 'user_42', exp: inAnHour() }, SECRET);

    const response = await post(noteFixture(), { headers: { Authorization: `Bearer ${token}` } });

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

    const response = await post(noteFixture({ client: { id: 'acme' } }), {
      env: mapped,
      headers: { Authorization: `Bearer ${token}` },
    });

    assert.equal(response.status, 201);
    const stored = parseNoteFromDescription(stub.issueInput().description);
    assert.ok(stored.ok);
    assert.partialDeepStrictEqual(stored.note.reporter, { id: 'user_7', verified: true });
  });
});

describe('the team’s replies on the read path', () => {
  it('returns them oldest first, whatever order Linear gave', async () => {
    // Linear answers newest-first by default. The order is settled once, in the worker, so the
    // widget renders what it is handed rather than sorting it again on the other side.
    const seed = noteFixture();
    installLinearStub({
      storedIssues: [
        storedIssueFromNote(seed, {
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
    const { issues } = (await response.json()) as { issues: NoteIssue[] };

    assert.deepEqual(
      issues[0]?.comments?.map((comment) => comment.body),
      ['Celui-ci d’abord.', 'Puis celui-ci.'],
    );
    assert.equal(issues[0]?.comments?.[0]?.author, 'Alice');
  });

  it('keeps a comment whose author Linear no longer knows', async () => {
    // An integration, or a deleted account. Dropping the comment would lose the reply; inventing a
    // name would be worse.
    const seed = noteFixture();
    installLinearStub({
      storedIssues: [
        storedIssueFromNote(seed, {
          comments: { nodes: [{ id: 'c1', body: 'Sans auteur.', createdAt: '2026-08-01T10:00:00.000Z', user: null }] },
        }),
      ],
    });

    const response = await get(`/feedback?url=${encodeURIComponent(seed.page.url)}`);
    const { issues } = (await response.json()) as { issues: NoteIssue[] };

    assert.equal(issues[0]?.comments?.length, 1);
    assert.equal(issues[0]?.comments?.[0]?.author, undefined);
  });

  it('says nothing rather than empty when a client turned replies off', async () => {
    // Absent and empty mean different things to the widget: one is "not asked", the other is "asked,
    // none". A client with comments off must not read as a team that never answered.
    const seed = noteFixture({ client: { id: 'acme' } });
    const hidden: WorkerEnv = {
      ...env,
      FRUITBACK_CLIENTS: JSON.stringify({ acme: { teamId: 'team_1', showComments: false } }),
    };
    installLinearStub({
      storedIssues: [
        storedIssueFromNote(seed, {
          comments: { nodes: [{ id: 'c1', body: 'Interne.', createdAt: '2026-08-01T10:00:00.000Z', user: null }] },
        }),
      ],
    });

    const response = await get(`/feedback?url=${encodeURIComponent(seed.page.url)}&client=acme`, { env: hidden });
    const { issues } = (await response.json()) as { issues: NoteIssue[] };

    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.comments, undefined);
  });
});

describe('who may read a pin (FRU-40)', () => {
  const SECRET = 'a-read-secret-long-enough-to-not-be-guessed';
  const inAnHour = () => Math.floor((Date.now() + 3_600_000) / 1000);
  const closed: WorkerEnv = { ...env, FRUITBACK_READ: 'authenticated', FRUITBACK_IDENTITY_SECRET: SECRET };

  function planted() {
    const seed = noteFixture();
    installLinearStub({ storedIssues: [storedIssueFromNote(seed)] });

    return `/feedback?url=${encodeURIComponent(seed.page.url)}`;
  }

  it('answers an anonymous read where reads are public, which stays the default', async () => {
    const response = await get(planted());

    assert.equal(response.status, 200);
    const { issues } = (await response.json()) as { issues: NoteIssue[] };
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
    const { issues } = (await response.json()) as { issues: NoteIssue[] };
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
    const seed = noteFixture();
    const stub = installLinearStub({ storedIssues: [storedIssueFromNote(seed)] });

    const response = await get(`/feedback?url=${encodeURIComponent(seed.page.url)}`, { env: closed });

    assert.equal(response.status, 401);
    assert.deepEqual(stub.calls, [], 'an unauthorised read reached Linear');
  });

  it('tells a reader it would sign that it is identified, and tells nobody who (FRU-112)', async () => {
    // The composer of the widget asks for no name then. One bit: the page reads this answer in team
    // mode, and the name of the session is not in it.
    const token = await signIdentityToken(
      { sub: 'acct_only_in_the_token', name: 'Zoé Seulement-Du-Jeton', email: 'zoe@token.test', exp: inAnHour() },
      SECRET,
    );

    const response = await get(planted(), { env: closed, headers: { Authorization: `Bearer ${token}` } });

    const text = await response.text();
    assert.equal((JSON.parse(text) as { identified?: unknown }).identified, true);
    for (const claim of ['acct_only_in_the_token', 'Seulement-Du-Jeton', 'zoe@token.test']) {
      assert.ok(!text.includes(claim), `the read answered ${claim}, which only the token held`);
    }
  });

  it('says nothing of identity to a reader it would not sign, a warm cache included', async () => {
    // Reads are public here, so a token is not needed, and a bad one is not refused. The field is
    // asked at each request: the entry of the cache is shared, and it must not carry the last answer.
    const open: WorkerEnv = { ...env, FRUITBACK_IDENTITY_SECRET: SECRET };
    const path = planted();
    const good = await signIdentityToken({ sub: 'user_42', exp: inAnHour() }, SECRET);
    const forged = await signIdentityToken({ sub: 'user_42', exp: inAnHour() }, 'a-different-secret-of-good-length');
    const expired = await signIdentityToken({ sub: 'user_42', exp: Math.floor(Date.now() / 1000) - 60 }, SECRET);
    const identifiedFor = async (headers?: Record<string, string>) => {
      const response = await get(path, { env: open, ...(headers === undefined ? {} : { headers }) });
      assert.equal(response.status, 200);

      return 'identified' in ((await response.json()) as object);
    };

    assert.equal(await identifiedFor({ Authorization: `Bearer ${good}` }), true, 'the control: a good token');
    assert.equal(await identifiedFor(), false);
    assert.equal(await identifiedFor({ Authorization: `Bearer ${forged}` }), false);
    assert.equal(await identifiedFor({ Authorization: `Bearer ${expired}` }), false);
    // A public read never verified a token before FRU-112, so anything could sit in the header.
    // None of it may turn a read that answered into a failure.
    for (const junk of [
      '',
      'x',
      '..',
      'a.b.c',
      '%%%.%%%.%%%',
      `${good}x`,
      `${good.split('.').slice(0, 2).join('.')}.`,
      'é'.repeat(4_000),
    ]) {
      assert.equal(await identifiedFor({ Authorization: `Bearer ${junk}` }), false, `Bearer ${junk.slice(0, 20)}`);
    }
    // No identity secret at all: the same good token names nobody.
    const response = await get(path, { headers: { Authorization: `Bearer ${good}` } });
    assert.equal('identified' in ((await response.json()) as object), false);
  });

  it('lets one client keep its reads open while another closes them', async () => {
    const seed = noteFixture({ client: { id: 'acme' } });
    installLinearStub({ storedIssues: [storedIssueFromNote(seed)] });
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

describe('one store per process, not one per request (FRU-29)', () => {
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

    const response = await post(noteFixture(), { store });

    assert.equal(response.status, 201);
    assert.equal(seen.writes, 1);
    assert.deepEqual(stub.calls, []);
  });

  it('serves several requests from the same instance', async () => {
    // The property that matters, and the one a per-call `storeFor` broke: a store holding a
    // resource — a SQLite connection, once FRU-31 lands — is opened once and reused.
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
