import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it, mock } from 'node:test';
import { seedFixture } from '@fruitback/shared/seed.fixture';
import { AUTH_BASE_PATH } from './auth.ts';
import { AUTH_SECRET } from './auth.fixture.ts';
import { GITHUB, GOOGLE, IDENTITY_SECRET, SESSION_COOKIE } from './auth-worker.fixture.ts';
import { type World, callOn, memberOf, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import {
  ADMIN_PATH,
  ADMIN_ROUTES,
  ADMIN_WRITE_ROUTES,
  type InstanceAdminReads,
  isAdminPath,
} from './instance-admin.ts';
import { createLinearStore } from './linear.ts';
import type { Place } from './notes-index.ts';
import { createPostgresNoteIndex } from './notes-index-postgres.ts';
import { rowsOf, withoutOwnerRule } from './postgres.fixture.ts';
import { StoreError } from './store.ts';

/**
 * The administrator of the instance and their reads (FRU-261), through `handleRequest`, as the
 * console calls them: a worker on PGlite with better-auth on.
 */

const SECRETS_KEY = 'a-key-that-seals-the-connectors-0123';
const TEM_SECRET = 'a-secret-key-of-scaleway-0123456789';
const SEALED = 'SEALED-KEY-OF-A-CONNECTOR-not-for-an-answer';
const NOTE_TEXT = 'THE TEXT OF A NOTE that only its tracker and the index excerpt hold';
const DELIVERY_BODY = 'THE BODY OF A DELIVERY that the receiver gets';

const envOf = worlds();

/** A world with every means of sign-in and of mail in its configuration, each with a secret. */
const world = () =>
  envOf({
    env: {
      FRUITBACK_SECRETS_KEY: SECRETS_KEY,
      FRUITBACK_MAIL_FROM: 'links@fruitback.test',
      FRUITBACK_SCALEWAY_TEM: `the-project:${TEM_SECRET}`,
      FRUITBACK_AUTH_GITHUB_OAUTH: `${GITHUB.clientId}:${GITHUB.clientSecret}`,
      FRUITBACK_GOOGLE_OAUTH: `${GOOGLE.clientId}:${GOOGLE.clientSecret}`,
    },
  });

async function get(on: World, path: string, token?: string) {
  const answer = await callOn(on, 'GET', path, token === undefined ? {} : { token });

  return { status: answer.status, text: await answer.text() };
}

/**
 * Ana signs in first and is the administrator, with a workspace of her own. Bob owns Beta, where
 * Carl is a member: Beta has a site, a connector that needs attention, a note and a delivery.
 */
async function anInstance() {
  const on = await world();
  const ana = await signInTo(on, 'ana@acme.dev');
  const bob = await signInTo(on, 'bob@beta.dev');
  const carl = await signInTo(on, 'carl@beta.dev');
  const alpha = await workspaceIn(on, ana.token, 'Alpha');
  const beta = await workspaceIn(on, bob.token, 'Beta');
  await memberOf(on, beta, carl.id, 'member');

  const site = await on.accounts.addSite(beta, { origin: 'https://staging.beta.dev', visibility: 'members' });
  const connector = await on.accounts.addConnector(beta, { kind: 'rest', label: 'Hook of Beta', sealed: SEALED });
  await on.accounts.noteConnector(connector.id, 'key-refused', Date.UTC(2026, 9, 17));
  await on.accounts.setDestinations(beta, site.id, [{ connector: connector.id, label: 'REST API · Hook of Beta' }]);
  await on.accounts.enqueueDelivery(connector.id, DELIVERY_BODY, Date.now());
  // The REST connector keeps the note in the worker's store first (FRU-122): its row is `FB-<id>`.
  const [kept] = await rowsOf(
    on.database,
    `INSERT INTO seeds (client_id, page_url, stage, seed, created_at, updated_at)
       VALUES ('${site.id}', 'https://staging.beta.dev/', 'seeded', '{"id":"sd_1","note":"${NOTE_TEXT}"}', 1, 1)
     RETURNING id`,
  );
  await rowsOf(
    on.database,
    `INSERT INTO note_index (site_id, seed_id, workspace_id, page_url, excerpt, stage, author_kind, place, connector_id, reference, created_at, checked_at)
       VALUES ('${site.id}', 'sd_1', '${beta}', 'https://staging.beta.dev/', '${NOTE_TEXT.slice(0, 64)}', 'ripe', 'visitor', 'connector', '${connector.id}', 'FB-${kept?.id}', 1, 1)`,
  );
  await rowsOf(
    on.database,
    `INSERT INTO invitation (id, "organizationId", email, role, status, "expiresAt", "inviterId")
       VALUES ('inv_1', '${beta}', 'dana@beta.dev', 'guest', 'pending', now() + interval '1 day', '${bob.id}')`,
  );

  return { on, ana, bob, carl, alpha, beta, site, connector };
}

/** The path of each route of the table, with a workspace that exists for the one that names one. */
function pathsOf(workspace: string): string[] {
  return ADMIN_ROUTES.map((route) => route.example.replace(/ws_0+$/, workspace));
}

/** The path of each route that writes, with an account that exists. */
function writePathsOf(account: string): string[] {
  return ADMIN_WRITE_ROUTES.map((route) => route.example.replace(/acc_0+/, account));
}

describe('who the administrator of the instance is (FRU-261)', () => {
  it('is the first account, and no account after it', async () => {
    const { on, ana, bob } = await anInstance();

    const me = async (token: string) =>
      JSON.parse((await get(on, '/console/me', token)).text) as { instanceAdmin: boolean };
    assert.equal((await me(ana.token)).instanceAdmin, true);
    assert.equal((await me(bob.token)).instanceAdmin, false);
    assert.deepEqual(
      (await rowsOf(on.database, `SELECT email FROM "user" WHERE role = 'admin'`)).map((row) => row.email),
      ['ana@acme.dev'],
    );
  });

  it('loses every route at the next call when the role is taken away in the database, with the session still open', async () => {
    const { on, ana, beta } = await anInstance();
    for (const path of pathsOf(beta)) assert.equal((await get(on, path, ana.token)).status, 200, path);

    await rowsOf(on.database, `UPDATE "user" SET role = NULL WHERE id = '${ana.id}'`);

    for (const path of pathsOf(beta)) assert.equal((await get(on, path, ana.token)).status, 404, path);
    const me = await get(on, '/console/me', ana.token);
    assert.equal(me.status, 200, 'the session ended: the test proves nothing about the role');
    assert.equal((JSON.parse(me.text) as { instanceAdmin: boolean }).instanceAdmin, false);
  });

  it('is not an administrator while banned, nor with a list of roles', async () => {
    const { on, ana, beta } = await anInstance();
    const [path] = pathsOf(beta) as [string];

    await rowsOf(on.database, `UPDATE "user" SET banned = true WHERE id = '${ana.id}'`);
    assert.equal((await get(on, path, ana.token)).status, 404);
    await rowsOf(on.database, `UPDATE "user" SET banned = NULL, role = 'admin,user' WHERE id = '${ana.id}'`);
    assert.equal((await get(on, path, ana.token)).status, 404);
    // The control: the plain role opens it again.
    await rowsOf(on.database, `UPDATE "user" SET role = 'admin' WHERE id = '${ana.id}'`);
    assert.equal((await get(on, path, ana.token)).status, 200);
  });
});

describe('the guard of the routes of the administrator (FRU-261)', () => {
  it('answers 404 on every route of the table to an account without the role, and to nobody, and 200 to the administrator', async () => {
    const { on, ana, bob, carl, beta } = await anInstance();
    assert.ok(ADMIN_ROUTES.length >= 4);

    for (const path of pathsOf(beta)) {
      // The control first: a guard that refuses everybody passes every line below it.
      assert.equal((await get(on, path, ana.token)).status, 200, path);
      for (const token of [bob.token, carl.token, undefined]) {
        const answer = await get(on, path, token);
        assert.equal(answer.status, 404, `${path} answered ${answer.status} to an account without the role`);
        assert.deepEqual(JSON.parse(answer.text), { error: 'not-found' });
      }
      // Another method, from the console, with the cookie: the guard answers before the method is read.
      const posted = await callOn(on, 'POST', path, { token: bob.token, body: {} });
      assert.equal(posted.status, 404, path);
      assert.equal((await callOn(on, 'POST', path, { token: ana.token, body: {} })).status, 405, path);
    }
    for (const path of [ADMIN_PATH, `${ADMIN_PATH}/`, `${ADMIN_PATH}/secrets`, `${ADMIN_PATH}/workspaces/${beta}/x`]) {
      assert.equal((await get(on, path, bob.token)).status, 404, path);
      assert.equal((await get(on, path, ana.token)).status, 404, path);
    }
  });

  it('answers 404 on every route that writes to an account without the role, and to nobody, and writes nothing (FRU-280)', async () => {
    const { on, ana, bob, carl } = await anInstance();
    assert.ok(ADMIN_WRITE_ROUTES.length >= 1);

    for (const path of writePathsOf(bob.id)) {
      for (const token of [bob.token, carl.token, undefined]) {
        const answer = await callOn(on, 'POST', path, {
          ...(token === undefined ? {} : { token }),
          body: { admin: true },
        });
        assert.equal(answer.status, 404, `${path} answered ${answer.status} to an account without the role`);
        assert.deepEqual(await answer.json(), { error: 'not-found' });
      }
      // The cookie of the administrator, from no page of the console: a form of another page can send it.
      const noOrigin = await callOn(on, 'POST', path, { token: ana.token, body: { admin: true }, origin: null });
      assert.equal(noOrigin.status, 404, path);
      assert.equal((await get(on, path, ana.token)).status, 405, path);
    }
    assert.deepEqual(
      (await rowsOf(on.database, `SELECT email FROM "user" WHERE role = 'admin'`)).map((row) => row.email),
      ['ana@acme.dev'],
    );
    assert.deepEqual(await rowsOf(on.database, 'SELECT id FROM admin_actions'), []);
    // The control: the same call from the administrator, with the origin of the console, writes.
    const [path] = writePathsOf(bob.id) as [string];
    assert.equal((await callOn(on, 'POST', path, { token: ana.token, body: { admin: true } })).status, 200);
  });

  it('names every path of the administrator in the table that the guard reads, and nowhere else', () => {
    const sources = readdirSync(new URL('.', import.meta.url)).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.fixture.ts'),
    );
    const found = (text: string): boolean => /['"`]\/console\/admin\b/.test(text);
    const elsewhere = sources.filter(
      (file) => file !== 'instance-admin.ts' && found(readFileSync(new URL(file, import.meta.url), 'utf8')),
    );

    assert.deepEqual(elsewhere, [], 'a route of the administrator is served outside ADMIN_ROUTES, so maybe unguarded');
    // The planted violation: a route written in `console-api.ts`, beside the table, is found.
    const planted = `${readFileSync(new URL('console-api.ts', import.meta.url), 'utf8')}\nif (pathname === '/console/admin/keys') {}`;
    assert.equal(found(planted), true);
    assert.equal(isAdminPath('/console/admin/keys'), true);
    assert.equal(isAdminPath('/console/administer'), false);
  });

  it('closes every route of the admin plugin of better-auth, which the worker does not mount', async () => {
    const { on, ana, bob } = await anInstance();
    const { admin } = await import('better-auth/plugins/admin');
    const paths = Object.values(admin().endpoints as Record<string, { path?: string }>)
      .map((endpoint) => endpoint.path)
      .filter((path): path is string => typeof path === 'string');
    assert.ok(paths.includes('/admin/impersonate-user'), 'the plugin no longer has the route this test is about');
    assert.ok(paths.length >= 15, paths.join(', '));

    for (const path of paths) {
      for (const token of [ana.token, bob.token]) {
        for (const method of ['GET', 'POST']) {
          const answer = await callOn(on, method, `${AUTH_BASE_PATH}${path}`, {
            token,
            ...(method === 'POST' ? { body: { userId: bob.id, role: 'admin' } } : {}),
          });
          assert.equal(answer.status, 404, `${method} ${path}`);
        }
      }
      // And to better-auth itself, past the list of the worker.
      const direct = await on.auth.handler(
        new Request(`https://api.fruitback.test${AUTH_BASE_PATH}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'https://app.fruitback.test', Cookie: ana.token },
          body: JSON.stringify({ userId: bob.id, role: 'admin' }),
        }),
      );
      assert.equal(direct.status, 404, `better-auth serves ${path}`);
    }
    assert.deepEqual(
      (await rowsOf(on.database, `SELECT email FROM "user" WHERE role = 'admin'`)).map((row) => row.email),
      ['ana@acme.dev'],
    );
  });
});

describe('what the administrator reads (FRU-261)', () => {
  it('reads the instance: its configuration by variable names, and the connectors that need attention', async () => {
    const { on, ana, beta, connector } = await anInstance();
    const answer = await get(on, `${ADMIN_PATH}/instance`, ana.token);
    assert.equal(answer.status, 200, answer.text);
    const body = JSON.parse(answer.text) as Record<string, any>;

    assert.equal(body.store, 'memory');
    assert.deepEqual(body.database, { kind: 'postgresql', schema: 'public' });
    assert.deepEqual(body.mail, {
      provider: 'scaleway-tem',
      sender: 'links@fruitback.test',
      variables: ['FRUITBACK_MAIL_FROM', 'FRUITBACK_SCALEWAY_TEM'],
      lastSentAt: null,
    });
    assert.deepEqual(body.signIn, {
      email: { on: true, variables: ['FRUITBACK_MAIL_FROM', 'FRUITBACK_SCALEWAY_TEM'] },
      github: { on: true, variables: ['FRUITBACK_AUTH_GITHUB_OAUTH'] },
      google: { on: true, variables: ['FRUITBACK_GOOGLE_OAUTH'] },
    });
    assert.deepEqual(body.publicUrl, { value: 'https://api.fruitback.test', variable: 'FRUITBACK_PUBLIC_URL' });
    assert.deepEqual(body.signUp, { policy: 'invited', variable: 'FRUITBACK_SIGN_UP' });
    assert.deepEqual(body.counts, { workspaces: 2, accounts: 3, admins: 1 });
    assert.equal(body.attention.count, 1);
    assert.deepEqual(body.attention.connectors, [
      {
        id: connector.id,
        kind: 'rest',
        label: 'Hook of Beta',
        attention: { reason: 'key-refused', since: new Date(Date.UTC(2026, 9, 17)).toISOString() },
        workspace: { id: beta, name: 'Beta' },
      },
    ]);
    assert.ok(Number.isFinite(Date.parse(body.startedAt)));
  });

  it('reads the policy of sign-up from FRUITBACK_SIGN_UP, in both of its values', async () => {
    for (const policy of ['anyone', 'invited'] as const) {
      const on = await envOf({ env: { FRUITBACK_SIGN_UP: policy } });
      const ana = await signInTo(on, 'ana@acme.dev');
      const answer = await get(on, `${ADMIN_PATH}/instance`, ana.token);

      assert.deepEqual(JSON.parse(answer.text).signUp, { policy, variable: 'FRUITBACK_SIGN_UP' }, policy);
    }
  });

  it('lists the workspaces with their owner, their counts, their destinations and what did not arrive', async () => {
    const { on, ana, bob, alpha, beta, connector } = await anInstance();
    const answer = await get(on, `${ADMIN_PATH}/workspaces`, ana.token);
    assert.equal(answer.status, 200, answer.text);
    const { workspaces, total } = JSON.parse(answer.text) as { workspaces: Record<string, any>[]; total: number };

    assert.equal(total, 2);
    assert.deepEqual(
      workspaces.map((each) => each.id),
      [beta, alpha],
    );
    const [first] = workspaces as [Record<string, any>];
    assert.deepEqual(first.owners, [{ id: bob.id, email: 'bob@beta.dev' }]);
    assert.equal(first.members, 2);
    assert.equal(first.sites, 1);
    assert.equal(first.notes.ripe, 1);
    assert.equal(first.pendingDeliveries, 1);
    assert.deepEqual(
      first.destinations.map((each: { id: string }) => each.id),
      [connector.id],
    );
    assert.ok(Number.isFinite(Date.parse(first.createdAt)));

    const search = async (query: string) =>
      (
        JSON.parse((await get(on, `${ADMIN_PATH}/workspaces?${query}`, ana.token)).text) as {
          workspaces: { id: string }[];
        }
      ).workspaces.map((each) => each.id);
    assert.deepEqual(await search('q=bob%40beta'), [beta]);
    assert.deepEqual(await search('q=alph'), [alpha]);
    assert.deepEqual(await search('q=%25'), []);
    assert.deepEqual(await search('show=attention'), [beta]);
    assert.deepEqual(await search('show=empty'), [alpha]);
    assert.equal((await get(on, `${ADMIN_PATH}/workspaces?show=everything`, ana.token)).status, 400);
  });

  it('reads one workspace: its members and roles, its sites and their visibility, its destinations', async () => {
    const { on, ana, bob, carl, beta, site, connector } = await anInstance();
    const answer = await get(on, `${ADMIN_PATH}/workspaces/${beta}`, ana.token);
    assert.equal(answer.status, 200, answer.text);
    const body = JSON.parse(answer.text) as Record<string, any>;

    assert.deepEqual(
      body.members.map(({ id, role }: { id: string; role: string }) => [id, role]).toSorted(),
      [
        [bob.id, 'owner'],
        [carl.id, 'member'],
      ].toSorted(),
    );
    assert.deepEqual(body.sites, [
      {
        id: site.id,
        origin: 'https://staging.beta.dev',
        visibility: 'members',
        destinations: [{ connector: connector.id, label: 'REST API · Hook of Beta' }],
        notes: { ...body.sites[0].notes, ripe: 1 },
      },
    ]);
    assert.deepEqual(
      body.destinations.map(({ id, kind }: { id: string; kind: string }) => [id, kind]),
      [[connector.id, 'rest']],
    );
    assert.equal(body.pendingDeliveries, 1);
    assert.equal(body.pendingInvitations, 1);
    assert.equal((await get(on, `${ADMIN_PATH}/workspaces/ws_nothing`, ana.token)).status, 404);
  });

  it('lists the accounts: their workspaces and roles, their ways to sign in, the administrator, the invitations', async () => {
    const { on, ana, bob, beta, alpha } = await anInstance();
    assert.equal((await get(on, `/console/workspaces/${beta}/sites`, bob.token)).status, 200);
    await rowsOf(
      on.database,
      `INSERT INTO invitation (id, "organizationId", email, role, status, "expiresAt", "inviterId")
         VALUES ('inv_2', '${alpha}', 'carl@beta.dev', 'admin', 'pending', now() + interval '1 day', '${ana.id}')`,
    );
    const answer = await get(on, `${ADMIN_PATH}/users`, ana.token);
    assert.equal(answer.status, 200, answer.text);
    const { users, total } = JSON.parse(answer.text) as { users: Record<string, any>[]; total: number };

    assert.equal(total, 3);
    const byEmail = Object.fromEntries(users.map((each) => [each.email, each]));
    assert.equal(byEmail['ana@acme.dev']?.instanceAdmin, true);
    assert.equal(byEmail['bob@beta.dev']?.instanceAdmin, false);
    assert.deepEqual(byEmail['carl@beta.dev']?.workspaces, [{ id: beta, name: 'Beta', role: 'member' }]);
    assert.deepEqual(byEmail['carl@beta.dev']?.pendingInvitations, [
      { workspace: { id: alpha, name: 'Alpha' }, role: 'admin' },
    ]);
    assert.ok(Array.isArray(byEmail['bob@beta.dev']?.providers));
    // Bob read the sites of Beta: « last seen » is that day (FRU-249).
    assert.match(byEmail['bob@beta.dev']?.lastSeen ?? '', /^\d{4}-\d{2}-\d{2}$/);

    const emails = async (query: string) =>
      (
        JSON.parse((await get(on, `${ADMIN_PATH}/users?${query}`, ana.token)).text) as { users: { email: string }[] }
      ).users
        .map((each) => each.email)
        .toSorted();
    assert.deepEqual(await emails('show=admins'), ['ana@acme.dev']);
    assert.deepEqual(await emails('q=beta.dev'), ['bob@beta.dev', 'carl@beta.dev']);
    await signInTo(on, 'eve@nowhere.dev');
    assert.deepEqual(await emails('show=alone'), ['eve@nowhere.dev']);
  });

  it('answers no secret, no token, no digest and no key on any route, and a note on the route of the notes only', async () => {
    const { on, ana, bob, beta } = await anInstance();
    const cookieValues = [ana.token, bob.token].map((cookie) => cookie.slice(`${SESSION_COOKIE}=`.length));
    const secrets = [
      AUTH_SECRET,
      IDENTITY_SECRET,
      SECRETS_KEY,
      TEM_SECRET,
      GITHUB.clientSecret,
      GOOGLE.clientSecret,
      'not-a-password',
      SEALED,
      DELIVERY_BODY,
      ...cookieValues,
      ...cookieValues.map((value) => decodeURIComponent(value).split('.')[0] as string),
    ];
    const digests = (await rowsOf(on.database, 'SELECT token FROM session')).map((row) => String(row.token));
    assert.ok(digests.length >= 2);

    for (const path of pathsOf(beta)) {
      const notes = path === `${ADMIN_PATH}/notes`;
      const { status, text } = await get(on, path, ana.token);
      assert.equal(status, 200, path);
      for (const secret of [...secrets, ...digests, ...(notes ? [] : [NOTE_TEXT.slice(0, 20)])])
        assert.equal(text.includes(secret), false, `${path} holds ${secret}`);
      assert.doesNotMatch(text, /[0-9a-f]{40,}/i, `${path} holds something that looks like a digest`);
      const keys = [...text.matchAll(/"([^"]+)":/g)].map((match) => match[1] as string);
      for (const key of keys) {
        assert.doesNotMatch(key, /token|secret|sealed|hash|digest|password|^body$|^seed$/i, path);
        if (!notes) assert.doesNotMatch(key, /excerpt|^note$|^text$/i, path);
      }
      // The control: the route of the notes holds the note, so the loop above reads an answer that has one.
      if (notes) assert.ok(text.includes(NOTE_TEXT), path);
    }
  });
});

describe('the trace of the reads of the administrator (FRU-261)', () => {
  it('writes one row for each workspace the administrator is not a member of, and its owner reads it', async () => {
    const { on, ana, bob, beta, alpha } = await anInstance();
    const at = Date.now();

    for (const path of pathsOf(beta)) assert.equal((await get(on, path, ana.token)).status, 200, path);

    const rows = await rowsOf(on.database, 'SELECT workspace_id, admin_account_id, admin_email, what FROM admin_reads');
    assert.deepEqual(
      rows
        .filter((row) => row.workspace_id === beta)
        .map((row) => row.what)
        .toSorted(),
      ['instance', 'notes', 'users', 'workspace', 'workspaces'],
    );
    assert.equal(
      rows.some((row) => row.workspace_id === alpha),
      false,
      'a read in her own workspace was traced',
    );
    assert.ok(rows.every((row) => row.admin_account_id === ana.id && row.admin_email === 'ana@acme.dev'));

    const answer = await get(on, `/console/workspaces/${beta}/admin-reads`, bob.token);
    assert.equal(answer.status, 200, answer.text);
    const { reads } = JSON.parse(answer.text) as { reads: { admin: { email: string }; what: string; at: string }[] };
    assert.equal(reads.length, 5);
    for (const read of reads) {
      assert.deepEqual(read.admin, { email: 'ana@acme.dev' });
      assert.ok(Date.parse(read.at) >= at - 1000, read.at);
    }
  });

  it('traces the workspace of an invitation that the list of the accounts shows', async () => {
    const { on, ana, bob, beta } = await anInstance();
    const eve = await signInTo(on, 'eve@nowhere.dev');
    await rowsOf(
      on.database,
      `INSERT INTO invitation (id, "organizationId", email, role, status, "expiresAt", "inviterId")
         VALUES ('inv_eve', '${beta}', 'eve@nowhere.dev', 'member', 'pending', now() + interval '1 day', '${bob.id}')`,
    );

    // Eve is a member of nothing: Beta is in the answer by her invitation only.
    const answer = await get(on, `${ADMIN_PATH}/users?q=eve`, ana.token);
    assert.equal(answer.status, 200, answer.text);
    assert.deepEqual(
      (JSON.parse(answer.text) as { users: { id: string }[] }).users.map((each) => each.id),
      [eve.id],
    );

    const rows = await rowsOf(on.database, `SELECT workspace_id, what FROM admin_reads`);
    assert.deepEqual(rows, [{ workspace_id: beta, what: 'users' }]);
  });

  it('is read by an owner only: a member is refused, and somebody of another workspace finds nothing', async () => {
    const { on, ana, bob, carl, beta } = await anInstance();
    await get(on, `${ADMIN_PATH}/workspaces/${beta}`, ana.token);

    assert.equal((await get(on, `/console/workspaces/${beta}/admin-reads`, bob.token)).status, 200);
    assert.equal((await get(on, `/console/workspaces/${beta}/admin-reads`, carl.token)).status, 403);
    // The administrator is no member of Beta: the route of its owners is not theirs.
    assert.equal((await get(on, `/console/workspaces/${beta}/admin-reads`, ana.token)).status, 404);
    assert.equal((await get(on, `/console/workspaces/${beta}/admin-reads`)).status, 401);
  });

  it('keeps who read after the account of the administrator goes', async () => {
    const { on, ana, bob, beta } = await anInstance();
    await get(on, `${ADMIN_PATH}/workspaces/${beta}`, ana.token);
    await withoutOwnerRule(on.database, `DELETE FROM "user" WHERE id = '${ana.id}'`);

    const { reads } = JSON.parse((await get(on, `/console/workspaces/${beta}/admin-reads`, bob.token)).text) as {
      reads: { admin: { email: string } }[];
    };
    assert.deepEqual(
      reads.map((read) => read.admin),
      [{ email: 'ana@acme.dev' }],
    );
  });

  it('fails the read when its trace cannot be written, and answers nothing of it', async () => {
    const { on, ana, beta } = await anInstance();
    const failing: InstanceAdminReads = {
      ...(on.context.instanceAdmin as InstanceAdminReads),
      async trace() {
        throw new StoreError('the database did not answer');
      },
    };

    for (const path of pathsOf(beta)) {
      const answer = await callOn(on, 'GET', path, { token: ana.token }, { instanceAdmin: failing });
      const text = await answer.text();
      assert.equal(answer.status, 502, `${path}: ${text}`);
      assert.deepEqual(JSON.parse(text), { error: 'store-unavailable' });
    }
  });
});

/** A note of more than `EXCERPT_LENGTH` characters: what follows the 64th is nowhere in the index. */
const LONG = (head: string) => `${head.padEnd(64, '.')}AFTER-THE-64TH-CHARACTER of ${head}`;

/**
 * Two workspaces of other people (FRU-272). Beta keeps a note in the worker's store. Gamma sent
 * three notes to Linear:
 * - one named like an issue of Linear;
 * - one whose reference and widget id are the ones of the note of Beta, as a team of Linear keyed
 *   `FB` and a page that reuses an id would make them;
 * - one whose reference names the row of a note that Gamma keeps, with another widget id.
 */
async function notesOfTheInstance() {
  const on = await world();
  const ana = await signInTo(on, 'ana@acme.dev');
  const bob = await signInTo(on, 'bob@beta.dev');
  const zed = await signInTo(on, 'zed@gamma.dev');
  const beta = await workspaceIn(on, bob.token, 'Beta');
  const gamma = await workspaceIn(on, zed.token, 'Gamma');
  const betaSite = await on.accounts.addSite(beta, { origin: 'https://beta.dev', visibility: 'members' });
  const gammaSite = await on.accounts.addSite(gamma, { origin: 'https://gamma.dev', visibility: 'members' });
  const linear = await on.accounts.addConnector(gamma, { kind: 'linear', label: 'Linear GAM', sealed: 'x' });
  const index = createPostgresNoteIndex(on.database);

  const keep = async (site: string, seed: string, note: string): Promise<string> => {
    const [row] = await rowsOf(
      on.database,
      `INSERT INTO seeds (client_id, page_url, stage, seed, created_at, updated_at)
         VALUES ('${site}', 'https://${site}.test/', 'seeded', '${JSON.stringify({ id: seed, note })}', 1, 1)
       RETURNING id`,
    );

    return `FB-${row?.id}`;
  };
  const entry = (workspace: string, site: string, id: string, note: string, place: Place, reference: string) => ({
    workspace,
    site,
    seed: seedFixture({ id, note }),
    channel: 'script' as const,
    author: { kind: 'visitor' as const },
    place,
    issue: { identifier: reference, url: `https://tracker.test/${reference}` },
    stage: 'seeded' as const,
  });

  const keptNote = LONG('The note that Beta keeps');
  const betaRow = await keep(betaSite.id, 'sd_kept', keptNote);
  const gammaRow = await keep(gammaSite.id, 'sd_gamma_kept', LONG('The note that Gamma keeps'));
  const toLinear = { kind: 'connector', connector: linear.id } as const;
  await index.record([entry(beta, betaSite.id, 'sd_kept', keptNote, { kind: 'fruitback' }, betaRow)], 1_000);
  await index.record([entry(gamma, gammaSite.id, 'sd_linear', LONG('A note of Linear'), toLinear, 'GAM-7')], 2_000);
  await index.record(
    // The widget id of the note of Beta: a page writes the id of its notes, so another site can reuse it.
    [entry(gamma, gammaSite.id, 'sd_kept', LONG('A note of Linear named FB'), toLinear, betaRow)],
    3_000,
  );
  await index.record(
    [entry(gamma, gammaSite.id, 'sd_same_site', LONG('A note of Linear on the site'), toLinear, gammaRow)],
    4_000,
  );

  return { on, ana, bob, zed, beta, gamma, keptNote };
}

type AdminNotes = {
  notes: {
    id: string;
    workspace: { id: string; name: string };
    excerpt: string;
    text?: string;
    place: { kind: string };
  }[];
  total: number;
  searched: string[];
  next?: string;
};

async function adminNotes(on: World, token: string, query = ''): Promise<{ answer: AdminNotes; raw: string }> {
  const { status, text } = await get(on, `${ADMIN_PATH}/notes${query}`, token);
  assert.equal(status, 200, text);

  return { answer: JSON.parse(text) as AdminNotes, raw: text };
}

describe('the notes of the instance, for its administrator (FRU-272)', () => {
  it('answers the text of a note the worker keeps, and of a note of a tracker its excerpt only', async () => {
    const { on, ana, keptNote } = await notesOfTheInstance();

    const { answer, raw } = await adminNotes(on, ana.token);

    assert.equal(answer.total, 4);
    const byExcerpt = new Map(answer.notes.map((note) => [note.excerpt.slice(0, 20), note]));
    assert.equal(byExcerpt.get('The note that Beta k')?.text, keptNote);
    for (const note of answer.notes) {
      assert.ok([...note.excerpt].length <= 64, note.excerpt);
      if (note.place.kind === 'linear') assert.equal(note.text, undefined, note.excerpt);
    }
    // No character after the 64th of a note of Linear: not as a text, not in the excerpt.
    for (const head of ['A note of Linear', 'A note of Linear named FB', 'A note of Linear on the site']) {
      assert.equal(raw.includes(`AFTER-THE-64TH-CHARACTER of ${head}`), false, head);
    }
    assert.deepEqual(answer.searched, ['excerpt', 'page', 'site', 'workspace', 'stage', 'reference']);
  });

  it('calls no tracker to read the notes, and the control sees the call of a read of Linear', async () => {
    const { on, ana } = await notesOfTheInstance();
    const fetched = mock.method(globalThis, 'fetch', async () => Response.json({ data: { issues: { nodes: [] } } }));
    try {
      await adminNotes(on, ana.token);
      await adminNotes(on, ana.token, '?q=Linear&place=fruitback');
      assert.equal(fetched.mock.callCount(), 0);

      const store = createLinearStore({ apiKey: 'lin_api_test', teamId: 'team_gamma', projectId: undefined });
      // The answer of the stub is not one Linear gives: only the call counts here.
      await store
        .findForPage({ url: 'https://gamma.dev/', clientId: undefined }, undefined, {
          showComments: false,
          identitySecret: undefined,
          read: 'public',
          locale: 'en',
        })
        .catch(() => []);
      assert.ok(fetched.mock.callCount() > 0);
    } finally {
      mock.restoreAll();
    }
  });

  it('filters by workspace, searches the name of a workspace, and pages with a cursor', async () => {
    const { on, ana, beta, gamma } = await notesOfTheInstance();

    const ofBeta = (await adminNotes(on, ana.token, `?workspace=${beta}`)).answer;
    assert.deepEqual(
      ofBeta.notes.map((note) => note.workspace),
      [{ id: beta, name: 'Beta' }],
    );
    const named = (await adminNotes(on, ana.token, '?q=gamma')).answer;
    assert.equal(named.total, 3);
    assert.ok(named.notes.every((note) => note.workspace.id === gamma));

    const first = (await adminNotes(on, ana.token, '?limit=8')).answer;
    assert.equal(first.next, undefined);
    assert.equal(first.notes.length, 4);
    assert.equal((await get(on, `${ADMIN_PATH}/notes?mine=1`, ana.token)).status, 400);
    assert.equal((await get(on, `${ADMIN_PATH}/notes?workspace=a%20b`, ana.token)).status, 400);
  });

  it('traces the workspaces of the notes it answers, and none of the notes of the administrator', async () => {
    const { on, ana, bob, beta, gamma } = await notesOfTheInstance();
    await memberOf(on, gamma, ana.id, 'member');

    await adminNotes(on, ana.token);

    const rows = await rowsOf(on.database, `SELECT workspace_id, what FROM admin_reads ORDER BY workspace_id`);
    assert.deepEqual(rows, [{ workspace_id: beta, what: 'notes' }]);
    const { reads } = JSON.parse((await get(on, `/console/workspaces/${beta}/admin-reads`, bob.token)).text) as {
      reads: { what: string }[];
    };
    assert.deepEqual(
      reads.map((read) => read.what),
      ['notes'],
    );
  });

  it('names the place of a note whose connector was removed', async () => {
    const { on, ana } = await notesOfTheInstance();
    await rowsOf(on.database, `DELETE FROM connectors WHERE kind = 'linear'`);

    const { answer } = await adminNotes(on, ana.token);

    assert.deepEqual(
      answer.notes.map((note) => note.place).filter((place) => place.kind !== 'fruitback'),
      [{ kind: 'removed' }, { kind: 'removed' }, { kind: 'removed' }],
    );
  });

  it('answers 404 to the owner of a workspace, who reads the notes of their own workspace elsewhere', async () => {
    const { on, bob, zed } = await notesOfTheInstance();

    for (const token of [bob.token, zed.token]) {
      const { status, text } = await get(on, `${ADMIN_PATH}/notes`, token);
      assert.equal(status, 404);
      assert.deepEqual(JSON.parse(text), { error: 'not-found' });
    }
  });
});

/** `POST /console/admin/users/<id>/instance-admin` from the person of `token`. */
async function setAdmin(on: World, token: string, account: string, body: unknown) {
  const answer = await callOn(on, 'POST', `${ADMIN_PATH}/users/${account}/instance-admin`, { token, body });

  return { status: answer.status, body: (await answer.json()) as Record<string, unknown> };
}

const adminEmails = async (on: World): Promise<unknown[]> =>
  (await rowsOf(on.database, `SELECT email FROM "user" WHERE role = 'admin' ORDER BY email`)).map((row) => row.email);

const actionRows = (on: World) =>
  rowsOf(
    on.database,
    'SELECT action, actor_account_id, actor_email, target_account_id, target_email, workspace_id, detail, at FROM admin_actions ORDER BY at, id',
  );

describe('an administrator names and removes an administrator (FRU-280)', () => {
  it('names an administrator, who reads the routes of the administrator at the next call', async () => {
    const { on, ana, bob, beta } = await anInstance();
    const [path] = pathsOf(beta) as [string];
    assert.equal((await get(on, path, bob.token)).status, 404);

    const named = await setAdmin(on, ana.token, bob.id, { admin: true });

    assert.equal(named.status, 200, JSON.stringify(named.body));
    assert.deepEqual(named.body, { user: { id: bob.id, instanceAdmin: true }, changed: true });
    assert.deepEqual(await adminEmails(on), ['ana@acme.dev', 'bob@beta.dev']);
    assert.equal((await get(on, path, bob.token)).status, 200);
  });

  it('refuses a removed administrator at their next call, with their session still open', async () => {
    const { on, ana, bob, beta } = await anInstance();
    assert.equal((await setAdmin(on, ana.token, bob.id, { admin: true })).status, 200);
    for (const path of pathsOf(beta)) assert.equal((await get(on, path, bob.token)).status, 200, path);

    const removed = await setAdmin(on, ana.token, bob.id, { admin: false });

    assert.deepEqual(removed.body, { user: { id: bob.id, instanceAdmin: false }, changed: true });
    for (const path of pathsOf(beta)) assert.equal((await get(on, path, bob.token)).status, 404, path);
    assert.equal((await setAdmin(on, bob.token, ana.id, { admin: false })).status, 404);
    const me = await get(on, '/console/me', bob.token);
    assert.equal(me.status, 200, 'the session ended: the test proves nothing about the role');
    assert.equal((JSON.parse(me.text) as { instanceAdmin: boolean }).instanceAdmin, false);
  });

  it('refuses an administrator who removes themselves, also when another administrator stays', async () => {
    const { on, ana, bob } = await anInstance();
    assert.equal((await setAdmin(on, ana.token, bob.id, { admin: true })).status, 200);
    const before = (await actionRows(on)).length;

    const refused = await setAdmin(on, ana.token, ana.id, { admin: false });

    assert.equal(refused.status, 409);
    assert.deepEqual(refused.body, { error: 'self-removal' });
    assert.deepEqual(await adminEmails(on), ['ana@acme.dev', 'bob@beta.dev']);
    assert.equal((await actionRows(on)).length, before);
    // The control: the other administrator removes her.
    assert.equal((await setAdmin(on, bob.token, ana.id, { admin: false })).status, 200);
    assert.deepEqual(await adminEmails(on), ['bob@beta.dev']);
  });

  it('refuses the last administrator who removes themselves', async () => {
    const { on, ana } = await anInstance();

    const refused = await setAdmin(on, ana.token, ana.id, { admin: false });

    assert.equal(refused.status, 409);
    assert.deepEqual(await adminEmails(on), ['ana@acme.dev']);
    assert.deepEqual(await actionRows(on), []);
  });

  it('answers 200 with no change and writes no action when the account already has the role asked', async () => {
    const { on, ana, bob } = await anInstance();

    assert.deepEqual((await setAdmin(on, ana.token, ana.id, { admin: true })).body, {
      user: { id: ana.id, instanceAdmin: true },
      changed: false,
    });
    assert.deepEqual((await setAdmin(on, ana.token, bob.id, { admin: false })).body, {
      user: { id: bob.id, instanceAdmin: false },
      changed: false,
    });
    assert.deepEqual(await actionRows(on), []);
    assert.deepEqual(await adminEmails(on), ['ana@acme.dev']);
  });

  it('answers 404 for an account that does not exist, and 400 for a body that is not { admin: true | false }', async () => {
    const { on, ana, bob } = await anInstance();

    const unknown = await setAdmin(on, ana.token, 'acc_nobody', { admin: true });
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.body, { error: 'not-found' });
    for (const body of [{}, { admin: 'true' }, { admin: 1 }, { admin: null }, [true], 'admin', null]) {
      const answer = await setAdmin(on, ana.token, bob.id, body);
      assert.equal(answer.status, 400, JSON.stringify(body));
      assert.deepEqual(answer.body, { error: 'invalid-admin' });
    }
    const raw = await callOn(on, 'POST', `${ADMIN_PATH}/users/${bob.id}/instance-admin`, {
      token: ana.token,
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(raw.status, 400);
    assert.deepEqual(await adminEmails(on), ['ana@acme.dev']);
    assert.deepEqual(await actionRows(on), []);
  });
});

describe('the trace of the actions of the administrators (FRU-280)', () => {
  it('writes one row for each change, on the instance, and the administrators read the rows', async () => {
    const { on, ana, bob } = await anInstance();
    const named = Date.now();
    await setAdmin(on, ana.token, bob.id, { admin: true });
    await setAdmin(on, bob.token, ana.id, { admin: false });

    const rows = await actionRows(on);
    assert.deepEqual(
      rows.map(({ at: _, ...row }) => row),
      [
        {
          action: 'admin-named',
          actor_account_id: ana.id,
          actor_email: 'ana@acme.dev',
          target_account_id: bob.id,
          target_email: 'bob@beta.dev',
          workspace_id: null,
          detail: null,
        },
        {
          action: 'admin-removed',
          actor_account_id: bob.id,
          actor_email: 'bob@beta.dev',
          target_account_id: ana.id,
          target_email: 'ana@acme.dev',
          workspace_id: null,
          detail: null,
        },
      ],
    );
    assert.ok(
      rows.every((row) => Number(row.at) >= named - 1000),
      JSON.stringify(rows),
    );

    const answer = await get(on, `${ADMIN_PATH}/actions`, bob.token);
    assert.equal(answer.status, 200, answer.text);
    const { actions } = JSON.parse(answer.text) as { actions: Record<string, unknown>[] };
    assert.deepEqual(
      actions.map(({ at: _, ...action }) => action),
      [
        {
          action: 'admin-removed',
          actor: { id: bob.id, email: 'bob@beta.dev' },
          target: { id: ana.id, email: 'ana@acme.dev' },
        },
        {
          action: 'admin-named',
          actor: { id: ana.id, email: 'ana@acme.dev' },
          target: { id: bob.id, email: 'bob@beta.dev' },
        },
      ],
    );
    // An action on the instance names no workspace: no owner reads it, and its read traces nothing.
    assert.deepEqual(await rowsOf(on.database, 'SELECT id FROM admin_reads'), []);
    assert.equal((await get(on, `${ADMIN_PATH}/actions`, ana.token)).status, 404);
  });

  it('keeps who acted on whom after both accounts go', async () => {
    const { on, ana, bob, carl } = await anInstance();
    await setAdmin(on, ana.token, bob.id, { admin: true });
    await setAdmin(on, bob.token, carl.id, { admin: true });
    await withoutOwnerRule(on.database, `DELETE FROM "user" WHERE id IN ('${bob.id}', '${carl.id}')`);

    const { actions } = JSON.parse((await get(on, `${ADMIN_PATH}/actions`, ana.token)).text) as {
      actions: { actor: unknown; target: unknown }[];
    };
    assert.deepEqual(
      actions.map(({ actor, target }) => [actor, target]),
      [
        [{ email: 'bob@beta.dev' }, { email: 'carl@beta.dev' }],
        [{ id: ana.id, email: 'ana@acme.dev' }, { email: 'bob@beta.dev' }],
      ],
    );
  });

  it('changes no role when its action cannot be written', async () => {
    const { on, ana, bob } = await anInstance();
    await rowsOf(on.database, 'ALTER TABLE admin_actions ADD CONSTRAINT refuses_every_row CHECK (false)');

    // A refusal of the database is no `StoreError`: `handleRequest` throws it, and the server answers 500.
    await assert.rejects(
      callOn(on, 'POST', `${ADMIN_PATH}/users/${bob.id}/instance-admin`, { token: ana.token, body: { admin: true } }),
      /refuses_every_row/,
    );
    assert.deepEqual(await adminEmails(on), ['ana@acme.dev']);
    // The control: the same call with the table open again names Bob.
    await rowsOf(on.database, 'ALTER TABLE admin_actions DROP CONSTRAINT refuses_every_row');
    assert.equal((await setAdmin(on, ana.token, bob.id, { admin: true })).status, 200);
    assert.deepEqual(await adminEmails(on), ['ana@acme.dev', 'bob@beta.dev']);
  });
});
