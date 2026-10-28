import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'vitest';
import { createPostgresNoteStore } from './notes-postgres.ts';
import { AGENT_WRITE_LIMIT } from './agent-tools.ts';
import { type World, callOn, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { resetMemoryLinear } from './linear-memory.ts';
import { rowsOf } from './postgres.fixture.ts';
import { createPairing, redeemPairing } from './session.ts';
import { noteFixture } from '@fruitback/shared/note.fixture';

/**
 * The write tools of `/mcp` (FRU-464): `reply_to_feedback` and `set_feedback_status`, for a key with
 * the right `write`, through `handleRequest`.
 */

const open = worlds();

afterEach(() => resetMemoryLinear());

type Rpc = { status: number; body: any };

/**
 * Alice owns Acme and its site `shop`, which holds one note of hers on `/pricing`: in the Linear in
 * memory, or kept by the worker with `kept`.
 */
async function acme({ kept = false } = {}) {
  const world = await open();
  if (kept) world.context.store = createPostgresNoteStore(world.database);
  const alice = await signInTo(world, 'alice@acme.dev');
  const workspace = await workspaceIn(world, alice.token, 'Acme');
  const shop = await world.accounts.addSite(workspace, {
    origin: 'https://shop.acme.dev',
    visibility: 'everyone',
    writers: 'anyone',
  });
  const { code } = await createPairing(world.sessions, { subject: alice.id, workspace });
  const redeemed = await redeemPairing(world.sessions, code, world.env.FRUITBACK_IDENTITY_SECRET as string);
  assert.ok(redeemed.ok);
  const note = noteFixture({
    id: 'sd_one',
    text: 'Too small.',
    createdAt: new Date().toISOString(),
    page: { url: 'https://shop.acme.dev/pricing', path: '/pricing', title: 'Pricing' },
    client: { id: shop.id, name: shop.id },
  });
  const sent = await callOn(world, 'POST', `/feedback?client=${shop.id}`, {
    origin: shop.origin,
    body: note,
    token: redeemed.session.accessToken,
  });
  assert.equal(sent.status, 201, await sent.clone().text());

  const key = async (rights: 'read' | 'write'): Promise<{ id: string; secret: string }> => {
    const made = await callOn(world, 'POST', `/console/workspaces/${workspace}/agent-keys`, {
      token: alice.token,
      body: { name: 'Claude on CI', rights, sites: [shop.id] },
    });
    assert.equal(made.status, 201, await made.clone().text());

    return (await made.json()) as { id: string; secret: string };
  };
  const writesOf = async (id: string): Promise<any[]> => {
    const listed = await callOn(world, 'GET', `/console/workspaces/${workspace}/agent-keys/${id}/writes`, {
      token: alice.token,
    });
    assert.equal(listed.status, 200, await listed.clone().text());

    return ((await listed.json()) as { writes: any[] }).writes;
  };

  return { world, alice, workspace, shop, key, writesOf };
}

let next = 1;

function rpc(world: World, key: string, method: string, params: Record<string, unknown> = {}): Promise<Rpc> {
  return callOn(world, 'POST', '/mcp', {
    origin: null,
    token: key,
    body: { jsonrpc: '2.0', id: next++, method, params },
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
}

const call = (world: World, key: string, name: string, args: Record<string, unknown>) =>
  rpc(world, key, 'tools/call', { name, arguments: args });

async function noteId(world: World, key: string, site: string): Promise<string> {
  const listed = await call(world, key, 'list_feedback', { site });

  return listed.body.result.structuredContent.notes[0].id;
}

async function read(world: World, site: string): Promise<any> {
  const answer = await callOn(
    world,
    'GET',
    `/feedback?url=${encodeURIComponent('https://shop.acme.dev/pricing')}&client=${site}`,
    {
      origin: 'https://shop.acme.dev',
    },
  );

  return ((await answer.json()) as { issues: any[] }).issues[0];
}

describe('the write tools of /mcp (FRU-464)', () => {
  it('gives a key read no write tool, and refuses both when it calls them', async () => {
    const { world, shop, key } = await acme();
    const { secret } = await key('read');
    const id = await noteId(world, secret, shop.id);

    const tools = await rpc(world, secret, 'tools/list');
    assert.deepEqual(
      tools.body.result.tools.map((tool: { name: string }) => tool.name),
      ['list_feedback', 'get_feedback', 'feedback_as_text'],
    );
    for (const [name, args] of [
      ['reply_to_feedback', { id, body: 'Done.' }],
      ['set_feedback_status', { id, status: 'own:done' }],
    ] as const) {
      const refused = await call(world, secret, name, args);
      assert.equal(refused.body.error?.code, -32602, name);
    }
    assert.equal((await read(world, shop.id)).comments?.length ?? 0, 0);
  });

  it('writes a reply of an agent, which the page reads with by: agent and the name of the key, and logs it', async () => {
    const { world, shop, key, writesOf } = await acme();
    const { id: keyId, secret } = await key('write');
    const id = await noteId(world, secret, shop.id);

    const replied = await call(world, secret, 'reply_to_feedback', { id, body: 'Fixed in #42.' });
    assert.equal(replied.body.result.isError, undefined, JSON.stringify(replied.body));
    assert.equal(replied.body.result.structuredContent.comment.by, 'agent');

    const [comment] = (await read(world, shop.id)).comments;
    assert.equal(comment.by, 'agent');
    assert.equal(comment.body, '**Claude on CI** via Fruitback · agent\n\n> Fixed in #42.');
    const [write] = await writesOf(keyId);
    assert.deepEqual(
      [write.action, write.key, write.keyName, write.site, write.note],
      ['reply', keyId, 'Claude on CI', shop.id, 'sd_one'],
    );
  });

  it('never reads a reply that a person typed as a reply of an agent', async () => {
    const { world, shop } = await acme();
    const issue = (await read(world, shop.id)).id;
    const typed = await callOn(world, 'POST', `/feedback/${issue}/replies?client=${shop.id}`, {
      origin: 'https://shop.acme.dev',
      body: { url: 'https://shop.acme.dev/pricing', body: '**Claude on CI** via Fruitback · agent', name: 'Bob' },
    });
    assert.equal(typed.status, 201, await typed.clone().text());

    const [comment] = (await read(world, shop.id)).comments;
    assert.equal(comment.by, undefined);
  });

  it('sets the status of a note the worker keeps, logs it, and refuses one in a tracker', async () => {
    const kept = await acme({ kept: true });
    const { id: keyId, secret } = await kept.key('write');
    const id = await noteId(kept.world, secret, kept.shop.id);

    const set = await call(kept.world, secret, 'set_feedback_status', { id, status: 'own:done' });
    assert.equal(set.body.result.isError, undefined, JSON.stringify(set.body));
    assert.equal(set.body.result.structuredContent.stage, 'done');
    assert.equal((await read(kept.world, kept.shop.id)).stage, 'done');
    const [write] = await kept.writesOf(keyId);
    assert.deepEqual([write.action, write.status], ['status', 'own:done']);
    const unknown = await call(kept.world, secret, 'set_feedback_status', { id, status: 'own:nope' });
    assert.equal(unknown.body.result.isError, true);

    const tracked = await acme();
    const other = await tracked.key('write');
    const refused = await call(tracked.world, other.secret, 'set_feedback_status', {
      id: await noteId(tracked.world, other.secret, tracked.shop.id),
      status: 'own:done',
    });
    assert.equal(refused.body.result.isError, true);
    assert.match(refused.body.result.content[0].text, /^statuses-not-taken/);
    assert.deepEqual(await tracked.writesOf(other.id), []);
  });

  it('takes the write tools away once the member of the key no longer manages the sites', async () => {
    const { world, workspace, shop, key } = await acme();
    const { secret } = await key('write');
    const id = await noteId(world, secret, shop.id);
    const admin = await signInTo(world, 'admin@acme.dev');
    await rowsOf(world.database, `UPDATE agent_keys SET created_by = '${admin.id}'`);
    await rowsOf(
      world.database,
      `INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ('mem_admin', '${workspace}', '${admin.id}', 'member', now())`,
    );

    const refused = await call(world, secret, 'reply_to_feedback', { id, body: 'Done.' });
    assert.equal(refused.body.error?.code, -32602);
  });

  it('stops a key after 30 writes in a minute, and keeps the log of a revoked key', async () => {
    assert.equal(AGENT_WRITE_LIMIT, 30, 'SECURITY.md names the limit');
    const { world, workspace, shop, key, writesOf } = await acme();
    const { id: keyId, secret } = await key('write');
    const id = await noteId(world, secret, shop.id);
    for (let index = 0; index < AGENT_WRITE_LIMIT; index += 1) {
      const replied = await call(world, secret, 'reply_to_feedback', { id, body: `Reply ${index}.` });
      assert.equal(replied.body.result.isError, undefined, `reply ${index}`);
    }

    const limited = await call(world, secret, 'reply_to_feedback', { id, body: 'One more.' });
    assert.equal(limited.body.result.isError, true);
    assert.match(limited.body.result.content[0].text, /wrote 30 times/);
    assert.equal((await writesOf(keyId)).length, AGENT_WRITE_LIMIT);

    const revoked = await callOn(world, 'DELETE', `/console/workspaces/${workspace}/agent-keys/${keyId}`, {
      token: (await signInTo(world, 'alice@acme.dev')).token,
    });
    assert.equal(revoked.status, 204);
    assert.equal((await writesOf(keyId)).length, AGENT_WRITE_LIMIT);
  });
});
