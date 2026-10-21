import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, it } from 'vitest';
import { WORKER as API, CONSOLE, type World, callOn, memberOf, signInTo, worlds } from './console-world.fixture.ts';
import { readRsaPrivateKey } from './github.ts';
import { createGithubApp, openInstallation, sealInstallation } from './github-connector.ts';
import { type Kv, createMemoryKv } from './kv.ts';
import { STATE_TTL_MS } from './oauth-flow.ts';
import { rowsOf } from './postgres.fixture.ts';

/**
 * The installation of the GitHub App on a workspace (FRU-360), against a GitHub on a port of this
 * machine. The fake answers over HTTP, so each assertion reads a request that the worker really sent.
 *
 * A person of the fake reaches a list of installations, and the fake gives it two at a time, as a
 * GitHub that pages. The routes follow the REST documentation, version 2022-11-28, and the user
 * token route of « Generating a user access token for a GitHub App ».
 */

const SECRETS_KEY = 'a-secret-that-opens-the-connectors-of-the-app';
const opened = worlds();

const { privateKey: PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const APP = {
  appId: '5409420',
  clientId: 'Iv23liFruitbackApp',
  clientSecret: 'the-client-secret-of-the-app',
  privateKey: readRsaPrivateKey(PEM) as NonNullable<ReturnType<typeof readRsaPrivateKey>>,
};
const CALLBACK = `${API}/auth/github-app/callback`;
/** What GitHub gives at once. The fake gives fewer, so a second page exists. */
const PAGE = 2;

type Seen = { method: string; path: string; query: URLSearchParams; authorization: string; text: string };
type Override = (call: Seen) => { status: number; body: unknown } | undefined;

const servers: { close(): void }[] = [];
afterAll(() => {
  for (const server of servers) server.close();
});

/** `people`: what each person reaches, by the login of the person. `logins`: the account of each installation. */
async function fakeGithub(people: Record<string, number[]>, logins: Record<number, string>) {
  const calls: Seen[] = [];
  const codes = new Map<string, string>();
  const tokens = new Map<string, string>();
  let issued = 0;
  let override: Override = () => undefined;

  function answer(call: Seen): { status: number; body: unknown } {
    const changed = override(call);
    if (changed !== undefined) return changed;

    if (call.path === '/app' && call.method === 'GET') {
      if (call.authorization.split('.').length !== 3) return { status: 401, body: { message: 'A JSON web token' } };

      return { status: 200, body: { id: 5409420, slug: 'fruitback-app', name: 'Fruitback App' } };
    }
    if (call.path === '/login/oauth/access_token' && call.method === 'POST') {
      const form = new URLSearchParams(call.text);
      if (form.get('client_id') !== APP.clientId || form.get('client_secret') !== APP.clientSecret) {
        return { status: 200, body: { error: 'incorrect_client_credentials' } };
      }
      const person = codes.get(form.get('code') ?? '');
      // GitHub answers a code it refuses with 200 and an error.
      if (person === undefined || form.get('redirect_uri') !== CALLBACK) {
        return { status: 200, body: { error: 'bad_verification_code' } };
      }
      codes.delete(form.get('code') ?? '');
      issued += 1;
      tokens.set(`ghu_user_${issued}`, person);

      return {
        status: 200,
        body: {
          access_token: `ghu_user_${issued}`,
          expires_in: 28_800,
          refresh_token: `ghr_refresh_${issued}`,
          refresh_token_expires_in: 15_897_600,
          scope: '',
          token_type: 'bearer',
        },
      };
    }
    if (call.path === '/user/installations' && call.method === 'GET') {
      const person = tokens.get(call.authorization.replace(/^Bearer /, ''));
      if (person === undefined) return { status: 401, body: { message: 'Bad credentials' } };
      const all = people[person] ?? [];
      const page = Number(call.query.get('page') ?? '1');
      const rows = all.slice((page - 1) * PAGE, page * PAGE);

      return {
        status: 200,
        body: {
          total_count: all.length,
          installations: rows.map((id) => ({ id, app_id: 5409420, account: { login: logins[id] ?? 'nobody' } })),
        },
      };
    }
    if (/^\/app\/installations\/\d+\/access_tokens$/.test(call.path)) {
      return { status: 201, body: { token: 'ghs_minted', expires_at: new Date(Date.now() + 3_600_000).toISOString() } };
    }

    return { status: 404, body: { message: 'Not Found' } };
  }

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://github.test');
      const call: Seen = {
        method: request.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        authorization: request.headers.authorization ?? '',
        text: Buffer.concat(chunks).toString('utf8'),
      };
      calls.push(call);
      const { status, body } = answer(call);
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    base,
    calls,
    /** A code of `person`, as GitHub gives it when the person comes back. */
    codeOf(person: string): string {
      const code = `code-${person}-${codes.size + issued + 1}`;
      codes.set(code, person);

      return code;
    },
    exchanges: () => calls.filter((call) => call.path === '/login/oauth/access_token'),
    listings: () => calls.filter((call) => call.path === '/user/installations'),
    mints: () => calls.filter((call) => call.path.endsWith('/access_tokens')),
    answerWith(changed: Override) {
      override = changed;
    },
  };
}

/** A worker with the App, and a clock for the Kv that holds the tickets and the states. */
async function setUp(people: Record<string, number[]>, logins: Record<number, string>, withApp = true) {
  const world = await opened({ env: { FRUITBACK_SECRETS_KEY: SECRETS_KEY } });
  const github = await fakeGithub(people, logins);
  const githubApp = createGithubApp(APP, { api: github.base, web: github.base });
  const clock = { now: Date.now() };
  const memory = createMemoryKv({ now: () => clock.now });
  const written: string[] = [];
  const kv: Kv = {
    ...memory,
    set: (key, value, ttl) => {
      written.push(`${key}=${value}`);

      return memory.set(key, value, ttl);
    },
  };
  const call = (method: string, path: string, options: { token?: string; body?: unknown; cookie?: string } = {}) => {
    const { cookie, ...rest } = options;

    return callOn(
      world,
      method,
      path,
      { ...rest, ...(cookie === undefined ? {} : { headers: { Cookie: cookie } }) },
      { kv, ...(withApp ? { githubApp } : {}) },
    );
  };

  return { world, github, call, clock, written };
}

type Case = Awaited<ReturnType<typeof setUp>>;

async function workspaceOf(world: World, name: string) {
  const owner = await signInTo(world, `owner@${name.toLowerCase()}.dev`);
  const workspace = await world.accounts.createWorkspace(name, owner.id);

  return { owner, workspace, base: `/console/workspaces/${workspace.id}` };
}

type Tenant = Awaited<ReturnType<typeof workspaceOf>>;

/** The console asks where to go, and the browser goes there: the address at GitHub, and the cookie it left with. */
async function leave({ call }: Case, tenant: Tenant, token = tenant.owner.token) {
  const asked = await call('POST', `${tenant.base}/connectors/github/start`, { token });
  assert.equal(asked.status, 201, await asked.clone().text());
  const { url } = (await asked.json()) as { url: string };
  const started = await call('GET', new URL(url).pathname + new URL(url).search);
  assert.equal(started.status, 302);
  const at = new URL(started.headers.get('Location') as string);
  const cookie = (started.headers.get('Set-Cookie') ?? '').split(';')[0] as string;

  return { ticket: url, at, cookie, state: at.searchParams.get('state') as string };
}

type Left = Awaited<ReturnType<typeof leave>>;

/** GitHub sends the browser back after the installation, with a code of `person`. */
function comeBack(
  { call, github }: Case,
  left: Left,
  person: string,
  installation: number,
  action = 'install',
): Promise<Response> {
  const code = github.codeOf(person);

  return call(
    'GET',
    `/auth/github-app/callback?code=${code}&installation_id=${installation}&setup_action=${action}&state=${left.state}`,
    { cookie: left.cookie },
  );
}

const word = (answer: Response) => new URL(answer.headers.get('Location') as string).searchParams.get('github');

/** Every row of every table of the database, as text. */
async function everyRow(world: World): Promise<string> {
  const tables = await rowsOf(world.database, `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
  let bytes = '';
  for (const { tablename } of tables) {
    const rows = await rowsOf(world.database, `SELECT t::text AS row FROM "${String(tablename)}" AS t`);
    bytes += rows.map((each) => String(each.row)).join('\n');
  }

  return bytes;
}

async function setRole(world: World, workspace: string, account: string, role: string): Promise<void> {
  await rowsOf(
    world.database,
    `DELETE FROM member WHERE "organizationId" = '${workspace}' AND "userId" = '${account}'`,
  );
  await memberOf(world, workspace, account, role);
}

describe('an owner installs the GitHub App on a workspace (FRU-360)', () => {
  it('sends the browser to the installation of the App, with a state bound to the browser', async () => {
    const setup = await setUp({}, {});
    const acme = await workspaceOf(setup.world, 'Acme');
    const left = await leave(setup, acme);

    assert.equal(`${left.at.origin}${left.at.pathname}`, 'https://github.com/apps/fruitback-app/installations/new');
    assert.deepEqual(Object.fromEntries(left.at.searchParams), { state: left.state });
    assert.match(left.cookie, /^fruitback_github_app_state=[\w-]{20,}$/);
    assert.equal(left.cookie.split('=')[1], left.state);

    // The slug is asked once for the process, with the JWT of the App.
    await leave(setup, acme);
    const asked = setup.github.calls.filter((call) => call.path === '/app');
    assert.equal(asked.length, 1);
    assert.equal(asked[0]?.authorization.split('.').length, 3);
  });

  it('attaches an installation that the person reaches, found on the second page, and seals its id', async () => {
    const setup = await setUp({ alice: [11, 12, 7] }, { 7: 'acme', 11: 'alice', 12: 'other' });
    const acme = await workspaceOf(setup.world, 'Acme');
    const back = await comeBack(setup, await leave(setup, acme), 'alice', 7);

    assert.equal(back.status, 302);
    assert.equal(back.headers.get('Location'), `${CONSOLE}/w/${acme.workspace.id}/connectors?github=connected`);
    const [connector] = await setup.world.accounts.connectors(acme.workspace.id);
    assert.equal(connector?.kind, 'github');
    assert.equal(connector?.label, 'GitHub App · acme');
    const kept = await setup.world.accounts.sealedKey(connector?.id as string);
    assert.equal(openInstallation(kept?.sealed as string, SECRETS_KEY), 7);
    assert.deepEqual(
      setup.github.listings().map((call) => call.query.get('page')),
      ['1', '2'],
    );
    assert.deepEqual(setup.github.mints(), [], 'nothing asks for a token of the installation');
  });

  it('sends the client secret to the exchange only, and the user token to the list only', async () => {
    const setup = await setUp({ alice: [7] }, { 7: 'acme' });
    const acme = await workspaceOf(setup.world, 'Acme');
    assert.equal(word(await comeBack(setup, await leave(setup, acme), 'alice', 7)), 'connected');

    const [exchange] = setup.github.exchanges();
    assert.deepEqual(Object.fromEntries(new URLSearchParams(exchange?.text)), {
      client_id: APP.clientId,
      client_secret: APP.clientSecret,
      code: 'code-alice-1',
      redirect_uri: CALLBACK,
    });
    assert.equal(exchange?.authorization, '');
    const elsewhere = setup.github.calls.filter((call) => call !== exchange);
    assert.ok(elsewhere.length >= 2, 'the control: the calls of the slug and of the list are read');
    for (const call of elsewhere) {
      assert.equal(`${call.path}?${call.query}${call.text}${call.authorization}`.includes(APP.clientSecret), false);
    }
    const holding = setup.github.calls.filter((call) => `${call.authorization}${call.text}`.includes('ghu_user_1'));
    assert.deepEqual(
      holding.map((call) => call.path),
      ['/user/installations'],
    );
  });

  it('keeps neither the user token nor its refresh token, and answers neither', async () => {
    const setup = await setUp({ alice: [7] }, { 7: 'acme' });
    const acme = await workspaceOf(setup.world, 'Acme');
    assert.equal(word(await comeBack(setup, await leave(setup, acme), 'alice', 7)), 'connected');
    const [connector] = await setup.world.accounts.connectors(acme.workspace.id);

    const bytes = await everyRow(setup.world);
    assert.ok(bytes.includes(connector?.id as string), 'the control: the row of the connector was read');
    assert.equal(bytes.includes('ghu_user_1') || bytes.includes('ghr_refresh_1'), false);
    const listed = await setup.call('GET', `${acme.base}/connectors`, { token: acme.owner.token });
    const text = await listed.text();
    assert.equal(text.includes('ghu_user_1') || text.includes('ghr_refresh_1'), false);
    assert.equal((JSON.parse(text) as { githubApp: boolean }).githubApp, true);
    // The Kv of the tickets and the states is a table of the database in production.
    assert.ok(
      setup.written.some((each) => each.includes('github-app-state')),
      'the control: the Kv was read',
    );
    assert.equal(
      setup.written.some((each) => each.includes('ghu_') || each.includes('ghr_')),
      false,
    );
  });

  it('installs again on the same workspace: one connector, with its id and its destinations', async () => {
    const setup = await setUp({ alice: [7] }, { 7: 'acme' });
    const acme = await workspaceOf(setup.world, 'Acme');
    assert.equal(word(await comeBack(setup, await leave(setup, acme), 'alice', 7)), 'connected');
    const [first] = await setup.world.accounts.connectors(acme.workspace.id);
    const site = await setup.world.accounts.addSite(acme.workspace.id, {
      origin: 'https://acme.dev',
      visibility: 'members',
    });
    const set = await setup.call('POST', `${acme.base}/sites/${site.id}/destination`, {
      token: acme.owner.token,
      body: { connector: first?.id, repository: 'acme/web' },
    });
    assert.equal(set.status, 200, await set.clone().text());

    assert.equal(word(await comeBack(setup, await leave(setup, acme), 'alice', 7, 'update')), 'connected');

    const after = await setup.world.accounts.connectors(acme.workspace.id);
    assert.deepEqual(
      after.map((each) => each.id),
      [first?.id],
    );
    const [kept] = await setup.world.accounts.sites(acme.workspace.id);
    assert.equal(kept?.destinations[0]?.connector, first?.id);
    assert.equal(kept?.destinations[0]?.teamId, 'acme/web');
  });

  it('attaches another installation beside the first, as a second connector', async () => {
    const setup = await setUp({ alice: [7, 8] }, { 7: 'acme', 8: 'acme-labs' });
    const acme = await workspaceOf(setup.world, 'Acme');
    assert.equal(word(await comeBack(setup, await leave(setup, acme), 'alice', 7)), 'connected');
    assert.equal(word(await comeBack(setup, await leave(setup, acme), 'alice', 8)), 'connected');

    assert.deepEqual(
      (await setup.world.accounts.connectors(acme.workspace.id)).map((each) => each.label),
      ['GitHub App · acme', 'GitHub App · acme-labs'],
    );
  });

  it('says whether the worker has the App, and offers nothing without it', async () => {
    const setup = await setUp({}, {}, false);
    const acme = await workspaceOf(setup.world, 'Acme');
    const listed = await setup.call('GET', `${acme.base}/connectors`, { token: acme.owner.token });
    assert.equal(((await listed.json()) as { githubApp: boolean }).githubApp, false);
    assert.equal(
      (await setup.call('POST', `${acme.base}/connectors/github/start`, { token: acme.owner.token })).status,
      404,
    );
    assert.equal((await setup.call('GET', '/auth/github-app/start?ticket=aaaaaaaaaaaaaaaaaaaaaaaa')).status, 404);
  });
});

describe('an installation_id that the browser says, and the installations that GitHub says (FRU-360)', () => {
  it('refuses the installation of another client, with a valid code of this person', async () => {
    // Installation 99 is of another client, and it exists: a token of it would be given.
    const setup = await setUp({ mallory: [5], victim: [99] }, { 5: 'mallory', 99: 'victim-org' });
    const acme = await workspaceOf(setup.world, 'Acme');
    const back = await comeBack(setup, await leave(setup, acme), 'mallory', 99);

    assert.equal(back.headers.get('Location'), `${CONSOLE}/w/${acme.workspace.id}/connectors?github=refused`);
    assert.deepEqual(await setup.world.accounts.connectors(acme.workspace.id), []);
    assert.deepEqual(setup.github.mints(), []);
    // The control: the whole list of the person was read, and the same flow with their own id attaches it.
    assert.equal(setup.github.listings().length, 1);
    assert.equal(word(await comeBack(setup, await leave(setup, acme), 'mallory', 5)), 'connected');
  });

  it('refuses an installation that another workspace holds, and keeps it where it is', async () => {
    const setup = await setUp({ alice: [7], bob: [7] }, { 7: 'acme' });
    const acme = await workspaceOf(setup.world, 'Acme');
    const globex = await workspaceOf(setup.world, 'Globex');
    assert.equal(word(await comeBack(setup, await leave(setup, acme), 'alice', 7)), 'connected');
    const [held] = await setup.world.accounts.connectors(acme.workspace.id);

    const back = await comeBack(setup, await leave(setup, globex), 'bob', 7);

    assert.equal(back.headers.get('Location'), `${CONSOLE}/w/${globex.workspace.id}/connectors?github=elsewhere`);
    assert.deepEqual(await setup.world.accounts.connectors(globex.workspace.id), []);
    assert.deepEqual(await setup.world.accounts.connectors(acme.workspace.id), [held]);

    // The control: after Acme removes its connector, the installation can feed Globex.
    assert.equal(await setup.world.accounts.removeConnector(acme.workspace.id, held?.id as string), true);
    assert.equal(word(await comeBack(setup, await leave(setup, globex), 'bob', 7)), 'connected');
    assert.equal((await setup.world.accounts.connectors(globex.workspace.id)).length, 1);
  });

  it('goes back with « requested » and writes nothing when an owner of the organisation must approve', async () => {
    const setup = await setUp({ alice: [7] }, { 7: 'acme' });
    const acme = await workspaceOf(setup.world, 'Acme');
    const left = await leave(setup, acme);
    const back = await setup.call('GET', `/auth/github-app/callback?setup_action=request&state=${left.state}`, {
      cookie: left.cookie,
    });

    assert.equal(back.headers.get('Location'), `${CONSOLE}/w/${acme.workspace.id}/connectors?github=requested`);
    assert.deepEqual(await setup.world.accounts.connectors(acme.workspace.id), []);
    assert.deepEqual(setup.github.exchanges(), []);
  });

  it('goes back with « unauthorized-app » and writes nothing when the App asks for no user authorization', async () => {
    const setup = await setUp({ alice: [7] }, { 7: 'acme' });
    const acme = await workspaceOf(setup.world, 'Acme');
    const left = await leave(setup, acme);
    const said = console.error;
    const lines: string[] = [];
    console.error = (...args: unknown[]) => void lines.push(args.join(' '));
    let back: Response;
    try {
      // What GitHub sends when « Request user authorization (OAuth) during installation » is off.
      back = await setup.call(
        'GET',
        `/auth/github-app/callback?installation_id=7&setup_action=install&state=${left.state}`,
        {
          cookie: left.cookie,
        },
      );
    } finally {
      console.error = said;
    }

    assert.equal(back.headers.get('Location'), `${CONSOLE}/w/${acme.workspace.id}/connectors?github=unauthorized-app`);
    assert.deepEqual(await setup.world.accounts.connectors(acme.workspace.id), []);
    assert.deepEqual(setup.github.exchanges(), []);
    assert.ok(
      lines.some((line) => line.includes('Request user authorization (OAuth) during installation')),
      lines.join('\n'),
    );
  });

  it('refuses, and writes nothing, when the exchange or the list fails', async () => {
    const setup = await setUp({ alice: [1, 2, 7] }, { 7: 'acme' });
    const acme = await workspaceOf(setup.world, 'Acme');

    const wrongCode = await leave(setup, acme);
    const refused = await setup.call(
      'GET',
      `/auth/github-app/callback?code=not-a-code&installation_id=7&setup_action=install&state=${wrongCode.state}`,
      { cookie: wrongCode.cookie },
    );
    assert.equal(word(refused), 'failed');

    setup.github.answerWith((call) =>
      call.path === '/login/oauth/access_token' ? { status: 500, body: { message: 'down' } } : undefined,
    );
    assert.equal(word(await comeBack(setup, await leave(setup, acme), 'alice', 7)), 'failed');

    setup.github.answerWith((call) =>
      call.path === '/user/installations' ? { status: 401, body: { message: 'Bad credentials' } } : undefined,
    );
    assert.equal(word(await comeBack(setup, await leave(setup, acme), 'alice', 7)), 'failed');

    setup.github.answerWith((call) =>
      call.path === '/user/installations' && call.query.get('page') === '2'
        ? { status: 502, body: { message: 'down' } }
        : undefined,
    );
    assert.equal(word(await comeBack(setup, await leave(setup, acme), 'alice', 7)), 'failed');
    assert.deepEqual(await setup.world.accounts.connectors(acme.workspace.id), []);

    // The control: the same way back, with GitHub that answers, attaches it.
    setup.github.answerWith(() => undefined);
    assert.equal(word(await comeBack(setup, await leave(setup, acme), 'alice', 7)), 'connected');
  });
});

describe('the state of the flow, and the person who comes back (FRU-360)', () => {
  it('refuses a callback with no state, from another browser, or with a state used once already', async () => {
    const setup = await setUp({ alice: [7] }, { 7: 'acme' });
    const acme = await workspaceOf(setup.world, 'Acme');
    const left = await leave(setup, acme);
    const query = `code=${setup.github.codeOf('alice')}&installation_id=7&setup_action=install`;

    const none = await setup.call('GET', `/auth/github-app/callback?${query}`, { cookie: left.cookie });
    const stranger = await setup.call('GET', `/auth/github-app/callback?${query}&state=${left.state}`);
    const forged = await setup.call('GET', `/auth/github-app/callback?${query}&state=${left.state}`, {
      cookie: 'fruitback_github_app_state=another-state-of-the-attacker',
    });
    for (const answer of [none, stranger, forged]) {
      assert.equal(answer.status, 302);
      assert.equal(answer.headers.get('Location'), `${CONSOLE}/`);
    }
    assert.deepEqual(setup.github.exchanges(), [], 'the code was not spent for them');

    // The control: this browser, with its state, attaches it. Then the same state is spent.
    assert.equal(word(await comeBack(setup, left, 'alice', 7)), 'connected');
    const replay = await comeBack(setup, left, 'alice', 7);
    assert.equal(replay.headers.get('Location'), `${CONSOLE}/`);
    assert.equal(setup.github.exchanges().length, 1);
  });

  it('spends a ticket once, and refuses a state that ended', async () => {
    const setup = await setUp({ alice: [7] }, { 7: 'acme' });
    const acme = await workspaceOf(setup.world, 'Acme');
    const left = await leave(setup, acme);
    const again = await setup.call('GET', new URL(left.ticket).pathname + new URL(left.ticket).search);
    assert.equal(again.headers.get('Location'), `${CONSOLE}/`, 'a ticket starts one flow');

    setup.clock.now += STATE_TTL_MS + 1_000;
    const late = await comeBack(setup, left, 'alice', 7);
    assert.equal(late.headers.get('Location'), `${CONSOLE}/`);
    assert.deepEqual(await setup.world.accounts.connectors(acme.workspace.id), []);
    assert.deepEqual(setup.github.exchanges(), []);
  });

  it('gives a ticket to an owner or an admin only, and asks the role again on the way back', async () => {
    const setup = await setUp({ alice: [7] }, { 7: 'acme' });
    const acme = await workspaceOf(setup.world, 'Acme');
    const member = await signInTo(setup.world, 'member@acme.dev');
    await setRole(setup.world, acme.workspace.id, member.id, 'member');
    const asked = await setup.call('POST', `${acme.base}/connectors/github/start`, { token: member.token });
    assert.equal(asked.status, 403);

    // An admin starts, and is a member again before GitHub sends them back.
    await setRole(setup.world, acme.workspace.id, member.id, 'admin');
    const left = await leave(setup, acme, member.token);
    await setRole(setup.world, acme.workspace.id, member.id, 'member');
    const back = await comeBack(setup, left, 'alice', 7);

    assert.equal(word(back), 'forbidden');
    assert.deepEqual(await setup.world.accounts.connectors(acme.workspace.id), []);
    assert.deepEqual(setup.github.exchanges(), []);

    // The control: an admin again, the same way back attaches it.
    await setRole(setup.world, acme.workspace.id, member.id, 'admin');
    assert.equal(word(await comeBack(setup, await leave(setup, acme, member.token), 'alice', 7)), 'connected');
  });

  it('keeps no connector for a workspace that was suspended during the flow (FRU-282)', async () => {
    const setup = await setUp({ alice: [7] }, { 7: 'acme' });
    const acme = await workspaceOf(setup.world, 'Acme');
    const left = await leave(setup, acme);
    await rowsOf(
      setup.world.database,
      `INSERT INTO workspace_suspensions (workspace_id, since) VALUES ('${acme.workspace.id}', ${Date.now()})`,
    );

    assert.equal(word(await comeBack(setup, left, 'alice', 7)), 'suspended');
    assert.deepEqual(await setup.world.accounts.connectors(acme.workspace.id), []);
  });
});

describe('the console routes of a github connector (FRU-359, FRU-360)', () => {
  it('answers 404 for its teams, its states and its settings, as for a connector that does not exist', async () => {
    const setup = await setUp({}, {});
    const acme = await workspaceOf(setup.world, 'Acme');
    const github = await setup.world.accounts.addConnector(acme.workspace.id, {
      kind: 'github',
      label: 'GitHub App · acme',
      sealed: sealInstallation(7, SECRETS_KEY),
    });
    const linear = await setup.world.accounts.addConnector(acme.workspace.id, {
      kind: 'linear',
      label: 'Linear',
      sealed: 'not-opened',
    });
    const token = acme.owner.token;
    const routes = (id: string) => [
      setup.call('GET', `${acme.base}/connectors/${id}/teams`, { token }),
      setup.call('GET', `${acme.base}/connectors/${id}/states`, { token }),
      setup.call('POST', `${acme.base}/connectors/${id}/settings`, { token, body: { showComments: false } }),
    ];

    const unknown = await Promise.all(routes('con_nobody'));
    const ofGithub = await Promise.all(routes(github.id));
    for (const [index, answer] of ofGithub.entries()) {
      assert.equal(answer.status, 404);
      assert.deepEqual(await answer.json(), await (unknown[index] as Response).json());
    }
    // The control: the settings of a Linear connector are written by the same route.
    const tuned = await setup.call('POST', `${acme.base}/connectors/${linear.id}/settings`, {
      token,
      body: { showComments: false },
    });
    assert.equal(tuned.status, 200);
  });

  it('refuses a github connector from POST …/connectors: the installation is the only way', async () => {
    const setup = await setUp({ alice: [7] }, { 7: 'acme' });
    const acme = await workspaceOf(setup.world, 'Acme');
    for (const body of [
      { kind: 'github' },
      { kind: 'github', installation: 7 },
      { kind: 'github', installationId: 7, apiKey: 'x' },
    ]) {
      const answer = await setup.call('POST', `${acme.base}/connectors`, { token: acme.owner.token, body });
      assert.equal(answer.status, 400);
      assert.deepEqual(await answer.json(), { error: 'invalid-connector' });
    }
    assert.deepEqual(await setup.world.accounts.connectors(acme.workspace.id), []);
  });
});
