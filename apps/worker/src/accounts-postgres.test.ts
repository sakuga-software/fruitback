import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { accountCases } from './account-conformance.fixture.ts';
import type { AccountStore } from './accounts.ts';
import { createPostgresAccountStore } from './accounts-postgres.ts';
import { accountStoreFor, handleRequest } from './app.ts';
import { type WorkerEnv, hasAccounts, readConfig } from './env.ts';
import type { Database } from './postgres.ts';
import {
  NO_REAL_POSTGRES,
  appliedDates,
  createPgliteDatabase,
  createRealDatabase,
  journalDates,
  outcomeOnChangedStore,
  rowsOf,
} from './postgres.fixture.ts';
import { createPostgresSessionStore } from './session-postgres.ts';
import { type SessionStore, createPairing, redeemPairing } from './session.ts';

/**
 * What is true of the PostgreSQL account store alone (FRU-141). The rules of every `AccountStore`
 * are in `account-conformance.fixture.ts`, and `account-conformance.test.ts` runs them on this store.
 */

const run = promisify(execFile);
const SECRET = 'a-worker-secret-of-exactly-enough';
const PASSWORD = 'hunter2-not-for-a-log';
// Port 1 of this machine: nothing listens there.
const DATABASE_URL = `postgres://fruitback:${PASSWORD}@127.0.0.1:1/fruitback`;

/** A worker on a database. Its sessions are in the database too (FRU-142): it names no session file. */
function envWith(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    FRUITBACK_STORE: 'memory',
    ALLOWED_ORIGINS: 'https://app.fruitback.test',
    FRUITBACK_IDENTITY_SECRET: SECRET,
    FRUITBACK_DATABASE_URL: DATABASE_URL,
    FRUITBACK_CONSOLE_URL: 'https://app.fruitback.test',
    ...overrides,
  };
}

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

  it('asks of the database what it asks of the accounts file: a console, and the key of a session', () => {
    // The sessions are in the database too (FRU-142), so the key that signs one is asked for.
    const noKey = readConfig(envWith({ FRUITBACK_IDENTITY_SECRET: undefined }));
    assert.deepEqual(noKey.ok === false && noKey.missing, [
      'FRUITBACK_IDENTITY_SECRET (FRUITBACK_DATABASE_URL is set, and a session signs its access token)',
    ]);

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
      envWith({ FRUITBACK_SESSION_PATH: '/data/sessions.db' }),
      envWith({ FRUITBACK_IDENTITY_SECRET: undefined }),
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

  async function sessionIn(sessions: SessionStore, account: string, workspace: string): Promise<string> {
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

    // The sessions are in the same database as the accounts.
    const sessions = createPostgresSessionStore(database);
    const mine = await sessionIn(sessions, alice.id, acme.id);
    const theirs = await sessionIn(sessions, mallory.id, evil.id);
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

  it('applies the migrations at the first call, and once for the stores of one database', async () => {
    database = await createPgliteDatabase();

    // Two requests at the same moment build their stores on the database of the process: two of
    // the accounts, and one of the sessions.
    const [first, second] = [createPostgresAccountStore(database), createPostgresAccountStore(database)];
    const sessions = createPostgresSessionStore(database);
    assert.deepEqual(await Promise.all([first.clientMap(), second.clientMap(), sessions.purge(0)]), [
      {},
      {},
      undefined,
    ]);

    // One row for each migration of the folder, and no more: three stores did not apply it three times.
    assert.deepEqual(await appliedDates(database), journalDates());
  });
});

/** What a case of the accounts answers on the store with one change. See `outcomeOnChangedStore`. */
function outcomeOf(
  name: string,
  change: { from: string; to: string },
  held: { table: string; when?: string },
  open: () => Promise<Database>,
): Promise<unknown> {
  return outcomeOnChangedStore({
    file: 'accounts-postgres.ts',
    factory: 'createPostgresAccountStore',
    cases: accountCases,
    name,
    change,
    held,
    open,
  });
}

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
    from: [
      '.insert(accounts)',
      "            .values({ id: newId('acc'), email: address, name: given, locale: locale ?? null, created_at: now })",
      '            .onConflictDoNothing({ target: accounts.email })',
    ].join('\n'),
    to: [
      '.execute(sql`INSERT INTO accounts (id, email, name, locale, created_at)',
      "  SELECT ${newId('acc')}::text, ${address}::text, ${given}::text, ${locale ?? null}::text, ${now}::bigint",
      '  WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE email = ${address}::text)`)',
    ].join('\n'),
  };
  // The first sign-in has read that the address is new, and has not written its account yet.
  const HELD = { table: 'accounts' };

  it('passes on PGlite with an insert that names no conflict', async () => {
    assert.equal(await outcomeOf(CASE, WITHOUT_CONFLICT, HELD, createPgliteDatabase), 'passed');
  });

  it('fails on a real server when the insert names no conflict', { skip: NO_REAL_POSTGRES }, async () => {
    const outcome = await outcomeOf(CASE, WITHOUT_CONFLICT, HELD, createRealDatabase);

    assert.ok(outcome instanceof Error, 'the case passed on a store that loses the race');
    assert.equal((outcome as { code?: string }).code, '23505');
  });
});

/**
 * Two lists for one site at the same moment (FRU-123 on PostgreSQL). `setDestinations` removes the
 * rows of the site, then writes the new ones. With no lock on the row of the site, the second
 * transaction does not see the rows of the first: both write position 0, and the key refuses one.
 */
describe('two lists of destinations for one site, on two connections (FRU-141)', () => {
  const CASE = 'keeps one whole list when two calls set the destinations of one site at the same moment';
  const WITHOUT_LOCK = { from: ".for('update')", to: '' };
  // The first list has removed the rows of the site, and has not written its first place yet.
  const HELD = { table: 'site_destinations', when: 'NEW.position = 0' };

  it('passes on PGlite with no lock on the site', async () => {
    assert.equal(await outcomeOf(CASE, WITHOUT_LOCK, HELD, createPgliteDatabase), 'passed');
  });

  it('fails on a real server with no lock on the site', { skip: NO_REAL_POSTGRES }, async () => {
    const outcome = await outcomeOf(CASE, WITHOUT_LOCK, HELD, createRealDatabase);

    assert.ok(outcome instanceof Error, 'the case passed on a store that loses the race');
    assert.equal((outcome as { code?: string }).code, '23505');
  });
});

/**
 * « Without `FRUITBACK_DATABASE_URL`, the worker loads nothing of PostgreSQL »: no file of the driver
 * (FRU-141), and no file of Drizzle (FRU-180). Each run is a process of its own: the modules that one
 * test loaded would be loaded for the next.
 */
describe('Drizzle and the driver of PostgreSQL, loaded only by a worker that has a database (FRU-141)', () => {
  const script = `
    import { createRequire, registerHooks } from 'node:module';
    // Drizzle is ES modules, and Node keeps no list of those: every module that is asked for is noted here.
    const asked = [];
    registerHooks({
      resolve(specifier, context, next) {
        const found = next(specifier, context);
        asked.push(found.url);
        return found;
      },
    });
    const { handleRequest } = await import(${JSON.stringify(new URL('./app.ts', import.meta.url).href)});
    const env = JSON.parse(process.env.WORKER_ENV);
    const ask = (path) => handleRequest(new Request('https://worker.test' + path, { headers: { Origin: 'https://acme.dev' } }), env, { clientIp: '192.0.2.9' });
    const statuses = [(await ask('/health')).status, (await ask('/feedback?url=' + encodeURIComponent('https://acme.dev/'))).status];
    // The driver is CommonJS: Node keeps every CommonJS module it loaded in this cache.
    const loaded = Object.keys(createRequire(import.meta.url).cache).filter((path) => /node_modules\\/(pg|pg-[a-z-]+)\\//.test(path));
    const drizzle = asked.filter((url) => /node_modules\\/drizzle-orm\\//.test(url));
    console.log(JSON.stringify({ statuses, driver: loaded.length, drizzle: drizzle.length, modules: asked.length }));
    process.exit(0);
  `;
  type Loaded = { statuses: number[]; driver: number; drizzle: number; modules: number };
  const worker = async (env: WorkerEnv): Promise<Loaded> => {
    const { stdout } = await run(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      env: { ...process.env, WORKER_ENV: JSON.stringify(env) },
    });

    return JSON.parse(stdout) as Loaded;
  };

  it('loads no file of Drizzle and no file of the driver for a worker without the variable', async () => {
    const answered = await worker({ FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: 'https://acme.dev' });

    assert.deepEqual({ ...answered, modules: 0 }, { statuses: [200, 200], driver: 0, drizzle: 0, modules: 0 });
    assert.ok(answered.modules > 0, 'no module was noted at all, so a zero for Drizzle proves nothing');
  });

  // The control of the test above: the same counts are not zero when the worker has a database.
  it('loads them at the first request that reads the accounts, and not for /health', async () => {
    const answered = await worker(envWith({ ALLOWED_ORIGINS: 'https://acme.dev' }));

    assert.deepEqual(answered.statuses, [200, 502]);
    assert.ok(answered.driver > 0, 'the count of the files of the driver found none, so a zero proves nothing');
    assert.ok(answered.drizzle > 0, 'the count of the files of Drizzle found none, so a zero proves nothing');
  });
});

/**
 * The values that the types say are given, as the store reads them at run time (FRU-187).
 *
 * No caller passes these values. With Drizzle they would change rows in silence: a `LIMIT` that is not
 * a positive number is left out, and an `undefined` in `.set()` leaves its column out. The store
 * refuses them, and the rows stay as they were.
 */
describe('a value that the types say is given, and that a caller leaves out (FRU-187)', () => {
  let database: Database | undefined;

  afterEach(async () => {
    await database?.close();
    database = undefined;
  });

  /** A store with a workspace, a connector, three deliveries due, and a link that can be spent. */
  async function world() {
    database = await createPgliteDatabase();
    const store = createPostgresAccountStore(database);
    const alice = await store.signIn({ provider: 'email', subject: 'alice@acme.dev', email: 'alice@acme.dev' });
    const workspace = await store.createWorkspace('Acme', alice.id);
    const hook = await store.addConnector(workspace.id, { kind: 'rest', label: 'Hook', sealed: 'sealed-1' });
    const ids = [
      await store.enqueueDelivery(hook.id, '{"n":1}', 100),
      await store.enqueueDelivery(hook.id, '{"n":2}', 200),
      await store.enqueueDelivery(hook.id, '{"n":3}', 300),
    ];
    await store.createEmailLink({ codeHash: 'digest-1', email: 'alice@acme.dev', expiresAt: Date.now() + 60_000 });

    return { store, workspace, hook, ids };
  }

  /** Each column that one of these calls writes, for every row. */
  async function snapshot(): Promise<unknown> {
    assert.ok(database !== undefined);

    return {
      connectors: await rowsOf(database, 'SELECT id, sealed, attention, attention_at FROM connectors ORDER BY id'),
      deliveries: await rowsOf(
        database,
        'SELECT id, attempts, next_at, last_at, last_status, last_error FROM deliveries ORDER BY id',
      ),
      links: await rowsOf(database, 'SELECT code_hash, spent_at FROM email_links ORDER BY code_hash'),
    };
  }

  it('refuses a limit of due deliveries that is not a positive integer, where Drizzle drops the LIMIT', async () => {
    const { store } = await world();

    for (const limit of [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(store.dueDeliveries(1_000, limit), TypeError, `limit ${limit}`);
    }
    assert.equal((await store.dueDeliveries(1_000, 2)).length, 2);
  });

  it('refuses undefined in place of a value it writes, and changes no row', async () => {
    const { store, workspace, hook, ids } = await world();
    const [first, second] = ids as [string, string, string];
    const before = await snapshot();
    const none = undefined as unknown as never;

    const calls: [string, () => Promise<unknown>][] = [
      ['resealConnector: sealed', () => store.resealConnector(hook.id, none)],
      ['resealConnector: connector', () => store.resealConnector(none, 'sealed-2')],
      ['noteConnector: now', () => store.noteConnector(hook.id, 'key-refused', none)],
      ['dueDeliveries: now', () => store.dueDeliveries(none, 10)],
      ['settleDelivery: outcome.at', () => store.settleDelivery(first, { delivered: false, attempts: 0, at: none })],
      [
        'settleDelivery: outcome.attempts',
        () => store.settleDelivery(first, { delivered: false, attempts: none, at: 1_000, nextAt: 2_000 }),
      ],
      ['settleDelivery: id', () => store.settleDelivery(none, { delivered: true })],
      ['retryDelivery: now', () => store.retryDelivery(workspace.id, hook.id, second, none)],
      ['dropAbandonedDeliveries: before', () => store.dropAbandonedDeliveries(none)],
      ['spendEmailLink: now', () => store.spendEmailLink('digest-1', none)],
    ];
    for (const [what, call] of calls) {
      await assert.rejects(call(), { name: 'TypeError', message: `${what} is required` }, what);
    }

    assert.deepEqual(await snapshot(), before);
  });
});
