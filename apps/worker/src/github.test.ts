import assert from 'node:assert/strict';
import { createPrivateKey, generateKeyPairSync, verify } from 'node:crypto';
import { afterEach, describe, it, vi } from 'vitest';
import { mockMethod } from './mock.fixture.ts';
import { DEFAULT_NOTE_STAGE, NOTE_STAGES, buildIssueDescription } from '@fruitback/shared';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { type ClientPolicy, readClientMap } from './clients.ts';
import {
  GITHUB_STAGES,
  createGithubStore,
  createGithubStoreSpec,
  githubLabelName,
  searchPhrase,
  signAppJwt,
  stageForGithubIssue,
} from './github.ts';
import { StoreError } from './store.ts';

/**
 * The GitHub store against a fake GitHub (FRU-32). No test writes to a real repository.
 *
 * The routes and the response fields follow the REST documentation, API version 2022-11-28.
 */

const { privateKey: PEM, publicKey: PUBLIC_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const NOW = Date.parse('2026-09-14T12:00:00Z');
const CONFIG = { appId: '12345', privateKey: createPrivateKey(PEM), repository: 'acme/site' };
const POLICY: ClientPolicy = {
  showComments: true,
  identitySecret: undefined,
  read: 'public',
  write: 'public',
  locale: 'en',
};
const PAGE = noteFixture().page.url;

afterEach(() => {
  vi.restoreAllMocks();
});

type Call = { method: string; path: string; query: URLSearchParams; authorization: string | null; body: unknown };
type Route = (call: Call) => Response | Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** GitHub, answering from a table of `METHOD /path` routes. Any other request gets a 404. */
function fakeGithub(routes: Record<string, Route>): Call[] {
  const calls: Call[] = [];

  mockMethod(globalThis, 'fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const call: Call = {
      method: init.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      authorization: new Headers(init.headers).get('Authorization'),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const route = routes[`${call.method} ${call.path}`];

    return route === undefined ? json(404, { message: 'Not Found' }) : route(call);
  });

  return calls;
}

/** The two calls that change the App JWT into an installation token. */
function installation(options: { repository?: string; expiresAt?: string } = {}): Record<string, Route> {
  let minted = 0;

  return {
    [`GET /repos/${options.repository ?? 'acme/site'}/installation`]: () => json(200, { id: 77 }),
    'POST /app/installations/77/access_tokens': () =>
      json(201, { token: `ghs_${++minted}`, expires_at: options.expiresAt ?? '2026-09-14T13:00:00Z' }),
  };
}

function row(overrides: Record<string, unknown> = {}, note = noteFixture()) {
  return {
    id: 9001,
    number: 12,
    html_url: 'https://github.com/acme/site/issues/12',
    title: 'Le bouton est trop petit',
    body: buildIssueDescription(note),
    state: 'open',
    state_reason: null,
    updated_at: '2026-09-14T10:00:00Z',
    comments: 0,
    labels: [{ name: 'fruitback' }, { name: 'fruitback:acme' }],
    ...overrides,
  };
}

function mints(calls: Call[]): number {
  return calls.filter((call) => call.path.endsWith('/access_tokens')).length;
}

function apiCalls(calls: Call[]): Call[] {
  return calls.filter((call) => !call.path.endsWith('/installation') && !call.path.endsWith('/access_tokens'));
}

function decodePart(part: string | undefined): Record<string, unknown> {
  return JSON.parse(Buffer.from(part ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('stageForGithubIssue', () => {
  it('projects the two states and the reason for a close', () => {
    assert.equal(stageForGithubIssue('open', null), 'new');
    assert.equal(stageForGithubIssue('open', 'reopened'), 'new');
    assert.equal(stageForGithubIssue('closed', 'completed'), 'done');
    // Closed before GitHub had state_reason. Closed then meant done.
    assert.equal(stageForGithubIssue('closed', null), 'done');
    assert.equal(stageForGithubIssue('closed', 'not_planned'), 'closed');
    assert.equal(stageForGithubIssue('closed', 'duplicate'), 'closed');
  });

  it('draws a state it does not know at the default of the contract', () => {
    assert.equal(stageForGithubIssue('locked', null), DEFAULT_NOTE_STAGE);
  });

  it('declares exactly the stages it can return, in the order of the contract', () => {
    // The panel offers a box for each declared stage. A stage declared and never returned is a box
    // that filters nothing, and a stage returned and not declared is a pin nobody can hide.
    const returned = new Set<string>();
    for (const state of ['open', 'closed', 'locked']) {
      for (const reason of [null, undefined, 'completed', 'reopened', 'not_planned', 'duplicate', 'other']) {
        returned.add(stageForGithubIssue(state, reason));
      }
    }

    assert.deepEqual([...returned].sort(), [...GITHUB_STAGES].sort());
    assert.deepEqual(
      NOTE_STAGES.filter((stage) => GITHUB_STAGES.includes(stage)),
      [...GITHUB_STAGES],
    );
  });
});

describe('signAppJwt', () => {
  it('signs RS256 claims that GitHub accepts', () => {
    const jwt = signAppJwt('12345', CONFIG.privateKey, NOW);
    const [header, payload, signature] = jwt.split('.');

    assert.deepEqual(decodePart(header), { alg: 'RS256', typ: 'JWT' });
    // iat is 60 seconds back for clock drift. exp stays under the ten minutes GitHub allows.
    assert.deepEqual(decodePart(payload), { iat: NOW / 1000 - 60, exp: NOW / 1000 + 540, iss: '12345' });
    assert.ok(
      verify('sha256', Buffer.from(`${header}.${payload}`), PUBLIC_KEY, Buffer.from(signature ?? '', 'base64url')),
      'the signature does not verify with the public key',
    );
  });
});

describe('the installation token', () => {
  it('is minted from the App JWT, for this repository only, and used on the call', async () => {
    const calls = fakeGithub({ ...installation(), 'GET /repos/acme/site/issues': () => json(200, []) });
    const store = createGithubStore(CONFIG, { now: () => NOW });

    await store.findForPage({ url: PAGE, clientId: 'acme' }, undefined, POLICY);

    assert.deepEqual(
      calls.map((call) => `${call.method} ${call.path}`),
      ['GET /repos/acme/site/installation', 'POST /app/installations/77/access_tokens', 'GET /repos/acme/site/issues'],
    );
    const jwt = calls[0]?.authorization?.replace(/^Bearer /, '') ?? '';
    assert.equal(decodePart(jwt.split('.')[1]).iss, '12345');
    assert.equal(calls[1]?.authorization, `Bearer ${jwt}`);
    assert.deepEqual(calls[1]?.body, { repositories: ['site'] });
    assert.equal(calls[2]?.authorization, 'Bearer ghs_1');
  });

  it('is reused until five minutes before it expires', async () => {
    const calls = fakeGithub({ ...installation(), 'GET /repos/acme/site/issues': () => json(200, []) });
    let now = NOW;
    const store = createGithubStore(CONFIG, { now: () => now });
    const read = () => store.findForPage({ url: PAGE, clientId: 'acme' }, undefined, POLICY);

    await read();
    now = Date.parse('2026-09-14T12:54:59Z');
    await read();
    assert.equal(mints(calls), 1, 'a token with more than five minutes left was minted again');

    now = Date.parse('2026-09-14T12:55:00Z');
    await read();
    assert.equal(mints(calls), 2);
    assert.equal(calls.at(-1)?.authorization, 'Bearer ghs_2');
  });

  it('is minted once for requests that arrive together', async () => {
    const calls = fakeGithub({ ...installation(), 'GET /repos/acme/site/issues': () => json(200, []) });
    const store = createGithubStore(CONFIG, { now: () => NOW });

    await Promise.all([1, 2, 3].map(() => store.findForPage({ url: PAGE, clientId: 'acme' }, undefined, POLICY)));

    assert.equal(mints(calls), 1);
  });

  it('is not kept after a failed mint', async () => {
    let attempts = 0;
    const calls = fakeGithub({
      ...installation(),
      'POST /app/installations/77/access_tokens': () =>
        ++attempts === 1
          ? json(500, { message: 'Server Error' })
          : json(201, { token: 'ghs_ok', expires_at: '2026-09-14T13:00:00Z' }),
      'GET /repos/acme/site/issues': () => json(200, []),
    });
    const store = createGithubStore(CONFIG, { now: () => NOW });
    const read = () => store.findForPage({ url: PAGE, clientId: 'acme' }, undefined, POLICY);

    await assert.rejects(read(), StoreError);
    await read();

    assert.equal(mints(calls), 2);
    assert.equal(calls.at(-1)?.authorization, 'Bearer ghs_ok');
  });

  it('is dropped only when GitHub refuses that token, not a newer one', async () => {
    // A 401 can land after a newer token replaced the one it refused. Found in review.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let minted = 0;
    const calls = fakeGithub({
      'GET /repos/acme/site/installation': () => json(200, { id: 77 }),
      'POST /app/installations/77/access_tokens': () => {
        minted += 1;

        return json(201, { token: `ghs_${minted}`, expires_at: `2026-09-14T1${2 + minted}:00:00Z` });
      },
      'GET /repos/acme/site/issues': async (call) => {
        if (call.authorization !== 'Bearer ghs_1') return json(200, []);
        await gate;

        return json(401, { message: 'Bad credentials' });
      },
    });
    let now = NOW;
    const store = createGithubStore(CONFIG, { now: () => now });
    const read = () => store.findForPage({ url: PAGE, clientId: 'acme' }, undefined, POLICY);

    const late = read();
    await new Promise((resolve) => setTimeout(resolve, 20));
    now = Date.parse('2026-09-14T12:56:00Z');
    await read();
    release();
    await assert.rejects(late, StoreError);
    await read();

    assert.equal(mints(calls), 2, 'the late 401 evicted the newer token');
    assert.equal(calls.at(-1)?.authorization, 'Bearer ghs_2');
  });

  it('is minted again after GitHub refuses it', async () => {
    let reads = 0;
    const calls = fakeGithub({
      ...installation(),
      'GET /repos/acme/site/issues': () => (++reads === 1 ? json(401, { message: 'Bad credentials' }) : json(200, [])),
    });
    const store = createGithubStore(CONFIG, { now: () => NOW });
    const read = () => store.findForPage({ url: PAGE, clientId: 'acme' }, undefined, POLICY);

    await assert.rejects(read(), StoreError);
    await read();

    assert.equal(mints(calls), 2);
    assert.equal(calls.at(-1)?.authorization, 'Bearer ghs_2');
  });
});

describe('create', () => {
  const created = () => json(201, { id: 9001, number: 12, html_url: 'https://github.com/acme/site/issues/12' });

  it('writes the hashed label for a client ID GitHub would change', async () => {
    const calls = fakeGithub({
      ...installation(),
      'POST /repos/acme/site/labels': () => json(201, {}),
      'POST /repos/acme/site/issues': created,
    });
    const store = createGithubStore(CONFIG, { now: () => NOW });
    const note = noteFixture({ client: { id: 'Acme', name: 'Acme' } });

    await store.create(note, undefined, POLICY);

    const label = githubLabelName('fruitback:Acme');
    assert.deepEqual(
      apiCalls(calls)
        .filter((call) => call.path.endsWith('/labels'))
        .map((call) => (call.body as { name: string }).name),
      ['fruitback', label],
    );
    assert.deepEqual((apiCalls(calls).at(-1)?.body as { labels: string[] } | undefined)?.labels, ['fruitback', label]);
  });

  it('creates the two labels, then the issue with the shared codec', async () => {
    const note = noteFixture();
    const calls = fakeGithub({
      ...installation(),
      'POST /repos/acme/site/labels': () => json(201, {}),
      'POST /repos/acme/site/issues': created,
    });
    const store = createGithubStore(CONFIG, { now: () => NOW });

    const issue = await store.create(note, undefined, POLICY);

    assert.deepEqual(issue, { id: '9001', identifier: '#12', url: 'https://github.com/acme/site/issues/12' });
    const api = apiCalls(calls);
    assert.deepEqual(
      api.map((call) => [call.path, (call.body as { name?: string }).name]),
      [
        ['/repos/acme/site/labels', 'fruitback'],
        ['/repos/acme/site/labels', 'fruitback:acme'],
        ['/repos/acme/site/issues', undefined],
      ],
    );
    assert.deepEqual(api[2]?.body, {
      title: 'Le bouton “Commander” est trop petit sur mobile, on le rate au pouce.',
      body: buildIssueDescription(note),
      labels: ['fruitback', 'fruitback:acme'],
    });
  });

  /** The prose follows the worker's own locale, wherever the issues are kept (FRU-39). */
  it('writes the issue body in the locale the policy carries', async () => {
    const note = noteFixture();
    const calls = fakeGithub({
      ...installation(),
      'POST /repos/acme/site/labels': () => json(201, {}),
      'POST /repos/acme/site/issues': created,
    });
    const store = createGithubStore(CONFIG, { now: () => NOW });

    await store.create(note, undefined, { ...POLICY, locale: 'fr' });

    const body = (apiCalls(calls)[2]?.body as { body?: string } | undefined)?.body ?? '';
    assert.equal(body, buildIssueDescription(note, { locale: 'fr' }));
    assert.match(body, /\*\*Signalé par\*\*/);
  });

  it('accepts a label that already exists', async () => {
    fakeGithub({
      ...installation(),
      'POST /repos/acme/site/labels': () =>
        json(422, { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'already_exists' }] }),
      'POST /repos/acme/site/issues': created,
    });
    const store = createGithubStore(CONFIG, { now: () => NOW });

    assert.equal((await store.create(noteFixture(), undefined, POLICY)).identifier, '#12');
  });

  it('stops before the issue if a label cannot be created', async () => {
    // A read finds a note by its labels. An issue without them is a note nobody sees again, and a
    // failed write lets the widget keep the note and try again.
    for (const refusal of [
      () => json(403, { message: 'Resource not accessible by integration' }),
      () => json(422, { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'invalid' }] }),
    ]) {
      const calls = fakeGithub({
        ...installation(),
        'POST /repos/acme/site/labels': refusal,
        'POST /repos/acme/site/issues': created,
      });
      const store = createGithubStore(CONFIG, { now: () => NOW });

      await assert.rejects(store.create(noteFixture(), undefined, POLICY), StoreError);
      assert.equal(calls.filter((call) => call.path === '/repos/acme/site/issues').length, 0);
      vi.restoreAllMocks();
    }
  });

  it('reports an unreachable GitHub as a store failure', async () => {
    mockMethod(globalThis, 'fetch', async () => {
      throw new TypeError('fetch failed');
    });
    const store = createGithubStore(CONFIG, { now: () => NOW });

    await assert.rejects(store.create(noteFixture(), undefined, POLICY), StoreError);
  });
});

describe('findForPage', () => {
  function readWith(rows: unknown[], routes: Record<string, Route> = {}, policy = POLICY, clientId = 'acme') {
    const calls = fakeGithub({
      ...installation(),
      'GET /repos/acme/site/issues': () => json(200, rows),
      ...routes,
    });
    const store = createGithubStore(CONFIG, { now: () => NOW });

    return { calls, issues: store.findForPage({ url: PAGE, clientId }, undefined, policy) };
  }

  it('asks for both labels, and for closed issues too', async () => {
    const { calls, issues } = readWith([]);
    await issues;

    const query = apiCalls(calls)[0]?.query;
    assert.equal(query?.get('labels'), 'fruitback,fruitback:acme');
    assert.equal(query?.get('state'), 'all');
    assert.equal(query?.get('per_page'), '100');

    const anonymous = readWith([], {}, POLICY, '');
    await anonymous.issues;
    assert.equal(apiCalls(anonymous.calls)[0]?.query.get('labels'), 'fruitback');
  });

  it('keeps only the notes of this exact page, and no pull request', async () => {
    const note = noteFixture();
    const otherPage = noteFixture({
      id: 'sd_other',
      page: { url: 'https://preview.acme.test/pricing', path: '/pricing', title: 'Pricing — Acme' },
    });
    const { issues } = readWith([
      row(),
      row({ id: 2, number: 2 }, otherPage),
      row({ id: 3, number: 3, pull_request: { url: 'https://api.github.com/repos/acme/site/pulls/3' } }),
      row({ id: 4, number: 4, body: 'Somebody removed the block.' }),
      row({ id: 5, number: 5, body: null }),
      { id: 'not a row' },
    ]);

    const found = await issues;

    assert.equal(found.length, 1);
    assert.partialDeepStrictEqual(found[0], {
      id: '9001',
      identifier: '#12',
      url: 'https://github.com/acme/site/issues/12',
      title: 'Le bouton est trop petit',
      stage: 'new',
      stateName: 'Open',
      updatedAt: '2026-09-14T10:00:00Z',
      comments: [],
    });
    assert.deepEqual(found[0]?.note, note);
  });

  it('gives a client ID that GitHub would change a hashed label, on the write and on the read', async () => {
    // GitHub splits `labels` on commas, compares names without case, and stops at 50 characters.
    // Found in review, and the case measured on cli/cli: `labels/BUG` answers the `bug` label.
    for (const clientId of ['acme,staging', 'Acme', 'a'.repeat(45)]) {
      const label = githubLabelName(`fruitback:${clientId}`);

      assert.match(label, /^fruitback:[0-9a-f]{32}$/, clientId);
      assert.notEqual(label, 'fruitback:acme', clientId);
    }
    assert.equal(githubLabelName('fruitback:acme'), 'fruitback:acme');
    assert.equal(githubLabelName('fruitback'), 'fruitback');

    const label = githubLabelName('fruitback:acme,staging');
    const { calls, issues } = readWith(
      [
        row({ labels: [{ name: 'fruitback' }, { name: label }] }, noteFixture({ client: { id: 'acme,staging' } })),
        row({ id: 2, number: 2, labels: [{ name: 'fruitback' }, { name: 'fruitback:acme' }, { name: 'staging' }] }),
      ],
      {},
      POLICY,
      'acme,staging',
    );

    const found = await issues;

    assert.equal(apiCalls(calls)[0]?.query.get('labels'), `fruitback,${label}`);
    assert.deepEqual(
      found.map((issue) => issue.id),
      ['9001'],
    );
  });

  it('never gives a client ID the hashed label of another client', () => {
    // A client ID can be the 32 hex characters of another client's hash. Found in review.
    const acme = githubLabelName('fruitback:Acme');
    const forged = githubLabelName(`fruitback:${acme.slice('fruitback:'.length)}`);

    assert.match(forged, /^fruitback:[0-9a-f]{32}$/);
    assert.notEqual(forged, acme);
  });

  it('keeps a note off a client whose name its note does not carry, whatever its labels say', async () => {
    const { issues } = readWith([
      row({}, noteFixture({ client: { id: 'globex', name: 'Globex' } })),
      row({ id: 2, number: 2 }),
    ]);

    assert.deepEqual(
      (await issues).map((issue) => issue.id),
      ['2'],
    );
  });

  it('keeps the notes of Acme off acme, whose label GitHub would treat as the same', async () => {
    const { issues } = readWith(
      [row({ labels: [{ name: 'fruitback' }, { name: 'fruitback:acme' }] })],
      {},
      POLICY,
      'Acme',
    );

    assert.deepEqual(await issues, []);
  });

  it('matches a label without case, as GitHub does', async () => {
    const { issues } = readWith([row({ labels: [{ name: 'Fruitback' }, { name: 'FRUITBACK:ACME' }] })]);

    assert.equal((await issues).length, 1);
  });

  it('keeps an issue without the client label off that client', async () => {
    const { issues } = readWith([
      row({ labels: [{ name: 'fruitback' }] }),
      row({ id: 2, number: 2, labels: [{ name: 'fruitback' }, { name: 'fruitback:globex' }] }),
      row({ id: 3, number: 3, labels: ['fruitback', 'fruitback:acme'] }),
    ]);

    assert.deepEqual(
      (await issues).map((issue) => issue.id),
      ['3'],
    );
  });

  it('fetches the comments of a page with many pins a few at a time', async () => {
    let inFlight = 0;
    let most = 0;
    const routes: Record<string, Route> = {};
    for (let number = 1; number <= 10; number += 1) {
      routes[`GET /repos/acme/site/issues/${number}/comments`] = async () => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;

        return json(200, [{ id: number, body: 'ok', created_at: '2026-09-14T10:00:00Z', user: null }]);
      };
    }
    const rows = Array.from({ length: 10 }, (_, index) => row({ id: index + 1, number: index + 1, comments: 1 }));
    const { issues } = readWith(rows, routes);

    const found = await issues;

    assert.equal(found.length, 10);
    assert.ok(
      found.every((issue) => issue.comments?.length === 1),
      'a pin lost its comment',
    );
    assert.ok(most <= 4, `${most} comment lists were fetched at once`);
    assert.ok(most > 1, 'the comment lists were fetched one by one');
  });

  it('names a closed issue by the reason it was closed', async () => {
    const { issues } = readWith([row({ state: 'closed', state_reason: 'not_planned' })]);

    assert.partialDeepStrictEqual((await issues)[0], { stage: 'closed', stateName: 'Not planned' });
  });

  it('returns the newest twenty comments, oldest first', async () => {
    const comment = (n: number) => ({
      id: n,
      body: `reply ${n}`,
      created_at: `2026-09-14T10:${String(n).padStart(2, '0')}:00Z`,
      user: n === 45 ? null : { login: 'octocat' },
    });
    const { calls, issues } = readWith([row({ comments: 45 })], {
      'GET /repos/acme/site/issues/12/comments': (call) => {
        const page = Number(call.query.get('page'));
        const first = (page - 1) * 20 + 1;
        const last = Math.min(page * 20, 45);

        return json(
          200,
          Array.from({ length: last - first + 1 }, (_, index) => comment(first + index)),
        );
      },
    });

    const comments = (await issues)[0]?.comments ?? [];

    assert.deepEqual(
      calls.filter((call) => call.path.endsWith('/comments')).map((call) => call.query.get('page')),
      ['2', '3'],
    );
    assert.deepEqual(
      comments.map((reply) => reply.id),
      Array.from({ length: 20 }, (_, index) => String(26 + index)),
    );
    assert.deepEqual(comments[0], {
      id: '26',
      body: 'reply 26',
      createdAt: '2026-09-14T10:26:00Z',
      author: 'octocat',
    });
    assert.equal('author' in (comments.at(-1) ?? {}), false, 'a comment with no user has no author');
  });

  it('reads on past the page the count predicts, for a reply that came after the list', async () => {
    // The list said 20. Five more replies arrived before the comments were read. Found in review.
    const { calls, issues } = readWith([row({ comments: 20 })], {
      'GET /repos/acme/site/issues/12/comments': (call) => {
        const page = Number(call.query.get('page'));
        const first = (page - 1) * 20 + 1;
        const last = Math.min(page * 20, 25);

        return json(
          200,
          Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => ({
            id: first + index,
            body: 'reply',
            created_at: `2026-09-14T10:${String(first + index).padStart(2, '0')}:00Z`,
            user: null,
          })),
        );
      },
    });

    const comments = (await issues)[0]?.comments ?? [];

    assert.deepEqual(
      calls.filter((call) => call.path.endsWith('/comments')).map((call) => call.query.get('page')),
      ['1', '2'],
    );
    assert.deepEqual(
      comments.map((reply) => reply.id),
      Array.from({ length: 20 }, (_, index) => String(6 + index)),
    );
  });

  it('asks for no comment if the client hides them, and says nothing about them', async () => {
    const { calls, issues } = readWith([row({ comments: 3 })], {}, { ...POLICY, showComments: false });

    const found = await issues;

    assert.equal('comments' in (found[0] ?? {}), false);
    assert.equal(calls.filter((call) => call.path.endsWith('/comments')).length, 0);
  });

  it('reads one list when the site has fewer notes than a list holds, and searches nothing', async () => {
    const { calls, issues } = readWith([row()]);

    assert.equal((await issues).length, 1);
    assert.deepEqual(
      apiCalls(calls).map((call) => call.path),
      ['/repos/acme/site/issues'],
    );
  });

  it('reads the oldest note of a page on a site of 1,001 issues, in two calls (FRU-500)', async () => {
    // 1,001 issues, the newest first, as GitHub lists them. Only the oldest is a note of this page:
    // the 1,000 others are notes of other pages.
    const elsewhere = noteFixture({
      id: 'sd_other',
      page: { url: 'https://preview.acme.test/pricing', path: '/pricing', title: 'Pricing — Acme' },
    });
    const site = Array.from({ length: 1001 }, (_, index) => {
      const number = 1001 - index;

      return number === 1
        ? row({ id: number, number, html_url: `https://github.com/acme/site/issues/${number}` })
        : row({ id: number, number, html_url: `https://github.com/acme/site/issues/${number}` }, elsewhere);
    });
    const { calls, issues } = readWith([], {
      'GET /repos/acme/site/issues': (call) => {
        const size = Number(call.query.get('per_page'));
        const page = Number(call.query.get('page') ?? '1');

        return json(200, site.slice((page - 1) * size, page * size));
      },
      // GitHub's search, as far as this store asks it: the labels, and a phrase of the body.
      'GET /search/issues': (call) => {
        const q = call.query.get('q') ?? '';
        const phrase = /"([^"]+)" in:body$/.exec(q)?.[1] ?? '';
        const labels = [...q.matchAll(/label:"([^"]+)"/g)].map(([, name]) => name);
        const items = site.filter(
          (each) =>
            each.body.includes(phrase) && labels.every((name) => each.labels.some((label) => label.name === name)),
        );

        return json(200, { total_count: items.length, incomplete_results: false, items });
      },
    });

    const found = await issues;

    assert.deepEqual(
      found.map((issue) => issue.identifier),
      ['#1'],
    );
    const api = apiCalls(calls);
    assert.deepEqual(
      api.map((call) => call.path),
      ['/repos/acme/site/issues', '/search/issues'],
    );
    assert.equal(
      api[1]?.query.get('q'),
      `repo:acme/site is:issue label:"fruitback" label:"fruitback:acme" "${PAGE}" in:body`,
    );
  });

  it('keeps one copy of a note that both the list and the search give', async () => {
    const full = [row(), ...Array.from({ length: 99 }, (_, index) => ({ id: 100 + index }))];
    const { issues } = readWith(full, {
      'GET /search/issues': () => json(200, { total_count: 1, incomplete_results: false, items: [row()] }),
    });

    assert.equal((await issues).length, 1);
  });

  it('keeps the newest notes when GitHub refuses the search for its rate, and says so in the log', async () => {
    const full = [row(), ...Array.from({ length: 99 }, (_, index) => ({ id: 100 + index }))];
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { issues } = readWith(full, {
      'GET /search/issues': () =>
        new Response(JSON.stringify({ message: 'secondary rate limit' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json', 'retry-after': '60' },
        }),
    });

    assert.equal((await issues).length, 1);
    assert.match(String(logged.mock.calls[0]?.[0]), /refused the search of a page \(403\)/);
  });

  it('fails as a store failure when the search is refused for another reason', async () => {
    const full = Array.from({ length: 100 }, (_, index) => ({ id: index }));
    const { issues } = readWith(full, { 'GET /search/issues': () => json(422, { message: 'Validation Failed' }) });

    await assert.rejects(issues, StoreError);
  });

  it('says in the log when the search reaches the 1,000 results GitHub gives, or calls itself incomplete', async () => {
    const full = Array.from({ length: 100 }, (_, index) => ({ id: index }));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const capped = readWith(full, {
      'GET /search/issues': () => json(200, { total_count: 5000, incomplete_results: false, items: full }),
    });
    await capped.issues;
    assert.equal(apiCalls(capped.calls).filter((call) => call.path === '/search/issues').length, 10);
    assert.match(String(logged.mock.calls.at(-1)?.[0]), /reached 1000 results: older notes may be missing/);

    logged.mockClear();
    const partial = readWith(full, {
      'GET /search/issues': () => json(200, { total_count: 1, incomplete_results: true, items: [row()] }),
    });
    assert.equal((await partial.issues).length, 1);
    assert.match(String(logged.mock.calls[0]?.[0]), /search of a page is incomplete/);

    logged.mockClear();
    const quiet = readWith(full, {
      'GET /search/issues': () => json(200, { total_count: 1, incomplete_results: false, items: [row()] }),
    });
    await quiet.issues;
    assert.equal(logged.mock.calls.length, 0);
  });

  it('searches a long URL by a prefix that ends on a slash', () => {
    const long = `https://preview.acme.test/${'a'.repeat(120)}/${'b'.repeat(120)}`;

    assert.equal(searchPhrase(PAGE), PAGE);
    assert.equal(searchPhrase(long), `https://preview.acme.test/${'a'.repeat(120)}`);
    assert.equal(searchPhrase('https://acme.test/a"b\\c'), 'https://acme.test/a b c');
  });

  it('gives a read up after its delay, and never a write (FRU-500)', async () => {
    const signals: [string, AbortSignal | undefined][] = [];
    mockMethod(globalThis, 'fetch', async (input: string, init: RequestInit = {}) => {
      signals.push([`${init.method ?? 'GET'} ${new URL(input).pathname}`, init.signal ?? undefined]);
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });
    const store = createGithubStore(CONFIG, { now: () => NOW });

    await assert.rejects(store.findForPage({ url: PAGE, clientId: 'acme' }, undefined, POLICY), {
      message: 'GitHub did not answer in time',
    });
    assert.equal(signals[0]?.[0], 'GET /repos/acme/site/installation');
    assert.ok(signals[0]?.[1] instanceof AbortSignal);

    const { githubFetch } = await import('./github.ts');
    await assert.rejects(githubFetch('/repos/acme/site/issues', { method: 'POST', token: 't', body: {} }), StoreError);
    assert.equal(signals.at(-1)?.[0], 'POST /repos/acme/site/issues');
    assert.equal(signals.at(-1)?.[1], undefined);
  });

  it('fails as a store failure when GitHub refuses the read', async () => {
    const { issues } = readWith([], { 'GET /repos/acme/site/issues': () => json(403, { message: 'rate limit' }) });

    await assert.rejects(issues, (error: unknown) => {
      assert.ok(error instanceof StoreError);
      assert.equal(error.message, 'GitHub responded 403');

      return true;
    });
  });
});

describe('which repository', () => {
  it('scopes the read cache by repository', () => {
    const store = createGithubStore(CONFIG);

    assert.equal(store.name, 'github');
    assert.equal(store.scope(undefined), 'acme/site');
    assert.equal(store.scope({ repository: 'globex/app' }), 'globex/app');
  });

  it('reads the repository of the client, with a token for that repository', async () => {
    const calls = fakeGithub({
      ...installation({ repository: 'globex/app' }),
      'GET /repos/globex/app/issues': () => json(200, []),
    });
    const store = createGithubStore(CONFIG, { now: () => NOW });

    await store.findForPage({ url: PAGE, clientId: 'globex' }, { repository: 'globex/app' }, POLICY);

    assert.deepEqual(calls[1]?.body, { repositories: ['app'] });
    assert.equal(calls[2]?.path, '/repos/globex/app/issues');
  });

  it('refuses a client repository that is not owner/repo', () => {
    assert.equal(readClientMap(JSON.stringify({ acme: { repository: 'acme/site' } })).ok, true);
    for (const repository of ['acme', 'acme/site/extra', 'acme/..', 'acme/.', '../site']) {
      assert.equal(readClientMap(JSON.stringify({ acme: { repository } })).ok, false, repository);
    }
  });
});

describe('createGithubStoreSpec', () => {
  const spec = createGithubStoreSpec();
  const ENV = {
    FRUITBACK_GITHUB_APP_ID: '12345',
    FRUITBACK_GITHUB_PRIVATE_KEY: PEM,
    FRUITBACK_GITHUB_REPOSITORY: 'acme/site',
  };

  it('names each variable that is missing', () => {
    assert.deepEqual(spec.readFrom({}), {
      ok: false,
      missing: ['FRUITBACK_GITHUB_APP_ID', 'FRUITBACK_GITHUB_PRIVATE_KEY', 'FRUITBACK_GITHUB_REPOSITORY'],
    });
    assert.equal(spec.readFrom(ENV).ok, true);
  });

  it('refuses a key that is not an RSA private key, and never repeats it', () => {
    const { privateKey: ecKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });

    for (const key of ['not-a-key-at-all', ecKey, PUBLIC_KEY]) {
      const result = spec.readFrom({ ...ENV, FRUITBACK_GITHUB_PRIVATE_KEY: key });

      assert.deepEqual(result, { ok: false, missing: ['FRUITBACK_GITHUB_PRIVATE_KEY'] });
      assert.equal(JSON.stringify(result).includes(key.slice(0, 16)), false);
    }
  });

  it('accepts the key on one line, with its line breaks written as \\n', () => {
    assert.equal(spec.readFrom({ ...ENV, FRUITBACK_GITHUB_PRIVATE_KEY: PEM.replace(/\n/g, '\\n') }).ok, true);
  });

  it('refuses a repository that is not owner/repo', () => {
    for (const repository of ['acme', 'acme/site/extra', 'acme/..']) {
      assert.deepEqual(spec.readFrom({ ...ENV, FRUITBACK_GITHUB_REPOSITORY: repository }), {
        ok: false,
        missing: ['FRUITBACK_GITHUB_REPOSITORY'],
      });
    }
  });
});
