import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { closeAccountConnections, createSqliteAccountStore } from './accounts-sqlite.ts';
import type { WorkerEnv } from './env.ts';
import { closeSessionConnections, createSqliteSessionStore } from './session-sqlite.ts';
import { createPairing, redeemPairing } from './session.ts';
import { handleRequest } from './app.ts';
import { signIdentityToken } from './identity.ts';
import { createMemoryKv } from './kv.ts';

const SECRET = 'a-worker-secret-of-exactly-enough';
const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const directories: string[] = [];

afterEach(() => {
  closeAccountConnections();
  closeSessionConnections();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function envWith(accounts = true): WorkerEnv {
  const directory = mkdtempSync(join(tmpdir(), 'fruitback-session-sites-'));
  directories.push(directory);

  return {
    FRUITBACK_STORE: 'memory',
    ALLOWED_ORIGINS: 'https://app.fruitback.test',
    FRUITBACK_IDENTITY_SECRET: SECRET,
    FRUITBACK_SESSION_PATH: join(directory, 'sessions.db'),
    ...(accounts
      ? { FRUITBACK_ACCOUNTS_PATH: join(directory, 'accounts.db'), FRUITBACK_CONSOLE_URL: 'https://app.fruitback.test' }
      : {}),
  };
}

function ask(env: WorkerEnv, token?: string, method = 'GET'): Promise<Response> {
  return handleRequest(
    new Request('https://api.fruitback.test/session/sites', {
      method,
      headers: { Origin: EXTENSION, ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) },
    }),
    env,
    { clientIp: '198.51.100.9', kv: createMemoryKv() },
  );
}

async function setUp(env: WorkerEnv) {
  const accounts = createSqliteAccountStore(env.FRUITBACK_ACCOUNTS_PATH as string);
  const alice = await accounts.signIn({ provider: 'email', subject: 'alice@acme.dev', email: 'alice@acme.dev' });
  const acme = await accounts.createWorkspace('Acme', alice.id);
  const other = await accounts.createWorkspace('Other', alice.id);
  const site = await accounts.addSite(acme.id, { origin: 'https://staging.acme.dev', visibility: 'members' });
  await accounts.addSite(other.id, { origin: 'https://other.dev', visibility: 'members' });
  const sessions = createSqliteSessionStore(env.FRUITBACK_SESSION_PATH as string);
  const { code } = await createPairing(sessions, { subject: alice.id, workspace: acme.id });
  const redeemed = await redeemPairing(sessions, code, SECRET);
  assert.ok(redeemed.ok);

  return { alice, acme, site, token: redeemed.session.accessToken };
}

describe('the sites a session may turn on (FRU-101)', () => {
  it('answers the sites of the workspace of the session, and of no other', async () => {
    const env = envWith();
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
    const env = envWith();
    const { alice, token } = await setUp(env);
    assert.equal('locale' in ((await (await ask(env, token)).json()) as object), false, 'no language yet: no field');

    await createSqliteAccountStore(env.FRUITBACK_ACCOUNTS_PATH as string).setLocale(alice.id, 'fr');

    assert.equal(((await (await ask(env, token)).json()) as { locale?: string }).locale, 'fr');
  });

  it('answers nobody without a token, and nothing to a session that names no workspace', async () => {
    const env = envWith();
    const { alice } = await setUp(env);
    const console = await signIdentityToken({ sub: alice.id, exp: Math.floor(Date.now() / 1000) + 600 }, SECRET);

    assert.equal((await ask(env)).status, 401);
    assert.equal((await ask(env, console)).status, 401);
  });

  it('answers nothing to a person who is no longer a member', async () => {
    const env = envWith();
    const { alice, acme, token } = await setUp(env);
    closeAccountConnections();
    const database = new DatabaseSync(env.FRUITBACK_ACCOUNTS_PATH as string);
    database.prepare('DELETE FROM members WHERE workspace_id = ? AND account_id = ?').run(acme.id, alice.id);
    database.close();

    assert.equal((await ask(env, token)).status, 401);
  });

  it('takes GET only, and does not exist on a worker with no accounts', async () => {
    const env = envWith();
    const { token } = await setUp(env);

    assert.equal((await ask(env, token, 'POST')).status, 405);
    const without = await ask(envWith(false), token);
    assert.notEqual(without.status, 200, 'a worker with no accounts lists no site');
  });
});
