import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { type AgentKey, MAX_AGENT_KEYS, type Reach } from './accounts.ts';
import { DEFAULT_KEY_DAYS, MAX_KEY_DAYS, MAX_KEY_SITES, newAgentKey, resolveAgentKey } from './agent-keys.ts';
import { type World, callOn, memberOf, shareWith, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { rowsOf } from './postgres.fixture.ts';
import { digest } from './session.ts';

const world = worlds();

const DAY_MS = 86_400_000;

type KeyView = {
  id: string;
  name: string;
  sites: { id: string; origin: string }[];
  rights: 'read' | 'write';
  verifiedOnly: boolean;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  secret?: string;
};

/** Alice owns Acme, with two sites and one person of each other role; Mallory owns Evil, with a site. */
async function acme(env: World) {
  const alice = await signInTo(env, 'alice@acme.dev');
  const id = await workspaceIn(env, alice.token, 'Acme');
  const people: Record<string, { id: string; token: string }> = { owner: alice };
  for (const role of ['admin', 'member', 'guest']) {
    const person = await signInTo(env, `${role}@acme.dev`);
    await memberOf(env, id, person.id, role);
    people[role] = person;
  }
  const site = async (token: string, workspace: string, url: string): Promise<string> => {
    const added = await callOn(env, 'POST', `/console/workspaces/${workspace}/sites`, { token, body: { url } });
    assert.equal(added.status, 201, await added.clone().text());

    return ((await added.json()) as { id: string }).id;
  };
  const shop = await site(alice.token, id, 'https://shop.acme.dev');
  // A key answers its sites oldest first: the pause gives each one its own instant.
  await new Promise((resolve) => setTimeout(resolve, 3));
  const blog = await site(alice.token, id, 'https://blog.acme.dev');
  const mallory = await signInTo(env, 'mallory@evil.dev');
  const evil = await workspaceIn(env, mallory.token, 'Evil');
  const evilSite = await site(mallory.token, evil, 'https://evil.dev');

  const make = (token: string | undefined, body: unknown, workspace = id, more: { origin?: string | null } = {}) =>
    callOn(env, 'POST', `/console/workspaces/${workspace}/agent-keys`, {
      ...(token === undefined ? {} : { token }),
      body,
      ...more,
    });
  const list = async (token = alice.token): Promise<KeyView[]> => {
    const listed = await callOn(env, 'GET', `/console/workspaces/${id}/agent-keys`, { token });
    assert.equal(listed.status, 200, await listed.clone().text());

    return ((await listed.json()) as { keys: KeyView[] }).keys;
  };

  return {
    id,
    alice,
    mallory,
    evil,
    evilSite,
    shop,
    blog,
    people: people as Record<'owner' | 'admin' | 'member' | 'guest', typeof alice>,
    make,
    list,
  };
}

async function made(answer: Response): Promise<KeyView & { secret: string }> {
  assert.equal(answer.status, 201, await answer.clone().text());

  return (await answer.json()) as KeyView & { secret: string };
}

describe('the agent keys of a workspace, in the console (FRU-461)', () => {
  it('lets the owner and an admin make a key, shown once, and lists it with no key and no digest', async () => {
    const env = await world();
    const { id, people, shop, blog, make, list } = await acme(env);

    const before = Date.now();
    const key = await made(
      await make(people.owner.token, { name: '  Claude  on CI ', sites: [blog, shop], rights: 'write' }),
    );
    assert.match(key.secret, /^fbk_[A-Za-z0-9_-]{43}$/);
    assert.equal(key.name, 'Claude on CI');
    assert.equal(key.rights, 'write');
    assert.equal(key.verifiedOnly, true, 'a key reads only the notes of a known person unless it says otherwise');
    assert.equal(key.createdBy, people.owner.id);
    assert.deepEqual(
      key.sites.map((site) => site.origin),
      ['https://shop.acme.dev', 'https://blog.acme.dev'],
    );
    const lives = Date.parse(key.expiresAt) - Date.parse(key.createdAt);
    assert.equal(lives, DEFAULT_KEY_DAYS * DAY_MS);
    assert.ok(Date.parse(key.createdAt) >= before - 1_000);

    const byAdmin = await made(
      await make(people.admin.token, { name: 'Reader', sites: [shop], rights: 'read', days: 7, verifiedOnly: false }),
    );
    assert.equal(Date.parse(byAdmin.expiresAt) - Date.parse(byAdmin.createdAt), 7 * DAY_MS);
    assert.notEqual(byAdmin.secret, key.secret);
    assert.equal(byAdmin.verifiedOnly, false);

    const listed = await list();
    assert.deepEqual(
      listed,
      [key, byAdmin].map(({ secret: _secret, ...view }) => view),
    );
    // The worker keeps the digest of each key, and never the key.
    const rows = await rowsOf(
      env.database,
      `SELECT * FROM agent_keys WHERE workspace_id = '${id}' ORDER BY created_at, id`,
    );
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => row.key_hash),
      [await digest(key.secret), await digest(byAdmin.secret)],
    );
    const stored = JSON.stringify(await rowsOf(env.database, 'SELECT * FROM agent_keys'));
    assert.ok(!stored.includes(key.secret) && !stored.includes(byAdmin.secret));
  });

  it('refuses a member and a guest, as every route of who manages a workspace, and writes nothing', async () => {
    const env = await world();
    const { id, people, shop, make, list } = await acme(env);
    const key = await made(await make(people.owner.token, { name: 'CI', sites: [shop], rights: 'read' }));

    for (const role of ['member', 'guest'] as const) {
      const token = people[role].token;
      const made = await make(token, { name: 'Mine', sites: [shop], rights: 'read' });
      assert.equal(made.status, 403, role);
      assert.deepEqual(await made.json(), { error: 'forbidden', role }, role);
      assert.equal((await callOn(env, 'GET', `/console/workspaces/${id}/agent-keys`, { token })).status, 403, role);
      const revoked = await callOn(env, 'DELETE', `/console/workspaces/${id}/agent-keys/${key.id}`, { token });
      assert.equal(revoked.status, 403, role);
    }
    assert.deepEqual(
      (await list()).map((each) => each.id),
      [key.id],
    );
  });

  it('answers a workspace somebody is not of as one that does not exist, nobody without a session, and no write with no Origin', async () => {
    const env = await world();
    const { id, mallory, people, shop, make, list } = await acme(env);

    const foreign = await make(mallory.token, { name: 'CI', sites: [shop], rights: 'read' });
    assert.equal(foreign.status, 404);
    assert.deepEqual(await foreign.json(), { error: 'not-found' });
    assert.equal(
      (await callOn(env, 'GET', `/console/workspaces/${id}/agent-keys`, { token: mallory.token })).status,
      404,
    );
    assert.equal((await make(undefined, { name: 'CI', sites: [shop], rights: 'read' })).status, 401);
    const noOrigin = await make(people.owner.token, { name: 'CI', sites: [shop], rights: 'read' }, id, {
      origin: null,
    });
    assert.equal(noOrigin.status, 403);
    assert.deepEqual(await list(), []);
  });

  it('refuses a name, sites, rights or days it cannot read, and a site of another workspace, and writes nothing', async () => {
    const env = await world();
    const { people, shop, evilSite, make, list } = await acme(env);
    const good = { name: 'CI', sites: [shop], rights: 'read' };
    const tooMany = Array.from({ length: MAX_KEY_SITES + 1 }, (_, index) => `site_${index}`);
    // At the bound the list is read, and its sites are then looked for in the workspace.
    const atTheBound = tooMany.slice(1);

    for (const [body, error] of [
      [{ ...good, name: '   ' }, 'invalid-name'],
      [{ ...good, name: 'x'.repeat(81) }, 'invalid-name'],
      [{ ...good, sites: [] }, 'invalid-sites'],
      [{ ...good, sites: shop }, 'invalid-sites'],
      [{ ...good, sites: [42] }, 'invalid-sites'],
      [{ ...good, sites: tooMany }, 'invalid-sites'],
      [{ ...good, sites: ['a site'] }, 'invalid-sites'],
      [{ ...good, sites: ['s'.repeat(65)] }, 'invalid-sites'],
      [{ ...good, rights: 'admin' }, 'invalid-rights'],
      [{ ...good, rights: undefined }, 'invalid-rights'],
      [{ ...good, days: 0 }, 'invalid-days'],
      [{ ...good, days: MAX_KEY_DAYS + 1 }, 'invalid-days'],
      [{ ...good, days: 1.5 }, 'invalid-days'],
      [{ ...good, days: null }, 'invalid-days'],
      [{ ...good, verifiedOnly: 'no' }, 'invalid-verified-only'],
      [{ ...good, verifiedOnly: null }, 'invalid-verified-only'],
      [{ ...good, sites: atTheBound }, 'unknown-site'],
      [{ ...good, sites: ['s'.repeat(64)] }, 'unknown-site'],
      [{ ...good, sites: [shop, evilSite] }, 'unknown-site'],
      [{ ...good, sites: ['site_none'] }, 'unknown-site'],
    ] as const) {
      const answer = await make(people.owner.token, body);
      assert.equal(answer.status, 400, JSON.stringify(body));
      assert.equal(((await answer.json()) as { error: string }).error, error, JSON.stringify(body));
    }
    assert.deepEqual(await list(), []);

    const longest = await made(await make(people.owner.token, { ...good, days: MAX_KEY_DAYS }));
    assert.equal(Date.parse(longest.expiresAt) - Date.parse(longest.createdAt), MAX_KEY_DAYS * DAY_MS);
  });

  it('answers 405 to a method that no route of the keys takes', async () => {
    const env = await world();
    const { id, people, shop, make } = await acme(env);
    const key = await made(await make(people.owner.token, { name: 'CI', sites: [shop], rights: 'read' }));

    for (const [method, path] of [
      ['PUT', `/console/workspaces/${id}/agent-keys`],
      ['DELETE', `/console/workspaces/${id}/agent-keys`],
      ['GET', `/console/workspaces/${id}/agent-keys/${key.id}`],
      ['POST', `/console/workspaces/${id}/agent-keys/${key.id}`],
    ] as const) {
      const answer = await callOn(env, method, path, {
        token: people.owner.token,
        ...(method === 'GET' ? {} : { body: {} }),
      });
      assert.equal(answer.status, 405, `${method} ${path}`);
    }
  });

  it(`holds ${MAX_AGENT_KEYS} keys in a workspace, and answers 409 past them`, async () => {
    const env = await world();
    const { people, shop, make, list } = await acme(env);
    for (let index = 0; index < MAX_AGENT_KEYS; index += 1) {
      await made(await make(people.owner.token, { name: `CI ${index}`, sites: [shop], rights: 'read' }));
    }

    const past = await make(people.owner.token, { name: 'One more', sites: [shop], rights: 'read' });
    assert.equal(past.status, 409);
    assert.deepEqual(await past.json(), { error: 'too-many-keys', max: MAX_AGENT_KEYS });
    assert.equal((await list()).length, MAX_AGENT_KEYS);
  });

  it('revokes a key of its workspace, after which the key reaches nothing', async () => {
    const env = await world();
    const { id, evil, evilSite, mallory, people, shop, make, list } = await acme(env);
    const key = await made(await make(people.admin.token, { name: 'CI', sites: [shop], rights: 'read' }));
    const theirs = await made(await make(mallory.token, { name: 'Theirs', sites: [evilSite], rights: 'read' }, evil));
    assert.ok((await resolveAgentKey(env.accounts, key.secret, Date.now())) !== undefined);

    // A key of another workspace, through the path of this one: as a key that does not exist.
    const across = await callOn(env, 'DELETE', `/console/workspaces/${id}/agent-keys/${theirs.id}`, {
      token: people.owner.token,
    });
    assert.equal(across.status, 404);
    assert.ok((await resolveAgentKey(env.accounts, theirs.secret, Date.now())) !== undefined);

    const revoked = await callOn(env, 'DELETE', `/console/workspaces/${id}/agent-keys/${key.id}`, {
      token: people.owner.token,
    });
    assert.equal(revoked.status, 204);
    assert.equal(await resolveAgentKey(env.accounts, key.secret, Date.now()), undefined);
    assert.deepEqual(await list(), []);
    const again = await callOn(env, 'DELETE', `/console/workspaces/${id}/agent-keys/${key.id}`, {
      token: people.owner.token,
    });
    assert.equal(again.status, 404);
  });

  it('refuses a new key and a revocation in a suspended workspace, whose owner still lists them', async () => {
    const env = await world();
    const { id, people, shop, make, list } = await acme(env);
    const key = await made(await make(people.owner.token, { name: 'CI', sites: [shop], rights: 'read' }));
    await rowsOf(env.database, `INSERT INTO workspace_suspensions (workspace_id, since) VALUES ('${id}', 1)`);

    const refused = await make(people.owner.token, { name: 'More', sites: [shop], rights: 'read' });
    assert.equal(refused.status, 409);
    assert.equal(((await refused.json()) as { error: string }).error, 'workspace-suspended');
    const revoked = await callOn(env, 'DELETE', `/console/workspaces/${id}/agent-keys/${key.id}`, {
      token: people.owner.token,
    });
    assert.equal(revoked.status, 409);
    assert.equal((await list()).length, 1);
  });
});

describe('what an agent key reaches, read at each request (FRU-461)', () => {
  it('reaches its workspace and the sites it names, and nothing for a key it does not know', async () => {
    const env = await world();
    const { id, people, shop, make } = await acme(env);
    const key = await made(await make(people.owner.token, { name: 'CI', sites: [shop], rights: 'write' }));

    assert.deepEqual(await resolveAgentKey(env.accounts, key.secret, Date.now()), {
      key: key.id,
      name: 'CI',
      workspace: id,
      role: 'owner',
      sites: [shop],
      write: true,
      verifiedOnly: true,
    });
    for (const presented of [newAgentKey(), key.secret.slice(0, -1), `${key.secret}x`, '', key.secret.toUpperCase()]) {
      assert.equal(await resolveAgentKey(env.accounts, presented, Date.now()), undefined, presented);
    }
  });

  it('ends at its date, and not before', async () => {
    const env = await world();
    const { people, shop, make } = await acme(env);
    const key = await made(await make(people.owner.token, { name: 'CI', sites: [shop], rights: 'read', days: 1 }));
    const end = Date.parse(key.expiresAt);

    assert.ok((await resolveAgentKey(env.accounts, key.secret, end - 1)) !== undefined);
    assert.equal(await resolveAgentKey(env.accounts, key.secret, end), undefined);
    assert.equal(await resolveAgentKey(env.accounts, key.secret, end + DAY_MS), undefined);
  });

  it('reaches nothing once its member is removed, or their account is suspended', async () => {
    const env = await world();
    const { id, people, shop, make } = await acme(env);
    const removed = await made(await make(people.admin.token, { name: 'Of the admin', sites: [shop], rights: 'read' }));
    const suspended = await made(
      await make(people.owner.token, { name: 'Of the owner', sites: [shop], rights: 'read' }),
    );

    await rowsOf(
      env.database,
      `DELETE FROM member WHERE "organizationId" = '${id}' AND "userId" = '${people.admin.id}'`,
    );
    assert.equal(await resolveAgentKey(env.accounts, removed.secret, Date.now()), undefined);

    assert.ok((await resolveAgentKey(env.accounts, suspended.secret, Date.now())) !== undefined);
    await rowsOf(env.database, `UPDATE "user" SET banned = true WHERE id = '${people.owner.id}'`);
    assert.equal(await resolveAgentKey(env.accounts, suspended.secret, Date.now()), undefined);
  });

  it('writes no more once its member is a member, and reads only the sites shared once they are a guest', async () => {
    const env = await world();
    const { id, people, shop, blog, make } = await acme(env);
    const key = await made(await make(people.admin.token, { name: 'CI', sites: [shop, blog], rights: 'write' }));
    const role = (to: string) =>
      rowsOf(
        env.database,
        `UPDATE member SET role = '${to}' WHERE "organizationId" = '${id}' AND "userId" = '${people.admin.id}'`,
      );

    await role('member');
    const asMember = await resolveAgentKey(env.accounts, key.secret, Date.now());
    assert.deepEqual([asMember?.role, asMember?.write, asMember?.sites], ['member', false, [shop, blog]]);

    await role('guest');
    assert.equal(await resolveAgentKey(env.accounts, key.secret, Date.now()), undefined, 'a guest with no site');
    await shareWith(env, id, people.admin.id, [blog]);
    const asGuest = await resolveAgentKey(env.accounts, key.secret, Date.now());
    assert.deepEqual([asGuest?.role, asGuest?.write, asGuest?.sites], ['guest', false, [blog]]);

    await role('admin');
    const again = await resolveAgentKey(env.accounts, key.secret, Date.now());
    assert.deepEqual([again?.write, again?.sites], [true, [shop, blog]]);
  });

  it('never reaches a site it does not name, nor one of another workspace, and nothing once its sites are gone', async () => {
    const env = await world();
    const { id, people, shop, blog, evilSite, make } = await acme(env);
    const key = await made(await make(people.owner.token, { name: 'CI', sites: [shop], rights: 'read' }));

    const grant = await resolveAgentKey(env.accounts, key.secret, Date.now());
    assert.deepEqual(grant?.sites, [shop]);
    assert.ok(!grant?.sites.includes(blog) && !grant?.sites.includes(evilSite));

    const removed = await callOn(env, 'DELETE', `/console/workspaces/${id}/sites/${shop}`, {
      token: people.owner.token,
    });
    assert.equal(removed.status, 204);
    assert.equal(await resolveAgentKey(env.accounts, key.secret, Date.now()), undefined);
  });
});

describe('the grant of a key, from what the store answers (FRU-461)', () => {
  const key: AgentKey = {
    id: 'agk_1',
    workspaceId: 'ws_acme',
    name: 'CI',
    sites: [
      { id: 'site_a', origin: 'https://a.acme.dev' },
      { id: 'site_b', origin: 'https://b.acme.dev' },
    ],
    write: true,
    verifiedOnly: false,
    createdBy: 'acc_alice',
    createdAt: 0,
    expiresAt: 10,
  };
  const presented = newAgentKey();
  const answering = (reach: Reach) => ({
    agentKeyOf: async (hash: string) => (hash === (await digest(presented)) ? { key, reach } : undefined),
  });

  it('keeps the sites its member reads, and writes only for who manages the sites', async () => {
    assert.deepEqual(
      (await resolveAgentKey(answering({ role: 'guest', sites: ['site_b', 'site_c'] }), presented, 5))?.sites,
      ['site_b'],
    );
    assert.equal((await resolveAgentKey(answering({ role: 'admin', sites: 'every' }), presented, 5))?.write, true);
    assert.equal((await resolveAgentKey(answering({ role: 'member', sites: 'every' }), presented, 5))?.write, false);
    assert.equal(
      (await resolveAgentKey(answering({ role: 'admin', sites: 'every' }), presented, 5).then((grant) => grant?.sites))
        ?.length,
      2,
    );
  });

  it('does not ask the store for a key of another shape', async () => {
    let asked = 0;
    const counting = {
      agentKeyOf: async () => {
        asked += 1;

        return undefined;
      },
    };
    for (const shape of ['fbk_short', `sk_${presented.slice(4)}`, `${presented} `]) {
      assert.equal(await resolveAgentKey(counting, shape, 5), undefined);
    }
    assert.equal(asked, 0);
    await resolveAgentKey(counting, presented, 5);
    assert.equal(asked, 1, 'the control: a key of the right shape is asked for');
  });
});
