import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { type Note, canonicalizePageUrl } from '@fruitback/shared';
import { noteFixture } from '@fruitback/shared/note.fixture';
import {
  type CallOptions,
  type World,
  callOn,
  memberOf,
  signInTo,
  workspaceIn,
  worlds,
} from './console-world.fixture.ts';
import { ADMIN_PATH } from './instance-admin.ts';
import { rowsOf } from './postgres.fixture.ts';
import { createMemoryAttachmentStore } from './attachments.ts';
import { createPostgresNoteStore } from './notes-postgres.ts';
import { createPairing, digest, redeemPairing } from './session.ts';

/**
 * An administrator of the instance deletes an account (FRU-285, D5 of FRU-260, decision 3 of
 * 2026-10-19: « Refusé tant qu'il y a des workspaces »). Every case goes through `handleRequest`, as
 * the console and the extension call it, on PGlite.
 */

const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const ACME = 'https://staging.acme.dev';
const PAGE = canonicalizePageUrl(`${ACME}/pricing`);

const open = worlds();

type Who = { id: string; token: string };

/** The access token of a session of the extension for one workspace. */
async function sessionOf(world: World, who: Who, workspace: string): Promise<string> {
  const { code } = await createPairing(world.sessions, { subject: who.id, workspace });
  const redeemed = await redeemPairing(world.sessions, code, world.env.FRUITBACK_IDENTITY_SECRET as string);
  assert.ok(redeemed.ok);

  return redeemed.session.accessToken;
}

/** The access token of a session of an account (FRU-238): the extension asks, the person approves, the extension claims. */
async function accountSession(world: World, who: Who): Promise<string> {
  const asked = await callOn(world, 'POST', '/session/connect', { origin: EXTENSION, body: { browser: 'Chrome' } });
  assert.equal(asked.status, 201, await asked.clone().text());
  const { request, claim } = (await asked.json()) as { request: string; claim: string };
  const shown = await callOn(world, 'GET', `/console/connect/${request}`, { token: who.token });
  const { word } = (await shown.json()) as { word: string };
  const approved = await callOn(world, 'POST', `/console/connect/${request}/approve`, {
    token: who.token,
    body: { word, account: who.id },
  });
  assert.equal(approved.status, 200, await approved.clone().text());
  await world.kv.set(`fruitback:connect-poll:${await digest(claim)}`, '0', 1);
  await new Promise((resolve) => setTimeout(resolve, 3));
  const claimed = await callOn(world, 'POST', '/session/connect/claim', { origin: EXTENSION, body: { claim } });
  assert.equal(claimed.status, 200, await claimed.clone().text());

  return ((await claimed.json()) as { accessToken: string }).accessToken;
}

function noteOn(site: string, id: string): Note {
  const seed = noteFixture({ id, page: { url: PAGE, path: '/pricing' } });

  return { ...seed, client: { id: site, name: 'Acme' } };
}

/**
 * Root signs in first and is the administrator of the instance. Alice owns Acme alone, where Carl is
 * a member who left a note through the extension, and Globex with Dana, who owns it too.
 */
async function anInstance() {
  const base = await open({ env: { FRUITBACK_STORE: 'postgres' } });
  const world: World = {
    ...base,
    context: {
      ...base.context,
      store: createPostgresNoteStore(base.database),
      attachments: createMemoryAttachmentStore(),
      connectStore: base.connectStore,
      resolveTxt: async () => [],
    },
  };
  const root = await signInTo(world, 'root@instance.dev');
  const alice = await signInTo(world, 'alice@acme.dev');
  const carl = await signInTo(world, 'carl@acme.dev');
  const dana = await signInTo(world, 'dana@globex.dev');
  const acme = await workspaceIn(world, alice.token, 'Acme');
  const globex = await workspaceIn(world, alice.token, 'Globex');
  await memberOf(world, acme, carl.id, 'member');
  await memberOf(world, globex, carl.id, 'member');
  await memberOf(world, globex, dana.id, 'owner');
  const site = await world.accounts.addSite(acme, { origin: ACME, visibility: 'everyone' });
  const call = (method: string, path: string, options: CallOptions = {}) => callOn(world, method, path, options);
  const deletion = (id: string, body: unknown, token = root.token) =>
    call('POST', `${ADMIN_PATH}/users/${id}/deletion`, { token, body });

  return { world, call, deletion, root, alice, carl, dana, acme, globex, site };
}

type Instance = Awaited<ReturnType<typeof anInstance>>;

async function count(on: Instance, statement: string): Promise<number> {
  const [row] = await rowsOf(on.world.database, `SELECT count(*)::int AS n FROM ${statement}`);

  return Number(row?.n);
}

describe('the deletion of an account by an administrator (FRU-285)', () => {
  it('deletes the account, its memberships and its ways to sign in, and its cookie opens nothing', async () => {
    const on = await anInstance();
    assert.equal((await on.call('GET', '/console/me', { token: on.carl.token })).status, 200);

    const answer = await on.deletion(on.carl.id, { email: ' Carl@Acme.dev ' });
    assert.equal(answer.status, 200, await answer.clone().text());
    assert.deepEqual(await answer.json(), {
      user: { id: on.carl.id, email: 'carl@acme.dev' },
      workspaces: [
        { id: on.acme, name: 'Acme' },
        { id: on.globex, name: 'Globex' },
      ].toSorted((a, b) => a.id.localeCompare(b.id)),
    });
    assert.equal(await count(on, `"user" WHERE id = '${on.carl.id}'`), 0);
    assert.equal(await count(on, `member WHERE "userId" = '${on.carl.id}'`), 0);
    assert.equal(await count(on, `account WHERE "userId" = '${on.carl.id}'`), 0);
    assert.equal(await count(on, `session WHERE "userId" = '${on.carl.id}'`), 0);
    assert.equal((await on.call('GET', '/console/me', { token: on.carl.token })).status, 401);
    // The rest of the instance stays.
    assert.equal(await count(on, 'organization'), 2);
    assert.equal(await count(on, `member WHERE "organizationId" = '${on.acme}'`), 1);
  });

  it('ends the sessions of the extension of the account, of its account and of each workspace, by the real transport', async () => {
    const on = await anInstance();
    const ofAccount = await accountSession(on.world, on.carl);
    const ofAcme = await sessionOf(on.world, on.carl, on.acme);
    const sitesOf = async (token: string) => {
      const answer = await on.call('GET', '/session/sites', { token, origin: EXTENSION });

      return { status: answer.status, body: await answer.text() };
    };
    const before = { account: await sitesOf(ofAccount), workspace: await sitesOf(ofAcme) };
    assert.deepEqual([before.account.status, before.workspace.status], [200, 200], 'the control: both read');
    assert.ok(before.account.body.includes(on.site.id), 'the control: the account reads the site of Acme');
    assert.ok((await count(on, `sessions WHERE subject = '${on.carl.id}' AND revoked_at IS NULL`)) >= 2);

    assert.equal((await on.deletion(on.carl.id, { email: 'carl@acme.dev' })).status, 200);

    // Every session of the extension is ended, so none refreshes. An access token of an account lives
    // its ten minutes, as one of a suspended account (FRU-281), and reaches no site: it is in no workspace.
    assert.equal(await count(on, `sessions WHERE subject = '${on.carl.id}' AND revoked_at IS NULL`), 0);
    assert.equal((await sitesOf(ofAcme)).status, 401);
    assert.ok(!(await sitesOf(ofAccount)).body.includes(on.site.id));
  });

  it('keeps the notes of the account, which the list names as of a former member, with no name', async () => {
    const on = await anInstance();
    await rowsOf(on.world.database, `UPDATE "user" SET name = 'Carl Martin' WHERE id = '${on.carl.id}'`);
    const token = await sessionOf(on.world, on.carl, on.acme);
    const posted = await on.call('POST', '/feedback', { token, origin: ACME, body: noteOn(on.site.id, 'sd_carl') });
    assert.equal(posted.status, 201, await posted.clone().text());
    const signed = async () =>
      (await rowsOf(on.world.database, `SELECT payload FROM notes WHERE client_id = '${on.site.id}'`)).map((row) =>
        String(row.seed),
      );
    const before = await signed();
    assert.equal(before.length, 1, 'the control: the note is kept');
    const named = async () =>
      (
        (await (await on.call('GET', `/console/workspaces/${on.acme}/notes`, { token: on.alice.token })).json()) as {
          notes: { author: { kind: string; name?: string } }[];
        }
      ).notes.map((note) => note.author);
    assert.deepEqual(await named(), [{ kind: 'member', name: 'Carl Martin' }], 'the control: a member is named');

    assert.equal((await on.deletion(on.carl.id, { email: 'carl@acme.dev' })).status, 200);

    assert.deepEqual(await signed(), before);
    // The rule of FRU-244 for a member who left: « Former member », and no name.
    assert.deepEqual(await named(), [{ kind: 'former-member' }]);
  });

  it('refuses an account that owns a workspace alone, and lists those workspaces, until it has another owner', async () => {
    const on = await anInstance();
    const refused = await on.deletion(on.alice.id, { email: 'alice@acme.dev' });
    assert.equal(refused.status, 409);
    // Globex has Dana as an owner too: only Acme holds the deletion.
    assert.deepEqual(await refused.json(), { error: 'sole-owner', workspaces: [{ id: on.acme, name: 'Acme' }] });
    assert.equal(await count(on, `"user" WHERE id = '${on.alice.id}'`), 1);
    assert.equal(await count(on, 'admin_actions'), 0);

    // The control: once Carl owns Acme, Alice can go.
    const owner = await on.call('POST', `${ADMIN_PATH}/workspaces/${on.acme}/owner`, {
      token: on.root.token,
      body: { email: 'carl@acme.dev' },
    });
    assert.equal(owner.status, 200);
    assert.equal((await on.deletion(on.alice.id, { email: 'alice@acme.dev' })).status, 200);
  });

  it('says which workspaces an account owns alone, in the list of the people', async () => {
    const on = await anInstance();
    const listed = (await (await on.call('GET', `${ADMIN_PATH}/users?q=alice`, { token: on.root.token })).json()) as {
      users: { workspaces: { id: string; soleOwner?: true }[] }[];
    };
    const workspaces = listed.users[0]?.workspaces ?? [];
    assert.equal(workspaces.find((each) => each.id === on.acme)?.soleOwner, true);
    assert.equal(workspaces.find((each) => each.id === on.globex)?.soleOwner, undefined);
  });

  it('refuses the administrator themselves, the last administrator, another address, and anybody else', async () => {
    const on = await anInstance();
    const self = await on.deletion(on.root.id, { email: 'root@instance.dev' });
    assert.deepEqual([self.status, await self.json()], [409, { error: 'self-deletion' }]);
    const other = await on.deletion(on.carl.id, { email: 'alice@acme.dev' });
    assert.deepEqual([other.status, await other.json()], [409, { error: 'email-mismatch' }]);
    for (const body of [{}, { email: 42 }, { email: 'not an address' }]) {
      const answer = await on.deletion(on.carl.id, body);
      assert.deepEqual([answer.status, await answer.json()], [400, { error: 'invalid-email' }], JSON.stringify(body));
    }
    const unknown = await on.deletion('acc_00000000000000000000', { email: 'carl@acme.dev' });
    assert.equal(unknown.status, 404);
    for (const token of [on.alice.token, on.carl.token]) {
      assert.equal((await on.deletion(on.dana.id, { email: 'dana@globex.dev' }, token)).status, 404);
    }

    assert.equal(await count(on, 'admin_actions'), 0);
  });

  it('keeps the last administrator: the store refuses it before it reads who asks', async () => {
    const on = await anInstance();
    // Carl is no administrator: the route would answer 404. The store reads the rule first, as when
    // two administrators delete each other and the second one is gone.
    const refused = await on.world.instanceAdmin.deleteAccount(
      { id: on.carl.id, email: 'carl@acme.dev' },
      on.root.id,
      'root@instance.dev',
      Date.now(),
    );
    assert.deepEqual(refused, { ok: false, refused: 'last-admin' });
    assert.equal(await count(on, `"user" WHERE id = '${on.root.id}'`), 1);
  });

  it('writes one action for each workspace of the account, that their owners read after it goes', async () => {
    const on = await anInstance();
    assert.equal((await on.deletion(on.carl.id, { email: 'carl@acme.dev' })).status, 200);

    for (const [workspace, token] of [
      [on.acme, on.alice.token],
      [on.globex, on.dana.token],
    ] as const) {
      const traced = (await (
        await on.call('GET', `/console/workspaces/${workspace}/admin-reads`, { token })
      ).json()) as { actions: { action: string; admin: { email: string }; target: { email: string } }[] };
      assert.deepEqual(
        traced.actions.map(({ action, admin, target }) => ({ action, admin: admin.email, target: target.email })),
        [{ action: 'account-deleted', admin: 'root@instance.dev', target: 'carl@acme.dev' }],
      );
    }
  });
});
