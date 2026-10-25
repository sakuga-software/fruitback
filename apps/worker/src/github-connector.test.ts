import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, it } from 'vitest';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { type CallOptions, type World, callOn, memberOf, signInTo, worlds } from './console-world.fixture.ts';
import { type WorkerEnv, readConfig } from './env.ts';
import { GITHUB_STAGES, readRsaPrivateKey } from './github.ts';
import {
  type GithubApp,
  MAX_LISTED_REPOSITORIES,
  createGithubApp,
  openInstallation,
  readGithubRepository,
  sealInstallation,
} from './github-connector.ts';
import { createMemoryKv } from './kv.ts';
import { open } from './secrets.ts';
import { envWith } from './auth-worker.fixture.ts';

/**
 * The `github` connector of a workspace (FRU-359), against a GitHub on a port of this machine.
 *
 * The fake answers over HTTP, so each assertion reads a request that the worker really sent. It
 * binds each token to the repositories it was asked for, as GitHub does: a token used on another
 * repository gets `404`. The routes and the fields follow the REST documentation, version 2022-11-28.
 */

const SECRETS_KEY = 'a-secret-that-opens-the-connectors-of-github';
const opened = worlds();

const { privateKey: PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const APP = {
  appId: '5409420',
  clientId: 'Iv23liFruitback',
  clientSecret: 'the-client-secret',
  privateKey: readRsaPrivateKey(PEM) as NonNullable<ReturnType<typeof readRsaPrivateKey>>,
};

type Seen = { method: string; path: string; query: URLSearchParams; authorization: string; body: unknown };
type Issue = Record<string, unknown> & { number: number; state: string; state_reason: string | null };

/** What an answer of the fake can be changed to, for one request. */
type Override = (call: Seen) => { status: number; body: unknown; headers?: Record<string, string> } | undefined;

const servers: { close(): void }[] = [];
afterAll(() => {
  for (const server of servers) server.close();
});

/** `public`: the repositories that anybody reads. The others are private. */
type Installation = { owner: string; repositories: string[]; public?: string[] };

/**
 * What GitHub gives a token that asks for no permission: the permissions of the App. `page`: the
 * repositories of one page of `/installation/repositories`, fewer than GitHub gives, so a second
 * page exists.
 */
const APP_PERMISSIONS = { issues: 'write', metadata: 'read' };

/**
 * Each fake by its address, so that `tenant` forgets the calls of its setup: the check of each
 * repository when its destination is written (FRU-382). The tests of a note read the calls of the note.
 */
const fakes = new Map<string, { forget(): void }>();

async function fakeGithub(installations: Record<number, Installation>, page = 2) {
  const calls: Seen[] = [];
  const bound = new Map<string, string[]>();
  const permitted = new Map<string, Record<string, string>>();
  const installationOf = new Map<string, number>();
  const issues = new Map<string, Issue[]>();
  const labels = new Map<string, Set<string>>();
  let minted = 0;
  /** The tokens given since the last `forget`, in order. */
  const given: string[] = [];
  let override: Override = () => undefined;

  async function answer(call: Seen): Promise<{ status: number; body: unknown; headers?: Record<string, string> }> {
    const changed = override(call);
    if (changed !== undefined) return changed;

    const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(call.path);
    if (mint !== null && call.method === 'POST') {
      if (call.authorization.split('.').length !== 3) return { status: 401, body: { message: 'A JSON web token' } };
      const installation = installations[Number(mint[1])];
      if (installation === undefined) return { status: 404, body: { message: 'Not Found' } };
      const asked = (call.body as { repositories?: string[] } | undefined)?.repositories;
      // With no list, GitHub gives a token for every repository of the installation.
      const names = asked ?? installation.repositories;
      if (names.some((name) => !installation.repositories.includes(name))) {
        return {
          status: 422,
          body: {
            message:
              'There is at least one repository that does not exist or is not accessible to the parent installation.',
          },
        };
      }
      minted += 1;
      const token = `ghs_${minted}`;
      const permissions = (call.body as { permissions?: Record<string, string> } | undefined)?.permissions;
      bound.set(
        token,
        names.map((name) => `${installation.owner}/${name}`),
      );
      permitted.set(token, permissions ?? APP_PERMISSIONS);
      given.push(token);
      installationOf.set(token, Number(mint[1]));

      return {
        status: 201,
        body: {
          token,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          permissions: permissions ?? APP_PERMISSIONS,
          repositories: names.map((name) => ({ name, full_name: `${installation.owner}/${name}` })),
        },
      };
    }

    if (call.path === '/installation/repositories' && call.method === 'GET') {
      const token = call.authorization.replace(/^Bearer /, '');
      const installation = installations[installationOf.get(token) ?? 0];
      if (installation === undefined) return { status: 401, body: { message: 'Bad credentials' } };
      const all = (bound.get(token) ?? []).map((fullName) => ({
        full_name: fullName,
        private: !(installation.public ?? []).includes(fullName.split('/')[1] as string),
      }));
      const size = Math.min(page, Number(call.query.get('per_page') ?? '30'));
      const at = Number(call.query.get('page') ?? '1');

      return { status: 200, body: { total_count: all.length, repositories: all.slice((at - 1) * size, at * size) } };
    }

    const scoped = /^\/repos\/([^/]+\/[^/]+)(?:\/(.*))?$/.exec(call.path);
    if (scoped === null) return { status: 404, body: { message: 'Not Found' } };
    const repository = scoped[1] as string;
    const reach = bound.get(call.authorization.replace(/^Bearer /, '')) ?? [];
    if (!reach.includes(repository)) return { status: 404, body: { message: 'Not Found' } };
    const rest = scoped[2] ?? '';
    // FRU-382: the repository itself, which any token that reaches it reads (its metadata).
    if (rest === '' && call.method === 'GET') {
      const owner = Object.values(installations).find((each) => each.owner === repository.split('/')[0]);
      const name = repository.split('/')[1] as string;

      return { status: 200, body: { full_name: repository, private: !(owner?.public ?? []).includes(name) } };
    }
    // A token with the metadata only reads the repository, and writes nothing in it.
    const may = permitted.get(call.authorization.replace(/^Bearer /, '')) ?? {};
    if (rest.startsWith('issues') || rest.startsWith('labels')) {
      if (may.issues === undefined || (call.method !== 'GET' && may.issues !== 'write')) {
        return { status: 403, body: { message: 'Resource not accessible by integration' } };
      }
    }

    if (rest === 'labels' && call.method === 'POST') {
      const kept = labels.get(repository) ?? new Set<string>();
      labels.set(repository, kept);
      const name = (call.body as { name: string }).name;
      if (kept.has(name)) return { status: 422, body: { errors: [{ code: 'already_exists' }] } };
      kept.add(name);

      return { status: 201, body: { name } };
    }
    if (rest === 'issues' && call.method === 'POST') {
      const list = issues.get(repository) ?? [];
      issues.set(repository, list);
      const { title, body, labels: names } = call.body as { title: string; body: string; labels: string[] };
      const number = list.length + 1;
      const issue: Issue = {
        id: 9000 + number,
        number,
        html_url: `https://github.com/${repository}/issues/${number}`,
        title,
        body,
        state: 'open',
        state_reason: null,
        updated_at: '2026-10-21T10:00:00Z',
        comments: 0,
        labels: names.map((name) => ({ name })),
      };
      list.push(issue);

      return { status: 201, body: issue };
    }
    if (rest === 'issues' && call.method === 'GET') {
      const wanted = (call.query.get('labels') ?? '').split(',').filter(Boolean);
      const rows = (issues.get(repository) ?? []).filter((issue) =>
        wanted.every((name) => (issue.labels as { name: string }[]).some((label) => label.name === name)),
      );

      return { status: 200, body: rows };
    }
    if (/^issues\/\d+\/comments$/.test(rest)) return { status: 200, body: [] };

    return { status: 404, body: { message: 'Not Found' } };
  }

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://github.test');
      const text = Buffer.concat(chunks).toString('utf8');
      const call: Seen = {
        method: request.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        authorization: request.headers.authorization ?? '',
        body: text === '' ? undefined : JSON.parse(text),
      };
      calls.push(call);
      void answer(call).then(({ status, body, headers }) => {
        response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        response.end(JSON.stringify(body));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  fakes.set(api, {
    forget: () => {
      calls.length = 0;
      given.length = 0;
    },
  });

  return {
    api,
    calls,
    issues,
    /** The tokens each mint asked for, in order: the `repositories` of each request. */
    mints: () =>
      calls
        .filter((call) => call.path.endsWith('/access_tokens'))
        .map((call) => ({ installation: call.path.split('/')[3], body: call.body })),
    /** The repositories each call outside the mints went to. */
    repositories: () =>
      calls.filter((call) => call.path.startsWith('/repos/')).map((call) => call.path.split('/').slice(2, 4).join('/')),
    /** The calls of the list of the repositories of an installation. */
    listings: () => calls.filter((call) => call.path === '/installation/repositories'),
    /** The token that GitHub gave to each mint, in order. */
    minted: () => [...given],
    /** Which repositories a token of a call reaches. */
    reach: (call: Seen) => bound.get(call.authorization.replace(/^Bearer /, '')) ?? [],
    answerWith(changed: Override) {
      override = changed;
    },
  };
}

function call(world: World, githubApp: GithubApp, method: string, path: string, options: CallOptions = {}) {
  return callOn(world, method, path, options, { kv: createMemoryKv(), githubApp });
}

/** A workspace with a `github` connector of `installation`, and one site per repository, set through the console. */
async function tenant(world: World, githubApp: GithubApp, installation: number, repositories: string[]) {
  const { accounts } = world;
  const { id, token } = await signInTo(world, `owner-${installation}@acme.dev`);
  const workspace = await accounts.createWorkspace('Acme', id);
  const connector = await accounts.addConnector(workspace.id, {
    kind: 'github',
    label: 'GitHub · acme',
    sealed: sealInstallation(installation, SECRETS_KEY),
  });
  const base = `/console/workspaces/${workspace.id}`;
  const sites = [];
  for (const [index, repository] of repositories.entries()) {
    const origin = `https://site-${index}.acme.dev`;
    const site = await accounts.addSite(workspace.id, { origin, visibility: 'everyone', writers: 'anyone' });
    const set = await call(world, githubApp, 'POST', `${base}/sites/${site.id}/destinations`, {
      token,
      body: { destinations: [{ connector: connector.id, repository }] },
    });
    assert.equal(set.status, 200, await set.clone().text());
    const page = `${origin}/pricing`;
    sites.push({
      site,
      write: (note: string) => {
        const base = noteFixture();

        return call(world, githubApp, 'POST', '/feedback', {
          origin,
          body: { ...base, text: note, page: { ...base.page, url: page }, client: { id: site.id } },
        });
      },
      read: async () => {
        const answer = await call(
          world,
          githubApp,
          'GET',
          `/feedback?url=${encodeURIComponent(page)}&client=${site.id}`,
          {
            origin,
          },
        );
        assert.equal(answer.status, 200, await answer.clone().text());

        return (await answer.json()) as { stages: string[]; issues: { identifier: string; stage: string }[] };
      },
    });
  }
  const attention = async () =>
    (await accounts.connectors(workspace.id)).find((each) => each.id === connector.id)?.attention?.reason;
  fakes.get(githubApp.api ?? '')?.forget();

  return { accounts, workspace, connector, base, token, sites, attention };
}

async function worldWithGithub(installations: Record<number, Installation>, page?: number) {
  const world = await opened({ env: { FRUITBACK_SECRETS_KEY: SECRETS_KEY } });
  const github = await fakeGithub(installations, page);
  const githubApp = createGithubApp(APP, { api: github.api });

  return { world, github, githubApp };
}

describe('the token of a github connector (FRU-359)', () => {
  it('is asked for the repository of the destination only, and the note goes to that repository', async () => {
    const { world, github, githubApp } = await worldWithGithub({
      7: { owner: 'acme', repositories: ['web', 'api', 'secret'] },
    });
    const acme = await tenant(world, githubApp, 7, ['acme/web']);

    const written = await acme.sites[0]?.write('The price is wrong.');
    assert.equal(written?.status, 201, written === undefined ? '' : await written.clone().text());

    assert.deepEqual(github.mints(), [{ installation: '7', body: { repositories: ['web'] } }]);
    assert.deepEqual([...new Set(github.repositories())], ['acme/web']);
    for (const each of github.calls.filter((one) => one.path.startsWith('/repos/'))) {
      assert.deepEqual(github.reach(each), ['acme/web']);
    }
    assert.equal(github.issues.get('acme/web')?.length, 1);
    assert.equal(github.issues.get('acme/api'), undefined);
  });

  it('is never served for another repository, and is kept for its own', async () => {
    const { world, github, githubApp } = await worldWithGithub({ 7: { owner: 'acme', repositories: ['web', 'api'] } });
    const acme = await tenant(world, githubApp, 7, ['acme/web', 'acme/api']);
    const [web, api] = acme.sites;

    assert.equal((await web?.write('On the web.'))?.status, 201);
    assert.equal((await api?.write('On the API.'))?.status, 201);
    assert.equal((await web?.write('On the web again.'))?.status, 201);

    // One token per repository: the third note reuses the token of the first.
    assert.deepEqual(
      github.mints().map((mint) => mint.body),
      [{ repositories: ['web'] }, { repositories: ['api'] }],
    );
    assert.equal(github.issues.get('acme/web')?.length, 2);
    assert.equal(github.issues.get('acme/api')?.length, 1);
    assert.equal(await acme.attention(), undefined);
  });

  it('keys the tokens by installation too: one repository name in two organisations is two tokens', async () => {
    const { world, github, githubApp } = await worldWithGithub({
      7: { owner: 'acme', repositories: ['web'] },
      8: { owner: 'globex', repositories: ['web'] },
    });
    const acme = await tenant(world, githubApp, 7, ['acme/web']);
    const globex = await tenant(world, githubApp, 8, ['globex/web']);

    assert.equal((await acme.sites[0]?.write('Acme.'))?.status, 201);
    assert.equal((await globex.sites[0]?.write('Globex.'))?.status, 201);

    assert.deepEqual(
      github.mints().map((mint) => mint.installation),
      ['7', '8'],
    );
    assert.equal(github.issues.get('acme/web')?.length, 1);
    assert.equal(github.issues.get('globex/web')?.length, 1);
  });

  it('refuses a token that GitHub gives for another owner, and the connector needs attention', async () => {
    // The installation 7 is of `globex`. A destination `acme/web` would get a token of `globex/web`.
    const { world, github, githubApp } = await worldWithGithub({ 7: { owner: 'globex', repositories: ['web'] } });
    const acme = await tenant(world, githubApp, 7, ['acme/web']);

    assert.equal((await acme.sites[0]?.write('Where does it go?'))?.status, 502);
    assert.deepEqual(github.repositories(), []);
    assert.equal(github.issues.get('globex/web'), undefined);
    assert.equal(await acme.attention(), 'key-lacks-access');
  });
});

describe('a repository that the installation does not cover (FRU-359)', () => {
  it('makes the connector need attention, and no token is asked for another repository', async () => {
    const { world, github, githubApp } = await worldWithGithub({ 7: { owner: 'acme', repositories: ['web'] } });
    const acme = await tenant(world, githubApp, 7, ['acme/secret']);

    assert.equal((await acme.sites[0]?.write('Hidden.'))?.status, 502);
    assert.equal(await acme.attention(), 'key-lacks-access');
    // A read asks again, for the same repository, and for nothing else.
    const read = await callOn(
      world,
      'GET',
      `/feedback?url=${encodeURIComponent(`${acme.sites[0]?.site.origin}/pricing`)}&client=${acme.sites[0]?.site.id}`,
      { origin: acme.sites[0]?.site.origin ?? '' },
      { kv: createMemoryKv(), githubApp },
    );
    assert.equal(read.status, 502);

    assert.deepEqual(
      github.mints().map((mint) => mint.body),
      [{ repositories: ['secret'] }, { repositories: ['secret'] }],
    );
    assert.deepEqual(github.repositories(), []);
  });

  it('makes it need attention when GitHub refuses the issue with 403 or 404, and drops the token', async () => {
    const { world, github, githubApp } = await worldWithGithub({ 7: { owner: 'acme', repositories: ['web'] } });
    const acme = await tenant(world, githubApp, 7, ['acme/web']);
    assert.equal((await acme.sites[0]?.write('First.'))?.status, 201);

    github.answerWith((each) =>
      each.method === 'POST' && each.path === '/repos/acme/web/issues'
        ? { status: 403, body: { message: 'Resource not accessible by integration' } }
        : undefined,
    );
    assert.equal((await acme.sites[0]?.write('Second.'))?.status, 502);
    assert.equal(await acme.attention(), 'key-lacks-access');

    // The token went with the refusal: the next note asks a new one, for the same repository.
    github.answerWith(() => undefined);
    assert.equal((await acme.sites[0]?.write('Third.'))?.status, 201);
    assert.deepEqual(
      github.mints().map((mint) => mint.body),
      [{ repositories: ['web'] }, { repositories: ['web'] }],
    );
    assert.equal(await acme.attention(), undefined);
  });

  it('says nothing of the connector for a rate limit, which is a 403 too', async () => {
    const { world, github, githubApp } = await worldWithGithub({ 7: { owner: 'acme', repositories: ['web'] } });
    const acme = await tenant(world, githubApp, 7, ['acme/web']);
    github.answerWith((each) =>
      each.method === 'POST' && each.path === '/repos/acme/web/issues'
        ? {
            status: 403,
            body: { message: 'You have exceeded a secondary rate limit' },
            headers: { 'retry-after': '60' },
          }
        : undefined,
    );

    assert.equal((await acme.sites[0]?.write('Too fast.'))?.status, 502);
    assert.equal(await acme.attention(), undefined);
  });

  it('says the connection ended for an installation that GitHub does not know', async () => {
    const { world, githubApp } = await worldWithGithub({ 7: { owner: 'acme', repositories: ['web'] } });
    const acme = await tenant(world, githubApp, 99, ['acme/web']);

    assert.equal((await acme.sites[0]?.write('Gone.'))?.status, 502);
    assert.equal(await acme.attention(), 'connection-ended');
  });
});

describe('a note through a github connector (FRU-359)', () => {
  it('is an issue of the repository, and its state reads back as one of the three stages', async () => {
    const { world, github, githubApp } = await worldWithGithub({ 7: { owner: 'acme', repositories: ['web'] } });
    const acme = await tenant(world, githubApp, 7, ['acme/web']);
    const site = acme.sites[0];
    assert.equal((await site?.write('The logo is cut.'))?.status, 201);

    const first = await site?.read();
    assert.deepEqual(first?.stages, [...GITHUB_STAGES]);
    assert.deepEqual(
      first?.issues.map((issue) => [issue.identifier, issue.stage]),
      [['#1', 'new']],
    );

    const issue = github.issues.get('acme/web')?.[0] as Issue;
    issue.state = 'closed';
    issue.state_reason = 'not_planned';
    assert.deepEqual(
      (await site?.read())?.issues.map((each) => each.stage),
      ['closed'],
    );
    issue.state_reason = 'completed';
    assert.deepEqual(
      (await site?.read())?.issues.map((each) => each.stage),
      ['done'],
    );
  });

  it('leaves the installation id alone in the sealed value: no token reaches the database', async () => {
    const { world, github, githubApp } = await worldWithGithub({ 7: { owner: 'acme', repositories: ['web'] } });
    const acme = await tenant(world, githubApp, 7, ['acme/web']);
    assert.equal((await acme.sites[0]?.write('Kept where?'))?.status, 201);
    assert.equal((await acme.sites[0]?.read())?.issues.length, 1);
    assert.ok(github.mints().length > 0);

    const kept = await acme.accounts.sealedKey(acme.connector.id);
    assert.equal(open(kept?.sealed ?? '', SECRETS_KEY), '7');
    assert.equal(openInstallation(kept?.sealed ?? '', SECRETS_KEY), 7);
  });
});

describe('the destination of a github connector, in the console (FRU-359)', () => {
  it('takes a repository owner/name, in lower case, and labels it with its name', async () => {
    const { world, githubApp } = await worldWithGithub({});
    const acme = await tenant(world, githubApp, 7, ['Acme/Web']);
    const [site] = await acme.accounts.sites(acme.workspace.id);

    assert.deepEqual(site?.destinations, [
      { connector: acme.connector.id, teamId: 'acme/web', label: 'GitHub · acme/web' },
    ]);
  });

  it('refuses what is not a repository, and a team or a project beside one', async () => {
    const { world, githubApp } = await worldWithGithub({});
    const acme = await tenant(world, githubApp, 7, []);
    const site = await acme.accounts.addSite(acme.workspace.id, {
      origin: 'https://x.acme.dev',
      visibility: 'everyone',
    });
    const refused = [
      { repository: 'acme' },
      { repository: 'acme/web/issues' },
      { repository: 'acme/..' },
      { repository: 'acme/.' },
      { repository: '../web' },
      { repository: '-acme/web' },
      { repository: 'acme-/web' },
      { repository: 'ac--me/web' },
      { repository: `${'a'.repeat(40)}/web` },
      { repository: `acme/${'w'.repeat(101)}` },
      { repository: 'acme/web?x=1' },
      { repository: 'acme/we b' },
      { repository: 42 },
      {},
      { repository: 'acme/web', teamId: 'team_design' },
      { repository: 'acme/web', projectId: 'proj_1' },
    ];
    for (const fields of refused) {
      const answer = await call(world, githubApp, 'POST', `${acme.base}/sites/${site.id}/destinations`, {
        token: acme.token,
        body: { destinations: [{ connector: acme.connector.id, ...fields }] },
      });
      assert.equal(answer.status, 400, JSON.stringify(fields));
    }
    const kept = (await acme.accounts.sites(acme.workspace.id)).find((each) => each.id === site.id);
    assert.deepEqual(kept?.destinations, []);

    // The control: the same route takes a repository.
    const taken = await call(world, githubApp, 'POST', `${acme.base}/sites/${site.id}/destinations`, {
      token: acme.token,
      body: { destinations: [{ connector: acme.connector.id, repository: `${'a'.repeat(39)}/${'w'.repeat(100)}` }] },
    });
    assert.equal(taken.status, 200, await taken.clone().text());
  });

  it('refuses the same repository twice, whatever its case', async () => {
    const { world, githubApp } = await worldWithGithub({});
    const acme = await tenant(world, githubApp, 7, []);
    const site = await acme.accounts.addSite(acme.workspace.id, {
      origin: 'https://x.acme.dev',
      visibility: 'everyone',
    });
    const answer = await call(world, githubApp, 'POST', `${acme.base}/sites/${site.id}/destinations`, {
      token: acme.token,
      body: {
        destinations: [
          { connector: acme.connector.id, repository: 'acme/web' },
          { connector: acme.connector.id, repository: 'ACME/Web' },
        ],
      },
    });
    assert.equal(answer.status, 400);
    assert.deepEqual(await answer.json(), { error: 'duplicate-destination' });
  });

  it('reads a repository strictly', () => {
    assert.equal(readGithubRepository(' Sakuga-Software/Fruitback '), 'sakuga-software/fruitback');
    assert.equal(readGithubRepository('a/b.c_d-e'), 'a/b.c_d-e');
    assert.equal(readGithubRepository('a/..'), undefined);
    assert.equal(readGithubRepository('a/b/c'), undefined);
  });
});

/** `GET …/connectors/<id>/repositories`, as the console asks it. */
async function listed(world: World, githubApp: GithubApp, base: string, connector: string, token: string) {
  return call(world, githubApp, 'GET', `${base}/connectors/${connector}/repositories`, { token });
}

describe('the repositories of a github connector, for a destination (FRU-361)', () => {
  it('lists every page, with a token that asks for the metadata only and for no repository', async () => {
    const { world, github, githubApp } = await worldWithGithub({
      7: { owner: 'acme', repositories: ['web', 'api', 'docs', 'site', 'blog'], public: ['site'] },
    });
    const acme = await tenant(world, githubApp, 7, []);

    const answer = await listed(world, githubApp, acme.base, acme.connector.id, acme.token);
    assert.equal(answer.status, 200, await answer.clone().text());
    assert.deepEqual(await answer.json(), {
      repositories: [
        { fullName: 'acme/web', private: true },
        { fullName: 'acme/api', private: true },
        { fullName: 'acme/docs', private: true },
        { fullName: 'acme/site', private: false },
        { fullName: 'acme/blog', private: true },
      ],
    });
    // The body whole: no `repositories` beside the permission, and no other permission.
    assert.deepEqual(github.mints(), [{ installation: '7', body: { permissions: { metadata: 'read' } } }]);
    assert.deepEqual(
      github.listings().map((each) => each.query.get('page')),
      ['1', '2', '3'],
    );
  });

  it('stops at MAX_LISTED_REPOSITORIES, and asks no page after', async () => {
    const names = Array.from({ length: MAX_LISTED_REPOSITORIES + 5 }, (_, index) => `repo-${index}`);
    const { world, github, githubApp } = await worldWithGithub({ 7: { owner: 'acme', repositories: names } }, 100);
    const acme = await tenant(world, githubApp, 7, []);

    const answer = await listed(world, githubApp, acme.base, acme.connector.id, acme.token);
    const { repositories } = (await answer.json()) as { repositories: unknown[] };
    assert.equal(repositories.length, MAX_LISTED_REPOSITORIES);
    assert.equal(github.listings().length, MAX_LISTED_REPOSITORIES / 100);
  });

  it('never gives the token of the list to an issue: a note asks its own, for its repository', async () => {
    const { world, github, githubApp } = await worldWithGithub({ 7: { owner: 'acme', repositories: ['web', 'api'] } });
    const acme = await tenant(world, githubApp, 7, ['acme/web']);

    assert.equal((await listed(world, githubApp, acme.base, acme.connector.id, acme.token)).status, 200);
    const [listing] = github.minted();
    assert.equal((await acme.sites[0]?.write('After the list.'))?.status, 201);

    assert.deepEqual(
      github.mints().map((mint) => mint.body),
      [{ permissions: { metadata: 'read' } }, { repositories: ['web'] }],
    );
    const repositoryCalls = github.calls.filter((each) => each.path.startsWith('/repos/'));
    assert.ok(repositoryCalls.length > 0, 'the control: the calls of the note are read');
    for (const each of repositoryCalls) {
      assert.notEqual(each.authorization, `Bearer ${listing}`);
      assert.deepEqual(github.reach(each), ['acme/web']);
    }
    // And the list again mints again: no cache holds its token.
    assert.equal((await listed(world, githubApp, acme.base, acme.connector.id, acme.token)).status, 200);
    assert.equal(github.mints().length, 3);
  });

  it('refuses a token that GitHub gives with more than the metadata, and lists nothing with it', async () => {
    const { world, github, githubApp } = await worldWithGithub({ 7: { owner: 'acme', repositories: ['web'] } });
    const acme = await tenant(world, githubApp, 7, []);
    github.answerWith((each) =>
      each.path.endsWith('/access_tokens')
        ? {
            status: 201,
            body: {
              token: 'ghs_wide',
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
              permissions: { metadata: 'read', issues: 'write' },
            },
          }
        : undefined,
    );

    const answer = await listed(world, githubApp, acme.base, acme.connector.id, acme.token);
    assert.equal(answer.status, 502);
    assert.deepEqual(github.listings(), []);
    // The control: the same answer with the metadata alone lists.
    github.answerWith(() => undefined);
    assert.equal((await listed(world, githubApp, acme.base, acme.connector.id, acme.token)).status, 200);
  });

  it('answers an owner or an admin, and refuses a member', async () => {
    const { world, githubApp } = await worldWithGithub({ 7: { owner: 'acme', repositories: ['web'] } });
    const acme = await tenant(world, githubApp, 7, []);
    const admin = await signInTo(world, 'admin@acme.dev');
    await memberOf(world, acme.workspace.id, admin.id, 'admin');
    const member = await signInTo(world, 'member@acme.dev');
    await memberOf(world, acme.workspace.id, member.id, 'member');

    assert.equal((await listed(world, githubApp, acme.base, acme.connector.id, admin.token)).status, 200);
    const refused = await listed(world, githubApp, acme.base, acme.connector.id, member.token);
    assert.equal(refused.status, 403);
  });

  it('answers 404 for a connector of another workspace, of another kind, or that does not exist', async () => {
    const { world, github, githubApp } = await worldWithGithub({
      7: { owner: 'acme', repositories: ['web'] },
      8: { owner: 'globex', repositories: ['secret'] },
    });
    const acme = await tenant(world, githubApp, 7, []);
    const globex = await tenant(world, githubApp, 8, []);
    const linear = await acme.accounts.addConnector(acme.workspace.id, {
      kind: 'linear',
      label: 'Linear',
      sealed: 'not-opened',
    });

    const unknown = await listed(world, githubApp, acme.base, 'con_nobody', acme.token);
    assert.equal(unknown.status, 404);
    const expected = await unknown.json();
    for (const id of [globex.connector.id, linear.id]) {
      const answer = await listed(world, githubApp, acme.base, id, acme.token);
      assert.equal(answer.status, 404);
      assert.deepEqual(await answer.json(), expected);
    }
    assert.deepEqual(github.mints(), [], 'no token of the installation of globex');
    // The control: globex lists its own.
    assert.equal((await listed(world, githubApp, globex.base, globex.connector.id, globex.token)).status, 200);
  });

  it('says the connection ended for an installation that is gone, and a list that comes back ends it', async () => {
    const installations: Record<number, Installation> = { 7: { owner: 'acme', repositories: ['web'] } };
    const { world, githubApp } = await worldWithGithub(installations);
    const acme = await tenant(world, githubApp, 99, []);

    assert.equal((await listed(world, githubApp, acme.base, acme.connector.id, acme.token)).status, 502);
    assert.equal(await acme.attention(), 'connection-ended');

    installations[99] = { owner: 'acme', repositories: ['web'] };
    assert.equal((await listed(world, githubApp, acme.base, acme.connector.id, acme.token)).status, 200);
    assert.equal(await acme.attention(), undefined);
  });

  it('keeps « key-lacks-access »: a list says nothing of the repository of a destination', async () => {
    const { world, githubApp } = await worldWithGithub({ 7: { owner: 'acme', repositories: ['web'] } });
    const acme = await tenant(world, githubApp, 7, ['acme/secret']);
    assert.equal((await acme.sites[0]?.write('Hidden.'))?.status, 502);
    assert.equal(await acme.attention(), 'key-lacks-access');

    assert.equal((await listed(world, githubApp, acme.base, acme.connector.id, acme.token)).status, 200);
    assert.equal(await acme.attention(), 'key-lacks-access');
  });
});

/** The destinations of a site, as `GET …/sites` answers them to `token`. */
async function destinationsSeen(world: World, githubApp: GithubApp, base: string, token: string) {
  const answer = await call(world, githubApp, 'GET', `${base}/sites`, { token });
  assert.equal(answer.status, 200, await answer.clone().text());

  return ((await answer.json()) as { sites: { destinations?: Record<string, unknown>[] }[] }).sites.map(
    (site) => site.destinations,
  );
}

describe('whether the repository of a github destination is private (FRU-382)', () => {
  it('learns it when the destination is written, with a token of that repository alone that reads the metadata only', async () => {
    const { world, github, githubApp } = await worldWithGithub({
      7: { owner: 'acme', repositories: ['web', 'docs'], public: ['docs'] },
    });
    const acme = await tenant(world, githubApp, 7, []);
    const site = await acme.accounts.addSite(acme.workspace.id, {
      origin: 'https://x.acme.dev',
      visibility: 'everyone',
    });

    const set = await call(world, githubApp, 'POST', `${acme.base}/sites/${site.id}/destinations`, {
      token: acme.token,
      // What a request says of it is not read: GitHub says it.
      body: {
        destinations: [
          { connector: acme.connector.id, repository: 'acme/web', private: false },
          { connector: acme.connector.id, repository: 'acme/docs' },
        ],
      },
    });

    assert.equal(set.status, 200, await set.clone().text());
    assert.deepEqual(
      ((await set.json()) as { destinations: { private?: boolean }[] }).destinations.map((each) => each.private),
      [true, false],
    );
    // The body whole: the repository, and the metadata only.
    assert.deepEqual(
      github.mints().map((mint) => mint.body),
      [
        { repositories: ['web'], permissions: { metadata: 'read' } },
        { repositories: ['docs'], permissions: { metadata: 'read' } },
      ],
    );
    for (const each of github.calls.filter((one) => one.path.startsWith('/repos/'))) {
      assert.deepEqual(github.reach(each), [each.path.slice('/repos/'.length)]);
    }

    // A member reads it with the destinations, as an owner does; a guest reads no destination.
    const member = await signInTo(world, 'member@acme.dev');
    await memberOf(world, acme.workspace.id, member.id, 'member');
    for (const token of [acme.token, member.token]) {
      assert.deepEqual(
        (await destinationsSeen(world, githubApp, acme.base, token)).map((places) => places?.map((one) => one.private)),
        [[true, false]],
      );
    }
    const guest = await signInTo(world, 'guest@client.fr');
    await memberOf(world, acme.workspace.id, guest.id, 'guest');
    assert.deepEqual(await destinationsSeen(world, githubApp, acme.base, guest.token), []);
  });

  it('writes the destination when GitHub does not say, and keeps nothing of it', async () => {
    const { world, github, githubApp } = await worldWithGithub({ 7: { owner: 'acme', repositories: ['web'] } });
    const acme = await tenant(world, githubApp, 7, []);
    const site = await acme.accounts.addSite(acme.workspace.id, {
      origin: 'https://x.acme.dev',
      visibility: 'everyone',
    });
    // A body that says the repository is public: only GitHub says it (review of #509).
    const write = (repository: string) =>
      call(world, githubApp, 'POST', `${acme.base}/sites/${site.id}/destinations`, {
        token: acme.token,
        body: { destinations: [{ connector: acme.connector.id, repository, private: false }] },
      });

    // GitHub does not answer the read of the repository.
    github.answerWith((each) => (each.path === '/repos/acme/web' ? { status: 502, body: {} } : undefined));
    assert.equal((await write('acme/web')).status, 200);
    assert.equal((await acme.accounts.sites(acme.workspace.id))[0]?.destinations[0]?.private, undefined);
    // A token with more than the metadata is not used.
    github.answerWith((each) =>
      each.path.endsWith('/access_tokens')
        ? {
            status: 201,
            body: {
              token: 'ghs_wide',
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
              permissions: { metadata: 'read', issues: 'write' },
              repositories: [{ name: 'web', full_name: 'acme/web' }],
            },
          }
        : undefined,
    );
    assert.equal((await write('acme/web')).status, 200);
    assert.equal(github.calls.filter((each) => each.authorization === 'Bearer ghs_wide').length, 0);
    // A repository that the installation does not cover: GitHub is asked again when a note goes.
    github.answerWith(() => undefined);
    assert.equal((await write('acme/gone')).status, 200);

    const [kept] = await acme.accounts.sites(acme.workspace.id);
    assert.deepEqual(kept?.destinations, [
      { connector: acme.connector.id, teamId: 'acme/gone', label: 'GitHub · acme/gone' },
    ]);
  });

  it('learns it again when a note goes: a repository that turned public is said at once', async () => {
    const installation: Installation = { owner: 'acme', repositories: ['web'] };
    const { world, github, githubApp } = await worldWithGithub({ 7: installation });
    const acme = await tenant(world, githubApp, 7, ['acme/web']);
    const privacy = async () => (await acme.accounts.sites(acme.workspace.id))[0]?.destinations[0]?.private;
    assert.equal(await privacy(), true);

    installation.public = ['web'];
    assert.equal((await acme.sites[0]?.write('Now in the open.'))?.status, 201);

    assert.equal(await privacy(), false);
    // Read with the token of the note: it reaches that repository alone.
    const read = github.calls.find((each) => each.path === '/repos/acme/web');
    assert.ok(read !== undefined);
    assert.deepEqual(github.reach(read), ['acme/web']);
  });

  it('costs the note nothing when GitHub does not say it then', async () => {
    const { world, github, githubApp } = await worldWithGithub({ 7: { owner: 'acme', repositories: ['web'] } });
    const acme = await tenant(world, githubApp, 7, ['acme/web']);
    github.answerWith((each) => (each.path === '/repos/acme/web' ? { status: 500, body: {} } : undefined));

    assert.equal((await acme.sites[0]?.write('Still delivered.'))?.status, 201);
    assert.equal(github.issues.get('acme/web')?.length, 1);
    assert.equal((await acme.accounts.sites(acme.workspace.id))[0]?.destinations[0]?.private, true);
  });
});

describe('FRUITBACK_GITHUB_CONNECTOR and its key, in env.ts (FRU-359)', () => {
  const base: Partial<WorkerEnv> = { FRUITBACK_SECRETS_KEY: SECRETS_KEY };
  const both = {
    FRUITBACK_GITHUB_CONNECTOR: '5409420:Iv23liFruitback:the-client-secret',
    FRUITBACK_GITHUB_CONNECTOR_PRIVATE_KEY: PEM,
  };
  const read = (more: Partial<WorkerEnv>) => readConfig(envWith({ ...base, ...more }));
  const missing = (more: Partial<WorkerEnv>) => {
    const result = read(more);

    return result.ok ? [] : result.missing;
  };

  it('refuses one variable without the other, and names the one that is absent', () => {
    const noKey = missing({ FRUITBACK_GITHUB_CONNECTOR: both.FRUITBACK_GITHUB_CONNECTOR });
    assert.equal(noKey.length, 1);
    assert.match(noKey[0] ?? '', /^FRUITBACK_GITHUB_CONNECTOR_PRIVATE_KEY \(/);
    assert.match(noKey[0] ?? '', /set the two, or neither/);

    const noApp = missing({ FRUITBACK_GITHUB_CONNECTOR_PRIVATE_KEY: PEM });
    assert.equal(noApp.length, 1);
    assert.match(noApp[0] ?? '', /^FRUITBACK_GITHUB_CONNECTOR \(/);
    assert.match(noApp[0] ?? '', /set the two, or neither/);
  });

  it('accepts both, with the line breaks of the PEM as they are, or written as \\n on one line', () => {
    for (const pem of [PEM, PEM.replace(/\n/g, '\\n')]) {
      const result = read({ ...both, FRUITBACK_GITHUB_CONNECTOR_PRIVATE_KEY: pem });
      assert.ok(result.ok, JSON.stringify(result));
      assert.equal(result.config.githubConnector?.appId, '5409420');
      assert.equal(result.config.githubConnector?.clientId, 'Iv23liFruitback');
      assert.equal(result.config.githubConnector?.privateKey.asymmetricKeyType, 'rsa');
    }
    // The control: neither is a worker with no GitHub App.
    const without = read({});
    assert.ok(without.ok);
    assert.equal(without.config.githubConnector, undefined);
  });

  it('refuses a value that is not three parts, or a key that is not RSA, and quotes neither', () => {
    for (const value of ['5409420:Iv23li', 'app:Iv23li:secret', '5409420::secret', '5409420:a:b:c']) {
      const said = missing({ ...both, FRUITBACK_GITHUB_CONNECTOR: value });
      assert.equal(said.length, 1, value);
      assert.match(said[0] ?? '', /^FRUITBACK_GITHUB_CONNECTOR \(<app id>/);
      assert.ok(!said[0]?.includes(value), value);
    }
    const { privateKey: ec } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    for (const key of ['not a key', ec]) {
      const said = missing({ ...both, FRUITBACK_GITHUB_CONNECTOR_PRIVATE_KEY: key });
      assert.equal(said.length, 1);
      assert.match(said[0] ?? '', /^FRUITBACK_GITHUB_CONNECTOR_PRIVATE_KEY \(an RSA private key/);
      assert.ok(!said[0]?.includes(key));
    }
  });

  it('needs FRUITBACK_SECRETS_KEY to seal an installation', () => {
    const said = readConfig(envWith({ ...both }));
    assert.equal(said.ok, false);
    assert.match(said.ok ? '' : (said.missing[0] ?? ''), /FRUITBACK_SECRETS_KEY \(FRUITBACK_GITHUB_CONNECTOR connects/);
  });

  it('is another App than the one of the store github, and both can be set', () => {
    const store: Record<string, string> = {
      FRUITBACK_STORE: 'github',
      FRUITBACK_GITHUB_APP_ID: '12345',
      FRUITBACK_GITHUB_PRIVATE_KEY: PEM,
      FRUITBACK_GITHUB_REPOSITORY: 'acme/site',
    };
    const result = read({ ...both, ...store });
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.config.store.provider, 'github');
    assert.equal(result.config.githubConnector?.appId, '5409420');
  });
});
