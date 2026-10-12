import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleRequest } from './app.ts';
import { type World, callOn, signInTo, worlds } from './console-world.fixture.ts';
import type { WorkerEnv } from './env.ts';
import { signIdentityToken } from './identity.ts';
import { createMemoryKv } from './kv.ts';
import { rowsOf } from './postgres.fixture.ts';
import { closeSessionConnections } from './session-sqlite.ts';
import { createPairing, redeemPairing } from './session.ts';

const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const directories: string[] = [];
const envWith = worlds();

afterEach(() => {
  closeSessionConnections();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A worker with no accounts: it has no database, and its sessions are in a file. */
function envWithoutAccounts(): WorkerEnv {
  const directory = mkdtempSync(join(tmpdir(), 'fruitback-session-sites-'));
  directories.push(directory);

  return {
    FRUITBACK_STORE: 'memory',
    ALLOWED_ORIGINS: 'https://app.fruitback.test',
    FRUITBACK_IDENTITY_SECRET: 'a-worker-secret-of-exactly-enough',
    FRUITBACK_SESSION_PATH: join(directory, 'sessions.db'),
  };
}

function ask(env: World, token?: string, method = 'GET'): Promise<Response> {
  return callOn(env, method, '/session/sites', { origin: EXTENSION, ...(token === undefined ? {} : { token }) });
}

async function setUp(env: World) {
  const { accounts, sessions } = env;
  const alice = await signInTo(env, 'alice@acme.dev');
  const acme = await accounts.createWorkspace('Acme', alice.id);
  const other = await accounts.createWorkspace('Other', alice.id);
  const site = await accounts.addSite(acme.id, { origin: 'https://staging.acme.dev', visibility: 'members' });
  await accounts.addSite(other.id, { origin: 'https://other.dev', visibility: 'members' });
  const { code } = await createPairing(sessions, { subject: alice.id, workspace: acme.id });
  const redeemed = await redeemPairing(sessions, code, env.env.FRUITBACK_IDENTITY_SECRET as string);
  assert.ok(redeemed.ok);

  return { alice, acme, site, token: redeemed.session.accessToken };
}

describe('the sites a session may turn on (FRU-101)', () => {
  it('answers the sites of the workspace of the session, and of no other', async () => {
    const env = await envWith();
    const { acme, site, token } = await setUp(env);

    const response = await ask(env, token);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      workspace: { id: acme.id, name: 'Acme' },
      sites: [{ id: site.id, origin: 'https://staging.acme.dev', visibility: 'members' }],
    });
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), EXTENSION);
  });

  it('answers the language of the account, when it holds one (FRU-131)', async () => {
    const env = await envWith();
    const { alice, token } = await setUp(env);
    assert.equal('locale' in ((await (await ask(env, token)).json()) as object), false, 'no language yet: no field');

    await env.accounts.setLocale(alice.id, 'fr');

    assert.equal(((await (await ask(env, token)).json()) as { locale?: string }).locale, 'fr');
  });

  it('answers nobody without a token, and nothing to a session that names no workspace', async () => {
    const env = await envWith();
    const { alice } = await setUp(env);
    const console = await signIdentityToken(
      { sub: alice.id, exp: Math.floor(Date.now() / 1000) + 600 },
      env.env.FRUITBACK_IDENTITY_SECRET as string,
    );

    assert.equal((await ask(env)).status, 401);
    assert.equal((await ask(env, console)).status, 401);
  });

  it('answers nothing to a person who is no longer a member', async () => {
    const env = await envWith();
    const { alice, acme, token } = await setUp(env);
    const removed = await rowsOf(
      env.database,
      `DELETE FROM member WHERE "organizationId" = '${acme.id}' AND "userId" = '${alice.id}' RETURNING id`,
    );
    assert.equal(removed.length, 1, 'the row of the member was there');

    assert.equal((await ask(env, token)).status, 401);
  });

  it('takes GET only, and does not exist on a worker with no accounts', async () => {
    const env = await envWith();
    const { token } = await setUp(env);

    assert.equal((await ask(env, token, 'POST')).status, 405);
    const without = await handleRequest(
      new Request('https://api.fruitback.test/session/sites', {
        headers: { Origin: EXTENSION, Authorization: `Bearer ${token}` },
      }),
      envWithoutAccounts(),
      { clientIp: '198.51.100.9', kv: createMemoryKv() },
    );
    // The session routes take a POST, so this GET is a `405`. The extension reads it as « this worker
    // keeps no accounts », which is an answer about a language (FRU-131): do not change it alone.
    assert.equal(without.status, 405, 'a worker with no accounts has no such route');
  });
});
