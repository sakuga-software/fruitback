import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ACTIONS, type Action, ROLES, type Role, can, clientOf, normalizeEmail, siteOrigin } from './accounts.ts';
import { closeAccountConnections, createSqliteAccountStore } from './accounts-sqlite.ts';
import { readExposureNotice } from './clients.ts';
import { type WorkerEnv, readConfig } from './env.ts';
import { closeSessionConnections, createSqliteSessionStore } from './session-sqlite.ts';
import { createPairing, redeemPairing } from './session.ts';
import { handleRequest } from './app.ts';

const SECRET = 'a-worker-secret-of-exactly-enough';
const directories: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'fruitback-accounts-'));
  directories.push(directory);

  return directory;
}

afterEach(() => {
  closeAccountConnections();
  closeSessionConnections();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('the rights of each role (FRU-96)', () => {
  const expected: Record<Role, readonly Action[]> = {
    owner: ['read-feedback', 'see-tracker', 'manage-sites', 'manage-members', 'manage-workspace', 'delete-workspace'],
    admin: ['read-feedback', 'see-tracker', 'manage-sites', 'manage-members', 'manage-workspace'],
    member: ['read-feedback', 'see-tracker'],
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
    const site = { id: 'site_1', workspaceId: 'ws_1', origin: 'https://acme.dev' };
    assert.deepEqual(clientOf({ ...site, visibility: 'members' }), {
      workspace: 'ws_1',
      origins: ['https://acme.dev'],
      read: 'authenticated',
    });
    assert.equal(clientOf({ ...site, visibility: 'everyone' }).read, 'public');
  });
});

describe('the account store', () => {
  it('makes one account of two providers that prove the same address', async () => {
    const store = createSqliteAccountStore(join(scratch(), 'accounts.db'));

    const byLink = await store.signIn({ provider: 'email', subject: 'alice@acme.dev', email: 'alice@acme.dev' });
    const byGitHub = await store.signIn({
      provider: 'github',
      subject: '4242',
      email: 'Alice@Acme.dev',
      name: 'Alice',
    });
    const again = await store.signIn({ provider: 'github', subject: '4242', email: 'alice@acme.dev' });

    assert.equal(byGitHub.id, byLink.id);
    assert.equal(again.id, byLink.id);
    assert.equal(byGitHub.name, 'Alice', 'a name the first sign-in did not have is kept');
  });

  it('keeps two addresses apart', async () => {
    const store = createSqliteAccountStore(join(scratch(), 'accounts.db'));

    const alice = await store.signIn({ provider: 'email', subject: 'alice@acme.dev', email: 'alice@acme.dev' });
    const bob = await store.signIn({ provider: 'email', subject: 'bob@acme.dev', email: 'bob@acme.dev' });

    assert.notEqual(alice.id, bob.id);
  });

  it('makes the creator the owner, and gives nobody else a role', async () => {
    const store = createSqliteAccountStore(join(scratch(), 'accounts.db'));
    const alice = await store.signIn({ provider: 'email', subject: 'alice@acme.dev', email: 'alice@acme.dev' });
    const bob = await store.signIn({ provider: 'email', subject: 'bob@acme.dev', email: 'bob@acme.dev' });

    const workspace = await store.createWorkspace('  Sakuga ', alice.id);

    assert.equal(workspace.name, 'Sakuga');
    assert.equal(await store.role(workspace.id, alice.id), 'owner');
    assert.equal(await store.role(workspace.id, bob.id), undefined);
    assert.deepEqual(await store.memberships(alice.id), [{ workspace, role: 'owner' }]);
    assert.deepEqual(await store.memberships(bob.id), []);
  });

  it('adds a site once, whatever was pasted twice, and serves it as a client of its workspace', async () => {
    const store = createSqliteAccountStore(join(scratch(), 'accounts.db'));
    const alice = await store.signIn({ provider: 'email', subject: 'alice@acme.dev', email: 'alice@acme.dev' });
    const workspace = await store.createWorkspace('Sakuga', alice.id);

    const first = await store.addSite(workspace.id, { origin: 'https://acme.dev', visibility: 'members' });
    const second = await store.addSite(workspace.id, { origin: 'https://acme.dev', visibility: 'everyone' });

    assert.equal(second.id, first.id);
    assert.deepEqual(await store.sites(workspace.id), [{ ...first, visibility: 'everyone' }]);
    assert.deepEqual(await store.clientMap(), {
      [first.id]: { workspace: workspace.id, origins: ['https://acme.dev'], read: 'public' },
    });
  });

  it('removes the members and the sites of a workspace it deletes, and only those', async () => {
    const path = join(scratch(), 'accounts.db');
    const store = createSqliteAccountStore(path);
    const alice = await store.signIn({ provider: 'email', subject: 'alice@acme.dev', email: 'alice@acme.dev' });
    const gone = await store.createWorkspace('Gone', alice.id);
    const kept = await store.createWorkspace('Kept', alice.id);
    await store.addSite(gone.id, { origin: 'https://gone.dev', visibility: 'members' });
    const site = await store.addSite(kept.id, { origin: 'https://kept.dev', visibility: 'members' });

    await store.deleteWorkspace(gone.id);

    assert.deepEqual(await store.memberships(alice.id), [{ workspace: kept, role: 'owner' }]);
    assert.deepEqual(Object.keys(await store.clientMap()), [site.id]);
    closeAccountConnections();
    // The cascade is the rule, so it is checked with the pragma off: `node:sqlite` turns it on itself.
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA foreign_keys = OFF');
    const left = raw.prepare('SELECT count(*) AS n FROM sites WHERE workspace_id = ?').get(gone.id) as { n: number };
    assert.equal(left.n, 0);
    raw.close();
  });

  it('removes a site only from its own workspace', async () => {
    const store = createSqliteAccountStore(join(scratch(), 'accounts.db'));
    const alice = await store.signIn({ provider: 'email', subject: 'alice@acme.dev', email: 'alice@acme.dev' });
    const a = await store.createWorkspace('A', alice.id);
    const b = await store.createWorkspace('B', alice.id);
    const site = await store.addSite(a.id, { origin: 'https://a.dev', visibility: 'members' });

    assert.equal(await store.removeSite(b.id, site.id), false);
    assert.equal(await store.removeSite(a.id, site.id), true);
    assert.deepEqual(await store.sites(a.id), []);
  });
});

describe('a worker that reads its clients from the accounts (FRU-96)', () => {
  function envWith(directory: string, overrides: Partial<WorkerEnv> = {}): WorkerEnv {
    return {
      FRUITBACK_STORE: 'memory',
      // The console's own origin. A site's origin is added when the site is.
      ALLOWED_ORIGINS: 'https://app.fruitback.test',
      FRUITBACK_IDENTITY_SECRET: SECRET,
      FRUITBACK_SESSION_PATH: join(directory, 'sessions.db'),
      FRUITBACK_ACCOUNTS_PATH: join(directory, 'accounts.db'),
      FRUITBACK_CONSOLE_URL: 'https://app.fruitback.test',
      ...overrides,
    };
  }

  let ip = 0;
  function read(env: WorkerEnv, client: string, origin: string, token?: string): Promise<Response> {
    const url = encodeURIComponent(`${origin}/pricing`);
    const headers: Record<string, string> = { Origin: origin };
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    ip += 1;

    return handleRequest(new Request(`https://worker.test/feedback?url=${url}&client=${client}`, { headers }), env, {
      clientIp: `192.0.2.${ip}`,
    });
  }

  async function sessionIn(env: WorkerEnv, account: string, workspace: string): Promise<string> {
    const sessions = createSqliteSessionStore(env.FRUITBACK_SESSION_PATH as string);
    const { code } = await createPairing(sessions, { subject: account, workspace });
    const redeemed = await redeemPairing(sessions, code, SECRET);
    assert.ok(redeemed.ok);

    return redeemed.session.accessToken;
  }

  it('serves a site the moment it is added, to the members of its workspace and to nobody else', async () => {
    const directory = scratch();
    const env = envWith(directory);
    const accounts = createSqliteAccountStore(env.FRUITBACK_ACCOUNTS_PATH as string);
    const alice = await accounts.signIn({ provider: 'email', subject: 'alice@acme.dev', email: 'alice@acme.dev' });
    const mallory = await accounts.signIn({
      provider: 'email',
      subject: 'mallory@evil.dev',
      email: 'mallory@evil.dev',
    });
    const acme = await accounts.createWorkspace('Acme', alice.id);
    const evil = await accounts.createWorkspace('Evil', mallory.id);

    assert.equal((await read(env, 'site_x', 'https://acme.dev')).status, 403, 'before: an origin nobody added');

    const site = await accounts.addSite(acme.id, { origin: 'https://acme.dev', visibility: 'members' });

    assert.equal((await read(env, site.id, 'https://acme.dev', await sessionIn(env, alice.id, acme.id))).status, 200);
    assert.equal((await read(env, site.id, 'https://acme.dev', await sessionIn(env, mallory.id, evil.id))).status, 401);
    assert.equal((await read(env, site.id, 'https://acme.dev')).status, 401, 'members only: no token, no read');
  });

  it('answers everyone on a site its workspace opened to everyone', async () => {
    const directory = scratch();
    const env = envWith(directory);
    const accounts = createSqliteAccountStore(env.FRUITBACK_ACCOUNTS_PATH as string);
    const alice = await accounts.signIn({ provider: 'email', subject: 'alice@acme.dev', email: 'alice@acme.dev' });
    const acme = await accounts.createWorkspace('Acme', alice.id);
    const site = await accounts.addSite(acme.id, { origin: 'https://acme.dev', visibility: 'everyone' });

    assert.equal((await read(env, site.id, 'https://acme.dev')).status, 200);
  });

  it('serves no client before a site exists, rather than every page to anybody', async () => {
    const env = envWith(scratch(), { ALLOWED_ORIGINS: 'https://acme.dev' });

    const response = await read(env, 'anything', 'https://acme.dev');
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'unknown-client' });
  });

  it('refuses a client map beside the accounts, and accounts with no sessions', () => {
    const directory = scratch();
    const both = readConfig(envWith(directory, { FRUITBACK_CLIENTS: '{"acme":{"workspace":"ws"}}' }));
    assert.ok(both.ok === false && both.missing.some((name) => name.startsWith('FRUITBACK_CLIENTS')));

    const alone = readConfig(envWith(directory, { FRUITBACK_SESSION_PATH: undefined }));
    assert.ok(alone.ok === false && alone.missing.some((name) => name.startsWith('FRUITBACK_SESSION_PATH')));
  });

  it('says nothing of the sites on /health, which never opens a file', async () => {
    const response = await handleRequest(new Request('https://worker.test/health'), envWith(scratch()), {
      clientIp: '192.0.2.250',
    });

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

    assert.match(server, /readExposureNotice\(\{[^}]*accounts: config\.config\.accountsPath !== undefined/s);
    assert.match(server, /console\.warn\(exposure\)/);
    assert.equal(server.includes('openReadClients('), false, 'the server holds no second copy of the rule');
  });
});
