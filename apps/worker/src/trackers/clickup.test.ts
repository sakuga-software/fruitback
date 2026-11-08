import assert from 'node:assert/strict';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { parseNoteFromDescription } from '@fruitback/shared';
import { describe, it } from 'vitest';
import { WORKER as API, CONSOLE, type World, callOn, signInTo, worlds } from '../console-world.fixture.ts';
import type { ClientPolicy } from '../clients.ts';
import type { WorkerEnv } from '../env.ts';
import { createPostgresNoteStore } from '../notes-postgres.ts';
import { open } from '../secrets.ts';
import { StoreError } from '../store.ts';
import { CLICKUP_CLIENT, PERSONAL, fakeClickup } from './clickup-fake.fixture.ts';
import { clickupStage, pageTag, plugin } from './clickup.ts';
import { pluginOf } from './index.ts';
import {
  type TrackerAccess,
  type TrackerCredential,
  TrackerInputRefused,
  TrackerKeyForbidden,
  TrackerKeyRefused,
  readTrackerCredential,
} from './plugin.ts';

/**
 * The connector ClickUp (FRU-625), against a fake ClickUp whose answers are the ones of its official
 * reference (`clickup-fake.fixture.ts`): the plugin and its store first, then the way a browser
 * connects it and a site writes and reads its notes through it.
 */

const SECRETS_KEY = 'another-secret-that-opens-the-connectors';
const SITE = 'https://staging.acme.dev';
const PAGE = `${SITE}/pricing`;
const POLICY = { showComments: true, identitySecret: undefined, read: 'public', write: 'public' } as ClientPolicy;

function accessTo(clickup: ReturnType<typeof fakeClickup>): TrackerAccess {
  const credential: TrackerCredential = { via: 'token', token: PERSONAL, extra: {} };

  return { credential: async () => credential, http: clickup.http, now: Date.now };
}

function note(client = 'site_1') {
  const base = noteFixture();

  return { ...base, page: { ...base.page, url: PAGE }, client: { id: client } };
}

describe('the plugin ClickUp (FRU-625)', () => {
  it('is the plugin of the kind clickup, by OAuth or by a personal token', () => {
    assert.equal(pluginOf('clickup'), plugin);
    assert.ok(plugin.connect !== undefined && plugin.oauth !== undefined);
    assert.deepEqual(plugin.envNames, { oauth: 'FRUITBACK_CLICKUP_OAUTH' });
  });

  it('asks ClickUp for its consent, and keeps a token that never ends', async () => {
    const clickup = fakeClickup();
    const url = new URL(
      plugin.oauth?.authorize({
        clientId: 'c',
        redirectUri: `${API}/auth/clickup/callback`,
        state: 's',
        challenge: 'x',
      }) ?? '',
    );
    assert.equal(`${url.origin}${url.pathname}`, 'https://app.clickup.com/api');
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      client_id: 'c',
      redirect_uri: `${API}/auth/clickup/callback`,
      state: 's',
    });

    clickup.state.codes.add('code-1');
    const tokens = await plugin.oauth?.exchange(
      { code: 'code-1', verifier: 'v', redirectUri: 'r', client: CLICKUP_CLIENT },
      clickup.http,
      0,
    );
    assert.deepEqual(tokens, {
      accessToken: '1_clickup_oauth_token',
      refreshToken: '',
      expiresAt: 100 * 365 * 24 * 60 * 60 * 1_000,
    });
    assert.ok(Number.isSafeInteger((tokens?.expiresAt ?? 0) + Date.now()), 'a sum with the end stays an integer');
    assert.equal(
      await plugin.oauth?.exchange(
        { code: 'code-1', verifier: 'v', redirectUri: 'r', client: CLICKUP_CLIENT },
        clickup.http,
        0,
      ),
      undefined,
      'a code is spent once',
    );
    assert.deepEqual(await plugin.oauth?.identify(tokens as NonNullable<typeof tokens>, clickup.http), {
      label: 'ClickUp · Acme',
    });
  });

  it('takes a personal token that ClickUp knows, and refuses one it does not, or that is no token', async () => {
    const clickup = fakeClickup();
    const context = { http: clickup.http, now: Date.now };

    assert.deepEqual(await plugin.connect?.({ token: ` ${PERSONAL} ` }, context), {
      label: 'ClickUp · Acme',
      token: PERSONAL,
    });
    await assert.rejects(
      plugin.connect?.({ token: 'pk_999_NOT_A_TOKEN_OF_CLICKUP' }, context) as Promise<unknown>,
      TrackerKeyRefused,
    );
    for (const wrong of ['', 'lin_api_abcdefgh', 'pk_ has spaces', 42]) {
      await assert.rejects(plugin.connect?.({ token: wrong }, context) as Promise<unknown>, TrackerInputRefused);
    }
  });

  it('lists the lists of each space, those of its folders too, and finds one by its name', async () => {
    const clickup = fakeClickup();
    const all = await plugin.places(accessTo(clickup), {});
    assert.deepEqual(all, {
      places: [
        { id: '125', name: 'Product › Inbox' },
        { id: '124', name: 'Product › Web › Bugs' },
        { id: '126', name: 'Marketing › Site' },
      ],
    });
    const found = await plugin.places(accessTo(clickup), { search: 'bug' });
    assert.deepEqual(found.places, [{ id: '124', name: 'Product › Web › Bugs' }]);
  });

  it('pages the spaces, five at a time', async () => {
    const clickup = fakeClickup();
    clickup.state.spaces = Array.from({ length: 7 }, (_, index) => ({
      id: String(800 + index),
      name: `S${index}`,
      team: '9001',
    }));
    clickup.state.lists = clickup.state.spaces.map((space, index) => ({
      id: String(200 + index),
      name: 'Inbox',
      space: space.id,
      folder: undefined,
    }));
    const first = await plugin.places(accessTo(clickup), {});
    assert.equal(first.places.length, 5);
    assert.equal(first.next, '5');
    const second = await plugin.places(accessTo(clickup), { after: '5' });
    assert.deepEqual(
      second.places.map((each) => each.name),
      ['S5 › Inbox', 'S6 › Inbox'],
    );
    assert.equal(second.next, undefined);
  });

  it('reads a place as a list, and names it as ClickUp does now', async () => {
    const clickup = fakeClickup();
    assert.equal(plugin.readPlace('124'), '124');
    for (const wrong of ['', 'abc', '12 3', 124, undefined, '../124']) assert.equal(plugin.readPlace(wrong), undefined);
    assert.deepEqual(await plugin.placeName(accessTo(clickup), '124'), { name: 'Product › Web › Bugs' });
    assert.deepEqual(await plugin.placeName(accessTo(clickup), '125'), { name: 'Product › Inbox' });
    clickup.state.hidden.add('124');
    assert.equal(await plugin.placeName(accessTo(clickup), '124'), undefined, 'a list the token does not reach');
  });
});

describe('a note in ClickUp (FRU-625)', () => {
  it('becomes a task of the list, with its tags made in the space first, and the note in its description', async () => {
    const clickup = fakeClickup();
    const store = plugin.store(accessTo(clickup), { connector: 'con_1' });
    const created = await store.create(note(), { teamId: '124' }, POLICY);

    assert.deepEqual(created, { id: '86abc1', identifier: '#86abc1', url: 'https://app.clickup.com/t/86abc1' });
    const [task] = clickup.state.tasks;
    assert.deepEqual(task?.tags, ['fruitback', pageTag(PAGE, 'site_1')], 'ClickUp keeps a tag its space has');
    const parsed = parseNoteFromDescription(task?.markdown);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.note, note());

    // A second note: the tags exist, and ClickUp's « already exists » stops nothing.
    await store.create(note(), { teamId: '124' }, POLICY);
    assert.equal(clickup.state.tasks.length, 2);
  });

  it('writes no task whose tags ClickUp would not keep: no read could find it', async () => {
    const clickup = fakeClickup();
    const store = plugin.store(accessTo(clickup), { connector: 'con_1' });
    clickup.state.refusedTags.add(pageTag(PAGE, 'site_1'));

    await assert.rejects(store.create(note(), { teamId: '124' }, POLICY), StoreError);
    assert.equal(clickup.state.tasks.length, 0);
  });

  it('reads a task whose dates are not dates, with no date', async () => {
    const clickup = fakeClickup();
    const store = plugin.store(accessTo(clickup), { connector: 'con_1' });
    await store.create(note(), { teamId: '124' }, POLICY);
    const [task] = clickup.state.tasks;
    assert.ok(task !== undefined);
    task.updated = 'not a date';
    task.comments.push({ id: '1', comment_text: 'Seen.', date: 'soon', user: { username: 'Mia' } });

    const read = await store.findForPage({ url: PAGE, clientId: 'site_1' }, { teamId: '124' }, POLICY);
    assert.equal(read.length, 1);
    assert.equal(read[0]?.updatedAt, '');
    assert.equal(read[0]?.comments?.[0]?.createdAt, '');
  });

  it('sends its files, and keeps the note when ClickUp refuses them', async () => {
    const clickup = fakeClickup();
    const store = plugin.store(accessTo(clickup), { connector: 'con_1' });
    const png = { id: 'f1', name: 'capture.png', type: 'image/png', content: new Uint8Array([0x89, 0x50]) };

    assert.deepEqual((await store.create(note(), { teamId: '124' }, POLICY, [png])).files, {
      sent: ['f1'],
      lost: [],
      waiting: [],
    });
    assert.deepEqual(clickup.state.tasks[0]?.attachments, [{ title: 'capture.png', mimetype: 'image/png', size: 2 }]);
    clickup.state.attachmentsOff = true;
    assert.deepEqual((await store.create(note(), { teamId: '124' }, POLICY, [png])).files, {
      sent: [],
      lost: ['f1'],
      waiting: [],
    });
  });

  it('reads the tasks of a page by its tag, closed ones too, with the stage of their status and their replies', async () => {
    const clickup = fakeClickup();
    const store = plugin.store(accessTo(clickup), { connector: 'con_1' });
    await store.create(note(), { teamId: '124' }, POLICY);
    await store.create(note(), { teamId: '124' }, POLICY);
    await store.create({ ...note(), page: { ...note().page, url: `${SITE}/other` } }, { teamId: '124' }, POLICY);
    const [first, second] = clickup.state.tasks;
    assert.ok(first !== undefined && second !== undefined);
    first.status = { status: 'in progress', type: 'custom' };
    second.status = { status: 'complete', type: 'closed' };
    first.comments.push(
      { id: '1', comment_text: 'Seen.', date: '1762596000000', user: { username: 'Mia' } },
      { id: '2', comment_text: 'Fixed on staging.', date: '1762599600000', user: { username: 'Bo' } },
    );

    const read = await store.findForPage({ url: PAGE, clientId: 'site_1' }, { teamId: '124' }, POLICY);
    assert.deepEqual(
      read.map(({ identifier, stage, stateName, status }) => ({ identifier, stage, stateName, status })),
      [
        { identifier: '#86abc2', stage: 'done', stateName: 'complete', status: 'con_1:complete' },
        { identifier: '#86abc1', stage: 'progress', stateName: 'in progress', status: 'con_1:in progress' },
      ],
    );
    assert.deepEqual(
      read[1]?.comments?.map(({ body, author }) => ({ body, author })),
      [
        { body: 'Seen.', author: 'Mia' },
        { body: 'Fixed on staging.', author: 'Bo' },
      ],
      'oldest first',
    );
    assert.deepEqual(clickup.state.reads.at(-1), [pageTag(PAGE, 'site_1')]);

    // The stage a site gives a status wins (FRU-368).
    const staged = plugin.store(accessTo(clickup), { connector: 'con_1', stages: { 'in progress': 'todo' } });
    const again = await staged.findForPage({ url: PAGE, clientId: 'site_1' }, { teamId: '124' }, POLICY);
    assert.equal(again[1]?.stage, 'todo');
  });

  it('keeps a task of the page that names another client off the read, and reads every page of tasks', async () => {
    const clickup = fakeClickup();
    const store = plugin.store(accessTo(clickup), { connector: 'con_1' });
    // Two sites send to one list: the tag of a page names its client, so a read asks for its own only.
    for (let index = 0; index < 150; index += 1) await store.create(note('site_2'), { teamId: '124' }, POLICY);
    assert.deepEqual(await store.findForPage({ url: PAGE, clientId: 'site_1' }, { teamId: '124' }, POLICY), []);
    assert.equal(clickup.state.reads.length, 1, 'no page of the other site is read');
    assert.notEqual(pageTag(PAGE, 'site_1'), pageTag(PAGE, 'site_2'));

    for (let index = 0; index < 120; index += 1) await store.create(note(), { teamId: '124' }, POLICY);
    const quiet = { ...POLICY, showComments: false };
    const read = await store.findForPage({ url: PAGE, clientId: 'site_1' }, { teamId: '124' }, quiet);
    assert.equal(read.length, 120);
    assert.equal(read[0]?.comments, undefined, 'no reply is asked for a site that shows none');
  });

  it('maps the type of a status to a stage, and lists the statuses of the list', async () => {
    assert.equal(clickupStage('open'), 'new');
    assert.equal(clickupStage('custom'), 'progress');
    assert.equal(clickupStage('done'), 'done');
    assert.equal(clickupStage('closed'), 'done');
    const store = plugin.store(accessTo(fakeClickup()), { connector: 'con_1' });

    assert.deepEqual(await store.trackerStates?.({ teamId: '124' }), [
      { id: 'to do', name: 'to do', stage: 'new', color: '#d3d3d3' },
      { id: 'in progress', name: 'in progress', stage: 'progress', color: '#4194f6' },
      { id: 'complete', name: 'complete', stage: 'done', color: '#6bc950' },
    ]);
  });

  it('says a token that ClickUp refuses, a list it hides, and a ClickUp that is down, apart', async () => {
    const clickup = fakeClickup();
    const store = plugin.store(accessTo(clickup), { connector: 'con_1' });
    clickup.state.next = { status: 401 };
    await assert.rejects(store.create(note(), { teamId: '124' }, POLICY), TrackerKeyRefused);
    clickup.state.hidden.add('124');
    await assert.rejects(store.create(note(), { teamId: '124' }, POLICY), TrackerKeyForbidden);
    clickup.state.hidden.clear();
    clickup.state.next = { status: 429 };
    await assert.rejects(
      store.create(note(), { teamId: '124' }, POLICY),
      (error: unknown) =>
        error instanceof StoreError && !(error instanceof TrackerKeyRefused) && !(error instanceof TrackerKeyForbidden),
    );
    await assert.rejects(store.create(note(), { teamId: '../124' }, POLICY), StoreError);
  });
});

describe('a workspace connects ClickUp (FRU-625)', () => {
  const worldWith = worlds();

  async function envWith(overrides: Partial<WorkerEnv> = {}) {
    const clickup = fakeClickup();
    const world = await worldWith({
      env: {
        FRUITBACK_STORE: 'postgres',
        FRUITBACK_SECRETS_KEY: SECRETS_KEY,
        FRUITBACK_CLICKUP_OAUTH: `${CLICKUP_CLIENT.clientId}:${CLICKUP_CLIENT.clientSecret}`,
        ...overrides,
      } as Partial<WorkerEnv>,
    });
    const env: World = {
      ...world,
      context: { ...world.context, store: createPostgresNoteStore(world.database), trackerHttp: clickup.http },
    };

    return { env, clickup };
  }

  async function acme(env: World) {
    const { id, token } = await signInTo(env, 'owner@acme.dev');
    const workspace = await env.accounts.createWorkspace('Acme', id);
    const site = await env.accounts.addSite(workspace.id, { origin: SITE, visibility: 'everyone' });

    return { token, workspace, site, base: `/console/workspaces/${workspace.id}` };
  }

  it('by consent at ClickUp, then a site writes its notes there and reads their pins', async () => {
    const { env, clickup } = await envWith();
    const { token, workspace, site, base } = await acme(env);

    const listed = await callOn(env, 'GET', `${base}/connectors`, { token });
    const offers = ((await listed.json()) as { trackers: { kind: string }[] }).trackers;
    assert.deepEqual(
      offers.find((each) => each.kind === 'clickup'),
      { kind: 'clickup', oauth: true, token: true },
    );
    const asked = await callOn(env, 'POST', `${base}/connectors/clickup/oauth`, { token });
    const { url } = (await asked.json()) as { url: string };
    const started = await callOn(env, 'GET', new URL(url).pathname + new URL(url).search);
    const at = new URL(started.headers.get('Location') as string);
    assert.equal(`${at.origin}${at.pathname}`, 'https://app.clickup.com/api');
    const cookie = (started.headers.get('Set-Cookie') ?? '').split(';')[0] as string;
    clickup.state.codes.add('code-1');
    const back = await callOn(env, 'GET', `/auth/clickup/callback?code=code-1&state=${at.searchParams.get('state')}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(back.headers.get('Location'), `${CONSOLE}/w/${workspace.id}/connectors?clickup=connected`);
    const [connector] = await env.accounts.connectors(workspace.id);
    assert.equal(connector?.label, 'ClickUp · Acme');

    const set = await callOn(env, 'POST', `${base}/sites/${site.id}/destination`, {
      token,
      body: { connector: connector?.id, teamId: '124' },
    });
    assert.equal(set.status, 200, await set.clone().text());
    assert.equal((await env.accounts.sites(workspace.id))[0]?.destinations[0]?.label, 'ClickUp · Product › Web › Bugs');

    const written = await callOn(env, 'POST', '/feedback', { origin: SITE, body: note(site.id) });
    assert.equal(written.status, 201, await written.clone().text());
    const read = await callOn(env, 'GET', `/feedback?url=${encodeURIComponent(PAGE)}&client=${site.id}`, {
      origin: SITE,
    });
    const pins = (await read.json()) as { issues: { identifier: string; stage: string }[] };
    assert.deepEqual(
      pins.issues.map(({ identifier, stage }) => ({ identifier, stage })),
      [{ identifier: '#86abc1', stage: 'new' }],
    );

    // Somebody removes the app in ClickUp: the next note says it on the connector.
    clickup.state.valid.clear();
    const refused = await callOn(env, 'POST', '/feedback', { origin: SITE, body: note(site.id) });
    assert.equal(refused.status, 502);
    assert.equal((await env.accounts.connectors(workspace.id))[0]?.attention?.reason, 'key-refused');
  });

  it('by a personal token, on a server with no ClickUp app, kept sealed and never answered', async () => {
    const { env } = await envWith({ FRUITBACK_CLICKUP_OAUTH: undefined } as Partial<WorkerEnv>);
    const { token, workspace, base } = await acme(env);

    const listed = await callOn(env, 'GET', `${base}/connectors`, { token });
    const offers = ((await listed.json()) as { trackers: { kind: string }[] }).trackers;
    assert.deepEqual(
      offers.find((each) => each.kind === 'clickup'),
      { kind: 'clickup', oauth: false, token: true },
    );
    const refused = await callOn(env, 'POST', `${base}/connectors`, {
      token,
      body: { kind: 'clickup', token: 'pk_1_wrong_token' },
    });
    assert.deepEqual(await refused.json(), { error: 'key-refused' });
    const made = await callOn(env, 'POST', `${base}/connectors`, { token, body: { kind: 'clickup', token: PERSONAL } });
    assert.equal(made.status, 201, await made.clone().text());
    assert.equal((await made.text()).includes(PERSONAL), false);
    const [connector] = await env.accounts.connectors(workspace.id);
    const kept = await env.accounts.sealedKey(connector?.id as string);
    assert.deepEqual(readTrackerCredential(open(kept?.sealed as string, SECRETS_KEY) as string), {
      via: 'token',
      token: PERSONAL,
      extra: {},
    });
  });
});
