import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { type World, callOn, memberOf, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { rowsOf } from './postgres.fixture.ts';
import { FORMER_SLUG_MS, MAX_FORMER_SLUGS } from './workspace-slug.ts';

/**
 * The short name of a workspace (FRU-715): chosen from its name when it is made, changed by who
 * manages it with `slug` on `POST /console/workspaces/<id>`, and answered by `GET /console/me` with the
 * names it left in the last 30 days. Through `handleRequest`, on PostgreSQL (PGlite), with better-auth
 * on: the plugin makes the workspace and keeps the short name as its slug.
 */

const world = worlds();

type MeWorkspace = { id: string; name: string; slug: string; formerSlugs?: string[] };

async function workspacesOf(env: World, token: string): Promise<Record<string, MeWorkspace>> {
  const me = (await (await callOn(env, 'GET', '/console/me', { token })).json()) as { workspaces: MeWorkspace[] };

  return Object.fromEntries(me.workspaces.map((each) => [each.id, each]));
}

async function made(env: World, token: string, name: string): Promise<{ id: string; slug: string }> {
  const answer = await callOn(env, 'POST', '/console/workspaces', { token, body: { name } });
  assert.equal(answer.status, 201, await answer.clone().text());

  return (await answer.json()) as { id: string; slug: string };
}

/** Alice owns Acme, with one person of each other role in it; Mallory owns Evil. */
async function acme(env: World) {
  const alice = await signInTo(env, 'alice@acme.dev');
  const id = await workspaceIn(env, alice.token, 'Acme');
  const people: Record<string, { id: string; token: string }> = { owner: alice };
  for (const role of ['admin', 'member', 'guest']) {
    const person = await signInTo(env, `${role}@acme.dev`);
    await memberOf(env, id, person.id, role);
    people[role] = person;
  }
  const mallory = await signInTo(env, 'mallory@evil.dev');
  const other = await workspaceIn(env, mallory.token, 'Evil');
  const save = (token: string, body: Record<string, unknown>, workspace = id) =>
    callOn(env, 'POST', `/console/workspaces/${workspace}`, { token, body: { name: 'Acme', ...body } });

  return {
    id,
    other,
    alice,
    mallory,
    people: people as Record<'owner' | 'admin' | 'member' | 'guest', typeof alice>,
    save,
  };
}

describe('the short name of a workspace (FRU-715)', () => {
  it('is read in the name when the workspace is made, with a suffix when another one holds it', async () => {
    const env = await world();
    const alice = await signInTo(env, 'alice@acme.dev');

    assert.equal((await made(env, alice.token, 'Café Crème Studio')).slug, 'cafe-creme-studio');
    const first = await made(env, alice.token, 'Acme');
    const second = await made(env, alice.token, 'ACME');
    assert.equal(first.slug, 'acme');
    assert.match(second.slug, /^acme-[a-z0-9]{4}$/);
    // A name that gives a reserved word, or less than three characters, never gets it alone.
    assert.match((await made(env, alice.token, 'Admin')).slug, /^admin-[a-z0-9]{4}$/);
    assert.match((await made(env, alice.token, '工作室')).slug, /^workspace-[a-z0-9]{4}$/);
    // What the plugin kept is what `/console/me` answers.
    const mine = await workspacesOf(env, alice.token);
    assert.equal(mine[second.id]?.slug, second.slug);
    assert.deepEqual(await rowsOf(env.database, `SELECT slug FROM organization WHERE id = '${first.id}'`), [
      { slug: 'acme' },
    ]);
  });

  it('is changed by the owner and an admin, with the name, and answered to every member', async () => {
    const env = await world();
    const { id, people, save } = await acme(env);

    const answer = await save(people.owner.token, { slug: '  Acme-Studio ' });
    assert.equal(answer.status, 200);
    assert.deepEqual(await answer.json(), { id, name: 'Acme', slug: 'acme-studio', role: 'owner', logo: null });
    const byAdmin = await save(people.admin.token, { name: 'Acme Outdoor', slug: 'acme-outdoor' });
    assert.equal(byAdmin.status, 200);
    for (const reader of Object.values(people)) {
      const read = (await workspacesOf(env, reader.token))[id];
      assert.equal(read?.slug, 'acme-outdoor');
      assert.equal(read?.name, 'Acme Outdoor');
      assert.deepEqual(read?.formerSlugs, ['acme-studio', 'acme']);
    }
  });

  it('refuses a member and a guest, and changes nothing', async () => {
    const env = await world();
    const { id, alice, people, save } = await acme(env);

    for (const role of ['member', 'guest'] as const) {
      const answer = await save(people[role].token, { slug: 'taken-over' });
      assert.equal(answer.status, 403, role);
      assert.deepEqual(await answer.json(), { error: 'forbidden', role }, role);
    }
    assert.equal((await workspacesOf(env, alice.token))[id]?.slug, 'acme');
  });

  it('refuses a name another workspace holds with its code, and keeps the name of the call as it was', async () => {
    const env = await world();
    const { id, other, alice, mallory, save } = await acme(env);
    assert.equal((await workspacesOf(env, mallory.token))[other]?.slug, 'evil');

    const answer = await save(alice.token, { name: 'Acme renamed', slug: 'evil' });
    assert.equal(answer.status, 409);
    assert.deepEqual(await answer.json(), { error: 'slug-taken' });
    const read = (await workspacesOf(env, alice.token))[id];
    assert.equal(read?.slug, 'acme');
    // The slug is written first: its refusal leaves the name too.
    assert.equal(read?.name, 'Acme');
    // Its own name again is no change, and no name of before.
    const same = await save(alice.token, { slug: 'acme' });
    assert.equal(same.status, 200);
    assert.equal((await workspacesOf(env, alice.token))[id]?.formerSlugs, undefined);
  });

  it('keeps the rule of the form and the reserved words, each with its code', async () => {
    const env = await world();
    const { id, alice, save } = await acme(env);

    for (const slug of ['ab', 'a'.repeat(41), '-acme', 'acme-', 'ac_me', 'ac me', 'acmé', '', 42, null, ['acme']]) {
      const answer = await save(alice.token, { slug });
      assert.equal(answer.status, 400, JSON.stringify(slug));
      assert.deepEqual(await answer.json(), { error: 'invalid-slug' }, JSON.stringify(slug));
    }
    for (const slug of ['api', 'w', 'login', 'setup', 'admin', 'Settings']) {
      const answer = await save(alice.token, { slug });
      assert.equal(answer.status, 400, slug);
      assert.deepEqual(await answer.json(), { error: slug === 'w' ? 'invalid-slug' : 'reserved-slug' }, slug);
    }
    assert.equal((await workspacesOf(env, alice.token))[id]?.slug, 'acme');
    // The control: three characters, then forty, with a hyphen inside.
    assert.equal((await save(alice.token, { slug: 'a-1' })).status, 200);
    assert.equal((await save(alice.token, { slug: `a${'-'.repeat(38)}z` })).status, 200);
  });

  it('keeps the name a workspace left 30 days its own, then frees it', async () => {
    const env = await world();
    const { id, other, alice, mallory, save } = await acme(env);
    const before = Date.now();
    assert.equal((await save(alice.token, { slug: 'acme-new' })).status, 200);

    // Mallory cannot take it while it opens Acme.
    const taken = await save(mallory.token, { name: 'Evil', slug: 'acme' }, other);
    assert.equal(taken.status, 409);
    const [row] = await rowsOf(env.database, `SELECT workspace_id, until FROM workspace_former_slugs`);
    assert.equal(row?.workspace_id, id);
    const until = Number(row?.until);
    assert.ok(until >= before + FORMER_SLUG_MS && until <= Date.now() + FORMER_SLUG_MS, String(until));

    // Acme takes it back at once: it is its short name again, and no name of before.
    assert.equal((await save(alice.token, { slug: 'acme' })).status, 200);
    assert.deepEqual((await workspacesOf(env, alice.token))[id]?.formerSlugs, ['acme-new']);

    // 30 days on (the row says so), the name is free: Mallory takes it, and Acme reads it no more.
    await rowsOf(env.database, `UPDATE workspace_former_slugs SET until = ${Date.now() - 1}`);
    assert.equal((await workspacesOf(env, alice.token))[id]?.formerSlugs, undefined);
    assert.equal((await save(mallory.token, { name: 'Evil', slug: 'acme-new' }, other)).status, 200);
    assert.deepEqual(await rowsOf(env.database, `SELECT slug FROM workspace_former_slugs ORDER BY slug`), [
      { slug: 'evil' },
    ]);
  });

  it(`keeps ${MAX_FORMER_SLUGS} names a workspace left at most, the newest ones`, async () => {
    const env = await world();
    const { id, other, alice, mallory, save } = await acme(env);

    for (let each = 1; each <= MAX_FORMER_SLUGS + 2; each += 1) {
      assert.equal((await save(alice.token, { slug: `acme-${each}` })).status, 200);
    }
    const former = (await workspacesOf(env, alice.token))[id]?.formerSlugs;
    assert.deepEqual(former, ['acme-6', 'acme-5', 'acme-4', 'acme-3', 'acme-2']);
    // The oldest one is free for anybody at once.
    assert.equal((await save(mallory.token, { name: 'Evil', slug: 'acme' }, other)).status, 200);
  });

  it('answers a workspace somebody is not of as one that does not exist', async () => {
    const env = await world();
    const { id, alice, mallory, save } = await acme(env);

    const stranger = await save(mallory.token, { slug: 'mine-now' }, id);
    assert.equal(stranger.status, 404);
    assert.equal((await workspacesOf(env, alice.token))[id]?.slug, 'acme');
    // And `/console/me` gives the names of before to the members of the workspace alone.
    assert.equal((await save(alice.token, { slug: 'acme-two' })).status, 200);
    assert.equal(JSON.stringify(await workspacesOf(env, mallory.token)).includes('acme'), false);
  });
});
