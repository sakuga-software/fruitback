import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, it } from 'vitest';
import { seedFixture } from '@fruitback/shared/seed.fixture';
import { type CallOptions, type World, callOn, signInTo, worlds } from './console-world.fixture.ts';
import { type WorkerEnv, readConfig } from './env.ts';
import { GITHUB_STAGES, readRsaPrivateKey } from './github.ts';
import {
  type GithubApp,
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

async function fakeGithub(installations: Record<number, { owner: string; repositories: string[] }>) {
  const calls: Seen[] = [];
  const bound = new Map<string, string[]>();
  const issues = new Map<string, Issue[]>();
  const labels = new Map<string, Set<string>>();
  let minted = 0;
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
      bound.set(
        token,
        names.map((name) => `${installation.owner}/${name}`),
      );

      return {
        status: 201,
        body: {
          token,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          repositories: names.map((name) => ({ name, full_name: `${installation.owner}/${name}` })),
        },
      };
    }

    const scoped = /^\/repos\/([^/]+\/[^/]+)\/(.*)$/.exec(call.path);
    if (scoped === null) return { status: 404, body: { message: 'Not Found' } };
    const repository = scoped[1] as string;
    const reach = bound.get(call.authorization.replace(/^Bearer /, '')) ?? [];
    if (!reach.includes(repository)) return { status: 404, body: { message: 'Not Found' } };
    const rest = scoped[2] as string;

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
        const seed = seedFixture();

        return call(world, githubApp, 'POST', '/feedback', {
          origin,
          body: { ...seed, note, page: { ...seed.page, url: page }, client: { id: site.id } },
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

  return { accounts, workspace, connector, base, token, sites, attention };
}

async function worldWithGithub(installations: Record<number, { owner: string; repositories: string[] }>) {
  const world = await opened({ env: { FRUITBACK_SECRETS_KEY: SECRETS_KEY } });
  const github = await fakeGithub(installations);
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
      [['#1', 'seeded']],
    );

    const issue = github.issues.get('acme/web')?.[0] as Issue;
    issue.state = 'closed';
    issue.state_reason = 'not_planned';
    assert.deepEqual(
      (await site?.read())?.issues.map((each) => each.stage),
      ['composted'],
    );
    issue.state_reason = 'completed';
    assert.deepEqual(
      (await site?.read())?.issues.map((each) => each.stage),
      ['ripe'],
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
