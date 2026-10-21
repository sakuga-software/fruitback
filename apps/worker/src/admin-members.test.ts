import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { INVITER_GONE } from './auth.ts';
import {
  type CallOptions,
  type World,
  callOn,
  memberOf,
  shareWith,
  signInTo,
  workspaceIn,
  worlds,
} from './console-world.fixture.ts';
import { ADMIN_PATH } from './instance-admin.ts';
import { rowsOf } from './postgres.fixture.ts';

/**
 * An administrator of the instance writes in a workspace they are not a member of (FRU-283): the
 * role of a member, a member added, the owner, an invitation, and a new workspace for an account.
 * Every case goes through `handleRequest`, as the console calls it, on PGlite.
 */

const open = worlds();
const ORG = '/console/auth/organization';

/**
 * Root signs in first and is the administrator of the instance, in no workspace. Alice owns Acme,
 * where Carl is an admin. Dana has an account in no workspace. Acme has a site.
 */
async function anInstance() {
  const world: World = await open();
  const root = await signInTo(world, 'root@instance.dev');
  const alice = await signInTo(world, 'alice@acme.dev');
  const carl = await signInTo(world, 'carl@acme.dev');
  const dana = await signInTo(world, 'dana@elsewhere.dev');
  const acme = await workspaceIn(world, alice.token, 'Acme');
  await memberOf(world, acme, carl.id, 'admin');
  const site = await world.accounts.addSite(acme, { origin: 'https://staging.acme.dev', visibility: 'members' });
  const call = (method: string, path: string, options: CallOptions = {}) => callOn(world, method, path, options);
  const post = (path: string, body: unknown, token = root.token) =>
    call('POST', `${ADMIN_PATH}${path}`, { token, body });

  return { world, call, post, root, alice, carl, dana, acme, site };
}

type Instance = Awaited<ReturnType<typeof anInstance>>;

async function rolesIn(on: Instance, workspace: string): Promise<Record<string, string>> {
  const rows = await rowsOf(
    on.world.database,
    `SELECT u.email, m.role FROM member m JOIN "user" u ON u.id = m."userId" WHERE m."organizationId" = '${workspace}' ORDER BY u.email`,
  );

  return Object.fromEntries(rows.map((row) => [String(row.email), String(row.role)]));
}

async function actions(on: Instance): Promise<Record<string, unknown>[]> {
  return rowsOf(
    on.world.database,
    'SELECT action, workspace_id, target_email, detail FROM admin_actions ORDER BY at, id',
  );
}

/** What the owners of a workspace read of the actions of the administrators in it. */
async function tracedFor(on: Instance, workspace: string, token: string) {
  const answer = await on.call('GET', `/console/workspaces/${workspace}/admin-reads`, { token });
  assert.equal(answer.status, 200, await answer.clone().text());

  return ((await answer.json()) as { actions: { action: string; target?: { email: string }; role?: string }[] })
    .actions;
}

describe('the role of a member, set by an administrator (FRU-283)', () => {
  it('changes it at once, says nothing changed the second time, and the owners read the action', async () => {
    const on = await anInstance();

    const changed = await on.post(`/workspaces/${on.acme}/members/${on.carl.id}/role`, { role: 'member' });
    assert.equal(changed.status, 200, await changed.clone().text());
    assert.deepEqual(await changed.json(), { member: { id: on.carl.id, role: 'member' }, changed: true });
    const again = await on.post(`/workspaces/${on.acme}/members/${on.carl.id}/role`, { role: 'member' });
    assert.deepEqual(await again.json(), { member: { id: on.carl.id, role: 'member' }, changed: false });

    assert.deepEqual(await rolesIn(on, on.acme), { 'alice@acme.dev': 'owner', 'carl@acme.dev': 'member' });
    assert.equal((await actions(on)).length, 1);
    assert.deepEqual(
      (await tracedFor(on, on.acme, on.alice.token)).map(({ action, target, role }) => ({ action, target, role })),
      [{ action: 'member-role-changed', target: { email: 'carl@acme.dev' }, role: 'member' }],
    );
  });

  it('refuses a role that is not owner, admin or member, and a person who is not a member', async () => {
    const on = await anInstance();
    for (const role of ['guest', 'boss', 'admin,member', 42, undefined]) {
      const answer = await on.post(`/workspaces/${on.acme}/members/${on.carl.id}/role`, { role });
      assert.equal(answer.status, 400, String(role));
      assert.deepEqual(await answer.json(), { error: 'invalid-role', roles: ['owner', 'admin', 'member'] });
    }
    const stranger = await on.post(`/workspaces/${on.acme}/members/${on.dana.id}/role`, { role: 'member' });
    assert.equal(stranger.status, 409);
    assert.deepEqual(await stranger.json(), { error: 'not-a-member' });
    const unknown = await on.post(`/workspaces/ws_00000000000000000000/members/${on.carl.id}/role`, { role: 'member' });
    assert.equal(unknown.status, 404);
    assert.deepEqual(await actions(on), []);
  });

  it('refuses to take the role of owner from the last owner, and takes it once there is another', async () => {
    const on = await anInstance();
    const last = await on.post(`/workspaces/${on.acme}/members/${on.alice.id}/role`, { role: 'admin' });
    assert.equal(last.status, 409);
    assert.deepEqual(await last.json(), { error: 'last-owner' });
    assert.equal((await rolesIn(on, on.acme))['alice@acme.dev'], 'owner');

    // The control: with Carl an owner too, Alice can be an admin.
    assert.equal((await on.post(`/workspaces/${on.acme}/members/${on.carl.id}/role`, { role: 'owner' })).status, 200);
    assert.equal((await on.post(`/workspaces/${on.acme}/members/${on.alice.id}/role`, { role: 'admin' })).status, 200);
    assert.deepEqual(await rolesIn(on, on.acme), { 'alice@acme.dev': 'admin', 'carl@acme.dev': 'owner' });
  });

  it('cancels the invitations of a member whose new role does not invite, and the sites of a guest who is no longer one', async () => {
    const on = await anInstance();
    const invited = await on.call('POST', `${ORG}/invite-member`, {
      token: on.carl.token,
      body: { organizationId: on.acme, email: 'paul@acme.dev', role: 'member' },
    });
    assert.equal(invited.status, 200, await invited.clone().text());
    await memberOf(on.world, on.acme, on.dana.id, 'guest');
    await shareWith(on.world, on.acme, on.dana.id, [on.site.id]);

    await on.post(`/workspaces/${on.acme}/members/${on.carl.id}/role`, { role: 'member' });
    await on.post(`/workspaces/${on.acme}/members/${on.dana.id}/role`, { role: 'member' });

    const [waits] = await rowsOf(on.world.database, `SELECT status FROM invitation WHERE email = 'paul@acme.dev'`);
    assert.equal(waits?.status, 'canceled');
    const [shares] = await rowsOf(on.world.database, `SELECT count(*)::int AS n FROM site_shares`);
    assert.equal(Number(shares?.n), 0);
  });
});

describe('a member added by an administrator (FRU-283)', () => {
  it('adds an account by its address with a role, and the account reads the workspace', async () => {
    const on = await anInstance();
    const before = await on.call('GET', `/console/workspaces/${on.acme}/sites`, { token: on.dana.token });
    assert.equal(before.status, 404, 'the control: Dana reads nothing of Acme yet');

    const added = await on.post(`/workspaces/${on.acme}/members`, { email: ' Dana@Elsewhere.dev ', role: 'member' });
    assert.equal(added.status, 200, await added.clone().text());
    assert.deepEqual(await added.json(), {
      member: { id: on.dana.id, email: 'dana@elsewhere.dev', role: 'member' },
    });
    const after = await on.call('GET', `/console/workspaces/${on.acme}/sites`, { token: on.dana.token });
    assert.equal(after.status, 200);
    assert.deepEqual(
      (await tracedFor(on, on.acme, on.alice.token)).map(({ action, target, role }) => ({ action, target, role })),
      [{ action: 'member-added', target: { email: 'dana@elsewhere.dev' }, role: 'member' }],
    );
  });

  it('refuses an address with no account, a member already, a guest role and an address that is not one', async () => {
    const on = await anInstance();
    const cases: [unknown, number, unknown][] = [
      [{ email: 'nobody@acme.dev', role: 'member' }, 409, { error: 'unknown-account' }],
      [{ email: 'carl@acme.dev', role: 'member' }, 409, { error: 'already-member' }],
      [
        { email: 'dana@elsewhere.dev', role: 'guest' },
        400,
        { error: 'invalid-role', roles: ['owner', 'admin', 'member'] },
      ],
      [{ email: 'not an address', role: 'member' }, 400, { error: 'invalid-email' }],
    ];
    for (const [body, status, error] of cases) {
      const answer = await on.post(`/workspaces/${on.acme}/members`, body);
      assert.equal(answer.status, status, JSON.stringify(body));
      assert.deepEqual(await answer.json(), error);
    }
    assert.deepEqual(await actions(on), []);
  });
});

describe('the owner of a workspace, changed by an administrator (FRU-283)', () => {
  it('makes an account the owner, and the owner of before an admin, who keeps the workspace', async () => {
    const on = await anInstance();
    const changed = await on.post(`/workspaces/${on.acme}/owner`, { email: 'dana@elsewhere.dev' });
    assert.equal(changed.status, 200, await changed.clone().text());
    assert.deepEqual(await changed.json(), {
      owner: { id: on.dana.id, email: 'dana@elsewhere.dev' },
      previous: ['alice@acme.dev'],
      changed: true,
    });
    assert.deepEqual(await rolesIn(on, on.acme), {
      'alice@acme.dev': 'admin',
      'carl@acme.dev': 'admin',
      'dana@elsewhere.dev': 'owner',
    });
    const same = await on.post(`/workspaces/${on.acme}/owner`, { email: 'dana@elsewhere.dev' });
    assert.deepEqual(((await same.json()) as { changed: boolean }).changed, false);
    assert.deepEqual(
      (await tracedFor(on, on.acme, on.dana.token)).map(({ action, target }) => ({ action, target })),
      [{ action: 'owner-changed', target: { email: 'dana@elsewhere.dev' } }],
    );
    const [row] = await actions(on);
    assert.deepEqual(JSON.parse(String(row?.detail)), { role: 'owner', previous: ['alice@acme.dev'] });
  });

  it('refuses an address with no account and a suspended account', async () => {
    const on = await anInstance();
    const unknown = await on.post(`/workspaces/${on.acme}/owner`, { email: 'nobody@acme.dev' });
    assert.deepEqual([unknown.status, await unknown.json()], [409, { error: 'unknown-account' }]);
    const suspended = await on.post(`/users/${on.dana.id}/suspension`, { suspended: true });
    assert.equal(suspended.status, 200);
    const refused = await on.post(`/workspaces/${on.acme}/owner`, { email: 'dana@elsewhere.dev' });
    assert.deepEqual([refused.status, await refused.json()], [409, { error: 'suspended-account' }]);
    assert.equal((await rolesIn(on, on.acme))['alice@acme.dev'], 'owner');
  });
});

describe('an invitation by an administrator (FRU-283)', () => {
  it('invites an address with no account, mails it, and the person joins by the invitation of a member', async () => {
    const on = await anInstance();
    const sent = on.world.mail.sent.length;
    const invited = await on.post(`/workspaces/${on.acme}/invitations`, { email: 'paul@acme.dev', role: 'member' });
    assert.equal(invited.status, 200, await invited.clone().text());
    const { invitation } = (await invited.json()) as { invitation: { id: string; mailed: boolean; role: string } };
    assert.equal(invitation.mailed, true);
    assert.equal(invitation.role, 'member');
    assert.equal(on.world.mail.sent.length, sent + 1);
    assert.match(on.world.mail.sent.at(-1)?.text ?? '', /Acme/);

    const paul = await signInTo(on.world, 'paul@acme.dev');
    const joined = await on.call('POST', `${ORG}/accept-invitation`, {
      token: paul.token,
      body: { invitationId: invitation.id },
    });
    assert.equal(joined.status, 200, await joined.clone().text());
    assert.equal((await rolesIn(on, on.acme))['paul@acme.dev'], 'member');
    assert.deepEqual(
      (await tracedFor(on, on.acme, on.alice.token)).map(({ action, target, role }) => ({ action, target, role })),
      [{ action: 'member-invited', target: { email: 'paul@acme.dev' }, role: 'member' }],
    );
  });

  it('stands behind an invitation while its administrator is one, and no longer once they are removed', async () => {
    const on = await anInstance();
    const invited = await on.post(`/workspaces/${on.acme}/invitations`, { email: 'paul@acme.dev', role: 'admin' });
    const { invitation } = (await invited.json()) as { invitation: { id: string } };
    // Another administrator takes the role from Root.
    await rowsOf(on.world.database, `UPDATE "user" SET role = 'admin' WHERE id = '${on.dana.id}'`);
    assert.equal((await on.post(`/users/${on.root.id}/instance-admin`, { admin: false }, on.dana.token)).status, 200);

    const paul = await signInTo(on.world, 'paul@acme.dev');
    const refused = await on.call('POST', `${ORG}/accept-invitation`, {
      token: paul.token,
      body: { invitationId: invitation.id },
    });
    assert.equal(refused.status, 400);
    assert.equal(((await refused.json()) as { code?: string }).code, INVITER_GONE);
    assert.equal((await rolesIn(on, on.acme))['paul@acme.dev'], undefined);
  });

  it('refuses an address that has an account, one invited already, a guest and an owner', async () => {
    const on = await anInstance();
    assert.equal(
      (await on.post(`/workspaces/${on.acme}/invitations`, { email: 'paul@acme.dev', role: 'member' })).status,
      200,
    );
    const cases: [unknown, number, unknown][] = [
      [{ email: 'dana@elsewhere.dev', role: 'member' }, 409, { error: 'has-account' }],
      [{ email: 'carl@acme.dev', role: 'member' }, 409, { error: 'already-member' }],
      [{ email: 'PAUL@acme.dev', role: 'admin' }, 409, { error: 'already-invited' }],
      [{ email: 'zoe@acme.dev', role: 'guest' }, 400, { error: 'invalid-role', roles: ['admin', 'member'] }],
      [{ email: 'zoe@acme.dev', role: 'owner' }, 400, { error: 'invalid-role', roles: ['admin', 'member'] }],
    ];
    for (const [body, status, error] of cases) {
      const answer = await on.post(`/workspaces/${on.acme}/invitations`, body);
      assert.equal(answer.status, status, JSON.stringify(body));
      assert.deepEqual(await answer.json(), error);
    }
    const [counted] = await rowsOf(on.world.database, 'SELECT count(*)::int AS n FROM invitation');
    assert.equal(Number(counted?.n), 1);
  });
});

describe('a workspace made by an administrator for an account (FRU-283)', () => {
  it('makes it with that account as its owner, who reads it and the action', async () => {
    const on = await anInstance();
    const made = await on.post('/new-workspace', { name: '  Dana   studio ', owner: 'dana@elsewhere.dev' });
    assert.equal(made.status, 201, await made.clone().text());
    const { workspace } = (await made.json()) as { workspace: { id: string; name: string } };
    assert.equal(workspace.name, 'Dana studio');
    assert.deepEqual(await rolesIn(on, workspace.id), { 'dana@elsewhere.dev': 'owner' });
    const me = (await (await on.call('GET', '/console/me', { token: on.dana.token })).json()) as {
      workspaces: { id: string; role: string }[];
    };
    assert.deepEqual(
      me.workspaces.map(({ id, role }) => ({ id, role })),
      [{ id: workspace.id, role: 'owner' }],
    );
    assert.deepEqual(
      (await tracedFor(on, workspace.id, on.dana.token)).map(({ action, target }) => ({ action, target })),
      [{ action: 'workspace-created', target: { email: 'dana@elsewhere.dev' } }],
    );
  });

  it('refuses a name that is not one, an address with no account, and a suspended account', async () => {
    const on = await anInstance();
    for (const name of ['', '   ', 'x'.repeat(81), 42]) {
      const answer = await on.post('/new-workspace', { name, owner: 'dana@elsewhere.dev' });
      assert.deepEqual([answer.status, await answer.json()], [400, { error: 'invalid-name' }], String(name));
    }
    const unknown = await on.post('/new-workspace', { name: 'Nope', owner: 'nobody@acme.dev' });
    assert.deepEqual([unknown.status, await unknown.json()], [409, { error: 'unknown-account' }]);
    await on.post(`/users/${on.dana.id}/suspension`, { suspended: true });
    const suspended = await on.post('/new-workspace', { name: 'Nope', owner: 'dana@elsewhere.dev' });
    assert.deepEqual([suspended.status, await suspended.json()], [409, { error: 'suspended-account' }]);
    const [counted] = await rowsOf(on.world.database, 'SELECT count(*)::int AS n FROM organization');
    assert.equal(Number(counted?.n), 1);
  });
});

describe('the writes of an administrator in a suspended workspace, and from anybody else (FRU-283)', () => {
  /** Each write in Acme, with a body that the route takes. */
  const writes = (on: Instance): [string, unknown][] => [
    [`/workspaces/${on.acme}/members/${on.carl.id}/role`, { role: 'member' }],
    [`/workspaces/${on.acme}/members`, { email: 'dana@elsewhere.dev', role: 'member' }],
    [`/workspaces/${on.acme}/owner`, { email: 'dana@elsewhere.dev' }],
    [`/workspaces/${on.acme}/invitations`, { email: 'paul@acme.dev', role: 'member' }],
  ];

  it('refuses each one with 409 workspace-suspended and writes nothing, and each works after the restoration', async () => {
    const on = await anInstance();
    assert.equal((await on.post(`/workspaces/${on.acme}/suspension`, { suspended: true })).status, 200);
    const before = await rolesIn(on, on.acme);
    for (const [path, body] of writes(on)) {
      const answer = await on.post(path, body);
      assert.deepEqual([answer.status, await answer.json()], [409, { error: 'workspace-suspended' }], path);
    }
    assert.deepEqual(await rolesIn(on, on.acme), before);
    assert.deepEqual(
      (await actions(on)).map((row) => row.action),
      ['workspace-suspended'],
    );

    assert.equal((await on.post(`/workspaces/${on.acme}/suspension`, { suspended: false })).status, 200);
    for (const [path, body] of writes(on)) assert.equal((await on.post(path, body)).status, 200, path);
  });

  it('answers 404 to an owner, an admin of the workspace and nobody, and writes nothing', async () => {
    const on = await anInstance();
    for (const [path, body] of [
      ...writes(on),
      ['/new-workspace', { name: 'X', owner: 'dana@elsewhere.dev' }] as const,
    ]) {
      for (const token of [on.alice.token, on.carl.token, undefined]) {
        const answer = await on.call('POST', `${ADMIN_PATH}${path}`, {
          ...(token === undefined ? {} : { token }),
          body,
        });
        assert.equal(answer.status, 404, `${path} answered ${answer.status}`);
      }
    }
    assert.deepEqual(await actions(on), []);
  });
});
