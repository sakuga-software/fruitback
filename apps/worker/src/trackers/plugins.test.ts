import assert from 'node:assert/strict';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { afterEach, describe, it } from 'vitest';
import { WORKER as API, CONSOLE, type World, callOn, signInTo, worlds } from '../console-world.fixture.ts';
import { type WorkerEnv, readConfig } from '../env.ts';
import { createPostgresNoteStore } from '../notes-postgres.ts';
import { open } from '../secrets.ts';
import { FAKE, FAKE_CLIENT, fakePlugin, fakeService } from './fake-plugin.fixture.ts';
import { pluginOf, shippedPlugins, useTestPlugin, withoutTestPlugins } from './index.ts';
import { PLUGIN_KINDS } from './kinds.ts';
import { readTrackerCredential } from './plugin.ts';

/**
 * The socle of the connectors of a plugin (FRU-621), through the routes a browser calls: connect by
 * a token or by OAuth, list the places, choose one for a site, write a note there, refresh a token,
 * say a refusal on the connector, and disconnect. The plugin is `fake-plugin.fixture.ts`.
 */

const SECRETS_KEY = 'another-secret-that-opens-the-connectors';
const SITE = 'https://staging.acme.dev';

afterEach(() => withoutTestPlugins());

const worldWith = worlds();

async function envWith(overrides: Partial<WorkerEnv> = {}) {
  const service = fakeService();
  const world = await worldWith({
    env: {
      FRUITBACK_STORE: 'postgres',
      FRUITBACK_SECRETS_KEY: SECRETS_KEY,
      ...overrides,
    },
  });
  const env: World = {
    ...world,
    context: { ...world.context, store: createPostgresNoteStore(world.database), trackerHttp: service.http },
  };

  return { env, service };
}

async function acme(env: World) {
  const { id, token } = await signInTo(env, 'owner@acme.dev');
  const workspace = await env.accounts.createWorkspace('Acme', id);
  const site = await env.accounts.addSite(workspace.id, { origin: SITE, visibility: 'everyone' });

  return { token, workspace, site, base: `/console/workspaces/${workspace.id}` };
}

function note(site: string) {
  const base = noteFixture();

  return { ...base, page: { ...base.page, url: `${SITE}/pricing` }, client: { id: site } };
}

describe('the plugins of this build (FRU-621)', () => {
  it('has a file for each kind, and no plugin has shipped in the socle', () => {
    assert.deepEqual([...PLUGIN_KINDS], ['jira', 'gitlab', 'slack', 'clickup', 'asana']);
    assert.deepEqual(shippedPlugins(), []);
    assert.equal(pluginOf('linear'), undefined);
    assert.equal(pluginOf('constructor'), undefined);
  });

  it('offers no plugin, and refuses to connect one that has not shipped', async () => {
    const { env } = await envWith();
    const world = await acme(env);

    const listed = await callOn(env, 'GET', `${world.base}/connectors`, { token: world.token });
    assert.deepEqual(((await listed.json()) as { trackers: unknown }).trackers, []);
    const refused = await callOn(env, 'POST', `${world.base}/connectors`, {
      token: world.token,
      body: { kind: 'asana', token: 'typed-token' },
    });
    assert.equal(refused.status, 400);
    assert.deepEqual(await refused.json(), { error: 'invalid-connector' });
  });
});

describe('a connector of a plugin, by a token (FRU-621)', () => {
  it('asks the service first, keeps the token sealed, and never answers it', async () => {
    useTestPlugin(fakePlugin);
    const { env, service } = await envWith();
    const world = await acme(env);

    const made = await callOn(env, 'POST', `${world.base}/connectors`, {
      token: world.token,
      body: { kind: 'asana', token: 'typed-token' },
    });
    assert.equal(made.status, 201, await made.clone().text());
    const connector = (await made.json()) as { id: string; kind: string; label: string };
    assert.equal(connector.kind, 'asana');
    assert.equal(connector.label, 'Fake · Acme');
    assert.ok(service.state.calls.includes('GET /me'));

    const kept = await env.accounts.sealedKey(connector.id);
    assert.deepEqual(readTrackerCredential(open(kept?.sealed as string, SECRETS_KEY) as string), {
      via: 'token',
      token: 'typed-token',
      extra: {},
    });
    const listed = await callOn(env, 'GET', `${world.base}/connectors`, { token: world.token });
    const text = await listed.text();
    assert.equal(text.includes('typed-token'), false);
    assert.deepEqual((JSON.parse(text) as { trackers: unknown }).trackers, [
      { kind: 'asana', oauth: false, token: true },
    ]);
  });

  it('keeps nothing for a token the service refuses, and says why', async () => {
    useTestPlugin(fakePlugin);
    const { env } = await envWith();
    const world = await acme(env);

    const refused = await callOn(env, 'POST', `${world.base}/connectors`, {
      token: world.token,
      body: { kind: 'asana', token: 'a-wrong-token' },
    });
    assert.equal(refused.status, 400);
    assert.deepEqual(await refused.json(), { error: 'key-refused' });
    const empty = await callOn(env, 'POST', `${world.base}/connectors`, {
      token: world.token,
      body: { kind: 'asana', token: ' ' },
    });
    assert.deepEqual(await empty.json(), { error: 'invalid-token' });
    assert.deepEqual(await env.accounts.connectors(world.workspace.id), []);
  });

  it('lists the places, names the destination after the service, and writes the note there', async () => {
    useTestPlugin(fakePlugin);
    const { env, service } = await envWith();
    const world = await acme(env);
    const made = await callOn(env, 'POST', `${world.base}/connectors`, {
      token: world.token,
      body: { kind: 'asana', token: 'typed-token' },
    });
    const { id } = (await made.json()) as { id: string };

    const places = await callOn(env, 'GET', `${world.base}/connectors/${id}/places?q=des`, { token: world.token });
    assert.equal(places.status, 200, await places.clone().text());
    assert.deepEqual(await places.json(), { places: [{ id: 'P1', name: 'Design' }] });

    const wrong = await callOn(env, 'POST', `${world.base}/sites/${world.site.id}/destination`, {
      token: world.token,
      body: { connector: id, teamId: 'not a place' },
    });
    assert.equal(wrong.status, 400, await wrong.clone().text());
    const set = await callOn(env, 'POST', `${world.base}/sites/${world.site.id}/destination`, {
      token: world.token,
      body: { connector: id, teamId: 'P1' },
    });
    assert.equal(set.status, 200, await set.clone().text());
    const [site] = await env.accounts.sites(world.workspace.id);
    assert.equal(site?.destinations[0]?.label, 'Fake · Design');

    const written = await callOn(env, 'POST', '/feedback', { origin: SITE, body: note(world.site.id) });
    assert.equal(written.status, 201, await written.clone().text());
    assert.deepEqual(
      service.state.issues.map(({ place, token }) => ({ place, token })),
      [{ place: 'P1', token: 'typed-token' }],
    );

    // FRU-368: the states of the place, for the statuses of the site, as the store of the plugin reads them.
    const states = await callOn(env, 'GET', `${world.base}/sites/${world.site.id}/statuses/tracker`, {
      token: world.token,
    });
    assert.equal(states.status, 200, await states.clone().text());
    assert.deepEqual(((await states.json()) as { trackers: unknown[] }).trackers, [
      {
        connector: id,
        teamId: 'P1',
        label: 'Fake · Design',
        states: [{ id: 'open', name: 'Open', stage: 'todo' }],
      },
    ]);
  });

  it('keeps no note through a connector whose plugin this build does not have', async () => {
    const { env } = await envWith();
    const world = await acme(env);
    const connector = await env.accounts.addConnector(world.workspace.id, {
      kind: 'jira',
      label: 'Jira · a server of after',
      sealed: 'not-opened',
    });
    await env.accounts.setDestinations(world.workspace.id, world.site.id, [{ connector: connector.id, teamId: 'P1' }]);

    const written = await callOn(env, 'POST', '/feedback', { origin: SITE, body: note(world.site.id) });
    assert.equal(written.status, 502, await written.clone().text());
  });

  it('says a token that the service revoked on the connector, and a place it refuses', async () => {
    useTestPlugin(fakePlugin);
    const { env, service } = await envWith();
    const world = await acme(env);
    const made = await callOn(env, 'POST', `${world.base}/connectors`, {
      token: world.token,
      body: { kind: 'asana', token: 'typed-token' },
    });
    const { id } = (await made.json()) as { id: string };
    const attention = async () =>
      (await env.accounts.connectors(world.workspace.id)).find((each) => each.id === id)?.attention?.reason;

    service.state.limited.add('typed-token');
    const limited = await callOn(env, 'GET', `${world.base}/connectors/${id}/places`, { token: world.token });
    assert.equal(limited.status, 502);
    assert.equal(await attention(), 'key-lacks-access');

    service.state.limited.clear();
    await callOn(env, 'GET', `${world.base}/connectors/${id}/places`, { token: world.token });
    assert.equal(await attention(), undefined, 'an answer ends the attention');

    service.state.valid.delete('typed-token');
    const revoked = await callOn(env, 'GET', `${world.base}/connectors/${id}/places`, { token: world.token });
    assert.equal(revoked.status, 502);
    assert.equal(await attention(), 'key-refused');
  });

  it('tells the service before the connector goes', async () => {
    useTestPlugin(fakePlugin);
    const { env, service } = await envWith();
    const world = await acme(env);
    const made = await callOn(env, 'POST', `${world.base}/connectors`, {
      token: world.token,
      body: { kind: 'asana', token: 'typed-token' },
    });
    const { id } = (await made.json()) as { id: string };

    const gone = await callOn(env, 'DELETE', `${world.base}/connectors/${id}`, { token: world.token });
    assert.equal(gone.status, 204);
    assert.deepEqual(service.state.revoked, ['typed-token']);
  });
});

describe('a connector of a plugin, by OAuth (FRU-621)', () => {
  const OAUTH = { FRUITBACK_ASANA_OAUTH: `${FAKE_CLIENT.clientId}:${FAKE_CLIENT.clientSecret}` } as Partial<WorkerEnv>;

  async function connected(
    env: World,
    service: ReturnType<typeof fakeService>,
    world: Awaited<ReturnType<typeof acme>>,
  ) {
    const asked = await callOn(env, 'POST', `${world.base}/connectors/asana/oauth`, { token: world.token });
    assert.equal(asked.status, 201, await asked.clone().text());
    const { url } = (await asked.json()) as { url: string };
    const started = await callOn(env, 'GET', new URL(url).pathname + new URL(url).search);
    assert.equal(started.status, 302);
    const at = new URL(started.headers.get('Location') as string);
    const cookie = (started.headers.get('Set-Cookie') ?? '').split(';')[0] as string;
    assert.equal(`${at.origin}${at.pathname}`, `${FAKE}/authorize`);
    assert.equal(at.searchParams.get('redirect_uri'), `${API}/auth/asana/callback`);
    assert.equal(cookie.split('=')[1], at.searchParams.get('state'));

    service.state.codes.add('code-1');
    const back = await callOn(env, 'GET', `/auth/asana/callback?code=code-1&state=${at.searchParams.get('state')}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(back.headers.get('Location'), `${CONSOLE}/w/${world.workspace.id}/connectors?asana=connected`);
    const [connector] = await env.accounts.connectors(world.workspace.id);
    assert.ok(connector !== undefined);
    const set = await callOn(env, 'POST', `${world.base}/sites/${world.site.id}/destination`, {
      token: world.token,
      body: { connector: connector.id, teamId: 'P2' },
    });
    assert.equal(set.status, 200, await set.clone().text());

    return connector;
  }

  it('offers OAuth only where the worker has the application', async () => {
    useTestPlugin(fakePlugin);
    const { env } = await envWith(OAUTH);
    const world = await acme(env);

    const listed = await callOn(env, 'GET', `${world.base}/connectors`, { token: world.token });
    assert.deepEqual(((await listed.json()) as { trackers: unknown }).trackers, [
      { kind: 'asana', oauth: true, token: true },
    ]);
    const none = await envWith();
    const elsewhere = await acme(none.env);
    const refused = await callOn(none.env, 'POST', `${elsewhere.base}/connectors/asana/oauth`, {
      token: elsewhere.token,
    });
    assert.equal(refused.status, 404);
  });

  it('keeps the tokens sealed, with what the plugin keeps beside them', async () => {
    useTestPlugin(fakePlugin);
    const { env, service } = await envWith(OAUTH);
    const world = await acme(env);
    const connector = await connected(env, service, world);

    assert.equal(connector.label, 'Fake OAuth · Acme');
    const kept = await env.accounts.sealedKey(connector.id);
    const credential = readTrackerCredential(open(kept?.sealed as string, SECRETS_KEY) as string);
    assert.equal(credential?.via, 'oauth');
    assert.deepEqual(credential?.extra, { site: 'one' });
  });

  it('refreshes a token near its end, writes the new pair, and uses it', async () => {
    useTestPlugin(fakePlugin);
    const { env, service } = await envWith(OAUTH);
    // Each token lasts a minute: inside the margin, so the first use refreshes it.
    service.state.lasts = 60;
    const world = await acme(env);
    const connector = await connected(env, service, world);

    const before = service.state.generation;
    const written = await callOn(env, 'POST', '/feedback', { origin: SITE, body: note(world.site.id) });
    assert.equal(written.status, 201, await written.clone().text());
    assert.equal(service.state.generation, before + 1, 'one refresh for the note');
    assert.equal(service.state.issues[0]?.token, `access-${before + 1}`);
    const kept = await env.accounts.sealedKey(connector.id);
    const credential = readTrackerCredential(open(kept?.sealed as string, SECRETS_KEY) as string);
    assert.equal(credential?.via === 'oauth' ? credential.refreshToken : '', `refresh-${before + 1}`);
    assert.deepEqual(credential?.extra, { site: 'one' }, 'a refresh keeps what the plugin kept');
  });

  it('says an ended connection on the connector when the service refuses the refresh', async () => {
    useTestPlugin(fakePlugin);
    const { env, service } = await envWith(OAUTH);
    service.state.lasts = 60;
    const world = await acme(env);
    const connector = await connected(env, service, world);
    service.state.refreshable.clear();

    const written = await callOn(env, 'POST', '/feedback', { origin: SITE, body: note(world.site.id) });
    assert.equal(written.status, 502);
    const [after] = await env.accounts.connectors(world.workspace.id);
    assert.equal(after?.id, connector.id);
    assert.equal(after?.attention?.reason, 'connection-ended');
  });

  it('keeps no connector for a person who said no, nor for a state of another browser', async () => {
    useTestPlugin(fakePlugin);
    const { env } = await envWith(OAUTH);
    const world = await acme(env);
    const asked = await callOn(env, 'POST', `${world.base}/connectors/asana/oauth`, { token: world.token });
    const { url } = (await asked.json()) as { url: string };
    const started = await callOn(env, 'GET', new URL(url).pathname + new URL(url).search);
    const state = new URL(started.headers.get('Location') as string).searchParams.get('state');
    const cookie = (started.headers.get('Set-Cookie') ?? '').split(';')[0] as string;

    const elsewhere = await callOn(env, 'GET', `/auth/asana/callback?code=code-1&state=${state}`);
    assert.equal(elsewhere.headers.get('Location'), `${CONSOLE}/`);
    const declined = await callOn(env, 'GET', `/auth/asana/callback?error=access_denied&state=${state}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(declined.headers.get('Location'), `${CONSOLE}/w/${world.workspace.id}/connectors?asana=declined`);
    assert.deepEqual(await env.accounts.connectors(world.workspace.id), []);
  });

  it('refuses to start with an application that is not two parts, or with no key to seal its tokens', async () => {
    useTestPlugin(fakePlugin);
    const { env } = await envWith(OAUTH);
    const base = env.env;
    const refused = readConfig({ ...base, FRUITBACK_ASANA_OAUTH: 'nocolon' } as WorkerEnv);
    assert.equal(refused.ok, false);
    assert.match(JSON.stringify(refused), /FRUITBACK_ASANA_OAUTH/);
    const unsealed = readConfig({ ...base, FRUITBACK_SECRETS_KEY: undefined });
    assert.equal(unsealed.ok, false);
    const read = readConfig(base);
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.deepEqual(read.ok ? read.config.trackerApps : undefined, { asana: FAKE_CLIENT });
  });
});
