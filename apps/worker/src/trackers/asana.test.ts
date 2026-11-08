import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { parseNoteFromDescription } from '@fruitback/shared';
import { describe, it } from 'vitest';
import { WORKER as API, CONSOLE, type World, callOn, signInTo, worlds } from '../console-world.fixture.ts';
import type { ClientPolicy } from '../clients.ts';
import type { WorkerEnv } from '../env.ts';
import { createPostgresNoteStore } from '../notes-postgres.ts';
import { open } from '../secrets.ts';
import { StoreError } from '../store.ts';
import { ASANA_CLIENT, PERSONAL, WORKSPACE, fakeAsana } from './asana-fake.fixture.ts';
import { COMPLETED, pageTag, plugin } from './asana.ts';
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
 * The connector Asana (FRU-626), against a fake Asana whose answers are the ones of its official
 * reference (`asana-fake.fixture.ts`): the plugin and its store first, then the way a browser connects
 * it and a site writes and reads its notes through it.
 */

const SECRETS_KEY = 'another-secret-that-opens-the-connectors';
const SITE = 'https://staging.acme.dev';
const PAGE = `${SITE}/pricing`;
const PROJECT = '1200000000000010';
const POLICY = { showComments: true, identitySecret: undefined, read: 'public', write: 'public' } as ClientPolicy;

function accessTo(asana: ReturnType<typeof fakeAsana>): TrackerAccess {
  const credential: TrackerCredential = { via: 'token', token: PERSONAL, extra: {} };

  return { credential: async () => credential, http: asana.http, now: Date.now };
}

function note(client = 'site_1') {
  const base = noteFixture();

  return { ...base, page: { ...base.page, url: PAGE }, client: { id: client } };
}

describe('the plugin Asana (FRU-626)', () => {
  it('is the plugin of the kind asana, by OAuth or by a personal access token', () => {
    assert.equal(pluginOf('asana'), plugin);
    assert.ok(plugin.connect !== undefined && plugin.oauth !== undefined);
    assert.deepEqual(plugin.envNames, { oauth: 'FRUITBACK_ASANA_OAUTH' });
  });

  it('asks Asana for its consent with PKCE, refreshes with the refresh token of the consent, and revokes it', async () => {
    const asana = fakeAsana();
    const verifier = 'a-verifier-of-forty-three-characters-or-more-x';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const url = new URL(
      plugin.oauth?.authorize({ clientId: 'c', redirectUri: `${API}/auth/asana/callback`, state: 's', challenge }) ??
        '',
    );
    assert.equal(`${url.origin}${url.pathname}`, 'https://app.asana.com/-/oauth_authorize');
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      client_id: 'c',
      redirect_uri: `${API}/auth/asana/callback`,
      response_type: 'code',
      state: 's',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    asana.state.codes.set('code-1', challenge);
    const tokens = await plugin.oauth?.exchange(
      { code: 'code-1', verifier, redirectUri: `${API}/auth/asana/callback`, client: ASANA_CLIENT },
      asana.http,
      0,
    );
    assert.deepEqual(tokens, { accessToken: 'asana-access-1', refreshToken: 'asana-refresh-1', expiresAt: 3_600_000 });
    asana.state.codes.set('code-2', challenge);
    assert.equal(
      await plugin.oauth?.exchange(
        { code: 'code-2', verifier: 'wrong', redirectUri: 'r', client: ASANA_CLIENT },
        asana.http,
        0,
      ),
      undefined,
      'a verifier that does not prove the challenge',
    );

    const refreshed = await plugin.oauth?.refresh('asana-refresh-1', ASANA_CLIENT, asana.http, 10);
    assert.deepEqual(refreshed, {
      accessToken: 'asana-access-3',
      refreshToken: 'asana-refresh-1',
      expiresAt: 3_600_010,
    });
    await plugin.oauth?.revoke?.(
      { via: 'oauth', accessToken: 'x', refreshToken: 'asana-refresh-1', expiresAt: 0, extra: {} },
      ASANA_CLIENT,
      asana.http,
    );
    assert.deepEqual(asana.state.revoked, ['asana-refresh-1']);
    assert.equal(await plugin.oauth?.refresh('asana-refresh-1', ASANA_CLIENT, asana.http, 10), 'ended');
    // A refusal that is not `invalid_grant` says nothing of the refresh token: the connection stays.
    await assert.rejects(
      plugin.oauth?.refresh(
        'asana-refresh-1',
        { ...ASANA_CLIENT, clientSecret: 'copied-wrong' },
        asana.http,
        10,
      ) as Promise<unknown>,
      StoreError,
    );
    assert.deepEqual(await plugin.oauth?.identify(tokens as NonNullable<typeof tokens>, asana.http), {
      label: 'Asana · Acme',
    });
  });

  it('takes a personal access token that Asana knows, and refuses one it does not, or that is no token', async () => {
    const asana = fakeAsana();
    const context = { http: asana.http, now: Date.now };

    assert.deepEqual(await plugin.connect?.({ token: ` ${PERSONAL} ` }, context), {
      label: 'Asana · Acme',
      token: PERSONAL,
    });
    await assert.rejects(
      plugin.connect?.({ token: '2/1200000000000001/9:ffffffffffffffffffffffffffffffff' }, context) as Promise<unknown>,
      TrackerKeyRefused,
    );
    for (const wrong of ['', 'pk_123', '2/short', 'a b c d e f g h i j k l m n o p', 7]) {
      await assert.rejects(plugin.connect?.({ token: wrong }, context) as Promise<unknown>, TrackerInputRefused);
    }
  });

  it('lists the projects of each workspace, a page at a time, and finds one by its name', async () => {
    const asana = fakeAsana();
    assert.deepEqual(await plugin.places(accessTo(asana), {}), {
      places: [
        { id: PROJECT, name: 'Website' },
        { id: '1200000000000011', name: 'Mobile app' },
      ],
    });
    assert.deepEqual((await plugin.places(accessTo(asana), { search: 'mob' })).places, [
      { id: '1200000000000011', name: 'Mobile app' },
    ]);

    asana.state.projects = Array.from({ length: 130 }, (_, index) => ({
      gid: String(1200000000001000 + index),
      name: `P${index}`,
      workspace: WORKSPACE,
    }));
    const first = await plugin.places(accessTo(asana), {});
    assert.equal(first.places.length, 100);
    assert.equal(first.next, '0.100');
    const second = await plugin.places(accessTo(asana), { after: first.next as string });
    assert.equal(second.places.length, 30);
    assert.equal(second.next, undefined);
  });

  it('reads a place as a project, and names it as Asana does now', async () => {
    const asana = fakeAsana();
    assert.equal(plugin.readPlace(PROJECT), PROJECT);
    for (const wrong of ['', 'abc', '12 3', 12, undefined, '../1']) assert.equal(plugin.readPlace(wrong), undefined);
    assert.deepEqual(await plugin.placeName(accessTo(asana), PROJECT), { name: 'Website' });
    asana.state.hidden.add(PROJECT);
    assert.equal(await plugin.placeName(accessTo(asana), PROJECT), undefined, 'a project the token cannot see');
  });
});

describe('a note in Asana (FRU-626)', () => {
  it('becomes a task of the project, with the tag of its site and its page, and the note in its notes', async () => {
    const asana = fakeAsana();
    const store = plugin.store(accessTo(asana), { connector: 'con_1' });
    const created = await store.create(note(), { teamId: PROJECT }, POLICY);

    assert.deepEqual(created, {
      id: '1500000000000001',
      identifier: '#1500000000000001',
      url: `https://app.asana.com/0/${PROJECT}/1500000000000001`,
    });
    assert.deepEqual(
      asana.state.tags.map((each) => each.name),
      [pageTag(PROJECT, PAGE, 'site_1')],
    );
    const parsed = parseNoteFromDescription(asana.state.tasks[0]?.notes);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.note, note());

    // The tag is found again for the next note of the page: one tag, two tasks.
    await store.create(note(), { teamId: PROJECT }, POLICY);
    assert.equal(asana.state.tags.length, 1);
    assert.equal(asana.state.tasks[1]?.tags[0], asana.state.tags[0]?.gid);
  });

  it('takes the tag of its exact name, not one the typeahead finds near it', async () => {
    const asana = fakeAsana();
    const store = plugin.store(accessTo(asana), { connector: 'con_1' });
    // A tag whose name begins like the tag of this page, as a fuzzy typeahead answers it.
    const near = `${pageTag(PROJECT, PAGE, 'site_1').slice(0, 20)}zzzz`;
    asana.state.tags.push({ gid: '1400000000000099', name: near, workspace: WORKSPACE });

    await store.create(note(), { teamId: PROJECT }, POLICY);
    assert.notEqual(asana.state.tasks[0]?.tags[0], '1400000000000099');
  });

  it('sends its files, and keeps the note when Asana refuses them', async () => {
    const asana = fakeAsana();
    const store = plugin.store(accessTo(asana), { connector: 'con_1' });
    const png = { id: 'f1', name: 'capture.png', type: 'image/png', content: new Uint8Array([0x89, 0x50]) };

    assert.deepEqual((await store.create(note(), { teamId: PROJECT }, POLICY, [png])).files, {
      sent: ['f1'],
      lost: [],
      waiting: [],
    });
    assert.deepEqual(asana.state.tasks[0]?.attachments, [{ name: 'capture.png', type: 'image/png', size: 2 }]);
    asana.state.attachmentsOff = true;
    assert.deepEqual((await store.create(note(), { teamId: PROJECT }, POLICY, [png])).files, {
      sent: [],
      lost: ['f1'],
      waiting: [],
    });
  });

  it('reads the tasks of the tag of a page, with the stage of their section or of their completion, and their comments', async () => {
    const asana = fakeAsana();
    const store = plugin.store(accessTo(asana), { connector: 'con_1' });
    assert.deepEqual(
      await store.findForPage({ url: PAGE, clientId: 'site_1' }, { teamId: PROJECT }, POLICY),
      [],
      'no tag yet',
    );
    await store.create(note(), { teamId: PROJECT }, POLICY);
    await store.create(note(), { teamId: PROJECT }, POLICY);
    const [first, second] = asana.state.tasks;
    assert.ok(first !== undefined && second !== undefined);
    first.section = { gid: '1300000000000002', name: 'Doing' };
    second.completed = true;
    first.stories.push(
      {
        gid: 's1',
        type: 'system',
        text: 'Mia moved this task',
        created_at: '2026-11-08T11:00:00.000Z',
        created_by: { name: 'Mia' },
      },
      {
        gid: 's2',
        type: 'comment',
        text: 'On it.',
        created_at: '2026-11-08T11:05:00.000Z',
        created_by: { name: 'Mia' },
      },
    );

    const read = await store.findForPage({ url: PAGE, clientId: 'site_1' }, { teamId: PROJECT }, POLICY);
    assert.deepEqual(
      read.map(({ stage, stateName, status }) => ({ stage, stateName, status })),
      [
        { stage: 'new', stateName: 'Doing', status: 'con_1:1300000000000002' },
        { stage: 'done', stateName: 'Completed', status: `con_1:${COMPLETED}` },
      ],
    );
    assert.deepEqual(read[0]?.comments, [
      { id: 's2', body: 'On it.', createdAt: '2026-11-08T11:05:00.000Z', author: 'Mia' },
    ]);

    // A site gives the section « Doing » its stage (FRU-368).
    const staged = plugin.store(accessTo(asana), { connector: 'con_1', stages: { '1300000000000002': 'progress' } });
    assert.equal(
      (await staged.findForPage({ url: PAGE, clientId: 'site_1' }, { teamId: PROJECT }, POLICY))[0]?.stage,
      'progress',
    );
  });

  it('keeps off a task of another project and one of another client, and reads every page of the tag', async () => {
    const asana = fakeAsana();
    const store = plugin.store(accessTo(asana), { connector: 'con_1' });
    await store.create(note(), { teamId: '1200000000000011' }, POLICY);
    await store.create(note('site_2'), { teamId: PROJECT }, POLICY);
    assert.deepEqual(await store.findForPage({ url: PAGE, clientId: 'site_1' }, { teamId: PROJECT }, POLICY), []);

    for (let index = 0; index < 120; index += 1) await store.create(note(), { teamId: PROJECT }, POLICY);
    const quiet = { ...POLICY, showComments: false };
    const read = await store.findForPage({ url: PAGE, clientId: 'site_1' }, { teamId: PROJECT }, quiet);
    assert.equal(read.length, 120);
  });

  it('gives each project its own tag, so another project never fills the pages of a read', async () => {
    const asana = fakeAsana();
    const store = plugin.store(accessTo(asana), { connector: 'con_1' });
    for (let index = 0; index < 150; index += 1) await store.create(note(), { teamId: '1200000000000011' }, POLICY);
    await store.create(note(), { teamId: PROJECT }, POLICY);

    assert.notEqual(pageTag(PROJECT, PAGE, 'site_1'), pageTag('1200000000000011', PAGE, 'site_1'));
    const read = await store.findForPage({ url: PAGE, clientId: 'site_1' }, { teamId: PROJECT }, POLICY);
    assert.equal(read.length, 1);
  });

  it('lists the sections of the project, then « Completed »', async () => {
    const store = plugin.store(accessTo(fakeAsana()), { connector: 'con_1' });

    assert.deepEqual(await store.trackerStates?.({ teamId: PROJECT }), [
      { id: '1300000000000001', name: 'To do', stage: 'new' },
      { id: '1300000000000002', name: 'Doing', stage: 'new' },
      { id: COMPLETED, name: 'Completed', stage: 'done' },
    ]);
  });

  it('says a token that Asana refuses, a project it hides, and an Asana that is down, apart', async () => {
    const asana = fakeAsana();
    const store = plugin.store(accessTo(asana), { connector: 'con_1' });
    asana.state.next = { status: 401 };
    await assert.rejects(store.create(note(), { teamId: PROJECT }, POLICY), TrackerKeyRefused);
    asana.state.hidden.add(PROJECT);
    await assert.rejects(store.create(note(), { teamId: PROJECT }, POLICY), TrackerKeyForbidden);
    asana.state.hidden.clear();
    asana.state.next = { status: 429 };
    await assert.rejects(
      store.create(note(), { teamId: PROJECT }, POLICY),
      (error: unknown) =>
        error instanceof StoreError && !(error instanceof TrackerKeyRefused) && !(error instanceof TrackerKeyForbidden),
    );
    await assert.rejects(store.create(note(), { teamId: 'nope' }, POLICY), StoreError);
  });
});

describe('a workspace connects Asana (FRU-626)', () => {
  const worldWith = worlds();

  async function envWith(overrides: Partial<WorkerEnv> = {}) {
    const asana = fakeAsana();
    const world = await worldWith({
      env: {
        FRUITBACK_STORE: 'postgres',
        FRUITBACK_SECRETS_KEY: SECRETS_KEY,
        FRUITBACK_ASANA_OAUTH: `${ASANA_CLIENT.clientId}:${ASANA_CLIENT.clientSecret}`,
        ...overrides,
      } as Partial<WorkerEnv>,
    });
    const env: World = {
      ...world,
      context: { ...world.context, store: createPostgresNoteStore(world.database), trackerHttp: asana.http },
    };

    return { env, asana };
  }

  async function acme(env: World) {
    const { id, token } = await signInTo(env, 'owner@acme.dev');
    const workspace = await env.accounts.createWorkspace('Acme', id);
    const site = await env.accounts.addSite(workspace.id, { origin: SITE, visibility: 'everyone' });

    return { token, workspace, site, base: `/console/workspaces/${workspace.id}` };
  }

  it('by consent at Asana, then a site writes its notes there and reads their pins, and the consent is revoked when it goes', async () => {
    const { env, asana } = await envWith();
    const { token, workspace, site, base } = await acme(env);

    const asked = await callOn(env, 'POST', `${base}/connectors/asana/oauth`, { token });
    const { url } = (await asked.json()) as { url: string };
    const started = await callOn(env, 'GET', new URL(url).pathname + new URL(url).search);
    const at = new URL(started.headers.get('Location') as string);
    assert.equal(`${at.origin}${at.pathname}`, 'https://app.asana.com/-/oauth_authorize');
    const cookie = (started.headers.get('Set-Cookie') ?? '').split(';')[0] as string;
    asana.state.codes.set('code-1', at.searchParams.get('code_challenge') as string);
    const back = await callOn(env, 'GET', `/auth/asana/callback?code=code-1&state=${at.searchParams.get('state')}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(back.headers.get('Location'), `${CONSOLE}/w/${workspace.id}/connectors?asana=connected`);
    const [connector] = await env.accounts.connectors(workspace.id);
    assert.equal(connector?.label, 'Asana · Acme');

    const set = await callOn(env, 'POST', `${base}/sites/${site.id}/destination`, {
      token,
      body: { connector: connector?.id, teamId: PROJECT },
    });
    assert.equal(set.status, 200, await set.clone().text());
    assert.equal((await env.accounts.sites(workspace.id))[0]?.destinations[0]?.label, 'Asana · Website');
    const written = await callOn(env, 'POST', '/feedback', { origin: SITE, body: note(site.id) });
    assert.equal(written.status, 201, await written.clone().text());
    const read = await callOn(env, 'GET', `/feedback?url=${encodeURIComponent(PAGE)}&client=${site.id}`, {
      origin: SITE,
    });
    const pins = (await read.json()) as { issues: { stage: string }[] };
    assert.deepEqual(
      pins.issues.map(({ stage }) => stage),
      ['new'],
    );

    const gone = await callOn(env, 'DELETE', `${base}/connectors/${connector?.id}`, { token });
    assert.equal(gone.status, 204);
    assert.deepEqual(asana.state.revoked, ['asana-refresh-1']);
  });

  it('by a personal access token, on a server with no Asana app, kept sealed and never answered', async () => {
    const { env } = await envWith({ FRUITBACK_ASANA_OAUTH: undefined } as Partial<WorkerEnv>);
    const { token, workspace, base } = await acme(env);

    const listed = await callOn(env, 'GET', `${base}/connectors`, { token });
    const offers = ((await listed.json()) as { trackers: { kind: string }[] }).trackers;
    assert.deepEqual(
      offers.find((each) => each.kind === 'asana'),
      { kind: 'asana', oauth: false, token: true },
    );
    const made = await callOn(env, 'POST', `${base}/connectors`, { token, body: { kind: 'asana', token: PERSONAL } });
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
