import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { connectorSettingsOf } from './account-rows.ts';
import {
  ACTIONS,
  type Action,
  DEFAULT_CONNECTOR_SETTINGS,
  ROLES,
  type Role,
  can,
  clientOf,
  normalizeEmail,
  siteOrigin,
} from './accounts.ts';
import { closeAccountConnections, createSqliteAccountStore } from './accounts-sqlite.fixture.ts';
import { readExposureNotice } from './clients.ts';
import { WORKER, type World, callOn, signInTo, worlds } from './console-world.fixture.ts';
import { readConfig } from './env.ts';
import { createPairing, redeemPairing } from './session.ts';
import { handleRequest } from './app.ts';

const directories: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'fruitback-accounts-'));
  directories.push(directory);

  return directory;
}

afterEach(() => {
  closeAccountConnections();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('the rights of each role (FRU-96)', () => {
  const expected: Record<Role, readonly Action[]> = {
    owner: [
      'read-feedback',
      'see-tracker',
      'read-members',
      'manage-sites',
      'manage-members',
      'manage-workspace',
      'delete-workspace',
    ],
    admin: ['read-feedback', 'see-tracker', 'read-members', 'manage-sites', 'manage-members', 'manage-workspace'],
    member: ['read-feedback', 'see-tracker', 'read-members'],
    guest: ['read-feedback'],
  };

  for (const role of ROLES) {
    it(`gives ${role} exactly what the design gives it`, () => {
      assert.deepEqual(
        ACTIONS.filter((action) => can(role, action)),
        expected[role],
      );
    });
  }

  it('never shows the tracker to a guest, and lets only the owner delete', () => {
    assert.equal(can('guest', 'see-tracker'), false);
    assert.deepEqual(
      ROLES.filter((role) => can(role, 'delete-workspace')),
      ['owner'],
    );
  });
});

describe('the words people paste', () => {
  it('keeps the origin of a pasted address, and refuses what is not a site', () => {
    assert.equal(siteOrigin('  https://staging.acme.dev/pricing?tab=1#top '), 'https://staging.acme.dev');
    assert.equal(siteOrigin('http://localhost:5173/'), 'http://localhost:5173');
    assert.equal(siteOrigin('ftp://acme.dev'), undefined);
    assert.equal(siteOrigin('https://user:pass@acme.dev'), undefined);
    assert.equal(siteOrigin('acme.dev'), undefined);
  });

  it('stores an address trimmed and in lower case, and refuses one that is not an address', () => {
    assert.equal(normalizeEmail('  Alice@Acme.DEV '), 'alice@acme.dev');
    assert.equal(normalizeEmail('alice'), undefined);
    assert.equal(normalizeEmail('alice @acme.dev'), undefined);
  });

  it('turns a site into a client of its workspace, read by members or by everyone', () => {
    const site = { id: 'site_1', workspaceId: 'ws_1', origin: 'https://acme.dev', destinations: [] };
    assert.deepEqual(clientOf({ ...site, visibility: 'members' }), {
      workspace: 'ws_1',
      origins: ['https://acme.dev'],
      read: 'authenticated',
    });
    assert.equal(clientOf({ ...site, visibility: 'everyone' }).read, 'public');
  });
});

/**
 * What is true of the SQLite file alone. Since FRU-150 this store is a fixture: the worker keeps its
 * accounts in PostgreSQL, and the copy command `migrate-to-postgres` reads the file. The rules of
 * every `AccountStore` are in `account-conformance.fixture.ts`, and `account-conformance.test.ts`
 * runs them on this store.
 */
describe('the SQLite account store', () => {
  it('leaves no site of a deleted workspace in the file, read with the foreign keys off', async () => {
    const path = join(scratch(), 'accounts.db');
    const store = createSqliteAccountStore(path);
    const alice = await store.signIn({ provider: 'email', subject: 'alice@acme.dev', email: 'alice@acme.dev' });
    const gone = await store.createWorkspace('Gone', alice.id);
    await store.addSite(gone.id, { origin: 'https://gone.dev', visibility: 'members' });

    await store.deleteWorkspace(gone.id);

    closeAccountConnections();
    // The cascade is the rule, so it is checked with the pragma off: `node:sqlite` turns it on itself.
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA foreign_keys = OFF');
    const left = raw.prepare('SELECT count(*) AS n FROM sites WHERE workspace_id = ?').get(gone.id) as { n: number };
    assert.equal(left.n, 0);
    raw.close();
  });
});

describe('a worker that reads its clients from the accounts (FRU-96)', () => {
  const envWith = worlds();

  function read(env: World, client: string, origin: string, token?: string): Promise<Response> {
    const url = encodeURIComponent(`${origin}/pricing`);

    return callOn(env, 'GET', `/feedback?url=${url}&client=${client}`, {
      origin,
      ...(token === undefined ? {} : { token }),
    });
  }

  async function sessionIn(env: World, account: string, workspace: string): Promise<string> {
    const { code } = await createPairing(env.sessions, { subject: account, workspace });
    const redeemed = await redeemPairing(env.sessions, code, env.env.FRUITBACK_IDENTITY_SECRET as string);
    assert.ok(redeemed.ok);

    return redeemed.session.accessToken;
  }

  it('serves a site the moment it is added, to the members of its workspace and to nobody else', async () => {
    const env = await envWith();
    const { accounts } = env;
    const alice = await signInTo(env, 'alice@acme.dev');
    const mallory = await signInTo(env, 'mallory@evil.dev');
    const acme = await accounts.createWorkspace('Acme', alice.id);
    const evil = await accounts.createWorkspace('Evil', mallory.id);

    assert.equal((await read(env, 'site_x', 'https://acme.dev')).status, 403, 'before: an origin nobody added');

    const site = await accounts.addSite(acme.id, { origin: 'https://acme.dev', visibility: 'members' });

    assert.equal((await read(env, site.id, 'https://acme.dev', await sessionIn(env, alice.id, acme.id))).status, 200);
    assert.equal((await read(env, site.id, 'https://acme.dev', await sessionIn(env, mallory.id, evil.id))).status, 401);
    assert.equal((await read(env, site.id, 'https://acme.dev')).status, 401, 'members only: no token, no read');
  });

  it('answers everyone on a site its workspace opened to everyone', async () => {
    const env = await envWith();
    const { accounts } = env;
    const alice = await signInTo(env, 'alice@acme.dev');
    const acme = await accounts.createWorkspace('Acme', alice.id);
    const site = await accounts.addSite(acme.id, { origin: 'https://acme.dev', visibility: 'everyone' });

    assert.equal((await read(env, site.id, 'https://acme.dev')).status, 200);
  });

  it('serves no client before a site exists, rather than every page to anybody', async () => {
    const env = await envWith({ env: { ALLOWED_ORIGINS: 'https://acme.dev' } });

    const response = await read(env, 'anything', 'https://acme.dev');
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'unknown-client' });
  });

  it('refuses a client map beside the accounts', async () => {
    const { env } = await envWith();
    assert.equal(readConfig(env).ok, true, 'the control: the same environment with no map');

    const both = readConfig({ ...env, FRUITBACK_CLIENTS: '{"acme":{"workspace":"ws"}}' });
    assert.ok(both.ok === false && both.missing.some((name) => name.startsWith('FRUITBACK_CLIENTS')));
  });

  it('says nothing of the sites on /health, which never opens a database', async () => {
    // Only the environment of the world is given: its address of a database has nothing behind it.
    const { env } = await envWith();
    const response = await handleRequest(new Request(`${WORKER}/health`), env, { clientIp: '192.0.2.250' });

    assert.deepEqual(await response.json(), { ok: true, store: 'memory' });
  });
});

describe('what the boot log says about who reads the pins (FRU-116)', () => {
  it('does not call a worker with accounts one public client', () => {
    const notice = readExposureNotice({ read: 'public', clients: undefined, accounts: true });

    assert.ok(notice !== undefined);
    assert.equal(notice.includes('read is public'), false);
    assert.equal(notice.includes('Set FRUITBACK_READ'), false, 'the advice does not apply to a site');
    assert.match(notice, /site by site/);
  });

  it('still names the open clients of a worker with no accounts, and says nothing when none is open', () => {
    assert.match(
      readExposureNotice({ read: 'public', clients: undefined, accounts: false }) ?? '',
      /read is public for <single client>/,
    );
    assert.match(
      readExposureNotice({ read: 'authenticated', clients: { acme: { read: 'public' }, zen: {} }, accounts: false }) ??
        '',
      /read is public for acme:/,
    );
    assert.equal(readExposureNotice({ read: 'authenticated', clients: undefined, accounts: false }), undefined);
  });

  it('is what the server prints, with the accounts of its configuration', () => {
    // `server.ts` has no test of its own: the cases above stay green with the call deleted.
    const server = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');

    assert.match(server, /readExposureNotice\(\{[^}]*accounts: hasAccounts\(config\.config\)/s);
    assert.match(server, /console\.warn\(exposure\)/);
    assert.equal(server.includes('openReadClients('), false, 'the server holds no second copy of the rule');
  });
});

describe('the accounts file of a version before (FRU-119)', () => {
  it('keeps an account written before the language column, with no language', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fruitback-accounts-old-'));
    directories.push(directory);
    const path = join(directory, 'accounts.db');
    // The shape of the file at version 2, as FRU-98 left it: no `locale` on an account.
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE logins (provider TEXT NOT NULL, subject TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE, created_at INTEGER NOT NULL, PRIMARY KEY (provider, subject));
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE members (workspace_id TEXT NOT NULL, account_id TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (workspace_id, account_id));
      CREATE TABLE sites (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, origin TEXT NOT NULL UNIQUE, visibility TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE email_links (code_hash TEXT PRIMARY KEY, email TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, spent_at INTEGER);
      INSERT INTO accounts VALUES ('acc_old', 'alice@acme.dev', 'Alice', 1);
      INSERT INTO logins VALUES ('email', 'alice@acme.dev', 'acc_old', 1);
      PRAGMA user_version = 2;
    `);
    old.close();

    const accounts = createSqliteAccountStore(path);

    assert.deepEqual(await accounts.account('acc_old'), { id: 'acc_old', email: 'alice@acme.dev', name: 'Alice' });
    assert.equal(await accounts.localeOf('alice@acme.dev'), undefined);
    await accounts.setLocale('acc_old', 'fr-FR');
    assert.equal((await accounts.account('acc_old'))?.locale, 'fr-FR');
    const again = await accounts.signIn({
      provider: 'email',
      subject: 'alice@acme.dev',
      email: 'alice@acme.dev',
      locale: 'en-US',
    });
    assert.equal(again.locale, 'fr-FR', 'a later sign-in does not change a language somebody has');
  });
});

describe('the settings a row of a connector holds (FRU-102)', () => {
  it('keeps each exception that is one, and loses only the entry that is not', () => {
    const row = JSON.stringify({
      showComments: false,
      stages: { s_kept: 'ripe', s_broken: 'purple', 'not an id': 'green' },
    });

    assert.deepEqual(connectorSettingsOf(row), { showComments: false, stages: { s_kept: 'ripe' } });
  });

  it('reads the defaults from a value that is not settings, field by field', () => {
    assert.deepEqual(connectorSettingsOf('not json'), DEFAULT_CONNECTOR_SETTINGS);
    assert.deepEqual(connectorSettingsOf(undefined), DEFAULT_CONNECTOR_SETTINGS);
    assert.deepEqual(connectorSettingsOf('{"showComments":"no","stages":{"s1":"green"}}'), {
      showComments: true,
      stages: { s1: 'green' },
    });
  });
});
