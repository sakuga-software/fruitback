import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { ACTIONS, ROLES, can } from './accounts.ts';
import { createPostgresAccountStore } from './accounts-postgres.ts';
import { handleRequest } from './app.ts';
import {
  AUTH_BASE_PATH,
  AUTH_PLUGINS,
  REFUSED_PLUGINS,
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
  PUBLIC_URL,
  ask,
  databasesOfACase,
  migrationsWith,
  optionsOn,
  withPool,
  without,
} from './auth.fixture.ts';
import { FRUITBACK_RESOURCE, IMPLIED, roleStatements } from './auth-roles.ts';
import { type WorkerEnv, hasAuth, readConfig } from './env.ts';
import { type Database, closeDatabases, createPgDatabase, migrate } from './postgres.ts';
import { NO_REAL_POSTGRES, TEST_DATABASE_URL, createPgliteDatabase, schemaName } from './postgres.fixture.ts';
import { MIGRATIONS } from './postgres-migrations.ts';
import { closeSessionConnections } from './session-sqlite.ts';

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

/** A worker whose accounts and sessions are in files: what a worker with no database runs on. */
function filesOnly(overrides: Record<string, string | undefined> = {}): WorkerEnv {
  const directory = mkdtempSync(join(tmpdir(), 'fruitback-auth-'));
  directories.push(directory);

  return envWith({
    FRUITBACK_DATABASE_URL: undefined,
    FRUITBACK_ACCOUNTS_PATH: join(directory, 'accounts.db'),
    FRUITBACK_SESSION_PATH: join(directory, 'sessions.db'),
    ...overrides,
  });
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
  it('switches better-auth on with its secret and a database, and leaves it off without the secret', () => {
    const on = configOf(envWith());
    assert.equal(hasAuth(on), true);
    assert.deepEqual(authConfigOf(on), AUTH_CONFIG);

    const off = configOf(envWith({ FRUITBACK_AUTH_SECRET: undefined }));
    assert.equal(hasAuth(off), false);
    assert.equal(authConfigOf(off), undefined);
    // An empty value is an absent one, as for every variable of the compose file.
    assert.equal(hasAuth(configOf(envWith({ FRUITBACK_AUTH_SECRET: '' }))), false);
  });

  it('refuses a secret of better-auth under 32 characters, and names the variable', () => {
    assert.equal(refusal(envWith({ FRUITBACK_AUTH_SECRET: 'x'.repeat(31) })), 'FRUITBACK_AUTH_SECRET');
    assert.ok(readConfig(envWith({ FRUITBACK_AUTH_SECRET: 'x'.repeat(32) })).ok);
  });

  it('says in SECURITY.md the length under which the secret of better-auth is refused', () => {
    const security = readFileSync(fileURLToPath(new URL('../../../SECURITY.md', import.meta.url)), 'utf8');
    const section = /### better-auth, built and switched off \(FRU-144\)\n([\s\S]*?)\n### /.exec(security)?.[1] ?? '';
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

  it('refuses the secret of better-auth without a database: the accounts in a file have no better-auth', () => {
    for (const env of [envWith({ FRUITBACK_DATABASE_URL: undefined, FRUITBACK_CONSOLE_URL: undefined }), filesOnly()]) {
      assert.equal(
        refusal(env),
        'FRUITBACK_DATABASE_URL (FRUITBACK_AUTH_SECRET is set, and better-auth keeps its tables there)',
      );
    }
  });

  it('refuses the secret of better-auth without the address of the worker, or with a path in it', () => {
    const needed =
      'FRUITBACK_PUBLIC_URL (FRUITBACK_AUTH_SECRET is set, and better-auth needs the address of this worker, with no path)';

    assert.equal(refusal(envWith({ FRUITBACK_PUBLIC_URL: undefined })), needed);
    assert.equal(refusal(envWith({ FRUITBACK_PUBLIC_URL: `${PUBLIC_URL}/worker` })), needed);
    assert.ok(readConfig(envWith({ FRUITBACK_PUBLIC_URL: `${PUBLIC_URL}/` })).ok);
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
    // An empty value is an absent one. And a worker that has better-auth off reads none of them.
    assert.ok(readConfig(envWith({ BETTER_AUTH_TELEMETRY: '' })).ok);
    assert.ok(readConfig(envWith({ FRUITBACK_AUTH_SECRET: undefined, BETTER_AUTH_TELEMETRY: '1' })).ok);
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
      { FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: CONSOLE_URL },
      filesOnly({ FRUITBACK_AUTH_SECRET: undefined }),
      envWith({ FRUITBACK_AUTH_SECRET: undefined }),
    ]) {
      const config = configOf(env);

      assert.equal(authFor(config, refuses), undefined);
      assert.equal(await announceAuth(config, log, refuses), 'off');
    }
    assert.deepEqual(lines, [], 'a worker with better-auth off said something of it at boot');
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
    if (process.env.BUILD_OPTIONS === '1') await authOptions(JSON.parse(process.env.AUTH_CONFIG), {});
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

  it('loads no file of better-auth for a worker that has it off, and answers 404 under /console/auth', async () => {
    const memory = await worker({ FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: CONSOLE_URL });

    assert.deepEqual(
      { ...memory, modules: 0 },
      { statuses: [200, 404, 404], announced: 'off', library: 0, modules: 0 },
    );
    assert.ok(memory.modules > 50, 'the hook saw almost no module, so a count of zero proves nothing');
  });

  // The control of the test above: the same count is not zero the moment the options are built.
  it('loads better-auth when its options are built, which the count of the test above must see', async () => {
    const built = await worker({ FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: CONSOLE_URL }, { BUILD_OPTIONS: '1' });

    assert.equal(built.announced, 'off');
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

  it('builds better-auth at boot on a real server, and still answers 404', { skip: NO_REAL_POSTGRES }, async () => {
    const schema = schemaName();
    const admin = createPgDatabase(TEST_DATABASE_URL as string, { max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    // The address of a worker has no schema: the tests put one in the options of the connection.
    const address = new URL(TEST_DATABASE_URL as string);
    address.searchParams.set('options', `-c search_path=${schema}`);

    try {
      const on = await worker(envWith({ FRUITBACK_DATABASE_URL: address.href }));

      assert.deepEqual(on.statuses, [200, 404, 404]);
      assert.equal(on.announced, 'ready');
      assert.ok(on.library > 0);
      const inSchema = createPgDatabase(TEST_DATABASE_URL as string, { schema, max: 1 });
      assert.deepEqual(
        (await inSchema.query('SELECT name FROM schema_migrations ORDER BY version')).rows.map((row) => row.name),
        MIGRATIONS.map((migration) => migration.name),
      );
      await inSchema.close();
    } finally {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.close();
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
const AUTH_ROUTES: readonly (readonly [method: string, path: string])[] = [
  ['GET', '/ok'],
  ['GET', '/error'],
  ['GET', '/get-session'],
  ['GET', '/list-sessions'],
  ['POST', '/sign-out'],
  ['POST', '/sign-in/social'],
  ['GET', '/organization/list'],
  ['POST', '/organization/create'],
  ['GET', '/organization/list-members'],
];

describe('the routes of better-auth, which the worker does not serve (FRU-144)', () => {
  let ip = 0;
  const through = (env: WorkerEnv, method: string, path: string, database?: Database): Promise<Response> => {
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
        ...(database === undefined ? {} : { accounts: createPostgresAccountStore(database) }),
      },
    );
  };

  it('answers 404 on every route of better-auth, with or without a database, with or without its secret', async () => {
    const database = await opening(createPgliteDatabase);
    const workers: [label: string, env: WorkerEnv, database?: Database][] = [
      ['no accounts', { FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: CONSOLE_URL }],
      ['a database, and no secret of better-auth', envWith({ FRUITBACK_AUTH_SECRET: undefined }), database],
      ['a database and the secret of better-auth', envWith(), database],
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

  // The control: these are routes of better-auth, so the 404 above is the worker that does not
  // serve them, and not a list of paths that nothing ever had.
  it('names routes that better-auth itself answers, so a 404 of the worker says something', async () => {
    const { options } = await optionsOn(await opening(createPgliteDatabase));
    const auth = await startAuth(options);

    for (const [method, path] of AUTH_ROUTES) {
      const answer = await ask(auth, path, { method, ...(method === 'POST' ? { body: '{}' } : {}) });

      assert.notEqual(answer.status, 404, `better-auth has no ${method} ${path}: take it out of AUTH_ROUTES`);
    }
    assert.equal((await ask(auth, '/a-path-nothing-has')).status, 404);
  });
});

describe('the options of better-auth, as they are written (FRU-144)', () => {
  it('writes each option that closes something, and reads none of them from the environment', async () => {
    const options = await authOptions(AUTH_CONFIG, {} as never);

    assert.equal(options.baseURL, PUBLIC_URL);
    assert.equal(options.basePath, '/console/auth');
    assert.equal(options.secret, AUTH_SECRET);
    assert.deepEqual(options.trustedOrigins, [CONSOLE_URL]);
    assert.deepEqual(options.telemetry, { enabled: false });
    assert.deepEqual(options.rateLimit, { enabled: false });
    assert.deepEqual(options.emailAndPassword, { enabled: false });
    assert.deepEqual(options.session, { cookieCache: { enabled: false } });
    assert.deepEqual(options.advanced?.ipAddress, { disableIpTracking: true });
    assert.deepEqual(options.advanced?.cookies, {
      session_token: { attributes: { sameSite: 'strict', path: '/console' } },
    });
    assert.equal(options.socialProviders, undefined);
  });

  it('takes the origin of the console and of the worker, and no path', async () => {
    const options = await authOptions(
      { ...AUTH_CONFIG, consoleUrl: 'https://app.fruitback.test/console', publicUrl: 'http://localhost:8788' },
      {} as never,
    );

    assert.deepEqual(options.trustedOrigins, ['https://app.fruitback.test']);
    assert.equal(options.baseURL, 'http://localhost:8788');
  });

  it('writes what better-auth says in the log of the worker, with no address of the database', async () => {
    const options = await authOptions(AUTH_CONFIG, {} as never);
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
  it('configures the organization plugin and no other', async () => {
    const options = await authOptions(AUTH_CONFIG, {} as never);

    assert.deepEqual(
      options.plugins?.map((plugin) => plugin.id),
      [...AUTH_PLUGINS],
    );
    assert.deepEqual(refusedPlugins(options), []);
  });

  it('refuses to build better-auth with the bearer plugin, and says why', async () => {
    const { bearer } = await import('better-auth/plugins/bearer');
    const options = await authOptions(AUTH_CONFIG, {} as never);
    const planted = { ...options, plugins: [...(options.plugins ?? []), bearer()] };

    assert.equal(refusedPlugins(planted).length, 1);
    await assert.rejects(startAuth(planted), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /« bearer »/);
      assert.match(error.message, /the token of a session as it is read in the `session` table opens that session/);
      assert.match(error.message, /a copy of the database is a set of working logins/);

      return true;
    });
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
    const options = await authOptions(AUTH_CONFIG, {} as never);
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

  it('applies the migrations of the worker, builds one instance, and says that it serves no route', async () => {
    const database = withPool(await opening(createPgliteDatabase));
    const config = configOf(envWith());
    const { lines, log } = listening();

    assert.equal(await announceAuth(config, log, () => database), 'ready');
    assert.deepEqual(lines, ['log [fruitback] better-auth is ready, and serves no route']);
    assert.deepEqual(
      (await database.query('SELECT name FROM schema_migrations ORDER BY version')).rows.map((row) => row.name),
      MIGRATIONS.map((migration) => migration.name),
    );

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
    const database = withPool(await opening(createPgliteDatabase));
    assert.equal(await announceAuth(config, log, () => database), 'ready');
  });

  it('says at boot that the schema is wrong, and not that better-auth is ready', async () => {
    const database = withPool(await opening(createPgliteDatabase));
    // A database whose migration of better-auth lost a table: the list of the worker finds each
    // step applied, by its name, and changes nothing.
    await migrate(
      database,
      migrationsWith((sql) =>
        without(sql, 'CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");').replace(
          /CREATE TABLE "verification" \([\s\S]*?\);/,
          '',
        ),
      ),
    );
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
  it('is built at boot by the file that has no test of its own, and by no route', () => {
    const read = (file: string): string => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');

    assert.match(read('./server.ts'), /if \(config\.ok\) void announceAuth\(config\.config\);/);
    for (const file of ['./app.ts', './console-routes.ts', './console-api.ts']) {
      assert.equal(
        /from '\.\/auth\.ts'/.test(read(file)),
        false,
        `${file} reaches better-auth: a route would serve it`,
      );
    }
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
