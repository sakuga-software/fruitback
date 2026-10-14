import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { ACTIONS, ROLES, can } from './accounts.ts';
import { createPostgresAccountStore } from './accounts-postgres.ts';
import { handleRequest } from './app.ts';
import {
  AT_REST_PLUGIN,
  AUTH_BASE_PATH,
  AUTH_PLUGINS,
  type Auth,
  CLIENT_IP_HEADER,
  REFUSED_PLUGINS,
  SERVED_PATHS,
  SESSION_FRESH_SECONDS,
  SESSION_RENEWAL_SECONDS,
  SESSION_TTL_SECONDS,
  announceAuth,
  authConfigOf,
  authFor,
  authOptions,
  refusedPlugins,
  startAuth,
} from './auth.ts';
import {
  AUTH_CONFIG,
  AUTH_SECRET,
  CONSOLE_URL,
  DATABASE_PASSWORD,
  DATABASE_URL,
  NO_SESSIONS,
  PUBLIC_URL,
  ask,
  databasesOfACase,
  make,
  optionsOn,
  plantedAfterTheMigrations,
} from './auth.fixture.ts';
import { FRUITBACK_RESOURCE, IMPLIED, roleStatements } from './auth-roles.ts';
import { ORGANIZATION_PATHS } from './organization-paths.ts';
import {
  ACCOUNTS_FILE_REFUSED,
  DATABASE_REQUIRED,
  GITHUB_APP_REFUSED,
  REQUIRED_WITH_DATABASE,
  type WorkerEnv,
  hasAuth,
  readConfig,
} from './env.ts';
import { beforePostgres } from './before-postgres.fixture.ts';
import { createMemoryKv } from './kv.ts';
import { type Database, closeDatabases, createPgDatabase } from './postgres.ts';
import { NO_REAL_POSTGRES, appliedDates, createPgliteDatabase, journalDates, ownDatabase } from './postgres.fixture.ts';
import { closeSessionConnections } from './session-sqlite.ts';

// The database of this environment is at an address where nothing listens: a case hands its stores
// over, and the `Kv` with them, as the transport does (FRU-67).
const kv = createMemoryKv();

/**
 * better-auth, built and switched off (FRU-144). No route of it is served: what is tested here is
 * its configuration, and that a worker which has it off loads nothing and answers `404`.
 * `auth-schema.test.ts` holds its tables, and `auth-instance.test.ts` what an instance does.
 *
 * A rule that says « never » has its control beside it: the same thing, planted, must fail.
 */

const run = promisify(execFile);
const IDENTITY_SECRET = 'a-worker-secret-of-exactly-enough';
const SECRETS_KEY = 'a-key-that-seals-the-connectors-0123';

const directories: string[] = [];
// Registered first: the databases of a case are closed before the pools of the process.
const { opening } = databasesOfACase();

/**
 * A worker with its accounts and its sessions in PostgreSQL and better-auth on, unless `overrides`
 * says otherwise. `FRUITBACK_SESSION_PATH` is refused beside the database (FRU-142).
 */
function envWith(overrides: Record<string, string | undefined> = {}): WorkerEnv {
  return {
    FRUITBACK_STORE: 'memory',
    ALLOWED_ORIGINS: CONSOLE_URL,
    FRUITBACK_IDENTITY_SECRET: IDENTITY_SECRET,
    FRUITBACK_DATABASE_URL: DATABASE_URL,
    FRUITBACK_CONSOLE_URL: CONSOLE_URL,
    FRUITBACK_PUBLIC_URL: PUBLIC_URL,
    FRUITBACK_AUTH_SECRET: AUTH_SECRET,
    ...overrides,
  };
}

/**
 * A worker whose sessions are in a file: what a worker with no database ran on, until FRU-225. Every
 * environment a process can be given refuses it since: see `beforePostgres`.
 */
function filesOnly(overrides: Record<string, string | undefined> = {}): WorkerEnv {
  const directory = mkdtempSync(join(tmpdir(), 'fruitback-auth-'));
  directories.push(directory);

  return beforePostgres(
    envWith({
      // A worker with no accounts: its sessions are in a file, and it has no console.
      FRUITBACK_DATABASE_URL: undefined,
      FRUITBACK_CONSOLE_URL: undefined,
      FRUITBACK_SESSION_PATH: join(directory, 'sessions.db'),
      ...overrides,
    }),
  );
}

function configOf(env: WorkerEnv) {
  const config = readConfig(env);
  assert.ok(config.ok, config.ok ? '' : config.missing.join(', '));

  return config.config;
}

function refusal(env: WorkerEnv): string {
  const config = readConfig(env);
  assert.equal(config.ok, false, 'the configuration was accepted');

  return config.ok ? '' : config.missing.join(' | ');
}

afterEach(async () => {
  closeSessionConnections();
  await closeDatabases();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('the secret of better-auth, and what it switches on (FRU-144)', () => {
  it('switches better-auth on with its secret and a database, and refuses a database without the secret (FRU-225)', () => {
    const on = configOf(envWith());
    assert.equal(hasAuth(on), true);
    assert.deepEqual(authConfigOf(on), AUTH_CONFIG);

    // An administrator can always sign in (FRU-225): the secret is asked for, and never made. An
    // empty value is an absent one, as for every variable of the compose file.
    for (const secret of [undefined, '']) {
      assert.equal(refusal(envWith({ FRUITBACK_AUTH_SECRET: secret })), REQUIRED_WITH_DATABASE.FRUITBACK_AUTH_SECRET);
    }

    // The worker of before started with better-auth off (FRU-217), and its code is still there.
    const off = configOf(beforePostgres(envWith({ FRUITBACK_AUTH_SECRET: undefined })));
    assert.equal(hasAuth(off), false);
    assert.equal(authConfigOf(off), undefined);
  });

  it('refuses a secret of better-auth under 32 characters, and names the variable', () => {
    assert.equal(refusal(envWith({ FRUITBACK_AUTH_SECRET: 'x'.repeat(31) })), 'FRUITBACK_AUTH_SECRET');
    assert.ok(readConfig(envWith({ FRUITBACK_AUTH_SECRET: 'x'.repeat(32) })).ok);
  });

  it('says in SECURITY.md the length under which the secret of better-auth is refused', () => {
    const security = readFileSync(fileURLToPath(new URL('../../../SECURITY.md', import.meta.url)), 'utf8');
    const section =
      /### better-auth, what it keeps and what it refuses \(FRU-144\)\n([\s\S]*?)\n### /.exec(security)?.[1] ?? '';
    const stated = Number(/when it is under (\d+) characters/.exec(section)?.[1]);

    assert.ok(Number.isInteger(stated), 'SECURITY.md no longer says how long the secret of better-auth must be');
    assert.equal(readConfig(envWith({ FRUITBACK_AUTH_SECRET: 'x'.repeat(stated - 1) })).ok, false);
    assert.equal(readConfig(envWith({ FRUITBACK_AUTH_SECRET: 'x'.repeat(stated) })).ok, true);
  });

  it('refuses a secret of better-auth that is the identity secret or the key of the connectors', () => {
    const same = 'FRUITBACK_AUTH_SECRET (it must differ from FRUITBACK_IDENTITY_SECRET and from FRUITBACK_SECRETS_KEY)';

    assert.equal(refusal(envWith({ FRUITBACK_AUTH_SECRET: IDENTITY_SECRET })), same);
    assert.equal(refusal(envWith({ FRUITBACK_SECRETS_KEY: SECRETS_KEY, FRUITBACK_AUTH_SECRET: SECRETS_KEY })), same);
    // The control: three secrets that differ are accepted.
    assert.ok(readConfig(envWith({ FRUITBACK_SECRETS_KEY: SECRETS_KEY })).ok);
  });

  it('refuses the secret of better-auth without a database: a worker with no accounts has no better-auth', () => {
    // Since FRU-225, the one line that says the database is required, with the console it needs.
    assert.equal(
      refusal(envWith({ FRUITBACK_DATABASE_URL: undefined, FRUITBACK_CONSOLE_URL: undefined })),
      [DATABASE_REQUIRED, REQUIRED_WITH_DATABASE.FRUITBACK_CONSOLE_URL].join(' | '),
    );
    for (const env of [
      beforePostgres(envWith({ FRUITBACK_DATABASE_URL: undefined, FRUITBACK_CONSOLE_URL: undefined })),
      filesOnly(),
    ]) {
      assert.equal(
        refusal(env),
        'FRUITBACK_DATABASE_URL (FRUITBACK_AUTH_SECRET is set, and better-auth keeps its tables there)',
      );
    }
  });

  it('refuses the secret of better-auth without the address of the worker, or with a path in it', () => {
    const needed =
      'FRUITBACK_PUBLIC_URL (FRUITBACK_AUTH_SECRET is set, and better-auth needs the address of this worker, with no path)';

    // FRU-225: absent, it is asked for with the rest, whatever else is set.
    assert.equal(refusal(envWith({ FRUITBACK_PUBLIC_URL: undefined })), REQUIRED_WITH_DATABASE.FRUITBACK_PUBLIC_URL);
    assert.equal(refusal(beforePostgres(envWith({ FRUITBACK_PUBLIC_URL: undefined }))), needed);
    assert.equal(refusal(envWith({ FRUITBACK_PUBLIC_URL: `${PUBLIC_URL}/worker` })), needed);
    assert.ok(readConfig(envWith({ FRUITBACK_PUBLIC_URL: `${PUBLIC_URL}/` })).ok);
  });

  it('reads the switch of the addresses as 1 or nothing, and only beside the secret (FRU-147)', () => {
    const on = readConfig(envWith({ FRUITBACK_AUTH_TRACK_IP: '1' }));
    assert.equal(on.ok && on.config.authTrackIp, true);
    const off = readConfig(envWith());
    assert.equal(off.ok && off.config.authTrackIp, false);
    for (const value of ['true', 'yes', '0']) {
      const refused = readConfig(envWith({ FRUITBACK_AUTH_TRACK_IP: value }));
      assert.deepEqual(refused.ok ? [] : refused.missing, ['FRUITBACK_AUTH_TRACK_IP (1, or unset)'], value);
    }
    assert.equal(readConfig(envWith({ FRUITBACK_AUTH_TRACK_IP: '1', FRUITBACK_AUTH_SECRET: undefined })).ok, false);
  });

  it('takes a second GitHub App for better-auth, beside the secret, and never the App of before (FRU-147)', () => {
    const second = readConfig(envWith({ FRUITBACK_AUTH_GITHUB_OAUTH: 'second-app:its-secret' }));
    assert.deepEqual(second.ok && second.config.authGithub, { clientId: 'second-app', clientSecret: 'its-secret' });
    assert.equal(readConfig(envWith({ FRUITBACK_AUTH_GITHUB_OAUTH: 'nocolon' })).ok, false);
    assert.equal(
      readConfig(envWith({ FRUITBACK_AUTH_GITHUB_OAUTH: 'second-app:its-secret', FRUITBACK_AUTH_SECRET: undefined }))
        .ok,
      false,
    );
    // The App of the sign-in of before stops the worker, with or without the second one (FRU-150).
    for (const more of [{}, { FRUITBACK_AUTH_GITHUB_OAUTH: 'two-app:b' }]) {
      assert.equal(refusal(envWith({ FRUITBACK_GITHUB_OAUTH: 'one-app:a-secret', ...more })), GITHUB_APP_REFUSED);
    }
    assert.match(GITHUB_APP_REFUSED, /^FRUITBACK_GITHUB_OAUTH \(.*FRUITBACK_AUTH_GITHUB_OAUTH/);
  });

  it('refuses the accounts file of before, and says what to set and where to read how (FRU-150)', () => {
    assert.equal(refusal(envWith({ FRUITBACK_ACCOUNTS_PATH: '/data/accounts.db' })), ACCOUNTS_FILE_REFUSED);
    // Said with the rest (FRU-217): with no database, beside the line that asks for one (FRU-225).
    assert.deepEqual(
      refusal(
        envWith({
          FRUITBACK_ACCOUNTS_PATH: '/data/accounts.db',
          FRUITBACK_DATABASE_URL: undefined,
          FRUITBACK_AUTH_SECRET: undefined,
        }),
      ).split(' | '),
      [DATABASE_REQUIRED, REQUIRED_WITH_DATABASE.FRUITBACK_AUTH_SECRET, ACCOUNTS_FILE_REFUSED],
    );
    assert.match(ACCOUNTS_FILE_REFUSED, /^FRUITBACK_ACCOUNTS_PATH \(/);
    for (const named of ['FRUITBACK_DATABASE_URL', 'migrate-to-postgres', 'docs/self-hosting.md']) {
      assert.ok(ACCOUNTS_FILE_REFUSED.includes(named), `the refusal does not name ${named}`);
    }
    // An empty value is an absent one.
    assert.ok(readConfig(envWith({ FRUITBACK_ACCOUNTS_PATH: '', FRUITBACK_GITHUB_OAUTH: '' })).ok);
  });

  it('refuses a variable that better-auth reads from the environment by itself, and never quotes it', () => {
    const leaked = 'a-secret-that-must-not-reach-a-log-0123456789';
    const said = refusal(
      envWith({ BETTER_AUTH_TRUSTED_ORIGINS: 'https://evil.test', BETTER_AUTH_SECRETS: `2:${leaked}` }),
    );

    assert.equal(
      said,
      'BETTER_AUTH_SECRETS, BETTER_AUTH_TRUSTED_ORIGINS (better-auth reads it from the environment over the configuration of the worker: remove it)',
    );
    assert.equal(said.includes(leaked), false);
    assert.match(refusal(envWith({ BETTER_AUTH_TELEMETRY: '1' })), /^BETTER_AUTH_TELEMETRY \(/);
    // An empty value is an absent one. And a worker that has better-auth off reads none of them: the
    // worker of before (FRU-225).
    assert.ok(readConfig(envWith({ BETTER_AUTH_TELEMETRY: '' })).ok);
    assert.ok(readConfig(beforePostgres(envWith({ FRUITBACK_AUTH_SECRET: undefined, BETTER_AUTH_TELEMETRY: '1' }))).ok);
  });

  it('never quotes a secret in a diagnostic, at boot or on /health', async () => {
    const cases = [
      envWith({ FRUITBACK_AUTH_SECRET: 'short-and-wrong' }),
      envWith({ FRUITBACK_AUTH_SECRET: IDENTITY_SECRET }),
      envWith({ FRUITBACK_DATABASE_URL: undefined, FRUITBACK_CONSOLE_URL: undefined }),
      envWith({ FRUITBACK_PUBLIC_URL: undefined }),
      envWith({ BETTER_AUTH_SECRET: AUTH_SECRET }),
    ];

    for (const env of cases) {
      const health = await handleRequest(new Request('https://worker.test/health'), env, { clientIp: '192.0.2.1' });
      const said = `${refusal(env)} ${await health.text()}`;

      assert.equal(health.status, 503);
      for (const secret of [AUTH_SECRET, IDENTITY_SECRET, DATABASE_PASSWORD, 'short-and-wrong']) {
        assert.equal(said.includes(secret), false, said);
      }
    }
  });
});

describe('a worker that has better-auth switched off (FRU-144)', () => {
  it('builds no instance of better-auth without a database, or without its secret', async () => {
    const lines: string[] = [];
    const log = { log: (line: string) => void lines.push(line), error: (line: string) => void lines.push(line) };
    const refuses = (): never => assert.fail('a worker with better-auth off asked for a database');

    for (const env of [
      beforePostgres({ FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: CONSOLE_URL }),
      filesOnly({ FRUITBACK_AUTH_SECRET: undefined }),
    ]) {
      const config = configOf(env);

      assert.equal(authFor(config, refuses), undefined);
      assert.equal(await announceAuth(config, log, refuses), 'off');
    }
    assert.deepEqual(lines, [], 'a worker with no accounts said something of the sign-in at boot');

    // FRU-217: accounts and no secret. It starts, nobody signs in, and it says so in one line that
    // names the variable to set. The line does not name better-auth: nothing of it was loaded.
    // The worker of before: since FRU-225 the secret is required beside a database.
    const config = configOf(beforePostgres(envWith({ FRUITBACK_AUTH_SECRET: undefined })));
    assert.equal(authFor(config, refuses), undefined);
    assert.equal(await announceAuth(config, log, refuses), 'off');
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? '', /^\[fruitback\] nobody can sign in to the console: .*FRUITBACK_AUTH_SECRET/);
    assert.doesNotMatch(lines[0] ?? '', /better-auth|postgres:\/\//);
  });

  /**
   * « Nothing of better-auth is loaded ». Each run is a process of its own, as for the driver of
   * PostgreSQL: the modules that one test loaded would be loaded for the next. The hook sees every
   * module the process loads, the ones of `server.ts` included, which is the file that names
   * `auth.ts`.
   */
  const script = `
    import { registerHooks } from 'node:module';
    const loaded = [];
    registerHooks({ load(url, context, nextLoad) { loaded.push(url); return nextLoad(url, context); } });
    const at = (file) => new URL(file, ${JSON.stringify(new URL('.', import.meta.url).href)}).href;
    await import(at('./server.ts'));
    const { handleRequest } = await import(at('./app.ts'));
    const { announceAuth, authOptions } = await import(at('./auth.ts'));
    const { readConfig } = await import(at('./env.ts'));
    const env = JSON.parse(process.env.WORKER_ENV);
    const ask = (path) => handleRequest(new Request('https://worker.test' + path, { headers: { Origin: ${JSON.stringify(CONSOLE_URL)} } }), env, { clientIp: '192.0.2.9' });
    const statuses = [(await ask('/health')).status, (await ask('/console/auth/ok')).status, (await ask('/console/auth/get-session')).status];
    const config = readConfig(env);
    const quiet = { log() {}, error() {} };
    const announced = config.ok ? await announceAuth(config.config, quiet) : config.missing.join(', ');
    // The control builds the options, as a worker that has better-auth on does after its migrations.
    if (process.env.BUILD_OPTIONS === '1') await authOptions(JSON.parse(process.env.AUTH_CONFIG), {}, { endSessionsOf: async () => {} });
    const library = loaded.filter((url) => /\\/node_modules\\/(?:better-auth|@better-auth|kysely|better-call)\\//.test(url)).length;
    console.log(JSON.stringify({ statuses, announced, library, modules: loaded.length }));
    process.exit(0);
  `;
  type Answered = { statuses: number[]; announced: string; library: number; modules: number };
  const worker = async (env: WorkerEnv, more: Record<string, string> = {}): Promise<Answered> => {
    const { stdout } = await run(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      env: { ...process.env, WORKER_ENV: JSON.stringify(env), AUTH_CONFIG: JSON.stringify(AUTH_CONFIG), ...more },
    });

    return JSON.parse(stdout) as Answered;
  };

  /**
   * A worker of a process has better-auth on since FRU-225, or does not start: the one that loads
   * nothing of it is the worker that is refused. It answers 503 on `/health` and 500 on every route.
   * The worker of before, which had it off, cannot be given to a process: its environment holds a
   * symbol, and this one goes through JSON.
   */
  it('loads no file of better-auth for a worker that is refused, and answers 500 under /console/auth', async () => {
    const refused = await worker({ FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: CONSOLE_URL });

    assert.deepEqual(
      { ...refused, announced: '', modules: 0 },
      { statuses: [503, 500, 500], announced: '', library: 0, modules: 0 },
    );
    assert.ok(refused.announced.startsWith(DATABASE_REQUIRED), refused.announced);
    assert.ok(refused.modules > 50, 'the hook saw almost no module, so a count of zero proves nothing');
  });

  // The control of the test above: the same count is not zero the moment the options are built.
  it('loads better-auth when its options are built, which the count of the test above must see', async () => {
    const built = await worker({ FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: CONSOLE_URL }, { BUILD_OPTIONS: '1' });

    assert.ok(built.announced.startsWith(DATABASE_REQUIRED), built.announced);
    assert.ok(built.library > 0, 'the count of the files of better-auth found none, so a zero proves nothing');
  });

  it('loads nothing of better-auth while the database of a worker that has it on does not answer', async () => {
    // The migrations of the worker run first, and they fail here: nothing is built on a schema that
    // is not there. The routes answer 404 all the same.
    const down = await worker(envWith());

    assert.deepEqual(
      down.statuses,
      [200, 502, 502],
      'the accounts do not answer, so every read is a store that is down',
    );
    assert.equal(down.announced, 'failed');
    assert.equal(down.library, 0);
  });

  it('builds better-auth at boot on a real server, and serves its routes', { skip: NO_REAL_POSTGRES }, async () => {
    // A database of its own, not a schema: see `postgres.fixture.ts`.
    const { url, drop } = await ownDatabase();

    try {
      const on = await worker(envWith({ FRUITBACK_DATABASE_URL: url }));

      // FRU-147: `/ok` answers. FRU-206: `/get-session` is a route of better-auth the worker does not serve.
      assert.deepEqual(on.statuses, [200, 200, 404]);
      assert.equal(on.announced, 'ready');
      assert.ok(on.library > 0);
      const made = createPgDatabase(url, 'public', { max: 1 });
      try {
        assert.deepEqual(await appliedDates(made), journalDates());
      } finally {
        await made.close();
      }
    } finally {
      await drop();
    }
  });
});

/**
 * The files of a library that the bundle evaluates when it starts: the ones `entry` reaches with no
 * dynamic import on the way. esbuild keeps a module that is only imported dynamically inside a
 * function, and runs it at the first `import()`.
 */
async function bundled(entry: string): Promise<{ eager: string[]; inBundle: number }> {
  const directory = fileURLToPath(new URL('..', import.meta.url));
  const { metafile } = await build({
    stdin: { contents: entry, resolveDir: directory, sourcefile: 'entry.ts', loader: 'ts' },
    absWorkingDir: directory,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node26',
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  const inputs = metafile.inputs;
  const reached = new Set(['entry.ts']);
  const queue = ['entry.ts'];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    for (const imported of inputs[file]?.imports ?? []) {
      if (imported.external === true || imported.kind === 'dynamic-import' || reached.has(imported.path)) continue;
      reached.add(imported.path);
      queue.push(imported.path);
    }
  }
  const ofALibrary = (file: string): boolean =>
    /\/node_modules\/(?:better-auth|@better-auth|kysely|better-call|jose|pg|pg-[a-z-]+)\//.test(file);

  return {
    eager: [...reached].filter(ofALibrary),
    inBundle: Object.keys(inputs).filter(ofALibrary).length,
  };
}

describe('the bundle of the image, with better-auth in it (FRU-144)', () => {
  it('keeps better-auth and the driver behind a dynamic import, so the image runs none of them at boot', async () => {
    const { eager, inBundle } = await bundled("import './src/main.ts';");

    assert.deepEqual(eager, []);
    // They are in the file all the same: the count above is not zero for want of a library.
    assert.ok(inBundle > 300, `only ${inBundle} files of the libraries are in the bundle`);
  });

  // The control: one static import, anywhere, and the image runs better-auth at every boot.
  it('finds better-auth at boot the moment a file imports it statically', async () => {
    const { eager } = await bundled(
      "import './src/main.ts'; import { betterAuth } from 'better-auth'; void betterAuth;",
    );

    assert.ok(eager.length > 100, `a static import of better-auth made only ${eager.length} files eager`);
  });
});

/** Routes that better-auth has with the options of the worker. None of them is served. */
/** Routes of better-auth, each with whether the worker serves it (FRU-147): see `SERVED_PATHS`. */
const AUTH_ROUTES: readonly (readonly [method: string, path: string, served: boolean])[] = [
  ['GET', '/ok', true],
  ['GET', '/error', true],
  ['GET', '/get-session', false],
  ['POST', '/sign-out', true],
  ['POST', '/sign-in/social', true],
  ['GET', '/list-sessions', false],
  ['POST', '/sign-in/magic-link', false],
  ['GET', '/magic-link/verify', false],
  ['POST', '/update-user', false],
  ['GET', '/organization/list', false],
  ['POST', '/organization/create', false],
  // An open route of the plugin is not here: `auth-organization.test.ts` holds each one to its rule.
  ['GET', '/organization/get-full-organization', false],
  ['GET', '/organization/get-invitation', false],
];

describe('the routes of better-auth that the worker serves (FRU-144, FRU-147)', () => {
  let ip = 0;
  const through = (
    env: WorkerEnv,
    method: string,
    path: string,
    database?: Database,
    auth?: Auth,
  ): Promise<Response> => {
    ip += 1;

    return handleRequest(
      new Request(`https://worker.test${AUTH_BASE_PATH}${path}`, {
        method,
        headers: { Origin: CONSOLE_URL, 'Content-Type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      }),
      env,
      {
        clientIp: `192.0.2.${ip}`,
        kv,
        ...(database === undefined ? {} : { accounts: createPostgresAccountStore(database) }),
        ...(auth === undefined ? {} : { auth }),
      },
    );
  };

  it('answers 404 on every route of better-auth when it is off, with or without a database', async () => {
    const database = await opening(createPgliteDatabase);
    const workers: [label: string, env: WorkerEnv, database?: Database][] = [
      // The worker of before (FRU-225): every process has better-auth on since.
      ['no accounts', beforePostgres({ FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: CONSOLE_URL })],
      [
        'a database, and no secret of better-auth',
        beforePostgres(envWith({ FRUITBACK_AUTH_SECRET: undefined })),
        database,
      ],
    ];

    for (const [label, env, accounts] of workers) {
      assert.ok(readConfig(env).ok, label);
      for (const [method, path] of AUTH_ROUTES) {
        const answer = await through(env, method, path, accounts);

        assert.equal(answer.status, 404, `${label}: ${method} ${AUTH_BASE_PATH}${path}`);
        assert.deepEqual(await answer.json(), { error: 'not-found' });
        assert.equal(answer.headers.get('Set-Cookie'), null);
      }
    }
  });

  // FRU-217: what the sign-in screen of the console reads to say that nobody can sign in.
  it('answers no way to sign in on /auth/providers, and 401 on the console, with a database and no secret', async () => {
    const database = await opening(createPgliteDatabase);
    // The worker of before (FRU-225): every process has the secret since.
    const env = beforePostgres(envWith({ FRUITBACK_AUTH_SECRET: undefined }));
    const ask = (path: string): Promise<Response> =>
      handleRequest(new Request(`https://worker.test${path}`, { headers: { Origin: CONSOLE_URL } }), env, {
        clientIp: '192.0.2.210',
        kv,
        accounts: createPostgresAccountStore(database),
      });

    const providers = await ask('/auth/providers');
    assert.equal(providers.status, 200);
    assert.deepEqual(await providers.json(), {});
    assert.equal((await ask('/console/me')).status, 401);
  });

  it('serves the routes of SERVED_PATHS when it is on, and answers 404 on any other one', async () => {
    const database = await opening(createPgliteDatabase);
    const { options } = await optionsOn(database);
    const auth = await startAuth(options);

    for (const [method, path, served] of AUTH_ROUTES) {
      const answer = await through(envWith(), method, path, database, auth);

      assert.equal(Object.hasOwn(SERVED_PATHS, path), served, `${path}: SERVED_PATHS and this list differ`);
      if (served) {
        assert.notEqual(answer.status, 404, `${method} ${path}`);
        // better-auth sets no header of CORS: the worker adds the ones of the console.
        assert.equal(answer.headers.get('Access-Control-Allow-Origin'), CONSOLE_URL, path);
      } else {
        assert.equal(answer.status, 404, `${method} ${path}`);
        assert.deepEqual(await answer.json(), { error: 'not-found' });
      }
    }
  });

  // The control: these are routes of better-auth, so the 404 above is the worker that does not
  // serve them, and not a list of paths that nothing ever had. The two of the link are closed to a
  // request by better-auth itself, and open to `auth.api`: see `auth-routes.test.ts`.
  it('names routes that better-auth itself answers, so a 404 of the worker says something', async () => {
    const { options } = await optionsOn(await opening(createPgliteDatabase));
    const auth = await startAuth({ ...options, disabledPaths: [] });

    for (const [method, path] of AUTH_ROUTES) {
      const answer = await ask(auth, path, { method, ...(method === 'POST' ? { body: '{}' } : {}) });

      assert.notEqual(answer.status, 404, `better-auth has no ${method} ${path}: take it out of AUTH_ROUTES`);
    }
    assert.equal((await ask(auth, '/a-path-nothing-has')).status, 404);
  });

  it('answers 502, and says why in its log, when better-auth rejects', async () => {
    const database = await opening(createPgliteDatabase);
    const rejecting = {
      handler: async () => Promise.reject(new Error('SCHEMA_MISMATCH of a test')),
    } as unknown as Auth;
    const errors: string[] = [];
    const logged = mock.method(console, 'error', (line: string) => void errors.push(line));
    try {
      const answer = await through(envWith(), 'GET', '/ok', database, rejecting);

      assert.equal(answer.status, 502);
      assert.deepEqual(await answer.json(), { error: 'auth-unavailable' });
    } finally {
      logged.mock.restore();
    }
    assert.deepEqual(errors, ['[fruitback] better-auth did not answer: SCHEMA_MISMATCH of a test']);
  });

  it('answers 502 to a call of the console with the cookie, when better-auth rejects its reading', async () => {
    const database = await opening(createPgliteDatabase);
    const rejecting = {
      api: { getSession: async () => Promise.reject(new Error('SCHEMA_MISMATCH of a test')) },
    } as unknown as Auth;
    const errors: string[] = [];
    const logged = mock.method(console, 'error', (line: string) => void errors.push(line));
    try {
      const answer = await handleRequest(
        new Request('https://worker.test/console/me', {
          headers: { Origin: CONSOLE_URL, Cookie: '__Secure-fruitback.session_token=a.b' },
        }),
        envWith(),
        { clientIp: '192.0.2.200', kv, accounts: createPostgresAccountStore(database), auth: rejecting },
      );

      assert.equal(answer.status, 502);
      assert.deepEqual(await answer.json(), { error: 'auth-unavailable' });
      assert.equal(answer.headers.get('Access-Control-Allow-Origin'), CONSOLE_URL);
    } finally {
      logged.mock.restore();
    }
    assert.deepEqual(errors, ['[fruitback] better-auth did not answer: SCHEMA_MISMATCH of a test']);
  });
});

describe('the options of better-auth, as they are written (FRU-144)', () => {
  it('writes each option that closes something, and reads none of them from the environment', async () => {
    const options = await authOptions(AUTH_CONFIG, {} as never, NO_SESSIONS);

    assert.equal(options.baseURL, PUBLIC_URL);
    assert.equal(options.basePath, '/console/auth');
    assert.equal(options.secret, AUTH_SECRET);
    assert.deepEqual(options.trustedOrigins, [CONSOLE_URL]);
    assert.deepEqual(options.telemetry, { enabled: false });
    assert.deepEqual(options.rateLimit, { enabled: false });
    assert.deepEqual(options.emailAndPassword, { enabled: false });
    assert.deepEqual(options.session, {
      cookieCache: { enabled: false },
      additionalFields: { browser: { type: 'string', required: false, input: false } },
      expiresIn: SESSION_TTL_SECONDS,
      updateAge: SESSION_RENEWAL_SECONDS,
      freshAge: SESSION_FRESH_SECONDS,
    });
    assert.deepEqual(options.advanced?.ipAddress, { disableIpTracking: true });
    assert.deepEqual(options.advanced?.cookies, {
      session_token: { attributes: { sameSite: 'strict', path: '/console' } },
      oauth_state: { attributes: { path: '/console/auth' } },
    });
    assert.deepEqual(options.socialProviders, {});
    assert.deepEqual(options.onAPIError, { errorURL: `${CONSOLE_URL}/setup` });
    // No provider is trusted, and the worker rules on unlinking (FRU-249): nothing else of linking is set.
    assert.deepEqual((options.account as { accountLinking?: unknown }).accountLinking, { allowUnlinkingAll: true });
    assert.deepEqual(options.disabledPaths?.slice(0, 7), [
      '/revoke-session',
      '/revoke-other-sessions',
      '/get-access-token',
      '/refresh-token',
      '/account-info',
      '/sign-in/magic-link',
      '/magic-link/verify',
    ]);
    // Then every route of the organization plugin that has no rule (FRU-149), read from the plugin.
    const closed = options.disabledPaths?.slice(7) ?? [];
    assert.ok(closed.length >= 12, `only ${closed.length} routes of the plugin are closed`);
    for (const path of closed) {
      assert.match(path, /^\/organization\//);
      assert.equal(Object.hasOwn(ORGANIZATION_PATHS, path), false, `${path} has a rule, and is closed`);
    }
    for (const path of ['/organization/create', '/organization/delete', '/organization/get-invitation']) {
      assert.ok(closed.includes(path), `${path} is open to a request`);
    }
  });

  it('reads the address of the caller from the header the worker writes, and only when it keeps addresses', async () => {
    const on = await authOptions({ ...AUTH_CONFIG, trackIp: true }, {} as never, NO_SESSIONS);

    assert.deepEqual(on.rateLimit, { enabled: true });
    assert.deepEqual(on.advanced?.ipAddress, { ipAddressHeaders: [CLIENT_IP_HEADER], disableIpTracking: false });
  });

  it('signs a person in with the second GitHub App and the Google client of before, and keeps no picture', async () => {
    const github = { clientId: 'gh-of-better-auth', clientSecret: 'a-secret-of-github' };
    const google = { clientId: 'the-google-client', clientSecret: 'a-secret-of-google' };
    const options = await authOptions({ ...AUTH_CONFIG, github, google }, {} as never, NO_SESSIONS);
    const providers = options.socialProviders as Record<string, Record<string, unknown>>;

    assert.deepEqual(Object.keys(providers), ['github', 'google']);
    assert.equal(providers.github?.clientId, 'gh-of-better-auth');
    assert.equal(providers.google?.clientId, 'the-google-client');
    const map = providers.github?.mapProfileToUser as () => Record<string, unknown>;
    assert.deepEqual(map(), { image: undefined });
  });

  it('takes the origin of the console and of the worker, and no path', async () => {
    const options = await authOptions(
      { ...AUTH_CONFIG, consoleUrl: 'https://app.fruitback.test/console', publicUrl: 'http://localhost:8788' },
      {} as never,
      NO_SESSIONS,
    );

    assert.deepEqual(options.trustedOrigins, ['https://app.fruitback.test']);
    assert.equal(options.baseURL, 'http://localhost:8788');
  });

  it('writes what better-auth says in the log of the worker, with no address of the database', async () => {
    const options = await authOptions(AUTH_CONFIG, {} as never, NO_SESSIONS);
    const lines: string[] = [];
    const [warn, error] = [console.warn, console.error];
    console.warn = (line: string) => void lines.push(`warn ${line}`);
    console.error = (line: string) => void lines.push(`error ${line}`);
    try {
      options.logger?.log?.('warn', `could not reach ${DATABASE_URL}`);
      options.logger?.log?.('error', 'the password was', DATABASE_PASSWORD);
    } finally {
      console.warn = warn;
      console.error = error;
    }

    assert.deepEqual(lines, [
      'warn [fruitback] better-auth warn: could not reach ***',
      'error [fruitback] better-auth error: the password was ***',
    ]);
    assert.equal(options.logger?.level, 'warn');
  });
});

describe('the plugins of better-auth (FRU-144)', () => {
  it('configures the organization plugin and the layer that keeps no secret at rest, and no other', async () => {
    const options = await authOptions(AUTH_CONFIG, {} as never, NO_SESSIONS);

    assert.deepEqual(
      options.plugins?.map((plugin) => plugin.id),
      [...AUTH_PLUGINS],
    );
    assert.deepEqual(refusedPlugins(options), []);
  });

  it('refuses to build better-auth with the bearer plugin, and says why', async () => {
    const { bearer } = await import('better-auth/plugins/bearer');
    const options = await authOptions(AUTH_CONFIG, {} as never, NO_SESSIONS);
    const planted = { ...options, plugins: [...(options.plugins ?? []), bearer()] };

    assert.equal(refusedPlugins(planted).length, 1);
    await assert.rejects(startAuth(planted), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /« bearer »/);
      assert.match(error.message, /in an `Authorization` header, which a script can send/);
      assert.match(error.message, /the token read in a copy of the `session` table opens that session alone/);

      return true;
    });
  });

  it('refuses to build better-auth without the layer that keeps no secret at rest, or with a secondary storage', async () => {
    const options = await authOptions(AUTH_CONFIG, {} as never, NO_SESSIONS);
    const store = {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      getAndDelete: async () => null,
      increment: async () => 1,
    };

    await assert.rejects(
      startAuth({ ...options, plugins: (options.plugins ?? []).filter((plugin) => plugin.id !== AT_REST_PLUGIN) }),
      /without the plugin « fruitback-at-rest »: without it, the database keeps the token of each session in the clear/,
    );
    await assert.rejects(startAuth({ ...options, secondaryStorage: store }), /secondary storage: it keeps each token/);
  });

  it('refuses each plugin the framing ruled out, by the id the plugin really has', async () => {
    const { bearer } = await import('better-auth/plugins/bearer');
    const { jwt } = await import('better-auth/plugins/jwt');
    const { deviceAuthorization } = await import('better-auth/plugins/device-authorization');
    const ids = [bearer().id, jwt().id, deviceAuthorization().id];

    // A plugin that changes its id in a later version would pass a list of the old names.
    assert.deepEqual(ids.toSorted(), Object.keys(REFUSED_PLUGINS).toSorted());
    for (const plugin of [bearer(), jwt(), deviceAuthorization()]) {
      assert.equal(refusedPlugins({ plugins: [plugin] }).length, 1, plugin.id);
    }
    for (const allowed of AUTH_PLUGINS) assert.equal(Object.hasOwn(REFUSED_PLUGINS, allowed), false);
  });
});

describe('the roles of a workspace, as better-auth reads them (FRU-144)', () => {
  type Authorize = { authorize(request: Record<string, string[]>): { success: boolean } };
  async function rolesOfThePlugin(): Promise<Record<string, Authorize>> {
    const options = await authOptions(AUTH_CONFIG, {} as never, NO_SESSIONS);
    const plugin = options.plugins?.find(({ id }) => id === 'organization') as
      | { options?: { roles?: Record<string, Authorize> } }
      | undefined;
    assert.ok(plugin?.options?.roles !== undefined, 'the organization plugin was given no role');

    return plugin.options.roles;
  }

  it('gives each role in better-auth what RIGHTS gives it, action for action', async () => {
    const roles = await rolesOfThePlugin();

    assert.deepEqual(Object.keys(roles), [...ROLES]);
    for (const role of ROLES) {
      for (const action of ACTIONS) {
        assert.equal(
          roles[role]?.authorize({ [FRUITBACK_RESOURCE]: [action] }).success,
          can(role, action),
          `${role} and ${action}`,
        );
      }
    }
    // The sentence of SECURITY.md, said once more on this side: a guest never sees the tracker.
    assert.equal(roles.guest?.authorize({ [FRUITBACK_RESOURCE]: ['see-tracker'] }).success, false);
    assert.equal(roles.guest?.authorize({ [FRUITBACK_RESOURCE]: ['read-feedback'] }).success, true);
    assert.equal(roles.member?.authorize({ [FRUITBACK_RESOURCE]: ['see-tracker'] }).success, true);
  });

  it('gives the permissions of the plugin from manage-members, manage-workspace and delete-workspace', async () => {
    const roles = await rolesOfThePlugin();
    const { defaultStatements } = await import('better-auth/plugins/organization/access');
    // Each permission the plugin declares, and the action of RIGHTS that gives it. No action gives
    // a permission on teams or on the roles made at run time.
    const givenBy: Record<string, (typeof ACTIONS)[number] | undefined> = {
      'organization.update': 'manage-workspace',
      'organization.delete': 'delete-workspace',
      'member.create': 'manage-members',
      'member.update': 'manage-members',
      'member.delete': 'manage-members',
      'invitation.create': 'manage-members',
      'invitation.cancel': 'manage-members',
    };
    const declared = Object.entries(defaultStatements).flatMap(([resource, actions]) =>
      actions.map((action) => `${resource}.${action}`),
    );
    assert.deepEqual(
      declared.filter((permission) => !/^(team|ac)\./.test(permission)).toSorted(),
      Object.keys(givenBy).toSorted(),
      'the plugin declares a permission that this test does not know',
    );

    for (const role of ROLES) {
      for (const permission of declared) {
        const [resource = '', action = ''] = permission.split('.');
        const from = givenBy[permission];

        assert.equal(
          roles[role]?.authorize({ [resource]: [action] }).success,
          from !== undefined && can(role, from),
          `${role} and ${permission}`,
        );
      }
    }
  });

  it('refuses an action of RIGHTS that has no line in the projection', () => {
    const planted = {
      roles: ROLES,
      actions: [...ACTIONS, 'export-notes'],
      can: (role: string, action: string) => action === 'export-notes' || can(role as never, action as never),
      implied: IMPLIED,
    };

    assert.throws(() => roleStatements(planted), /« export-notes » has no line in IMPLIED/);
    // The control: with its line, the same table is projected, and the action is given.
    const projected = roleStatements({ ...planted, implied: { ...IMPLIED, 'export-notes': {} } });
    assert.ok(projected.guest?.[FRUITBACK_RESOURCE]?.includes('export-notes'));
    assert.deepEqual(Object.keys(IMPLIED).toSorted(), [...ACTIONS].toSorted());
  });
});

describe('better-auth, built when the server starts (FRU-144)', () => {
  const listening = () => {
    const lines: string[] = [];

    return {
      lines,
      log: {
        log: (line: string) => void lines.push(`log ${line}`),
        error: (line: string) => void lines.push(`error ${line}`),
      },
    };
  };

  it('applies the migrations of the worker, builds one instance, and says that it is ready', async () => {
    const database = await opening(createPgliteDatabase);
    const config = configOf(envWith());
    const { lines, log } = listening();

    assert.equal(await announceAuth(config, log, () => database), 'ready');
    assert.deepEqual(lines, ['log [fruitback] better-auth is ready, under /console/auth']);
    assert.deepEqual(await appliedDates(database), journalDates());

    const first = authFor(config, () => database);
    assert.equal(
      authFor(config, () => database),
      first,
      'a second instance was built for one database',
    );
    const auth = await first;
    assert.equal((await ask(auth as never, '/ok')).status, 200);
  });

  it('says that better-auth did not start, with no address of the database, and keeps no failure', async () => {
    const config = configOf(envWith());
    const { lines, log } = listening();

    assert.equal(await announceAuth(config, log), 'failed');
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? '', /^error \[fruitback\] better-auth did not start: PostgreSQL did not answer/);
    // The driver names the host it could not reach. The password and the address are not there.
    assert.equal(lines.join('').includes(DATABASE_PASSWORD), false);
    assert.equal(lines.join('').includes('fruitback:'), false);

    // The database may answer the next time: the failure is not the instance of the process.
    const database = await opening(createPgliteDatabase);
    assert.equal(await announceAuth(config, log, () => database), 'ready');
  });

  it('says at boot that the schema is wrong, and not that better-auth is ready', async () => {
    const database = await opening(createPgliteDatabase);
    // A database that lost a table after its migrations: Drizzle finds each migration applied, and
    // changes nothing.
    await make(database, plantedAfterTheMigrations('DROP TABLE "verification"'));
    const { lines, log } = listening();

    assert.equal(await announceAuth(configOf(envWith()), log, () => database), 'failed');
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(
      lines[0] ?? '',
      /^error \[fruitback\] better-auth did not start: the schema of the database is not the one better-auth expects \(missing-table verification\)/,
    );
  });

  it('answers and never rejects, whatever fails while better-auth is built: the server does not wait for it', async () => {
    const { lines, log } = listening();
    const breaks = (): never => {
      throw new Error('the database of the process could not be made');
    };

    assert.equal(await announceAuth(configOf(envWith()), log, breaks), 'failed');
    assert.deepEqual(lines, [
      'error [fruitback] better-auth did not start: the database of the process could not be made',
    ]);
  });

  /**
   * `server.ts` opens a socket and has no test of its own, so the call is asserted on its source, as
   * the boot lines of `stores.test.ts` are: every case above stays green with the call deleted, and
   * better-auth is then built by nobody.
   */
  it('is built at boot by the file that has no test of its own', () => {
    const read = (file: string): string => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');

    assert.match(read('./server.ts'), /if \(config\.ok\) void announceAuth\(config\.config\);/);
  });
});

describe('the dependencies of the worker (FRU-144)', () => {
  const EXACT = /^\d+\.\d+\.\d+$/;

  it('pins better-auth and the driver of PostgreSQL to one exact version', () => {
    const workspace = readFileSync(fileURLToPath(new URL('../../../pnpm-workspace.yaml', import.meta.url)), 'utf8');
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
      dependencies: Record<string, string>;
    };

    for (const name of ['better-auth', 'pg']) {
      const pinned = new RegExp(`^  ${name}: (.+)$`, 'm').exec(workspace)?.[1];

      assert.equal(manifest.dependencies[name], 'catalog:', name);
      assert.match(pinned ?? '', EXACT, `${name} is not pinned to one version in the catalog`);
    }
    // The control: a range is not a version.
    for (const range of ['^1.7.7', '~1.7.7', '1.7', '1.x', '>=1.7.7', 'latest']) assert.doesNotMatch(range, EXACT);
  });
});
