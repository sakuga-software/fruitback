import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';
import { mockMethod } from './mock.fixture.ts';
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
import { ADMIN_PATH, type InstanceAdminReads, handleInstanceAdmin } from './instance-admin.ts';
import { rowsOf } from './postgres.fixture.ts';
import { createMemoryAttachmentStore } from './attachments.ts';
import { seal } from './secrets.ts';
import { createPostgresNoteStore } from './notes-postgres.ts';
import { createPairing, redeemPairing } from './session.ts';

/**
 * An administrator of the instance deletes a workspace (FRU-284). Every case goes through
 * `handleRequest`, as the console and the extension call it, on PGlite.
 */

const SECRETS_KEY = 'a-key-that-seals-the-connectors-0123456789';
const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const ACME = 'https://staging.acme.dev';
const GLOBEX = 'https://staging.globex.dev';
const PAGE = canonicalizePageUrl(`${ACME}/pricing`);
const REVOKE = 'https://api.linear.app/oauth/revoke';

const open = worlds();

/** The calls that the worker makes out of the process, while a test runs. */
let outside: { url: string; token: string | null }[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  outside = [];
});

function watchOutside(): void {
  mockMethod(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    outside.push({ url, token: new URLSearchParams(String(init?.body ?? '')).get('token') });

    return new Response('{}', { status: 200 });
  });
}

function noteOn(site: string, id: string): Note {
  const note = noteFixture({ id, page: { url: PAGE, path: '/pricing' } });

  return { ...note, client: { id: site, name: 'Acme' } };
}

/** The access token of a session of the extension for one workspace. */
async function sessionOf(world: World, who: { id: string }, workspace: string): Promise<string> {
  const { code } = await createPairing(world.sessions, { subject: who.id, workspace });
  const redeemed = await redeemPairing(world.sessions, code, world.env.FRUITBACK_IDENTITY_SECRET as string);
  assert.ok(redeemed.ok);

  return redeemed.session.accessToken;
}

/**
 * Root signs in first and is the administrator of the instance, in no workspace. Alice owns Acme,
 * with Carl a member and Dana invited, and Globex. Acme has a site with a note that Fruitback keeps,
 * a Linear connector signed in by OAuth, and a receiving address with a delivery that waits. Globex
 * has a site on the same origin, with a note of its own.
 */
async function anInstance() {
  const base = await open({ env: { FRUITBACK_STORE: 'postgres', FRUITBACK_SECRETS_KEY: SECRETS_KEY } });
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
  const acme = await workspaceIn(world, alice.token, 'Acme');
  const globex = await workspaceIn(world, alice.token, 'Globex');
  await memberOf(world, acme, carl.id, 'member');
  const site = await world.accounts.addSite(acme, { origin: ACME, visibility: 'everyone' });
  const twin = await world.accounts.addSite(globex, { origin: ACME, visibility: 'everyone' });
  await world.accounts.addSite(globex, { origin: GLOBEX, visibility: 'members' });
  const credential = JSON.stringify({
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: Date.now() + 1e6,
  });
  await world.accounts.addConnector(acme, {
    kind: 'linear',
    label: 'Linear OAuth · Acme',
    sealed: seal(credential, SECRETS_KEY),
  });
  const hook = await world.accounts.addConnector(acme, {
    kind: 'rest',
    label: 'Hook of Acme',
    sealed: seal('https://hooks.acme.dev/fruitback', SECRETS_KEY),
  });
  await world.accounts.enqueueDelivery(hook.id, JSON.stringify({ site: { id: site.id } }), Date.now());
  await rowsOf(
    world.database,
    `INSERT INTO invitation (id, "organizationId", email, role, status, "expiresAt", "inviterId")
       VALUES ('inv_dana', '${acme}', 'dana@acme.dev', 'member', 'pending', now() + interval '1 day', '${alice.id}')`,
  );

  const call = (method: string, path: string, options: CallOptions = {}) => callOn(world, method, path, options);
  const member = await sessionOf(world, alice, acme);
  for (const [token, client, id] of [
    [member, site.id, 'sd_acme'],
    [await sessionOf(world, alice, globex), twin.id, 'sd_globex'],
  ] as const) {
    const posted = await call('POST', '/feedback', { token, origin: ACME, body: noteOn(client, id) });
    assert.equal(posted.status, 201, await posted.clone().text());
  }

  return { world, call, root, alice, carl, acme, globex, site, twin, member };
}

type Instance = Awaited<ReturnType<typeof anInstance>>;

function deletion(on: Instance, workspace: string, body: unknown, token = on.root.token): Promise<Response> {
  return on.call('POST', `${ADMIN_PATH}/workspaces/${workspace}/deletion`, { token, body });
}

async function count(on: Instance, statement: string): Promise<number> {
  const [row] = await rowsOf(on.world.database, `SELECT count(*)::int AS n FROM ${statement}`);

  return Number(row?.n);
}

/** What Fruitback holds of Acme, table by table. */
async function heldOf(on: Instance, workspace: string) {
  const sitesOf = `(SELECT id FROM sites WHERE workspace_id = '${workspace}')`;

  return {
    workspace: await count(on, `organization WHERE id = '${workspace}'`),
    members: await count(on, `member WHERE "organizationId" = '${workspace}'`),
    invitations: await count(on, `invitation WHERE "organizationId" = '${workspace}'`),
    sites: await count(on, `sites WHERE workspace_id = '${workspace}'`),
    connectors: await count(on, `connectors WHERE workspace_id = '${workspace}'`),
    deliveries: await count(
      on,
      `deliveries WHERE connector_id IN (SELECT id FROM connectors WHERE workspace_id = '${workspace}')`,
    ),
    keptNotes: await count(on, `notes WHERE client_id IN ${sitesOf}`),
    indexed: await count(on, `note_index WHERE workspace_id = '${workspace}'`),
  };
}

describe('the route of the deletion of a workspace (FRU-284)', () => {
  it('refuses a name that is not the name of the workspace, and deletes, revokes and writes nothing', async () => {
    const on = await anInstance();
    watchOutside();
    const before = await heldOf(on, on.acme);
    assert.equal(before.workspace, 1);

    for (const name of ['acme', 'ACME', 'Acm', 'Acme Inc', 'Globex', 'A c m e']) {
      const answer = await deletion(on, on.acme, { name });
      assert.equal(answer.status, 409, name);
      assert.deepEqual(await answer.json(), { error: 'name-mismatch' });
    }
    for (const body of [{}, { name: 42 }, { name: '   ' }, { name: null }, ['Acme'], 'Acme', null]) {
      const answer = await deletion(on, on.acme, body);
      assert.equal(answer.status, 400, JSON.stringify(body));
      assert.deepEqual(await answer.json(), { error: 'invalid-name' });
    }
    const unknown = await deletion(on, 'ws_00000000000000000000', { name: 'Acme' });
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: 'not-found' });

    assert.deepEqual(await heldOf(on, on.acme), before);
    assert.equal(await count(on, 'admin_actions'), 0);
    assert.deepEqual(outside, [], 'a refusal revokes no token of Linear');

    // The control: the name as it is, with spaces at its ends, deletes it.
    const deleted = await deletion(on, on.acme, { name: '  Acme ' });
    assert.equal(deleted.status, 200, await deleted.clone().text());
    assert.equal((await heldOf(on, on.acme)).workspace, 0);
  });

  it('answers 404 to every caller who is not the administrator of the instance, with the right name, and deletes nothing', async () => {
    const on = await anInstance();
    for (const token of [on.alice.token, on.carl.token]) {
      const answer = await deletion(on, on.acme, { name: 'Acme' }, token);
      assert.equal(answer.status, 404);
      assert.deepEqual(await answer.json(), { error: 'not-found' });
    }
    const nobody = await on.call('POST', `${ADMIN_PATH}/workspaces/${on.acme}/deletion`, { body: { name: 'Acme' } });
    assert.equal(nobody.status, 404);
    const read = await on.call('GET', `${ADMIN_PATH}/workspaces/${on.acme}/deletion`, { token: on.root.token });
    assert.equal(read.status, 405);

    assert.equal((await heldOf(on, on.acme)).workspace, 1);
    assert.equal(await count(on, 'admin_actions'), 0);
  });

  it('deletes the workspace with the notes Fruitback keeps, and leaves its people, the other workspaces and the tracker', async () => {
    const on = await anInstance();
    watchOutside();
    const globexBefore = await heldOf(on, on.globex);
    assert.equal(globexBefore.keptNotes, 1, 'the control: Globex keeps a note on the same origin');
    assert.deepEqual(await heldOf(on, on.acme), {
      workspace: 1,
      members: 2,
      invitations: 1,
      sites: 1,
      connectors: 2,
      deliveries: 1,
      keptNotes: 1,
      indexed: 1,
    });

    const answer = await deletion(on, on.acme, { name: 'Acme' });
    assert.equal(answer.status, 200, await answer.clone().text());
    assert.deepEqual(await answer.json(), {
      workspace: { id: on.acme, name: 'Acme' },
      gone: { sites: 1, members: 2, invitations: 1, connectors: 2, keptNotes: 1 },
    });

    // What goes: every row of the workspace, and the notes that Fruitback kept for its site.
    assert.deepEqual(await heldOf(on, on.acme), {
      workspace: 0,
      members: 0,
      invitations: 0,
      sites: 0,
      connectors: 0,
      deliveries: 0,
      keptNotes: 0,
      indexed: 0,
    });
    assert.equal(await count(on, `notes WHERE client_id = '${on.site.id}'`), 0);
    // What stays: the accounts of its people, and the other workspace of its owner with its note.
    assert.deepEqual(
      (await rowsOf(on.world.database, `SELECT email FROM "user" ORDER BY email`)).map((row) => row.email),
      ['alice@acme.dev', 'carl@acme.dev', 'root@instance.dev'],
    );
    assert.deepEqual(await heldOf(on, on.globex), globexBefore);
    // The tracker: the worker revokes its token of Linear and calls nothing else. The issues stay there.
    assert.deepEqual(outside, [{ url: REVOKE, token: 'refresh-1' }]);

    const again = await deletion(on, on.acme, { name: 'Acme' });
    assert.equal(again.status, 404);
    assert.equal(await count(on, 'admin_actions'), 1);
  });

  it('ends the sessions of the extension of the workspace, and no other', async () => {
    const on = await anInstance();
    const ofGlobex = await sessionOf(on.world, on.alice, on.globex);
    const live = (workspace: string) => count(on, `sessions WHERE workspace = '${workspace}' AND revoked_at IS NULL`);
    assert.ok((await live(on.acme)) >= 1, 'the control: Acme has a live session of the extension');
    const globexLive = await live(on.globex);

    assert.equal((await deletion(on, on.acme, { name: 'Acme' })).status, 200);

    assert.equal(await live(on.acme), 0);
    assert.equal(await live(on.globex), globexLive);
    const sites = await on.call('GET', '/session/sites', { token: on.member, origin: EXTENSION });
    assert.equal(sites.status, 401);
    const other = await on.call('GET', '/session/sites', { token: ofGlobex, origin: EXTENSION });
    assert.equal(other.status, 200);
  });

  it('deletes a workspace the administrator is a member of, and a suspended one', async () => {
    const on = await anInstance();
    await memberOf(on.world, on.acme, on.root.id, 'member');
    const suspended = await on.call('POST', `${ADMIN_PATH}/workspaces/${on.globex}/suspension`, {
      token: on.root.token,
      body: { suspended: true, reason: 'impayé' },
    });
    assert.equal(suspended.status, 200);

    assert.equal((await deletion(on, on.acme, { name: 'Acme' })).status, 200);
    assert.equal((await deletion(on, on.globex, { name: 'Globex' })).status, 200);
    assert.equal(await count(on, 'organization'), 0);
    assert.equal(await count(on, 'workspace_suspensions'), 0);
  });
});

describe('the trace of a deletion of a workspace (FRU-284)', () => {
  it('writes one action that outlives the workspace, with its name and what went, that the administrators read', async () => {
    const on = await anInstance();
    assert.equal((await deletion(on, on.acme, { name: 'Acme' })).status, 200);

    const [row] = await rowsOf(on.world.database, 'SELECT action, workspace_id, actor_email FROM admin_actions');
    assert.deepEqual(row, { action: 'workspace-deleted', workspace_id: null, actor_email: 'root@instance.dev' });

    const all = (await (await on.call('GET', `${ADMIN_PATH}/actions`, { token: on.root.token })).json()) as {
      actions: Record<string, unknown>[];
    };
    assert.equal(all.actions.length, 1);
    const [action] = all.actions as [Record<string, unknown>];
    assert.deepEqual(Object.keys(action).toSorted(), ['action', 'actor', 'at', 'detail', 'workspace']);
    assert.equal(action.action, 'workspace-deleted');
    assert.deepEqual(action.actor, { id: on.root.id, email: 'root@instance.dev' });
    assert.deepEqual(action.workspace, { id: on.acme, name: 'Acme' });
    assert.deepEqual(action.detail, {
      workspace: { id: on.acme, name: 'Acme' },
      gone: { sites: 1, members: 2, invitations: 1, connectors: 2, keptNotes: 1 },
    });
    assert.ok(!Number.isNaN(Date.parse(String(action.at))));

    // No owner reads it: the workspace is gone, and the other workspace of its owner does not show it.
    const ofGlobex = (await (
      await on.call('GET', `/console/workspaces/${on.globex}/admin-reads`, { token: on.alice.token })
    ).json()) as { actions: unknown[] };
    assert.deepEqual(ofGlobex.actions, []);
  });

  it('lists the deleted workspaces alone with kind, and that read leaves no trace with an owner', async () => {
    const on = await anInstance();
    const suspended = await on.call('POST', `${ADMIN_PATH}/workspaces/${on.globex}/suspension`, {
      token: on.root.token,
      body: { suspended: true },
    });
    assert.equal(suspended.status, 200);
    assert.equal((await deletion(on, on.acme, { name: 'Acme' })).status, 200);
    const read = async (query: string) => {
      const answer = await on.call('GET', `${ADMIN_PATH}/actions${query}`, { token: on.root.token });

      return { status: answer.status, body: (await answer.json()) as { actions?: { action: string }[] } };
    };

    const deleted = await read('?kind=workspace-deleted');
    assert.equal(deleted.status, 200);
    assert.deepEqual(
      deleted.body.actions?.map((each) => each.action),
      ['workspace-deleted'],
    );
    assert.equal(await count(on, 'admin_reads'), 0);
    for (const kind of ['nothing', 'workspace-deleted,admin-named', '']) {
      const refused = await read(`?kind=${encodeURIComponent(kind)}`);
      assert.equal(refused.status, 400, kind);
      assert.deepEqual(refused.body, { error: 'invalid-kind' });
    }

    // The control: every action names Globex, and its owners read that the administrator read it.
    const all = await read('');
    assert.deepEqual(
      all.body.actions?.map((each) => each.action),
      ['workspace-deleted', 'workspace-suspended'],
    );
    assert.equal(await count(on, `admin_reads WHERE workspace_id = '${on.globex}' AND what = 'actions'`), 1);
  });
});

describe('what follows the commit of a deletion (FRU-284)', () => {
  it('ends the sessions of the extension even when a revocation throws, and writes it in the log', async () => {
    const ended: string[] = [];
    const reads = {
      deleteWorkspace: async () => ({
        ok: true as const,
        workspace: { id: 'ws_1', name: 'Acme' },
        gone: { sites: 0, members: 1, invitations: 0, connectors: 1, keptNotes: 0 },
        revoke: ['sealed-1', 'sealed-2'],
      }),
    } as unknown as InstanceAdminReads;
    const revoked: string[] = [];
    const logged = mockMethod(console, 'error', () => undefined);
    const answer = await handleInstanceAdmin(
      new Request(`http://worker.test${ADMIN_PATH}/workspaces/ws_1/deletion`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Acme' }),
      }),
      `${ADMIN_PATH}/workspaces/ws_1/deletion`,
      {
        admin: async () => ({ id: 'acc_root', email: 'root@instance.dev' }),
        reads,
        facts: {} as never,
        afterDeletion: {
          revoke: async (sealed) => {
            revoked.push(sealed);
            if (sealed === 'sealed-1') throw new Error('the key could not be read');
          },
          endWorkspaceSessions: async (workspace) => void ended.push(workspace),
        },
      },
      {},
    );

    assert.equal(answer?.status, 200);
    assert.deepEqual(revoked, ['sealed-1', 'sealed-2'], 'the second key is revoked after the first one failed');
    assert.deepEqual(ended, ['ws_1']);
    assert.equal(logged.mock.calls.length, 1);
  });
});
