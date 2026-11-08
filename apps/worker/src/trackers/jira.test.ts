import assert from 'node:assert/strict';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { describe, it } from 'vitest';
import { WORKER as API, CONSOLE, type World, callOn, signInTo, worlds } from '../console-world.fixture.ts';
import type { WorkerEnv } from '../env.ts';
import { createPostgresNoteStore } from '../notes-postgres.ts';
import type { ClientPolicy } from '../clients.ts';
import { StoreError } from '../store.ts';
import { pluginOf } from './index.ts';
import { JIRA_CLIENT, OTHER_SITE_ID, SITE_ID, fakeJira } from './jira-fake.fixture.ts';
import { JIRA_SCOPES, jiraStage, pageLabel, plugin } from './jira.ts';
import { noteOfDescription } from './jira-adf.ts';
import { type TrackerAccess, type TrackerCredential, TrackerKeyForbidden, TrackerKeyRefused } from './plugin.ts';

/**
 * The connector Jira Cloud (FRU-622), against a fake Jira whose answers are the ones of the official
 * documentation (`jira-fake.fixture.ts`): the store and the places of the plugin first, then the way
 * a browser connects it and a site writes and reads its notes through it.
 */

const SECRETS_KEY = 'another-secret-that-opens-the-connectors';
const SITE = 'https://staging.acme.dev';
const PAGE = `${SITE}/pricing`;
const PLACE = `${SITE_ID}/10000`;
const POLICY = { showComments: true, identitySecret: undefined, read: 'public', write: 'public' } as ClientPolicy;
const SITES = JSON.stringify([{ id: SITE_ID, name: 'acme', url: 'https://acme.atlassian.net' }]);

function accessTo(jira: ReturnType<typeof fakeJira>, sites = SITES): TrackerAccess {
  jira.state.valid.add('jira-access-0');
  const credential: TrackerCredential = {
    via: 'oauth',
    accessToken: 'jira-access-0',
    refreshToken: 'jira-refresh-0',
    expiresAt: Date.now() + 3_600_000,
    extra: { sites },
  };

  return { credential: async () => credential, http: jira.http, now: Date.now };
}

function note(client = 'site_1') {
  const base = noteFixture();

  return { ...base, page: { ...base.page, url: PAGE }, client: { id: client } };
}

describe('the plugin Jira (FRU-622)', () => {
  it('is the plugin of the kind jira, and connects by OAuth only', () => {
    assert.equal(pluginOf('jira'), plugin);
    assert.equal(plugin.connect, undefined, 'no API token is ever collected');
    assert.deepEqual(plugin.envNames, { oauth: 'FRUITBACK_JIRA_OAUTH' });
  });

  it('asks Atlassian for the scopes it uses, with the audience of the API and a consent', () => {
    const url = new URL(
      plugin.oauth?.authorize({
        clientId: 'c',
        redirectUri: `${API}/auth/jira/callback`,
        state: 's',
        challenge: 'x',
      }) ?? '',
    );

    assert.equal(`${url.origin}${url.pathname}`, 'https://auth.atlassian.com/authorize');
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      audience: 'api.atlassian.com',
      client_id: 'c',
      scope: JIRA_SCOPES.join(' '),
      redirect_uri: `${API}/auth/jira/callback`,
      state: 's',
      response_type: 'code',
      prompt: 'consent',
    });
    assert.ok(JIRA_SCOPES.includes('offline_access'), 'a refresh token needs offline_access');
  });

  it('keeps the Jira sites of the consent, and names the connector after them', async () => {
    const jira = fakeJira();
    jira.state.codes.add('code-1');
    const tokens = await plugin.oauth?.exchange(
      { code: 'code-1', verifier: 'v', redirectUri: `${API}/auth/jira/callback`, client: JIRA_CLIENT },
      jira.http,
      0,
    );
    assert.ok(tokens !== undefined);
    assert.equal(tokens.expiresAt, 3_600_000);
    const named = await plugin.oauth?.identify(tokens, jira.http);

    // The Confluence resource of the same id is not a Jira site.
    assert.deepEqual(named, { label: 'Jira · acme', extra: { sites: SITES } });
    jira.state.resources = jira.state.resources.filter((each) => !each.scopes.includes('write:jira-work'));
    assert.equal(
      await plugin.oauth?.identify(tokens, jira.http),
      undefined,
      'a consent that reaches no Jira keeps nothing',
    );
  });

  it('says a refresh token that Atlassian refuses as an ended connection', async () => {
    const jira = fakeJira();
    jira.state.codes.add('code-1');
    const tokens = await plugin.oauth?.exchange(
      { code: 'code-1', verifier: 'v', redirectUri: 'r', client: JIRA_CLIENT },
      jira.http,
      0,
    );
    const next = await plugin.oauth?.refresh(tokens?.refreshToken ?? '', JIRA_CLIENT, jira.http, 0);
    assert.notEqual(next, 'ended');
    // Rotating refresh tokens: the one just spent is refused the second time.
    assert.equal(await plugin.oauth?.refresh(tokens?.refreshToken ?? '', JIRA_CLIENT, jira.http, 0), 'ended');
  });

  it('lists the projects a page at a time, and the projects of each site of the consent', async () => {
    const jira = fakeJira();
    jira.state.projects = Array.from({ length: 60 }, (_, index) => ({
      id: String(10_000 + index),
      key: `P${index}`,
      name: `Project ${String(index).padStart(2, '0')}`,
    }));
    const first = await plugin.places(accessTo(jira), {});
    assert.equal(first.places.length, 50);
    assert.deepEqual(first.places[0], { id: `${SITE_ID}/10000`, name: 'Project 00 (P0)' });
    assert.equal(first.next, '0.50');
    const second = await plugin.places(accessTo(jira), { after: first.next as string });
    assert.equal(second.places.length, 10);
    assert.equal(second.next, undefined);
    const found = await plugin.places(accessTo(jira), { search: 'project 42' });
    assert.deepEqual(found.places, [{ id: `${SITE_ID}/10042`, name: 'Project 42 (P42)' }]);

    const two = JSON.stringify([
      { id: SITE_ID, name: 'acme', url: 'https://acme.atlassian.net' },
      { id: OTHER_SITE_ID, name: 'beta', url: 'https://beta.atlassian.net' },
    ]);
    const last = await plugin.places(accessTo(jira, two), { after: '0.50' });
    assert.equal(last.next, '1.0', 'the next site after the last page of the first');
    assert.equal(last.places[0]?.name, 'acme · Project 50 (P50)');
  });

  it('reads a place as a project of a site, and names it as Jira does now', async () => {
    const jira = fakeJira();
    assert.equal(plugin.readPlace(PLACE), PLACE);
    for (const wrong of ['10000', `${SITE_ID}/DES`, `${SITE_ID}/1/2`, 'x/10000', 42, undefined]) {
      assert.equal(plugin.readPlace(wrong), undefined, String(wrong));
    }
    assert.deepEqual(await plugin.placeName(accessTo(jira), PLACE), { name: 'Design (DES)' });
    jira.state.hidden.add('10000');
    assert.equal(await plugin.placeName(accessTo(jira), PLACE), undefined, 'a project the person cannot see');
    assert.equal(await plugin.placeName(accessTo(jira), `${OTHER_SITE_ID}/10000`), undefined, 'a site of no consent');
  });
});

describe('a note in Jira (FRU-622)', () => {
  it('becomes an issue of the project, a bug, with its labels and the note in its description', async () => {
    const jira = fakeJira();
    const store = plugin.store(accessTo(jira), { connector: 'con_1' });
    const created = await store.create(note(), { teamId: PLACE }, POLICY);

    assert.deepEqual(created, { id: '10001', identifier: 'DES-1', url: 'https://acme.atlassian.net/browse/DES-1' });
    const [issue] = jira.state.issues;
    assert.ok(issue !== undefined);
    assert.equal((issue.fields.issuetype as { id: string }).id, '10004', 'Bug, before Task, never a sub-task');
    assert.deepEqual(issue?.labels, ['fruitback', 'fruitback:site_1', pageLabel(PAGE)]);
    assert.equal(issue?.fields.summary, 'Le bouton “Commander” est trop petit sur mobile, on le rate au pouce.');
    const parsed = noteOfDescription(issue?.fields.description);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.note, note());
  });

  it('sends each file of the note to the issue, and says a file that Jira refused lost', async () => {
    const jira = fakeJira();
    const store = plugin.store(accessTo(jira), { connector: 'con_1' });
    assert.equal(store.attachments, true);
    const png = { id: 'f1', name: 'capture.png', type: 'image/png', content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) };
    const created = await store.create(note(), { teamId: PLACE }, POLICY, [png]);

    assert.deepEqual(created.files, { sent: ['f1'], lost: [], waiting: [] });
    assert.deepEqual(jira.state.issues[0]?.attachments, [{ filename: 'capture.png', mimeType: 'image/png', size: 4 }]);
  });

  it('reads the issues of a page by its label, with the stage of their status and their replies', async () => {
    const jira = fakeJira();
    const store = plugin.store(accessTo(jira), { connector: 'con_1' });
    await store.create(note(), { teamId: PLACE }, POLICY);
    await store.create({ ...note(), page: { ...note().page, url: `${SITE}/other` } }, { teamId: PLACE }, POLICY);
    const issue = jira.state.issues[0];
    assert.ok(issue !== undefined);
    issue.status = { id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate' } };
    issue.comments.push({
      id: '100',
      created: '2026-11-08T11:00:00.000+0000',
      author: { displayName: 'Mia Krystof' },
      body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'On it.' }] }] },
    });

    const read = await store.findForPage({ url: PAGE, clientId: 'site_1' }, { teamId: PLACE }, POLICY);
    assert.equal(read.length, 1);
    assert.equal(read[0]?.identifier, 'DES-1');
    assert.equal(read[0]?.stage, 'progress');
    assert.equal(read[0]?.stateName, 'In Progress');
    assert.equal(read[0]?.status, 'con_1:3');
    assert.deepEqual(read[0]?.comments, [
      { id: '100', body: 'On it.', createdAt: '2026-11-08T11:00:00.000+0000', author: 'Mia Krystof' },
    ]);
    assert.deepEqual(
      jira.state.searches.at(-1),
      `project = 10000 AND labels = "fruitback" AND labels = "${pageLabel(PAGE)}" AND labels = "fruitback:site_1" ORDER BY created DESC`,
    );

    // The stage a site gives a status wins (FRU-368).
    const staged = plugin.store(accessTo(jira), { connector: 'con_1', stages: { '3': 'todo' } });
    assert.equal(
      (await staged.findForPage({ url: PAGE, clientId: 'site_1' }, { teamId: PLACE }, POLICY))[0]?.stage,
      'todo',
    );
  });

  it('keeps an issue of the page that names another client off the read', async () => {
    const jira = fakeJira();
    const store = plugin.store(accessTo(jira), { connector: 'con_1' });
    await store.create(note('site_2'), { teamId: PLACE }, POLICY);
    // Somebody gave the issue of another client the label of this one.
    jira.state.issues[0]?.labels.push('fruitback:site_1');

    assert.deepEqual(await store.findForPage({ url: PAGE, clientId: 'site_1' }, { teamId: PLACE }, POLICY), []);
  });

  it('maps the category of a status, and a resolution of refusal, to a stage', () => {
    assert.equal(jiraStage('new'), 'new');
    assert.equal(jiraStage('indeterminate'), 'progress');
    assert.equal(jiraStage('done', 'Done'), 'done');
    assert.equal(jiraStage('done', "Won't Do"), 'closed');
    assert.equal(jiraStage('done', 'Duplicate'), 'closed');
    assert.equal(jiraStage('undefined'), 'new');
  });

  it('lists the statuses of the project once each, with the stage of their category', async () => {
    const jira = fakeJira();
    const store = plugin.store(accessTo(jira), { connector: 'con_1' });

    assert.deepEqual(await store.trackerStates?.({ teamId: PLACE }), [
      { id: '10000', name: 'To Do', stage: 'new' },
      { id: '3', name: 'In Progress', stage: 'progress' },
      { id: '10001', name: 'Done', stage: 'done' },
    ]);
  });

  it('says a token that Jira refuses, a project it hides, and a Jira that is down, apart', async () => {
    const jira = fakeJira();
    const store = plugin.store(accessTo(jira), { connector: 'con_1' });
    jira.state.next = { status: 401 };
    await assert.rejects(store.create(note(), { teamId: PLACE }, POLICY), TrackerKeyRefused);
    jira.state.hidden.add('10000');
    await assert.rejects(store.create(note(), { teamId: PLACE }, POLICY), TrackerKeyForbidden);
    jira.state.hidden.clear();
    jira.state.next = { status: 429 };
    await assert.rejects(store.create(note(), { teamId: PLACE }, POLICY), (error: unknown) => {
      return (
        error instanceof StoreError && !(error instanceof TrackerKeyRefused) && !(error instanceof TrackerKeyForbidden)
      );
    });
    await assert.rejects(store.create(note(), { teamId: 'not-a-place' }, POLICY), StoreError);
  });
});

describe('a workspace connects Jira (FRU-622)', () => {
  const worldWith = worlds();

  async function envWith(overrides: Partial<WorkerEnv> = {}) {
    const jira = fakeJira();
    const world = await worldWith({
      env: {
        FRUITBACK_STORE: 'postgres',
        FRUITBACK_SECRETS_KEY: SECRETS_KEY,
        FRUITBACK_JIRA_OAUTH: `${JIRA_CLIENT.clientId}:${JIRA_CLIENT.clientSecret}`,
        ...overrides,
      } as Partial<WorkerEnv>,
    });
    const env: World = {
      ...world,
      context: { ...world.context, store: createPostgresNoteStore(world.database), trackerHttp: jira.http },
    };

    return { env, jira };
  }

  it('by consent at Atlassian, then a site writes its notes there and reads their pins', async () => {
    const { env, jira } = await envWith();
    const { id, token } = await signInTo(env, 'owner@acme.dev');
    const workspace = await env.accounts.createWorkspace('Acme', id);
    const site = await env.accounts.addSite(workspace.id, { origin: SITE, visibility: 'everyone' });
    const base = `/console/workspaces/${workspace.id}`;

    const listed = await callOn(env, 'GET', `${base}/connectors`, { token });
    assert.deepEqual(((await listed.json()) as { trackers: unknown }).trackers, [
      { kind: 'jira', oauth: true, token: false },
    ]);
    const asked = await callOn(env, 'POST', `${base}/connectors/jira/oauth`, { token });
    const { url } = (await asked.json()) as { url: string };
    const started = await callOn(env, 'GET', new URL(url).pathname + new URL(url).search);
    const at = new URL(started.headers.get('Location') as string);
    assert.equal(at.origin, 'https://auth.atlassian.com');
    const cookie = (started.headers.get('Set-Cookie') ?? '').split(';')[0] as string;
    jira.state.codes.add('code-1');
    const back = await callOn(env, 'GET', `/auth/jira/callback?code=code-1&state=${at.searchParams.get('state')}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(back.headers.get('Location'), `${CONSOLE}/w/${workspace.id}/connectors?jira=connected`);
    const [connector] = await env.accounts.connectors(workspace.id);
    assert.equal(connector?.label, 'Jira · acme');

    const places = await callOn(env, 'GET', `${base}/connectors/${connector?.id}/places?q=des`, { token });
    assert.deepEqual(await places.json(), { places: [{ id: PLACE, name: 'Design (DES)' }] });
    const set = await callOn(env, 'POST', `${base}/sites/${site.id}/destination`, {
      token,
      body: { connector: connector?.id, teamId: PLACE },
    });
    assert.equal(set.status, 200, await set.clone().text());
    assert.equal((await env.accounts.sites(workspace.id))[0]?.destinations[0]?.label, 'Jira · Design (DES)');

    const written = await callOn(env, 'POST', '/feedback', { origin: SITE, body: note(site.id) });
    assert.equal(written.status, 201, await written.clone().text());
    assert.equal(jira.state.issues[0]?.key, 'DES-1');
    const read = await callOn(env, 'GET', `/feedback?url=${encodeURIComponent(PAGE)}&client=${site.id}`, {
      origin: SITE,
    });
    assert.equal(read.status, 200, await read.clone().text());
    const pins = (await read.json()) as { issues: { identifier: string; stage: string }[] };
    assert.deepEqual(
      pins.issues.map(({ identifier, stage }) => ({ identifier, stage })),
      [{ identifier: 'DES-1', stage: 'new' }],
    );

    // Somebody revokes the app at Atlassian: the next note says it on the connector.
    jira.state.valid.clear();
    const refused = await callOn(env, 'POST', '/feedback', { origin: SITE, body: note(site.id) });
    assert.equal(refused.status, 502);
    assert.equal((await env.accounts.connectors(workspace.id))[0]?.attention?.reason, 'key-refused');
  });

  it('offers no consent where the worker has no Jira app', async () => {
    const { env } = await envWith({ FRUITBACK_JIRA_OAUTH: undefined } as Partial<WorkerEnv>);
    const { id, token } = await signInTo(env, 'owner@acme.dev');
    const workspace = await env.accounts.createWorkspace('Acme', id);

    const listed = await callOn(env, 'GET', `/console/workspaces/${workspace.id}/connectors`, { token });
    assert.deepEqual(((await listed.json()) as { trackers: unknown }).trackers, [
      { kind: 'jira', oauth: false, token: false },
    ]);
    const asked = await callOn(env, 'POST', `/console/workspaces/${workspace.id}/connectors/jira/oauth`, { token });
    assert.equal(asked.status, 404);
  });
});
