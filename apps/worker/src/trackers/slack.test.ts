import assert from 'node:assert/strict';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { afterEach, describe, it, vi } from 'vitest';
import { mockMethod } from '../mock.fixture.ts';
import type { ClientConfig, ClientPolicy } from '../clients.ts';
import { createConnectorStores } from '../connectors.ts';
import { type World, callOn, signInTo, worlds } from '../console-world.fixture.ts';
import { createMemoryStore } from '../linear-memory.ts';
import { deliverDue } from '../rest-connector.ts';
import { open } from '../secrets.ts';
import { readTrackerCredential } from './plugin.ts';
import { escapeSlack, noteLink, readWebhook, slackMessage, slackTakes } from './slack.ts';

/**
 * The connector Slack (FRU-624) against a fake Slack, through the routes a browser calls and the loop
 * that sends the deliveries. The fake answers as « Sending messages using incoming webhooks » says
 * (read on 2026-11-08): `200` with the body `ok`, and an error as a short word in the body
 * (`no_service`, `invalid_token`, `channel_is_archived`, `invalid_payload`), with `429` and
 * `Retry-After` for the rate.
 */

const SECRETS_KEY = 'a-secret-that-opens-the-connectors-of-slack';
const SITE = 'https://staging.acme.dev';
const HOOK = 'https://hooks.slack.com/services/T0ACME01/B0NOTES1/abcDEF0123456789xyz';
const POLICY: ClientPolicy = {
  showComments: true,
  identitySecret: undefined,
  read: 'public',
  write: 'public',
  locale: 'en',
};

function fakeSlack() {
  const state = {
    posts: [] as { url: string; body: Record<string, unknown> }[],
    /** The answer of the next posts: a status and the word of Slack. */
    answer: { status: 200, word: 'ok' } as { status: number; word: string },
  };
  const http = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith('https://hooks.slack.com/services/')) throw new TypeError(`fetch failed: ${url}`);
    state.posts.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });

    return new Response(state.answer.word, {
      status: state.answer.status,
      headers: state.answer.status === 429 ? { 'Retry-After': '1' } : {},
    });
  }) as typeof fetch;

  return { state, http };
}

const opened = worlds();

async function setup() {
  const slack = fakeSlack();
  const world = await opened({ env: { FRUITBACK_STORE: 'postgres', FRUITBACK_SECRETS_KEY: SECRETS_KEY } });
  const env: World = { ...world, context: { ...world.context, trackerHttp: slack.http } };
  const { id, token } = await signInTo(env, 'owner@acme.dev');
  const workspace = await env.accounts.createWorkspace('Acme', id);
  const site = await env.accounts.addSite(workspace.id, { origin: SITE, visibility: 'everyone' });

  return { env, slack, token, workspace, site, base: `/console/workspaces/${workspace.id}` };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function connect(world: Setup, body: Record<string, unknown>) {
  return callOn(world.env, 'POST', `${world.base}/connectors`, {
    token: world.token,
    body: { kind: 'slack', ...body },
  });
}

/** A note kept through the connector of the site, as `POST /feedback` keeps it. */
async function keep(world: Setup, connector: string, verified: boolean, files = 0) {
  const stores = createConnectorStores(world.env.accounts, SECRETS_KEY, Date.now, undefined, { filesReachable: true });
  const store = await stores(connector, world.workspace.id, createMemoryStore());
  const base = noteFixture();
  const note = {
    ...base,
    id: `sd_${verified ? 'known' : 'visitor'}_${Math.random().toString(36).slice(2, 8)}`,
    page: { ...base.page, url: `${SITE}/pricing` },
    client: { id: world.site.id },
    reporter: verified ? { id: 'user_42', name: 'Mia', verified: true as const } : { name: 'Somebody' },
  };
  const client = { id: world.site.id, workspace: world.workspace.id, connector, origins: [SITE] } as ClientConfig;
  const content = new Uint8Array([137, 80, 78, 71]);

  return store.create(
    note,
    client,
    POLICY,
    Array.from({ length: files }, (_, index) => ({
      id: `att_${index}`,
      name: 'capture.png',
      type: 'image/png',
      content,
    })),
  );
}

describe('the message of a note in Slack (FRU-624)', () => {
  it('takes an Incoming Webhook of Slack only, and names it by its team and its hook', () => {
    assert.deepEqual(readWebhook(` ${HOOK} `), { url: HOOK, label: 'Slack · T0ACME01/B0NOTES1' });
    for (const refused of [
      'https://hooks.slack.com/workflows/T0ACME01/A01/123/abcDEF0123456789',
      'http://hooks.slack.com/services/T0ACME01/B0NOTES1/abcDEF0123456789xyz',
      'https://hooks.slack.com.evil.dev/services/T0ACME01/B0NOTES1/abcDEF0123456789xyz',
      'https://hooks.slack.com/services/T0ACME01/B0NOTES1/abcDEF0123456789xyz?x=1',
      42,
    ]) {
      assert.equal(readWebhook(refused), undefined, String(refused));
    }
  });

  it('posts the note with its link, its element and its capture, escaped', () => {
    const base = noteFixture();
    const note = {
      ...base,
      text: 'Price <b> & "plan" > here <!channel>',
      reporter: { name: 'Mia', verified: true as const },
    };
    const message = slackMessage({
      version: 2,
      event: 'note.created',
      workspace: 'ws',
      site: { id: 's1' },
      identifier: 'FB-12',
      note,
      attachments: [
        { name: 'capture.png', type: 'image/png', size: 4, url: 'https://api.acme.dev/a/1?s=x', expiresAt: '' },
        { name: 'log.txt', type: 'text/plain', size: 4, url: 'https://api.acme.dev/a/2?s=y', expiresAt: '' },
      ],
    });
    const text = JSON.stringify(message.blocks);
    assert.equal(noteLink(note), `${base.page.url}#fruitback-note=${base.id}`);
    assert.ok(text.includes(`<${noteLink(note)}|FB-12 · Pricing — Acme>`), text);
    assert.ok(text.includes('Price &lt;b&gt; &amp; \\"plan\\" &gt; here'), text);
    assert.ok(text.includes('`[data-testid=\\"checkout-cta\\"]`'), text);
    assert.ok(text.includes('CheckoutCta · src/components/checkout-cta.tsx:42'), text);
    assert.deepEqual(
      message.blocks.filter((block) => (block as { type: string }).type === 'image'),
      [{ type: 'image', image_url: 'https://api.acme.dev/a/1?s=x', alt_text: 'capture.png' }],
    );
    assert.ok(text.includes('<https://api.acme.dev/a/2?s=y|log.txt>'), text);
    // Nothing a visitor writes is markup of Slack: no mention of the channel (review of #871).
    assert.equal(message.text.startsWith('FB-12: Price &lt;b&gt; &amp;'), true, message.text);
    assert.equal(JSON.stringify(message).includes('<!channel>'), false);
    assert.ok(JSON.stringify(message).includes('&lt;!channel&gt;'));
    assert.equal(escapeSlack('a&<>'), 'a&amp;&lt;&gt;');
  });

  it('posts a verified note by default, and every note when the connector says so', () => {
    assert.equal(slackTakes({ reporter: { name: 'x', verified: true } }, 'verified'), true);
    assert.equal(slackTakes({ reporter: { name: 'x' } }, 'verified'), false);
    assert.equal(slackTakes({}, undefined), false);
    assert.equal(slackTakes({ reporter: { name: 'x' } }, 'all'), true);
  });
});

describe('a Slack connector through the routes and the deliveries (FRU-624)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('posts with the fetch of the worker when the loop of the server hands no http (review of #871)', async () => {
    const world = await setup();
    const { id } = (await (await connect(world, { url: HOOK })).json()) as { id: string };
    await keep(world, id, true);
    // `server.ts` calls `deliverDue` with no `http`: `trackerAccess` then takes the global `fetch`.
    const posted: string[] = [];
    mockMethod(globalThis, 'fetch', async (url: unknown) => {
      posted.push(String(url));

      return new Response('ok', { status: 200 });
    });
    const pass = await deliverDue({
      accounts: world.env.accounts,
      secretsKey: SECRETS_KEY,
      send: async () => ({ status: 500 }),
    });
    assert.deepEqual(pass, { delivered: 1, failed: 0 });
    assert.deepEqual(posted, [HOOK]);
  });

  it('keeps a note when the credential of the connector does not open, and queues it (review of #871)', async () => {
    const world = await setup();
    const { id } = (await (await connect(world, { url: HOOK })).json()) as { id: string };
    await world.env.accounts.resealConnector(id, 'sealed-by-another-key');
    const kept = await keep(world, id, false);
    assert.match(kept.identifier, /.+/);
    assert.equal((await world.env.accounts.dueDeliveries(Date.now(), 10)).length, 1);
  });

  it('refuses what is no webhook, and keeps none that Slack refuses', async () => {
    const world = await setup();
    for (const [body, error] of [
      [{ url: 'https://example.com/hook' }, 'invalid-webhook'],
      [{ url: HOOK, notes: 'some' }, 'invalid-setting'],
    ] as const) {
      const refused = await connect(world, body);
      assert.equal(refused.status, 400);
      assert.deepEqual(await refused.json(), { error });
    }
    world.slack.state.answer = { status: 404, word: 'no_service' };
    const gone = await connect(world, { url: HOOK });
    assert.equal(gone.status, 400);
    assert.deepEqual(await gone.json(), { error: 'key-refused' });
    assert.deepEqual(await world.env.accounts.connectors(world.workspace.id), []);
  });

  it('says in the channel that it is connected, and keeps the webhook sealed with its setting', async () => {
    const world = await setup();
    const made = await connect(world, { url: HOOK, notes: 'all' });
    assert.equal(made.status, 201, await made.clone().text());
    const connector = (await made.json()) as { id: string; label: string };
    assert.equal(connector.label, 'Slack · T0ACME01/B0NOTES1');
    assert.match(String(world.slack.state.posts[0]?.body.text), /^Fruitback is connected: each note/);
    const kept = await world.env.accounts.sealedKey(connector.id);
    assert.ok(!(kept?.sealed ?? '').includes('abcDEF0123456789xyz'));
    assert.deepEqual(readTrackerCredential(open(kept?.sealed as string, SECRETS_KEY) as string), {
      via: 'token',
      token: HOOK,
      extra: { notes: 'all' },
    });
    const listed = await callOn(world.env, 'GET', `${world.base}/connectors`, { token: world.token });
    assert.equal((await listed.text()).includes('abcDEF0123456789xyz'), false);

    const set = await callOn(world.env, 'POST', `${world.base}/sites/${world.site.id}/destination`, {
      token: world.token,
      body: { connector: connector.id, teamId: 'channel' },
    });
    assert.equal(set.status, 200, await set.clone().text());
  });

  it('posts a verified note with its capture, and keeps a visitor note in Fruitback only', async () => {
    const world = await setup();
    const { id } = (await (await connect(world, { url: HOOK })).json()) as { id: string };
    world.slack.state.posts = [];

    const visitor = await keep(world, id, false, 1);
    // Not sent: its file has nowhere to wait, and the worker removes it now.
    assert.deepEqual(visitor.files, { sent: [], lost: ['att_0'], waiting: [] });
    const known = await keep(world, id, true, 1);
    assert.deepEqual(known.files, { sent: [], lost: [], waiting: ['att_0'] });
    assert.equal((await world.env.accounts.dueDeliveries(Date.now(), 10)).length, 1);

    const pass = await deliverDue({
      accounts: world.env.accounts,
      secretsKey: SECRETS_KEY,
      send: async () => ({ status: 500 }),
      publicUrl: 'https://api.fruitback.test',
      http: world.slack.http,
    });
    assert.deepEqual(pass, { delivered: 1, failed: 0 });
    const [post] = world.slack.state.posts;
    assert.equal(post?.url, HOOK);
    assert.match(String(post?.body.text), new RegExp(`^${known.identifier}: `));
    assert.ok(JSON.stringify(post?.body.blocks).includes('#fruitback-note=sd_known_'));
  });

  it('gives up and says it on the connector when Slack refuses the webhook, and tries a Slack that is down again', async () => {
    const world = await setup();
    const { id } = (await (await connect(world, { url: HOOK })).json()) as { id: string };
    const pass = () =>
      deliverDue({
        accounts: world.env.accounts,
        secretsKey: SECRETS_KEY,
        send: async () => ({ status: 500 }),
        http: world.slack.http,
      });
    const attention = async () =>
      (await world.env.accounts.connectors(world.workspace.id)).find((each) => each.id === id)?.attention?.reason;
    const pending = async () => world.env.accounts.deliveries(world.workspace.id, id);

    world.slack.state.answer = { status: 503, word: 'service_unavailable' };
    await keep(world, id, true);
    assert.deepEqual(await pass(), { delivered: 0, failed: 1 });
    assert.notEqual((await pending())[0]?.nextAt, undefined, 'a Slack that is down is tried again');
    assert.equal(await attention(), undefined);

    await world.env.accounts.retryDelivery(world.workspace.id, id, (await pending())[0]?.id as string, Date.now());
    world.slack.state.answer = { status: 404, word: 'no_service' };
    await pass();
    const [given] = await pending();
    assert.equal(given?.nextAt, undefined, 'a webhook that is gone is not tried again');
    assert.match(given?.lastError ?? '', /no_service/);
    assert.equal(await attention(), 'key-refused');

    await world.env.accounts.retryDelivery(world.workspace.id, id, given?.id as string, Date.now());
    world.slack.state.answer = { status: 410, word: 'channel_is_archived' };
    await pass();
    assert.equal(await attention(), 'key-lacks-access');

    world.slack.state.answer = { status: 200, word: 'ok' };
    await world.env.accounts.retryDelivery(world.workspace.id, id, (await pending())[0]?.id as string, Date.now());
    assert.deepEqual(await pass(), { delivered: 1, failed: 0 });
    assert.equal(await attention(), undefined, 'a post that arrives ends the attention');
  });
});
