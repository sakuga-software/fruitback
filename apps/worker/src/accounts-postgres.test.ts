import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { accountCases } from './account-conformance.fixture.ts';
import type { AccountStore } from './accounts.ts';
import { createPostgresAccountStore } from './accounts-postgres.ts';
import { accountStoreFor, handleRequest } from './app.ts';
import { collect, mutatedModule } from './conformance.fixture.ts';
import { type WorkerEnv, hasAccounts, readConfig } from './env.ts';
import type { Database } from './postgres.ts';
import { NO_REAL_POSTGRES, createPgliteDatabase, createRealDatabase } from './postgres.fixture.ts';
import { closeSessionConnections, createSqliteSessionStore } from './session-sqlite.ts';
import { createPairing, redeemPairing } from './session.ts';

/**
 * What is true of the PostgreSQL account store alone (FRU-141). The rules of every `AccountStore`
 * are in `account-conformance.fixture.ts`, and `account-conformance.test.ts` runs them on this store.
 */

const run = promisify(execFile);
const SECRET = 'a-worker-secret-of-exactly-enough';
const PASSWORD = 'hunter2-not-for-a-log';
// Port 1 of this machine: nothing listens there.
const DATABASE_URL = `postgres://fruitback:${PASSWORD}@127.0.0.1:1/fruitback`;

const directories: string[] = [];

function envWith(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  const directory = mkdtempSync(join(tmpdir(), 'fruitback-accounts-pg-'));
  directories.push(directory);

  return {
    FRUITBACK_STORE: 'memory',
    ALLOWED_ORIGINS: 'https://app.fruitback.test',
    FRUITBACK_IDENTITY_SECRET: SECRET,
    FRUITBACK_SESSION_PATH: join(directory, 'sessions.db'),
    FRUITBACK_DATABASE_URL: DATABASE_URL,
    FRUITBACK_CONSOLE_URL: 'https://app.fruitback.test',
    ...overrides,
  };
}

afterEach(() => {
  closeSessionConnections();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('a worker whose accounts are in PostgreSQL (FRU-141)', () => {
  it('takes the address of the database in place of the accounts file', () => {
    const config = readConfig(envWith());

    assert.ok(config.ok, config.ok ? '' : config.missing.join(', '));
    assert.equal(config.config.accountsPath, undefined);
    assert.equal(hasAccounts(config.config), true);
    assert.ok(accountStoreFor(config.config) !== undefined);
  });

  it('refuses the database beside the accounts file, and beside a client map', () => {
    const both = readConfig(envWith({ FRUITBACK_ACCOUNTS_PATH: '/data/accounts.db' }));
    assert.ok(both.ok === false && both.missing.some((name) => name.startsWith('FRUITBACK_ACCOUNTS_PATH')));

    const clients = readConfig(envWith({ FRUITBACK_CLIENTS: '{"acme":{"workspace":"ws"}}' }));
    assert.ok(
      clients.ok === false &&
        clients.missing.some((name) => name.startsWith('FRUITBACK_CLIENTS (FRUITBACK_DATABASE_URL is set')),
    );
  });

  it('asks of the database what it asks of the accounts file: sessions, and a console', () => {
    const noSessions = readConfig(envWith({ FRUITBACK_SESSION_PATH: undefined }));
    assert.ok(noSessions.ok === false && noSessions.missing.some((name) => name.startsWith('FRUITBACK_SESSION_PATH')));

    const noConsole = readConfig(envWith({ FRUITBACK_CONSOLE_URL: undefined }));
    assert.ok(noConsole.ok === false && noConsole.missing.some((name) => name.startsWith('FRUITBACK_CONSOLE_URL')));

    // The key of the connectors needs accounts, and the database is accounts.
    assert.ok(readConfig(envWith({ FRUITBACK_SECRETS_KEY: 'a-key-that-seals-the-connectors-0123' })).ok);
  });

  it('never quotes the address in a diagnostic, at boot or on /health', async () => {
    const malformed = `mysql://fruitback:${PASSWORD}@db/fruitback`;
    const cases = [
      envWith({ FRUITBACK_DATABASE_URL: malformed }),
      envWith({ FRUITBACK_ACCOUNTS_PATH: '/data/accounts.db' }),
      envWith({ FRUITBACK_SESSION_PATH: undefined }),
      envWith({ FRUITBACK_CONSOLE_URL: undefined }),
      envWith({ FRUITBACK_CLIENTS: '{"acme":{"workspace":"ws"}}' }),
    ];

    for (const env of cases) {
      const config = readConfig(env);
      assert.equal(config.ok, false);
      const health = await handleRequest(new Request('https://worker.test/health'), env, { clientIp: '192.0.2.1' });
      const said = `${config.ok ? '' : config.missing.join(' ')} ${await health.text()}`;

      assert.equal(health.status, 503);
      assert.equal(said.includes(PASSWORD), false, said);
      assert.equal(said.includes('127.0.0.1:1'), false, said);
    }
    const refused = readConfig(cases[0] as WorkerEnv);
    assert.deepEqual(refused.ok === false && refused.missing, [
      'FRUITBACK_DATABASE_URL (a postgres:// address with a host)',
    ]);
  });

  it('answers /health without the database, and a read as a store that is down when it does not answer', async () => {
    const env = envWith({ ALLOWED_ORIGINS: 'https://acme.dev' });

    const health = await handleRequest(new Request('https://worker.test/health'), env, { clientIp: '192.0.2.2' });
    assert.deepEqual(await health.json(), { ok: true, store: 'memory' });

    const read = await handleRequest(
      new Request(`https://worker.test/feedback?url=${encodeURIComponent('https://acme.dev/')}&client=site_x`, {
        headers: { Origin: 'https://acme.dev' },
      }),
      env,
      { clientIp: '192.0.2.3' },
    );
    const body = await read.text();

    assert.equal(read.status, 502);
    assert.equal(body.includes(PASSWORD), false, body);
  });
});

describe('the sites of a workspace, read from PostgreSQL (FRU-141)', () => {
  let database: Database | undefined;

  afterEach(async () => {
    await database?.close();
    database = undefined;
  });

  let ip = 0;
  function read(env: WorkerEnv, accounts: AccountStore, client: string, origin: string, token?: string) {
    const url = encodeURIComponent(`${origin}/pricing`);
    const headers: Record<string, string> = { Origin: origin };
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    ip += 1;

    return handleRequest(new Request(`https://worker.test/feedback?url=${url}&client=${client}`, { headers }), env, {
      clientIp: `192.0.2.${100 + ip}`,
      accounts,
    });
  }

  async function sessionIn(env: WorkerEnv, account: string, workspace: string): Promise<string> {
    const sessions = createSqliteSessionStore(env.FRUITBACK_SESSION_PATH as string);
    const redeemed = await redeemPairing(
      sessions,
      (await createPairing(sessions, { subject: account, workspace })).code,
      SECRET,
    );
    assert.ok(redeemed.ok);

    return redeemed.session.accessToken;
  }

  it('serves a site the moment it is added, to the members of its workspace and to nobody else', async () => {
    database = await createPgliteDatabase();
    const accounts = createPostgresAccountStore(database);
    const env = envWith();
    const alice = await accounts.signIn({ provider: 'email', subject: 'alice@acme.dev', email: 'alice@acme.dev' });
    const mallory = await accounts.signIn({
      provider: 'email',
      subject: 'mallory@evil.dev',
      email: 'mallory@evil.dev',
    });
    const acme = await accounts.createWorkspace('Acme', alice.id);
    const evil = await accounts.createWorkspace('Evil', mallory.id);

    assert.equal(
      (await read(env, accounts, 'site_x', 'https://acme.dev')).status,
      403,
      'before: an origin nobody added',
    );

    const site = await accounts.addSite(acme.id, { origin: 'https://acme.dev', visibility: 'members' });

    const mine = await sessionIn(env, alice.id, acme.id);
    const theirs = await sessionIn(env, mallory.id, evil.id);
    assert.equal((await read(env, accounts, site.id, 'https://acme.dev', mine)).status, 200);
    assert.equal((await read(env, accounts, site.id, 'https://acme.dev', theirs)).status, 401);
    assert.equal(
      (await read(env, accounts, site.id, 'https://acme.dev')).status,
      401,
      'members only: no token, no read',
    );

    assert.equal(await accounts.removeSite(acme.id, site.id), true);
    assert.equal((await read(env, accounts, site.id, 'https://acme.dev', mine)).status, 403, 'after: the site is gone');
  });

  it('applies the migrations at the first call, and once for the two stores of one database', async () => {
    database = await createPgliteDatabase();

    // Two requests at the same moment build two stores on the database of the process.
    const [first, second] = [createPostgresAccountStore(database), createPostgresAccountStore(database)];
    assert.deepEqual(await Promise.all([first.clientMap(), second.clientMap()]), [{}, {}]);

    assert.deepEqual((await database.query('SELECT version, name FROM schema_migrations')).rows, [
      { version: 1, name: 'accounts' },
    ]);
  });
});

/**
 * What only a real server shows. PGlite has one connection: a transaction holds every other call
 * back, so two sign-ins never overlap there. On a server they do, and the insert of an account
 * must name its conflict. The same change to the store passes on PGlite and fails on the server.
 * It passes every other case too: only this case, on a server, refuses it.
 */
describe('two sign-ins of one new address, on two connections (FRU-141)', () => {
  const CASE = 'makes one account of two sign-ins of one address at the same moment';
  // A read and a write in one statement, as a store that never saw two connections writes it: an
  // account that is not there yet is inserted. One call after the other, it is correct.
  const WITHOUT_CONFLICT = {
    from: 'VALUES ($1, $2, $3, $4, $5)\n             ON CONFLICT (email) DO NOTHING',
    to: 'SELECT $1::text, $2::text, $3::text, $4::text, $5::bigint WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE email = $2::text)',
  };

  async function outcomeOn(open: () => Promise<Database>): Promise<unknown> {
    const mutant = await mutatedModule('accounts-postgres.ts', WITHOUT_CONFLICT);
    const opened = await open();
    const create = mutant.module.createPostgresAccountStore as typeof createPostgresAccountStore;
    try {
      const runCase = collect(accountCases).get(CASE);
      assert.ok(runCase !== undefined, 'the case is gone');

      return await runCase(create(opened)).then(
        () => 'passed',
        (error: unknown) => error,
      );
    } finally {
      await opened.close();
      mutant.remove();
    }
  }

  it('passes on PGlite with an insert that names no conflict', async () => {
    assert.equal(await outcomeOn(createPgliteDatabase), 'passed');
  });

  it('fails on a real server when the insert names no conflict', { skip: NO_REAL_POSTGRES }, async () => {
    const outcome = await outcomeOn(createRealDatabase);

    assert.ok(outcome instanceof Error, 'the case passed on a store that loses the race');
    assert.equal((outcome as { code?: string }).code, '23505');
  });
});

/**
 * « Without `FRUITBACK_DATABASE_URL`, the worker loads nothing of PostgreSQL ». Each run is a process
 * of its own: the modules that one test loaded would be loaded for the next.
 */
describe('the driver of PostgreSQL, loaded only by a worker that has a database (FRU-141)', () => {
  const script = `
    import { createRequire } from 'node:module';
    import { handleRequest } from ${JSON.stringify(new URL('./app.ts', import.meta.url).href)};
    const env = JSON.parse(process.env.WORKER_ENV);
    const ask = (path) => handleRequest(new Request('https://worker.test' + path, { headers: { Origin: 'https://acme.dev' } }), env, { clientIp: '192.0.2.9' });
    const statuses = [(await ask('/health')).status, (await ask('/feedback?url=' + encodeURIComponent('https://acme.dev/'))).status];
    // The driver is CommonJS: Node keeps every CommonJS module it loaded in this cache.
    const loaded = Object.keys(createRequire(import.meta.url).cache).filter((path) => /node_modules\\/(pg|pg-[a-z-]+)\\//.test(path));
    console.log(JSON.stringify({ statuses, driver: loaded.length }));
    process.exit(0);
  `;
  const worker = async (env: WorkerEnv): Promise<{ statuses: number[]; driver: number }> => {
    const { stdout } = await run(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      env: { ...process.env, WORKER_ENV: JSON.stringify(env) },
    });

    return JSON.parse(stdout) as { statuses: number[]; driver: number };
  };

  it('loads no file of the driver for a worker without the variable', async () => {
    const answered = await worker({ FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: 'https://acme.dev' });

    assert.deepEqual(answered, { statuses: [200, 200], driver: 0 });
  });

  // The control of the test above: the same count is not zero when the worker has a database.
  it('loads it at the first request that reads the accounts, and not for /health', async () => {
    const answered = await worker(envWith({ ALLOWED_ORIGINS: 'https://acme.dev' }));

    assert.deepEqual(answered.statuses, [200, 502]);
    assert.ok(answered.driver > 0, 'the count of the files of the driver found none, so a zero proves nothing');
  });
});
