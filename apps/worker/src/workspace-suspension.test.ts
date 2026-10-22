import { DEFAULT_SEED_STAGE } from '@fruitback/shared';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'vitest';
import { type Seed, canonicalizePageUrl } from '@fruitback/shared';
import { seedFixture } from '@fruitback/shared/seed.fixture';
import { newId } from './account-rows.ts';
import { DEFAULT_CONNECTOR_SETTINGS } from './accounts.ts';
import { type RequestContext, handleRequest } from './app.ts';
import { noteIdOf } from './console-notes.ts';
import {
  type CallOptions,
  WORKER,
  type World,
  callOn,
  memberOf,
  signInTo,
  workspaceIn,
  worlds,
} from './console-world.fixture.ts';
import { ADMIN_PATH, SUSPENSION_REASON_LENGTH } from './instance-admin.ts';
import { ORGANIZATION_PATHS } from './organization-paths.ts';
import { rowsOf } from './postgres.fixture.ts';
import { deliverDue, deliveryBody, sealTarget } from './rest-connector.ts';
import { createMemoryAttachmentStore } from './attachments.ts';
import { seal } from './secrets.ts';
import { createPostgresSeedStore } from './seeds-postgres.ts';
import { createPairing, digest, redeemPairing } from './session.ts';
import { ALLOWED_WHILE_SUSPENDED, SUSPENDED_ERROR, SUSPENDED_STATUS } from './workspace-suspension.ts';

/**
 * An administrator of the instance suspends and restores a workspace (FRU-282). Every case goes
 * through `handleRequest`, as the console, the widget and the extension call it, on PGlite.
 */

const SECRETS_KEY = 'a-key-that-seals-the-connectors-0123456789';
const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const ACME = 'https://staging.acme.dev';
const GLOBEX = 'https://staging.globex.dev';
const PAGE = canonicalizePageUrl(`${ACME}/pricing`);
/** A site id that no site has. */
const UNKNOWN = 'site_00000000000000000000';
const ORG = '/console/auth/organization';

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

function noteOn(site: string, id: string): Seed {
  const seed = seedFixture({ id, page: { url: PAGE, path: '/pricing' } });

  return { ...seed, client: { id: site, name: 'Acme' } };
}

/** A PNG header and nothing more: the worker reads its size and keeps its bytes. */
function png(): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, 4);
  new DataView(bytes.buffer).setUint32(20, 3);

  return bytes;
}

/**
 * Root signs in first and is the administrator of the instance, in no workspace. Alice owns Acme,
 * with Carl a member, and Globex. Acme has a site that everybody reads, with one note. Globex has a
 * site on the same origin as the one of Acme, and a site of its own.
 */
async function anInstance() {
  const base = await open({ env: { FRUITBACK_STORE: 'postgres', FRUITBACK_SECRETS_KEY: SECRETS_KEY } });
  const world: World = {
    ...base,
    context: {
      ...base.context,
      store: createPostgresSeedStore(base.database),
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

  const call = (method: string, path: string, options: CallOptions = {}) => callOn(world, method, path, options);
  const member = await sessionOf(world, alice, acme);
  const posted = await call('POST', '/feedback', { token: member, origin: ACME, body: noteOn(site.id, 'sd_kept') });
  assert.equal(posted.status, 201, await posted.clone().text());

  return { world, call, root, alice, carl, acme, globex, site, twin, member };
}

type Instance = Awaited<ReturnType<typeof anInstance>>;

function suspension(on: Instance, workspace: string, body: unknown, token = on.root.token): Promise<Response> {
  return on.call('POST', `${ADMIN_PATH}/workspaces/${workspace}/suspension`, { token, body });
}

async function suspend(on: Instance, workspace: string, reason?: string): Promise<void> {
  const answer = await suspension(on, workspace, { suspended: true, ...(reason === undefined ? {} : { reason }) });
  assert.equal(answer.status, 200, await answer.clone().text());
}

async function restore(on: Instance, workspace: string): Promise<void> {
  const answer = await suspension(on, workspace, { suspended: false });
  assert.equal(answer.status, 200, await answer.clone().text());
}

/** Everything of an answer that a caller can read: its status, its headers and its bytes. */
async function bytesOf(answer: Response) {
  return {
    status: answer.status,
    headers: [...answer.headers].toSorted(([a], [b]) => a.localeCompare(b)),
    body: await answer.text(),
  };
}

/** A call of the extension with the bytes of a file (FRU-331): `callOn` sends JSON. */
function picture(on: Instance, method: string, path: string, origin: string | null, body?: Uint8Array) {
  return handleRequest(
    new Request(`${WORKER}${path}`, {
      method,
      headers: { ...(origin === null ? {} : { Origin: origin }), Authorization: `Bearer ${on.member}` },
      ...(body === undefined ? {} : { body }),
    }),
    on.world.env,
    { clientIp: '198.18.3.1', ...on.world.context } as RequestContext,
  );
}

async function count(on: Instance, table: string): Promise<number> {
  const [row] = await rowsOf(on.world.database, `SELECT count(*)::int AS n FROM ${table}`);

  return Number(row?.n);
}

describe('the route of the suspension of a workspace (FRU-282)', () => {
  it('suspends with a reason, says nothing changed the second time, and restores', async () => {
    const on = await anInstance();

    const first = await suspension(on, on.acme, { suspended: true, reason: '  impayé \n depuis   octobre ' });
    assert.equal(first.status, 200);
    const suspended = (await first.json()) as { workspace: Record<string, unknown>; changed: boolean };
    assert.equal(suspended.changed, true);
    assert.deepEqual(Object.keys(suspended.workspace), ['id', 'suspended', 'suspendedAt', 'reason']);
    assert.equal(suspended.workspace.id, on.acme);
    assert.equal(suspended.workspace.suspended, true);
    assert.equal(suspended.workspace.reason, 'impayé depuis octobre');
    assert.ok(!Number.isNaN(Date.parse(String(suspended.workspace.suspendedAt))));

    const again = (await (await suspension(on, on.acme, { suspended: true, reason: 'another' })).json()) as {
      workspace: Record<string, unknown>;
      changed: boolean;
    };
    assert.equal(again.changed, false);
    assert.deepEqual(again.workspace, suspended.workspace, 'a suspension that changes nothing keeps the first one');
    assert.equal(await count(on, 'admin_actions'), 1);

    const restored = await suspension(on, on.acme, { suspended: false });
    assert.deepEqual(await restored.json(), { workspace: { id: on.acme, suspended: false }, changed: true });
    const twice = await suspension(on, on.acme, { suspended: false });
    assert.deepEqual(await twice.json(), { workspace: { id: on.acme, suspended: false }, changed: false });
    assert.equal(await count(on, 'admin_actions'), 2);
    assert.equal(await count(on, 'workspace_suspensions'), 0);
  });

  it(`refuses a body that is not valid, a reason past ${SUSPENSION_REASON_LENGTH} characters, and a workspace that does not exist`, async () => {
    const on = await anInstance();
    assert.equal(SUSPENSION_REASON_LENGTH, 200, 'the name of this test says 200');

    for (const body of [{}, { suspended: 'yes' }, { suspended: 1 }, [true], 'true', null]) {
      const answer = await suspension(on, on.acme, body);
      assert.equal(answer.status, 400, JSON.stringify(body));
      assert.deepEqual(await answer.json(), { error: 'invalid-suspended' });
    }
    for (const reason of [42, { text: 'impayé' }, 'é'.repeat(SUSPENSION_REASON_LENGTH + 1)]) {
      const answer = await suspension(on, on.acme, { suspended: true, reason });
      assert.equal(answer.status, 400);
      assert.deepEqual(await answer.json(), { error: 'invalid-reason', maxLength: SUSPENSION_REASON_LENGTH });
    }
    const unknown = await suspension(on, 'ws_00000000000000000000', { suspended: true });
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: 'not-found' });
    assert.equal(await count(on, 'workspace_suspensions'), 0);
    assert.equal(await count(on, 'admin_actions'), 0);

    // The control: the longest reason is taken, and an empty one is none.
    const longest = await suspension(on, on.acme, { suspended: true, reason: 'é'.repeat(SUSPENSION_REASON_LENGTH) });
    assert.equal(((await longest.json()) as { workspace: { reason: string } }).workspace.reason.length, 200);
    const blank = await suspension(on, on.globex, { suspended: true, reason: '   ' });
    assert.equal(((await blank.json()) as { workspace: { reason?: string } }).workspace.reason, undefined);
  });

  it('answers 404 to every caller who is not the administrator of the instance, and writes nothing', async () => {
    const on = await anInstance();
    for (const token of [on.alice.token, on.carl.token]) {
      const answer = await suspension(on, on.acme, { suspended: true }, token);
      assert.equal(answer.status, 404);
    }
    const nobody = await on.call('POST', `${ADMIN_PATH}/workspaces/${on.acme}/suspension`, {
      body: { suspended: true },
    });
    assert.equal(nobody.status, 404);
    assert.equal(await count(on, 'workspace_suspensions'), 0);
  });

  it('lets an administrator suspend a workspace they are a member of, and restore it', async () => {
    const on = await anInstance();
    await memberOf(on.world, on.acme, on.root.id, 'member');

    await suspend(on, on.acme);
    const me = (await (await on.call('GET', '/console/me', { token: on.root.token })).json()) as {
      workspaces: { id: string; suspended: boolean }[];
    };
    assert.equal(me.workspaces.find((each) => each.id === on.acme)?.suspended, true);
    const sites = await on.call('GET', `/console/workspaces/${on.acme}/sites`, { token: on.root.token });
    assert.equal(sites.status, 200);
    await restore(on, on.acme);
  });
});

describe('a site of a suspended workspace answers as a site that does not exist (FRU-282)', () => {
  /** Each route of the widget and of the extension that takes a site, as `client`. */
  const SITE_ROUTES: { name: string; ask(on: Instance, site: string, origin: string | null): Promise<Response> }[] = [
    {
      name: 'GET /feedback, with no token',
      ask: (on, site, origin) => on.call('GET', `/feedback?url=${encodeURIComponent(PAGE)}&client=${site}`, { origin }),
    },
    {
      name: 'GET /feedback, with a session of the workspace',
      ask: (on, site, origin) =>
        on.call('GET', `/feedback?url=${encodeURIComponent(PAGE)}&client=${site}`, { origin, token: on.member }),
    },
    {
      name: 'POST /feedback',
      ask: (on, site, origin) =>
        on.call('POST', '/feedback', { origin, token: on.member, body: noteOn(site, 'sd_while_suspended') }),
    },
    {
      name: 'POST /feedback, a batch',
      ask: (on, site, origin) =>
        on.call('POST', '/feedback', { origin, token: on.member, body: [noteOn(site, 'sd_batch_suspended')] }),
    },
    {
      name: 'POST /feedback/<id>/replies, with no token',
      ask: (on, site, origin) =>
        on.call('POST', `/feedback/lin_1/replies?client=${site}`, {
          origin,
          body: { url: PAGE, body: 'Same here.', name: 'Bob' },
        }),
    },
    {
      name: 'POST /feedback/<id>/replies, with a session of the workspace',
      ask: (on, site, origin) =>
        on.call('POST', `/feedback/lin_1/replies?client=${site}`, {
          origin,
          token: on.member,
          body: { url: PAGE, body: 'Same here.' },
        }),
    },
    {
      name: 'POST /attachments',
      ask: (on, site, origin) => picture(on, 'POST', `/attachments?client=${site}`, origin, png()),
    },
  ];

  it('answers every route of the widget that takes a site, for a site of a suspended workspace, with the bytes of an unknown site', async () => {
    assert.equal(SITE_ROUTES.length, 7);
    for (const route of SITE_ROUTES) {
      const on = await anInstance();
      // The control: before the suspension, the site is served, and the answers differ.
      const served = await bytesOf(await route.ask(on, on.site.id, null));
      const unknownBefore = await bytesOf(await route.ask(on, UNKNOWN, null));
      assert.notDeepEqual(
        served,
        unknownBefore,
        `${route.name}: the site is not served, the comparison proves nothing`,
      );
      const notes = await count(on, 'seeds');

      await suspend(on, on.acme, 'impayé');

      // No `Origin`, the origin of the site, which the twin site of Globex keeps allowed, and the
      // origin of Globex: the answer of the site is the one of a site that does not exist.
      for (const origin of [null, ACME, GLOBEX]) {
        const suspended = await bytesOf(await route.ask(on, on.site.id, origin));
        const unknown = await bytesOf(await route.ask(on, UNKNOWN, origin));
        assert.deepEqual(suspended, unknown, `${route.name}, from ${origin ?? 'no origin'}`);
      }
      assert.equal(await count(on, 'seeds'), notes, `${route.name}: a suspended site took a note`);

      // The notes stay, and the restored site serves them again.
      await restore(on, on.acme);
      const read = await on.call('GET', `/feedback?url=${encodeURIComponent(PAGE)}&client=${on.site.id}`, {
        origin: ACME,
      });
      assert.equal(read.status, 200);
      const { issues } = (await read.json()) as { issues: { seed: { id: string } }[] };
      assert.ok(
        issues.some((issue) => issue.seed.id === 'sd_kept'),
        route.name,
      );
    }
  });

  it('stops allowing the origin of a site that no other workspace has, as an origin that no site has', async () => {
    const on = await anInstance();
    const only = await on.world.accounts.addSite(on.acme, { origin: 'https://only.acme.dev', visibility: 'everyone' });
    const read = (site: string, origin: string) =>
      on.call('GET', `/feedback?url=${encodeURIComponent(PAGE)}&client=${site}`, { origin });
    // The control: before the suspension, the origin is allowed.
    assert.notEqual((await read(only.id, 'https://only.acme.dev')).status, 403);

    await suspend(on, on.acme);

    const suspended = await bytesOf(await read(only.id, 'https://only.acme.dev'));
    assert.deepEqual(suspended, await bytesOf(await read(UNKNOWN, 'https://never.acme.dev')));
    assert.equal(suspended.status, 403);
  });

  it('answers as a deleted workspace on GET /session/sites, with a session of the account and of the workspace', async () => {
    const on = await anInstance();
    const ofAccount = await accountSession(on.world, on.alice);
    const ofAcme = on.member;
    const sitesOf = async (token: string) =>
      bytesOf(await on.call('GET', '/session/sites', { token, origin: EXTENSION }));
    const before = await sitesOf(ofAccount);
    assert.ok(before.body.includes(on.site.id), 'the control: the site of Acme is listed');
    assert.equal((await sitesOf(ofAcme)).status, 200);

    await suspend(on, on.acme, 'impayé');
    const suspended = { account: await sitesOf(ofAccount), workspace: await sitesOf(ofAcme) };
    assert.ok(!suspended.account.body.includes(on.acme));

    // A deletion by its owner is allowed while it is suspended. Then the workspace does not exist.
    const deleted = await on.call('DELETE', `/console/workspaces/${on.acme}`, { token: on.alice.token });
    assert.equal(deleted.status, 204);
    assert.deepEqual(suspended.account, await sitesOf(ofAccount));
    assert.deepEqual(suspended.workspace, await sitesOf(ofAcme));
    assert.equal(suspended.workspace.status, 401);
  });

  it('keeps the sessions of the extension: the same tokens read the sites again after the restoration', async () => {
    const on = await anInstance();
    const ofAccount = await accountSession(on.world, on.alice);
    const ofAcme = on.member;
    const sitesOf = async (token: string) =>
      bytesOf(await on.call('GET', '/session/sites', { token, origin: EXTENSION }));
    const before = { account: await sitesOf(ofAccount), workspace: await sitesOf(ofAcme) };
    assert.equal(before.workspace.status, 200);
    assert.ok(before.account.body.includes(on.site.id), 'the control: the site of Acme is listed');

    await suspend(on, on.acme, 'impayé');
    // The answer of a workspace that does not exist, which the extension reads as no answer: it ends
    // a session only on a refusal of `/session/refresh` (`apps/extension/src/session.ts`).
    assert.equal((await sitesOf(ofAcme)).status, 401);
    assert.ok(!(await sitesOf(ofAccount)).body.includes(on.site.id));

    await restore(on, on.acme);
    assert.deepEqual(await sitesOf(ofAcme), before.workspace);
    assert.deepEqual(await sitesOf(ofAccount), before.account);
  });

  it('refuses POST /session/sites into a suspended workspace as into a workspace that does not exist', async () => {
    const on = await anInstance();
    const ofAccount = await accountSession(on.world, on.alice);
    const add = async (workspace: string) =>
      bytesOf(
        await on.call('POST', '/session/sites', {
          token: ofAccount,
          origin: EXTENSION,
          body: { workspace, origin: 'https://new.acme.dev' },
        }),
      );
    await suspend(on, on.acme);

    assert.deepEqual(await add(on.acme), await add('ws_00000000000000000000'));
    assert.equal(await count(on, 'sites'), 3);
    // The control: the same call into Globex adds the site.
    assert.equal((await add(on.globex)).status, 201);
  });
});

describe('the members of a suspended workspace (FRU-282)', () => {
  it('read every route of the console, sign in again, and read the suspension on /console/me', async () => {
    const on = await anInstance();
    await suspend(on, on.acme, 'impayé');
    const carl = await signInTo(on.world, 'carl@acme.dev');

    const me = (await (await on.call('GET', '/console/me', { token: carl.token })).json()) as {
      workspaces: Record<string, unknown>[];
    };
    const [acme] = me.workspaces;
    // No reason (FRU-328): it is a note of the administrator of the instance.
    assert.deepEqual(Object.keys(acme ?? {}), ['id', 'name', 'role', 'suspended', 'suspendedAt']);
    assert.equal(acme?.suspended, true);
    const globex = (await (await on.call('GET', '/console/me', { token: on.alice.token })).json()) as {
      workspaces: Record<string, unknown>[];
    };
    assert.deepEqual(
      globex.workspaces.find((each) => each.id === on.globex),
      { id: on.globex, name: 'Globex', role: 'owner', suspended: false },
    );

    for (const rest of ['/sites', '/connectors', '/notes', '/domains', '/members/seen', '/admin-reads']) {
      const answer = await on.call('GET', `/console/workspaces/${on.acme}${rest}`, { token: on.alice.token });
      assert.equal(answer.status, 200, `${rest}: ${await answer.text()}`);
    }
    for (const path of [`list-members?organizationId=${on.acme}`, `list-invitations?organizationId=${on.acme}`]) {
      assert.equal((await on.call('GET', `${ORG}/${path}`, { token: on.alice.token })).status, 200, path);
    }
  });

  it('answers the reason on no route that a member reads, and on the routes of the administrator (FRU-328)', async () => {
    const on = await anInstance();
    const NOTE = 'NOTE-OF-THE-ADMINISTRATOR unpaid since October';
    await suspend(on, on.acme, NOTE);
    const said = async (method: string, path: string, token: string, body?: unknown) => {
      const answer = await on.call(method, path, { token, ...(body === undefined ? {} : { body }) });

      return `${method} ${path} ${answer.status} ${await answer.text()}`;
    };

    // What the owner and a member of the workspace read: every read of the console and of the
    // organization plugin, the trace of the administrators, and the refusal of a write.
    const read: string[] = [];
    for (const token of [on.alice.token, on.carl.token]) {
      read.push(await said('GET', '/console/me', token));
      for (const rest of ['/sites', '/connectors', '/notes', '/domains', '/members/seen', '/admin-reads']) {
        read.push(await said('GET', `/console/workspaces/${on.acme}${rest}`, token));
      }
      for (const path of [
        `list-members?organizationId=${on.acme}`,
        `list-invitations?organizationId=${on.acme}`,
        `get-full-organization?organizationId=${on.acme}`,
      ]) {
        read.push(await said('GET', `${ORG}/${path}`, token));
      }
      read.push(await said('POST', `/console/workspaces/${on.acme}/sites`, token, { url: 'https://new.acme.dev' }));
      read.push(await said('POST', `${ORG}/update`, token, { organizationId: on.acme, data: { name: 'Renamed' } }));
    }
    // The extension: the sites of a session of the account and of a session of the workspace, and
    // the widget on the site of the workspace.
    const ofAccount = await accountSession(on.world, on.alice);
    for (const token of [ofAccount, on.member]) {
      const sites = await on.call('GET', '/session/sites', { token, origin: EXTENSION });
      read.push(`GET /session/sites ${sites.status} ${await sites.text()}`);
    }
    const widget = await on.call('GET', `/feedback?url=${encodeURIComponent(PAGE)}&client=${on.site.id}`, {
      origin: ACME,
    });
    read.push(`GET /feedback ${widget.status} ${await widget.text()}`);
    // A sign-in link sent while suspended: the mail that the worker sends.
    await signInTo(on.world, 'carl@acme.dev');
    assert.ok(on.world.mail.sent.length > 0, 'the control: the worker sent mail');
    read.push(...on.world.mail.sent.map((message) => `mail ${JSON.stringify(message)}`));
    for (const answer of read) assert.ok(!answer.includes('NOTE-OF-THE-ADMINISTRATOR'), answer);
    // The reads did happen: the suspension is said, with its day.
    assert.ok(read.some((answer) => answer.includes('"suspendedAt"')));
    assert.ok(read.some((answer) => answer.includes('workspace-suspended')));

    // The control: the routes of the administrator of the instance answer the reason.
    for (const path of [`${ADMIN_PATH}/workspaces`, `${ADMIN_PATH}/workspaces/${on.acme}`, `${ADMIN_PATH}/actions`]) {
      assert.ok((await said('GET', path, on.root.token)).includes(NOTE), path);
    }
  });

  it('says the suspension in the lists of the administrator, and in the detail of the workspace', async () => {
    const on = await anInstance();
    await suspend(on, on.acme, 'impayé');

    const list = (await (await on.call('GET', `${ADMIN_PATH}/workspaces`, { token: on.root.token })).json()) as {
      workspaces: { id: string; suspended: boolean; reason?: string; suspendedAt?: string }[];
    };
    const acme = list.workspaces.find((each) => each.id === on.acme);
    assert.equal(acme?.suspended, true);
    assert.equal(acme?.reason, 'impayé');
    assert.equal(typeof acme?.suspendedAt, 'string');
    assert.deepEqual(
      list.workspaces.filter((each) => each.id === on.globex).map(({ suspended, reason }) => ({ suspended, reason })),
      [{ suspended: false, reason: undefined }],
    );
    const detail = (await (
      await on.call('GET', `${ADMIN_PATH}/workspaces/${on.acme}`, { token: on.root.token })
    ).json()) as { suspended: boolean; reason?: string };
    assert.equal(detail.suspended, true);
    assert.equal(detail.reason, 'impayé');
  });
});

describe('the trace of a suspension of a workspace (FRU-282)', () => {
  it('writes one action for each change: the owners read who and when, the administrators the reason too', async () => {
    const on = await anInstance();
    await suspend(on, on.acme, 'impayé');
    await suspend(on, on.acme, 'twice');
    const restored = await suspension(on, on.acme, { suspended: false, reason: 'payé' });
    assert.equal(restored.status, 200);

    const traced = (await (
      await on.call('GET', `/console/workspaces/${on.acme}/admin-reads`, { token: on.alice.token })
    ).json()) as { actions: Record<string, unknown>[] };
    assert.deepEqual(
      traced.actions.map(({ action, admin, target }) => ({ action, admin, target })),
      [
        { action: 'workspace-restored', admin: { email: 'root@instance.dev' }, target: undefined },
        { action: 'workspace-suspended', admin: { email: 'root@instance.dev' }, target: undefined },
      ],
    );
    // The shape of `TracedAction` for an action on the workspace: no `target` key at all, not even
    // null, and no `reason` (FRU-328): the administrators read it below.
    assert.deepEqual(
      traced.actions.map((each) => Object.keys(each).toSorted()),
      [
        ['action', 'admin', 'at'],
        ['action', 'admin', 'at'],
      ],
    );
    const ofGlobex = (await (
      await on.call('GET', `/console/workspaces/${on.globex}/admin-reads`, { token: on.alice.token })
    ).json()) as { actions: unknown[] };
    assert.deepEqual(ofGlobex.actions, []);

    const all = (await (await on.call('GET', `${ADMIN_PATH}/actions`, { token: on.root.token })).json()) as {
      actions: { action: string; workspace?: { id: string }; detail?: unknown; target?: unknown }[];
    };
    assert.deepEqual(
      all.actions.map(({ action, workspace, detail, target }) => ({
        action,
        workspace: workspace?.id,
        detail,
        target,
      })),
      [
        { action: 'workspace-restored', workspace: on.acme, detail: { reason: 'payé' }, target: undefined },
        { action: 'workspace-suspended', workspace: on.acme, detail: { reason: 'impayé' }, target: undefined },
      ],
    );
  });
});

describe('the deliveries of a suspended workspace (FRU-282)', () => {
  async function withADelivery(attempts: number) {
    const on = await anInstance();
    const connector = await on.world.accounts.addConnector(on.acme, {
      kind: 'rest',
      label: 'hooks.acme.dev',
      sealed: sealTarget(
        { url: 'https://hooks.acme.dev/fruitback', secret: 'a-secret-of-the-receiver-0123456789' },
        SECRETS_KEY,
      ),
    });
    const id = await on.world.accounts.enqueueDelivery(connector.id, '{"a":"note"}', 1_000);
    await rowsOf(on.world.database, `UPDATE deliveries SET attempts = ${attempts}, next_at = 2000 WHERE id = '${id}'`);
    const sent: string[] = [];
    const pass = (status: number, now: number) =>
      deliverDue({
        accounts: on.world.accounts,
        secretsKey: SECRETS_KEY,
        now: () => now,
        send: async (url) => {
          sent.push(url);
          return new Response(null, { status });
        },
      });
    const row = async () =>
      (await rowsOf(on.world.database, `SELECT attempts, next_at FROM deliveries WHERE id = '${id}'`))[0];

    return { on, sent, pass, row };
  }

  it('sends nothing while suspended, counts no attempt, and sends after the restoration', async () => {
    const { on, sent, pass, row } = await withADelivery(0);
    await suspend(on, on.acme);

    for (const now of [3_000, 10_000_000, 10_000_000_000]) {
      assert.deepEqual(await pass(200, now), { delivered: 0, failed: 0 });
    }
    assert.deepEqual(sent, []);
    assert.deepEqual(await row(), { attempts: 0, next_at: 2000 });

    await restore(on, on.acme);
    assert.deepEqual(await pass(200, 3_000), { delivered: 1, failed: 0 });
    assert.deepEqual(sent, ['https://hooks.acme.dev/fruitback']);
    assert.equal(await row(), undefined, 'a delivery that arrived goes');
  });

  it('keeps the count of a delivery that failed before the suspension, and goes on from it after', async () => {
    const { on, sent, pass, row } = await withADelivery(2);
    await suspend(on, on.acme);
    assert.deepEqual(await pass(503, 3_000), { delivered: 0, failed: 0 });
    assert.deepEqual(await row(), { attempts: 2, next_at: 2000 });

    await restore(on, on.acme);
    assert.deepEqual(await pass(503, 3_000), { delivered: 0, failed: 1 });
    assert.equal(sent.length, 1);
    assert.equal((await row())?.attempts, 3);
  });
});

/**
 * Every write of the console API under `/console/workspaces/<id>`. `rest` is the path after the id,
 * `make` writes what the call needs and gives the call, and `status` is the answer with no suspension.
 */
type Write = {
  method: string;
  rest: (fx: Fixtures) => string;
  body?: (fx: Fixtures) => unknown;
  status: number;
};

type Fixtures = Instance & {
  spareSite: string;
  domain: string;
  spareDomain: string;
  rest: string;
  spareConnector: string;
  linear: string;
  delivery: string;
  note: string;
  kept: string;
};

async function fixtures(on: Instance): Promise<Fixtures> {
  const { accounts, database } = on.world;
  const spareSite = (await accounts.addSite(on.acme, { origin: 'https://spare.acme.dev', visibility: 'members' })).id;
  const domain = (await accounts.addDomain(on.acme, 'acme.dev', Date.now())).id;
  const spareDomain = (await accounts.addDomain(on.acme, 'spare.dev', Date.now())).id;
  const sealed = sealTarget(
    { url: 'https://hooks.acme.dev/x', secret: 'a-secret-of-the-receiver-0123456789' },
    SECRETS_KEY,
  );
  const rest = (await accounts.addConnector(on.acme, { kind: 'rest', label: 'hooks.acme.dev', sealed })).id;
  const spareConnector = (await accounts.addConnector(on.acme, { kind: 'rest', label: 'spare', sealed })).id;
  const linear = (
    await accounts.addConnector(on.acme, { kind: 'linear', label: 'Linear', sealed: seal('lin_api_key', SECRETS_KEY) })
  ).id;
  await rowsOf(
    database,
    `INSERT INTO note_index (site_id, seed_id, workspace_id, page_url, excerpt, stage, author_kind, place, connector_id, reference, created_at, checked_at)
       VALUES ('${on.site.id}', 'sd_late', '${on.acme}', '${PAGE}', 'A note', 'new', 'visitor', 'connector', '${rest}', 'FB-1', 1, 1)`,
  );
  const delivery = await accounts.enqueueDelivery(
    rest,
    deliveryBody({
      workspace: on.acme,
      site: { id: on.site.id },
      identifier: 'FB-1',
      seed: seedFixture({ id: 'sd_late' }),
    }),
    1,
  );
  await rowsOf(database, `UPDATE deliveries SET next_at = NULL, attempts = 7`);

  return {
    ...on,
    spareSite,
    domain,
    spareDomain,
    rest,
    spareConnector,
    linear,
    delivery,
    note: noteIdOf(on.site.id, 'sd_late'),
    kept: noteIdOf(on.site.id, 'sd_kept'),
  };
}

const CONSOLE_WRITES: readonly Write[] = [
  { method: 'POST', rest: () => '', body: () => ({ name: 'Acme Studio' }), status: 200 },
  { method: 'POST', rest: () => '/sites', body: () => ({ url: 'https://new.acme.dev' }), status: 201 },
  { method: 'DELETE', rest: (fx) => `/sites/${fx.spareSite}`, status: 204 },
  { method: 'POST', rest: (fx) => `/sites/${fx.site.id}/destination`, body: () => ({ connector: null }), status: 200 },
  {
    method: 'POST',
    rest: (fx) => `/sites/${fx.site.id}/destinations`,
    body: () => ({ destinations: [] }),
    status: 200,
  },
  // FRU-366: the statuses of a site. The status added first is the one ordered, then removed.
  {
    method: 'POST',
    rest: (fx) => `/sites/${fx.site.id}/statuses`,
    body: () => ({ source: 'own', key: 'waiting', stage: DEFAULT_SEED_STAGE }),
    status: 200,
  },
  {
    method: 'POST',
    rest: (fx) => `/sites/${fx.site.id}/statuses/order`,
    body: () => ({ order: [{ source: 'own', key: 'waiting' }] }),
    status: 200,
  },
  { method: 'DELETE', rest: (fx) => `/sites/${fx.site.id}/statuses/own/waiting`, status: 200 },
  { method: 'POST', rest: () => '/domains', body: () => ({ domain: 'acme.test' }), status: 201 },
  { method: 'DELETE', rest: (fx) => `/domains/${fx.spareDomain}`, status: 204 },
  { method: 'POST', rest: (fx) => `/domains/${fx.domain}/check`, status: 200 },
  { method: 'POST', rest: (fx) => `/domains/${fx.domain}/previews`, body: () => ({ site: null }), status: 200 },
  {
    method: 'POST',
    rest: () => '/connectors',
    body: () => ({ kind: 'rest', url: 'https://hooks.example.com/fruitback' }),
    status: 201,
  },
  // No application of Linear on this worker: the route answers after the guard that it has none.
  { method: 'POST', rest: () => '/connectors/linear/oauth', status: 404 },
  // No GitHub App on this worker either (FRU-360).
  { method: 'POST', rest: () => '/connectors/github/start', status: 404 },
  { method: 'POST', rest: (fx) => `/connectors/${fx.rest}/deliveries/${fx.delivery}/retry`, status: 204 },
  {
    method: 'POST',
    rest: (fx) => `/connectors/${fx.linear}/settings`,
    body: () => DEFAULT_CONNECTOR_SETTINGS,
    status: 200,
  },
  { method: 'DELETE', rest: (fx) => `/connectors/${fx.spareConnector}`, status: 204 },
  { method: 'POST', rest: () => '/connect', body: () => ({}), status: 201 },
  { method: 'POST', rest: (fx) => `/notes/${fx.note}/retry`, status: 204 },
  // FRU-384: the status of a note the worker keeps, chosen in the console.
  {
    method: 'POST',
    rest: (fx) => `/notes/${fx.kept}/status`,
    body: () => ({ status: `own:${DEFAULT_SEED_STAGE}` }),
    status: 200,
  },
  // A path that no route serves: the guard answers before the routes.
  { method: 'POST', rest: () => '/a-route-of-later', body: () => ({}), status: 404 },
];

/** The routes that only read: the source scan finds them, and no write reaches them. */
const READ_ONLY_RESTS = [
  '/members/seen',
  '/admin-reads',
  '/notes',
  '/connectors/con_1/states',
  '/connectors/con_1/teams',
  '/connectors/con_1/repositories',
];

/** The paths that a route of the console API matches `rest` with, as the source writes them. */
function routesIn(source: string): string[] {
  return [
    ...[...source.matchAll(/rest (?:===|!==) '([^']*)'/g)].map((match) => `'${match[1]}'`),
    ...[...source.matchAll(/rest\.startsWith\('([^']*)'\)/g)].map((match) => `startsWith ${match[1]}`),
    ...[...source.matchAll(/\/(\^\S+?\$)\/\.exec\(rest\)/g)].map((match) => match[1] as string),
  ];
}

function covers(route: string, rest: string): boolean {
  if (route.startsWith("'")) return route === `'${rest}'`;
  if (route.startsWith('startsWith ')) return rest.startsWith(route.slice('startsWith '.length));

  return new RegExp(route).test(rest);
}

describe('the one guard of the writes of a suspended workspace (FRU-282)', () => {
  it('refuses every write of the console API with 409 and writes nothing, and each one works after the restoration', async () => {
    const fx = await fixtures(await anInstance());
    const tables = [
      'sites',
      'domains',
      'connectors',
      'deliveries',
      'site_destinations',
      'statuses',
      'seeds',
      'note_index',
      'pairings',
      'organization',
    ];
    const snapshot = async () =>
      Promise.all(
        tables.map(async (table) =>
          JSON.stringify(await rowsOf(fx.world.database, `SELECT * FROM ${table} ORDER BY 1`)),
        ),
      );

    for (const write of CONSOLE_WRITES) {
      const rest = write.rest(fx);
      const ask = () =>
        fx.call(write.method, `/console/workspaces/${fx.acme}${rest}`, {
          token: fx.alice.token,
          ...(write.body === undefined ? {} : { body: write.body(fx) }),
        });
      await suspend(fx, fx.acme, 'impayé');
      const before = await snapshot();
      const refused = await ask();
      assert.equal(refused.status, SUSPENDED_STATUS, `${write.method} ${rest}: ${await refused.clone().text()}`);
      const body = (await refused.json()) as Record<string, unknown>;
      assert.equal(body.error, SUSPENDED_ERROR);
      // The day, for the banner, and no reason (FRU-328).
      assert.deepEqual(Object.keys(body).toSorted(), ['error', 'suspendedAt'], `${write.method} ${rest}`);
      assert.deepEqual(await snapshot(), before, `${write.method} ${rest} wrote while suspended`);

      await restore(fx, fx.acme);
      const done = await ask();
      assert.equal(done.status, write.status, `${write.method} ${rest} after the restoration: ${await done.text()}`);
    }
  });

  it('refuses every POST of the organization plugin that changes the workspace, and lets a member leave', async () => {
    const on = await anInstance();
    const { database } = on.world;
    const dave = await signInTo(on.world, 'dave@acme.dev');
    const erin = await signInTo(on.world, 'erin@acme.dev');
    const fay = await signInTo(on.world, 'fay@client.fr');
    await memberOf(on.world, on.acme, dave.id, 'member');
    await memberOf(on.world, on.acme, erin.id, 'member');
    const [carl] = await rowsOf(database, `SELECT id FROM member WHERE "userId" = '${on.carl.id}'`);
    const invitation = async (email: string) => {
      const id = newId('inv');
      await rowsOf(
        database,
        `INSERT INTO invitation (id, "organizationId", email, role, status, "expiresAt", "inviterId")
           VALUES ('${id}', '${on.acme}', '${email}', 'member', 'pending', now() + interval '1 day', '${on.alice.id}')`,
      );

      return id;
    };
    const toCancel = await invitation('gus@acme.dev');
    const toAccept = await invitation('fay@client.fr');

    const writes: Record<string, { token: string; body: Record<string, unknown> }> = {
      '/organization/update-member-role': {
        token: on.alice.token,
        body: { organizationId: on.acme, memberId: carl?.id, role: 'admin' },
      },
      '/organization/remove-member': {
        token: on.alice.token,
        body: { organizationId: on.acme, memberIdOrEmail: 'dave@acme.dev' },
      },
      '/organization/invite-member': {
        token: on.alice.token,
        body: { organizationId: on.acme, email: 'hal@acme.dev', role: 'member' },
      },
      '/organization/cancel-invitation': {
        token: on.alice.token,
        body: { organizationId: on.acme, invitationId: toCancel },
      },
      '/organization/accept-invitation': { token: fay.token, body: { invitationId: toAccept } },
    };
    const allowed: Record<string, { token: string; body: Record<string, unknown> }> = {
      '/organization/leave': { token: erin.token, body: { organizationId: on.acme } },
    };
    // A refusal of an invitation names no workspace: it changes what the person received, and the
    // guard does not see it.
    const ofThePerson = ['/organization/reject-invitation'];
    const posts = Object.entries(ORGANIZATION_PATHS)
      .filter(([, rule]) => rule.method === 'POST')
      .map(([path]) => path);
    assert.deepEqual(
      posts.toSorted(),
      [...Object.keys(writes), ...Object.keys(allowed), ...ofThePerson].toSorted(),
      'a POST of the organization plugin that this test does not name',
    );
    const snapshot = async () =>
      JSON.stringify([
        await rowsOf(database, `SELECT id, role FROM member ORDER BY id`),
        await rowsOf(database, `SELECT id, status FROM invitation ORDER BY id`),
      ]);

    for (const [path, { token, body }] of Object.entries(writes)) {
      await suspend(on, on.acme, 'impayé');
      const before = await snapshot();
      const refused = await on.call('POST', `${ORG}${path.slice('/organization'.length)}`, { token, body });
      assert.equal(refused.status, SUSPENDED_STATUS, `${path}: ${await refused.clone().text()}`);
      // A member reads since when, and a person invited only that the workspace is suspended. Nobody
      // reads the reason here (FRU-328).
      const said = (await refused.json()) as { error: string; reason?: string; suspendedAt?: string };
      assert.equal(said.error, SUSPENDED_ERROR);
      const toMember = path !== '/organization/accept-invitation';
      assert.deepEqual(
        [said.reason, said.suspendedAt !== undefined],
        toMember ? [undefined, true] : [undefined, false],
        path,
      );
      assert.equal(await snapshot(), before, `${path} wrote while suspended`);

      await restore(on, on.acme);
      const done = await on.call('POST', `${ORG}${path.slice('/organization'.length)}`, { token, body });
      assert.equal(done.status, 200, `${path} after the restoration: ${await done.text()}`);
    }

    await suspend(on, on.acme);
    for (const [path, { token, body }] of Object.entries(allowed)) {
      const left = await on.call('POST', `${ORG}${path.slice('/organization'.length)}`, { token, body });
      assert.equal(left.status, 200, `${path}: ${await left.text()}`);
    }
    assert.equal(
      (
        (await on.call('GET', '/console/me', { token: erin.token }).then((each) => each.json())) as {
          workspaces: unknown[];
        }
      ).workspaces.length,
      0,
    );
  });

  it('tells the suspension to the person of an invitation only, not to another account that holds its id', async () => {
    const on = await anInstance();
    const { database } = on.world;
    const fay = await signInTo(on.world, 'fay@client.fr');
    const mallory = await signInTo(on.world, 'mallory@elsewhere.dev');
    const id = newId('inv');
    await rowsOf(
      database,
      `INSERT INTO invitation (id, "organizationId", email, role, status, "expiresAt", "inviterId")
         VALUES ('${id}', '${on.acme}', 'fay@client.fr', 'member', 'pending', now() + interval '1 day', '${on.alice.id}')`,
    );
    const accept = async (token: string) => {
      const answer = await on.call('POST', `${ORG}/accept-invitation`, { token, body: { invitationId: id } });

      return { status: answer.status, body: (await answer.json()) as Record<string, unknown> };
    };
    const members = async () => rowsOf(database, `SELECT "userId" FROM member ORDER BY id`);
    // The control: with the workspace not suspended, better-auth refuses another account.
    const before = await accept(mallory.token);
    assert.notEqual(before.status, 200);
    const membersBefore = await members();

    await suspend(on, on.acme, 'impayé');
    const ofMallory = await accept(mallory.token);
    assert.deepEqual(ofMallory, before, 'another account reads the refusal of better-auth, not the suspension');
    assert.notEqual(ofMallory.body.error, SUSPENDED_ERROR);
    // The person of the invitation reads the suspension, without its reason.
    assert.deepEqual(await accept(fay.token), { status: SUSPENDED_STATUS, body: { error: SUSPENDED_ERROR } });
    assert.deepEqual(await members(), membersBefore);
  });

  it('refuses a write to a member who is not a member of the workspace with 404, not with the suspension', async () => {
    const on = await anInstance();
    const stranger = await signInTo(on.world, 'mallory@elsewhere.dev');
    await suspend(on, on.acme, 'impayé');

    const console = await on.call('POST', `/console/workspaces/${on.acme}/sites`, {
      token: stranger.token,
      body: { url: 'https://new.acme.dev' },
    });
    assert.deepEqual([console.status, await console.json()], [404, { error: 'not-found' }]);
    const plugin = await on.call('POST', `${ORG}/invite-member`, {
      token: stranger.token,
      body: { organizationId: on.acme, email: 'x@acme.dev', role: 'member' },
    });
    assert.deepEqual([plugin.status, await plugin.json()], [404, { error: 'not-found' }]);
  });

  it('lets the owner delete a suspended workspace, the one write of the console API that it allows', async () => {
    assert.deepEqual(
      ALLOWED_WHILE_SUSPENDED.map((each) =>
        'organization' in each ? each.organization : `${each.method} ${each.rest}`,
      ),
      ['DELETE ', '/organization/leave'],
    );
    const on = await anInstance();
    await suspend(on, on.acme, 'impayé');
    const deleted = await on.call('DELETE', `/console/workspaces/${on.acme}`, { token: on.alice.token });
    assert.equal(deleted.status, 204);
    assert.equal(await count(on, 'workspace_suspensions'), 0);
    // The trace of the administrator stays after the workspace goes.
    assert.deepEqual(
      (await rowsOf(on.world.database, 'SELECT action, workspace_id FROM admin_actions')).map((row) => row.action),
      ['workspace-suspended'],
    );
  });

  it('serves the paths of the workspaces in console-api.ts only, so no route of a workspace skips the guard', () => {
    const sources = readdirSync(new URL('.', import.meta.url)).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.fixture.ts'),
    );
    const found = (text: string): boolean => /['"`]\/console\/workspaces\b|\\\/console\\\/workspaces/.test(text);
    const elsewhere = sources.filter(
      (file) => file !== 'console-api.ts' && found(readFileSync(new URL(file, import.meta.url), 'utf8')),
    );

    assert.deepEqual(elsewhere, [], 'a route of a workspace is served outside console-api.ts, so maybe unguarded');
    assert.equal(found(readFileSync(new URL('console-api.ts', import.meta.url), 'utf8')), true);
    // The planted violation: a route written in `app.ts`, before the console API, is found.
    const planted = `${readFileSync(new URL('app.ts', import.meta.url), 'utf8')}\nif (pathname.startsWith('/console/workspaces/')) {}`;
    assert.equal(found(planted), true);
  });

  it('names every route of the console API that writes, and the guard comes before each one', () => {
    const sources = ['console-api.ts', 'console-notes.ts'].map((file) =>
      readFileSync(new URL(file, import.meta.url), 'utf8'),
    );
    const fx = {
      spareSite: 's',
      domain: 'd',
      spareDomain: 'd2',
      rest: 'c',
      spareConnector: 'c2',
      linear: 'l',
      delivery: 'dl',
      note: 'n',
      site: { id: 'site' },
    } as unknown as Fixtures;
    const rests = [...CONSOLE_WRITES.map((write) => write.rest(fx)), ...READ_ONLY_RESTS];
    const uncovered = (source: string) =>
      routesIn(source).filter((route) => !rests.some((rest) => covers(route, rest)));

    for (const source of sources) {
      assert.ok(routesIn(source).length > 0);
      assert.deepEqual(uncovered(source), [], 'a route of the console API that this test does not name');
    }
    const [api] = sources as [string];
    const handler = api.slice(api.indexOf('export async function handleConsoleApi'));
    const guard = handler.indexOf('refusedWhileSuspended(');
    const firstRoute = Math.min(
      ...["rest === '/members/seen'", 'handleNotes(rest', "rest === '/sites'"].map((each) => handler.indexOf(each)),
    );
    assert.ok(guard > 0 && guard < firstRoute, 'a route of the console API comes before the guard');

    // The planted violation: a route of later, written beside the others, is found.
    const planted = `${api}\nif (rest === '/invoices' && request.method === 'POST') {}`;
    assert.deepEqual(uncovered(planted), ["'/invoices'"]);
  });
});
