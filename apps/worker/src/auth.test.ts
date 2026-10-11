import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { getMigrations } from 'better-auth/db/migration';
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
  authId,
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
  migrationsWith,
  optionsOn,
  signUp,
  withPool,
  withTestSignUp,
} from './auth.fixture.ts';
import { FRUITBACK_RESOURCE, IMPLIED, roleStatements } from './auth-roles.ts';
import { type WorkerEnv, hasAuth, readConfig } from './env.ts';
import { type Database, type Migration, closeDatabases, createPgDatabase, migrate } from './postgres.ts';
import {
  NO_REAL_POSTGRES,
  TEST_DATABASE_URL,
  createPgliteDatabase,
  createRealDatabase,
  schemaName,
} from './postgres.fixture.ts';
import { MIGRATIONS } from './postgres-migrations.ts';
import { closeSessionConnections } from './session-sqlite.ts';

/**
 * better-auth, built and switched off (FRU-144). No route of it is served: what is tested here is
 * its configuration, its schema, and that a worker which has it off loads nothing and answers `404`.
 *
 * A rule that says « never » has its control beside it: the same thing, planted, must fail.
 */

const run = promisify(execFile);
const IDENTITY_SECRET = 'a-worker-secret-of-exactly-enough';
const SECRETS_KEY = 'a-key-that-seals-the-connectors-0123';

const directories: string[] = [];
const opened: Database[] = [];

/** A worker with its accounts in PostgreSQL and better-auth on, unless `overrides` says otherwise. */
function envWith(overrides: Record<string, string | undefined> = {}): WorkerEnv {
  const directory = mkdtempSync(join(tmpdir(), 'fruitback-auth-'));
  directories.push(directory);

  return {
    FRUITBACK_STORE: 'memory',
    ALLOWED_ORIGINS: CONSOLE_URL,
    FRUITBACK_IDENTITY_SECRET: IDENTITY_SECRET,
    FRUITBACK_SESSION_PATH: join(directory, 'sessions.db'),
    FRUITBACK_DATABASE_URL: DATABASE_URL,
    FRUITBACK_CONSOLE_URL: CONSOLE_URL,
    FRUITBACK_PUBLIC_URL: PUBLIC_URL,
    FRUITBACK_AUTH_SECRET: AUTH_SECRET,
    ...overrides,
  };
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

async function opening(open: () => Promise<Database>): Promise<Database> {
  const database = await open();
  opened.push(database);

  return database;
}

afterEach(async () => {
  closeSessionConnections();
  for (const database of opened.splice(0)) await database.close();
  await closeDatabases();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** The databases a case runs on. PGlite has one connection; the CI job « postgres » has a server. */
const DATABASES = [
  { label: 'PGlite', open: createPgliteDatabase, skip: false as string | false },
  { label: 'a real server', open: createRealDatabase, skip: NO_REAL_POSTGRES },
];

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
    const directory = mkdtempSync(join(tmpdir(), 'fruitback-auth-'));
    directories.push(directory);

    for (const env of [
      envWith({ FRUITBACK_DATABASE_URL: undefined, FRUITBACK_CONSOLE_URL: undefined }),
      envWith({ FRUITBACK_DATABASE_URL: undefined, FRUITBACK_ACCOUNTS_PATH: join(directory, 'accounts.db') }),
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
    const directory = mkdtempSync(join(tmpdir(), 'fruitback-auth-'));
    directories.push(directory);
    const lines: string[] = [];
    const log = { log: (line: string) => void lines.push(line), error: (line: string) => void lines.push(line) };
    const refuses = (): never => assert.fail('a worker with better-auth off asked for a database');

    for (const env of [
      { FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: CONSOLE_URL },
      envWith({
        FRUITBACK_DATABASE_URL: undefined,
        FRUITBACK_AUTH_SECRET: undefined,
        FRUITBACK_ACCOUNTS_PATH: join(directory, 'accounts.db'),
      }),
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

/** What better-auth would do to the database to make it the one its options ask for. */
async function plan(
  database: Database,
  migrations: readonly Migration[] = MIGRATIONS,
  change: (options: Awaited<ReturnType<typeof authOptions>>) => Awaited<ReturnType<typeof authOptions>> = (same) =>
    same,
) {
  const { options, said } = await optionsOn(database, migrations);
  const found = await getMigrations(change(options), { throwOnUnsafe: false });

  return {
    create: found.toBeCreated.map((table) => table.table),
    add: found.toBeAdded.flatMap((table) => Object.keys(table.fields).map((field) => `${table.table}.${field}`)),
    indexes: found.toBeAddedIndexes.map((index) => index.name),
    unsafe: found.unsafeChanges,
    problems: found.schemaProblems,
    // A column of another type, and a required column that takes a null, are only said in the log.
    said: said.filter(({ level }) => level === 'warn' || level === 'error').map(({ message }) => message),
  };
}

const NOTHING = { create: [], add: [], indexes: [], unsafe: [], problems: [], said: [] };

/** `sql` with `text` taken out. It must be there once: a control that changes nothing proves nothing. */
function without(sql: string, text: string, replacement = ''): string {
  assert.equal(sql.split(text).length - 1, 1, `the migration of better-auth must hold this text once: ${text}`);

  return sql.replace(text, replacement);
}

/** The tables in the current schema with their columns, constraints and indexes, by name. */
async function shapeOf(database: Database, only?: readonly string[]) {
  const schema = String((await database.query('SELECT current_schema() AS name')).rows[0]?.name);
  const plain = (value: unknown): string => String(value).replaceAll(`${schema}.`, '');
  const kept = (table: unknown): boolean => only === undefined || only.includes(String(table));

  const columns = await database.query(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, column_name`,
    [schema],
  );
  const constraints = await database.query(
    `SELECT t.relname AS table_name, c.conname AS name, pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = $1 ORDER BY t.relname, c.conname`,
    [schema],
  );
  const indexes = await database.query(
    'SELECT tablename AS table_name, indexname AS name, indexdef AS definition FROM pg_indexes WHERE schemaname = $1 ORDER BY tablename, indexname',
    [schema],
  );

  return {
    tables: [...new Set(columns.rows.map((row) => String(row.table_name)))].filter(kept),
    columns: columns.rows
      .filter((row) => kept(row.table_name))
      .map(
        (row) =>
          `${row.table_name}.${row.column_name} ${row.data_type} null:${row.is_nullable} default:${plain(row.column_default)}`,
      ),
    constraints: constraints.rows
      .filter((row) => kept(row.table_name))
      .map((row) => `${row.table_name} ${row.name}: ${plain(row.definition)}`),
    indexes: indexes.rows.filter((row) => kept(row.table_name)).map((row) => `${row.name}: ${plain(row.definition)}`),
  };
}

/** The one thing the migration of the worker has that the DDL of better-auth does not. */
const ADDED = 'member member_organizationId_userId_key: UNIQUE ("organizationId", "userId")';
const ADDED_INDEX =
  'member_organizationId_userId_key: CREATE UNIQUE INDEX "member_organizationId_userId_key" ON member USING btree ("organizationId", "userId")';

/**
 * How the tables that `migrations` make differ from the ones better-auth makes on an empty database
 * by its own migration: `-` is what better-auth has and the worker has not, `+` the reverse.
 *
 * `runMigrations` of better-auth never runs on a database of the worker. Here it makes the database
 * that the hand-written migration is compared with.
 */
async function drift(open: () => Promise<Database>, migrations: readonly Migration[]): Promise<string[]> {
  const theirs = await opening(open);
  const { options } = await optionsOn(theirs, []);
  await (await getMigrations(options)).runMigrations();
  const expected = await shapeOf(theirs);
  // One PGlite is one connection, and the schema of a case is its search path: one case at a time.
  await theirs.close();
  opened.splice(opened.indexOf(theirs), 1);

  const ours = await opening(open);
  await optionsOn(ours, migrations);
  const made = await shapeOf(ours, expected.tables);

  assert.deepEqual(expected.tables.toSorted(), [
    'account',
    'invitation',
    'member',
    'organization',
    'session',
    'user',
    'verification',
  ]);

  return (['columns', 'constraints', 'indexes'] as const).flatMap((kind) => {
    const word = { columns: 'column', constraints: 'constraint', indexes: 'index' }[kind];
    const all = [...new Set([...expected[kind], ...made[kind]])].toSorted();

    return all.flatMap((line) => {
      if (expected[kind].includes(line) === made[kind].includes(line)) return [];

      return [`${expected[kind].includes(line) ? '-' : '+'} ${word} ${line}`];
    });
  });
}

for (const { label, open, skip } of DATABASES) {
  describe(`the schema of better-auth, as one migration of the worker, on ${label} (FRU-144)`, { skip }, () => {
    it('leaves better-auth nothing to create and nothing to add after the migrations of the worker', async () => {
      assert.deepEqual(await plan(await opening(open)), NOTHING);
    });

    // The controls: each thing the test above says is there is taken out, and must be reported.
    it('reports a column that the migration lost', async () => {
      const lost = migrationsWith((sql) =>
        without(without(sql, ',\n      "activeOrganizationId" text'), '      "image" text,\n'),
      );

      assert.deepEqual(await plan(await opening(open), lost), {
        ...NOTHING,
        add: ['user.image', 'session.activeOrganizationId'],
      });
    });

    it('reports a table that the migration lost', async () => {
      const lost = migrationsWith((sql) => {
        const table = sql.slice(
          sql.indexOf('CREATE TABLE "invitation"'),
          sql.indexOf('CREATE INDEX "session_userId_idx"'),
        );

        return [
          table,
          'CREATE INDEX "invitation_organizationId_idx" ON "invitation" ("organizationId");',
          'CREATE INDEX "invitation_email_idx" ON "invitation" ("email");',
        ].reduce((left, text) => without(left, text), sql);
      });

      assert.deepEqual(await plan(await opening(open), lost), { ...NOTHING, create: ['invitation'] });
    });

    it('says in its log a column of another type, and a required column that takes a null', async () => {
      const drifted = migrationsWith((sql) =>
        without(
          without(sql, '"emailVerified" boolean NOT NULL', '"emailVerified" text NOT NULL'),
          '"slug" text NOT NULL UNIQUE',
          '"slug" text UNIQUE',
        ),
      );
      const found = await plan(await opening(open), drifted);

      assert.deepEqual({ ...found, said: [] }, NOTHING);
      assert.equal(found.said.length, 2, found.said.join('\n'));
      assert.match(found.said.join('\n'), /emailVerified.*different type/);
      assert.match(found.said.join('\n'), /"slug".*stays nullable/);
    });

    it('reports a required column that better-auth never fills', async () => {
      const more = migrationsWith((sql) =>
        without(sql, '      "image" text,\n', '      "image" text,\n      "plan" text NOT NULL,\n'),
      );
      const found = await plan(await opening(open), more);

      assert.deepEqual({ ...found, problems: [] }, NOTHING);
      assert.match(found.problems.join('\n'), /plan/);
    });

    it('reports the tables of a plugin that no migration makes', async () => {
      const { organization } = await import('better-auth/plugins/organization');
      const found = await plan(await opening(open), MIGRATIONS, (options) => ({
        ...options,
        plugins: [organization({ teams: { enabled: true } })],
      }));

      assert.deepEqual(found.create, ['team', 'teamMember']);
      assert.deepEqual(found.add, ['session.activeTeamId', 'invitation.teamId']);
    });

    it('makes the tables that the migration of better-auth itself makes, and one constraint more', async () => {
      assert.deepEqual(await drift(open, MIGRATIONS), [`+ constraint ${ADDED}`, `+ index ${ADDED_INDEX}`]);
    });

    // The controls of the test above. better-auth reports none of these three (measured): it reads
    // the names of the tables and of the columns, and an index of one column only when it makes the
    // table. So the comparison with its own migration is what holds them.
    it('finds an index, a cascade and a unique constraint that the migration lost', async () => {
      const lost = migrationsWith((sql) =>
        [
          ['CREATE INDEX "member_userId_idx" ON "member" ("userId");', ''],
          [
            '"inviterId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE',
            '"inviterId" text NOT NULL REFERENCES "user" ("id")',
          ],
          ['"token" text NOT NULL UNIQUE', '"token" text NOT NULL'],
        ].reduce((left, [text = '', replacement = '']) => without(left, text, replacement), sql),
      );

      assert.deepEqual(
        await plan(await opening(open), lost),
        NOTHING,
        'better-auth now reports one of these: say so in worker.md',
      );
      assert.deepEqual(await drift(open, lost), [
        '+ constraint invitation invitation_inviterId_fkey: FOREIGN KEY ("inviterId") REFERENCES "user"(id)',
        '- constraint invitation invitation_inviterId_fkey: FOREIGN KEY ("inviterId") REFERENCES "user"(id) ON DELETE CASCADE',
        `+ constraint ${ADDED}`,
        '- constraint session session_token_key: UNIQUE (token)',
        `+ index ${ADDED_INDEX}`,
        '- index member_userId_idx: CREATE INDEX "member_userId_idx" ON member USING btree ("userId")',
        '- index session_token_key: CREATE UNIQUE INDEX session_token_key ON session USING btree (token)',
      ]);
    });

    // better-auth builds its context on a schema that is wrong, and rejects the first request
    // (measured). `startAuth` asks for that request before it says « ready ».
    it('refuses to call better-auth ready on a schema that lost a column, and names the column', async () => {
      const lost = migrationsWith((sql) => without(sql, ',\n      "activeOrganizationId" text'));
      const { options } = await optionsOn(await opening(open), lost);

      await assert.rejects(startAuth(options), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /not the one better-auth expects \(missing-column session\.activeOrganizationId\)/);
        assert.match(error.message, /never run `auth migrate` on this database/);
        // The advice of better-auth itself, which is the second migration tool the worker must not have.
        assert.doesNotMatch(error.message, /npx auth migrate/);

        return true;
      });
    });

    it('refuses a second row for one person in one workspace', async () => {
      const database = await opening(open);
      await optionsOn(database);
      await database.query(
        `INSERT INTO "user" ("id", "name", "email", "emailVerified") VALUES ('acc_1', 'Alice', 'alice@acme.dev', true);
         INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES ('ws_1', 'Acme', 'acme', now());
         INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt") VALUES ('mem_1', 'ws_1', 'acc_1', 'guest', now());`,
      );

      const second = await database
        .query(
          'INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt") VALUES ($1, $2, $3, $4, now())',
          ['mem_2', 'ws_1', 'acc_1', 'admin'],
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      assert.equal((second as { code?: string } | undefined)?.code, '23505', 'one person has two rows, so two roles');
    });

    it('gives every table of better-auth an id of the worker, and keeps acc_ and ws_', async () => {
      const { create: tables } = await plan(await opening(open), []);

      assert.equal(tables.length, 7);
      for (const table of tables) assert.match(authId(table), /^[a-z]{2,3}_[0-9a-f]{20}$/, table);
      assert.match(authId('user'), /^acc_/);
      assert.match(authId('organization'), /^ws_/);
      // The control: a table that has no prefix is refused, and is not given a default one.
      assert.throws(() => authId('team'), /« team ».*no prefix/);
    });
  });

  describe(`the options of better-auth, measured on an instance, on ${label} (FRU-144)`, { skip }, () => {
    it('opens no session with the token read in the session table, and opens one with the bearer plugin', async () => {
      const database = await opening(open);
      const { options } = await optionsOn(database);
      const auth = await startAuth(withTestSignUp(options));
      const { cookie } = await signUp(auth, 'alice@acme.dev');
      const token = String((await database.query('SELECT "token" FROM "session"')).rows[0]?.token);
      const name = cookie.split('=')[0];
      const sessionOf = async (instance: typeof auth, headers: Record<string, string>): Promise<unknown> =>
        ((await (await ask(instance, '/get-session', { headers })).json()) as { session?: unknown } | null)?.session;

      assert.ok(token.length >= 32, 'no token was read in the table, so nothing below is tested');
      assert.equal(await sessionOf(auth, { Authorization: `Bearer ${token}` }), undefined);
      assert.equal(await sessionOf(auth, { Cookie: `${name}=${token}` }), undefined, 'a cookie that is not signed');
      // The control: the cookie the worker signed opens the session.
      assert.ok(await sessionOf(auth, { Cookie: cookie }));

      // The reason `bearer` is refused, kept measured. Built past `startAuth`, which refuses it.
      const { betterAuth } = await import('better-auth');
      const { bearer } = await import('better-auth/plugins/bearer');
      const withBearer = betterAuth({ ...withTestSignUp(options), plugins: [...(options.plugins ?? []), bearer()] });

      assert.ok(
        await sessionOf(withBearer as unknown as typeof auth, { Authorization: `Bearer ${token}` }),
        'the bearer plugin no longer opens a session with the token of the table: read REFUSED_PLUGINS again',
      );
    });

    it('sets the cookie of a session for the routes of the console only, where no script reads it', async () => {
      const database = await opening(open);
      const { options } = await optionsOn(database);
      const { setCookie } = await signUp(await startAuth(withTestSignUp(options)), 'alice@acme.dev');

      assert.equal(setCookie.length, 1, setCookie.join('\n'));
      const [pair, ...attributes] = (setCookie[0] ?? '').split('; ');
      assert.match(pair ?? '', /^__Secure-fruitback\.session_token=/);
      assert.deepEqual(attributes.filter((attribute) => !attribute.startsWith('Max-Age=')).toSorted(), [
        'HttpOnly',
        'Path=/console',
        'SameSite=Strict',
        'Secure',
      ]);
      // The ids of the worker, on the rows that better-auth wrote.
      assert.match(String((await database.query('SELECT "id" FROM "user"')).rows[0]?.id), /^acc_[0-9a-f]{20}$/);
      assert.match(String((await database.query('SELECT "id" FROM "session"')).rows[0]?.id), /^ses_[0-9a-f]{20}$/);
    });

    it('refuses a request that has the cookie and comes from another origin, or from none', async () => {
      const { options } = await optionsOn(await opening(open));
      const auth = await startAuth(withTestSignUp(options));
      const { cookie } = await signUp(auth, 'alice@acme.dev');
      const signOut = (headers: Record<string, string>): Promise<Response> =>
        auth.handler(
          new Request(`${PUBLIC_URL}${AUTH_BASE_PATH}/sign-out`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers },
            body: '{}',
          }),
        );

      // `demo.fruitback.com` is the same site as the worker: the cookie is sent from there.
      assert.equal((await signOut({ Origin: 'https://demo.fruitback.test' })).status, 403);
      assert.equal((await signOut({})).status, 403);
      // The control: the console itself is answered.
      assert.equal((await signOut({ Origin: CONSOLE_URL })).status, 200);
    });

    it('keeps no address of the caller, whatever X-Forwarded-For says', async () => {
      const database = await opening(open);
      const { options } = await optionsOn(database);
      await signUp(await startAuth(withTestSignUp(options)), 'alice@acme.dev', { 'X-Forwarded-For': '203.0.113.7' });

      assert.deepEqual((await database.query('SELECT "ipAddress" FROM "session"')).rows, [{ ipAddress: '' }]);
    });

    // Why the worker does not let better-auth read the address: measured, with the tracking on.
    it('takes a lone X-Forwarded-For as the caller wrote it, and refuses a chain, when it tracks addresses', async () => {
      const database = await opening(open);
      const { options } = await optionsOn(database);
      const tracking = await startAuth(
        withTestSignUp({ ...options, advanced: { ...options.advanced, ipAddress: { disableIpTracking: false } } }),
      );
      await signUp(tracking, 'lone@acme.dev', { 'X-Forwarded-For': '203.0.113.7' });
      await signUp(tracking, 'chain@acme.dev', { 'X-Forwarded-For': '203.0.113.7, 198.51.100.9' });

      assert.deepEqual(
        (
          await database.query(
            'SELECT u."email", s."ipAddress" FROM "session" s JOIN "user" u ON u."id" = s."userId" ORDER BY u."email"',
          )
        ).rows,
        [
          { email: 'chain@acme.dev', ipAddress: '' },
          { email: 'lone@acme.dev', ipAddress: '203.0.113.7' },
        ],
      );
    });

    // Why `readConfig` refuses every BETTER_AUTH_ variable: measured. The options of the worker are
    // the same in each half, and only the environment of the process changes.
    it('takes an origin and a secret from the environment over its options, when the worker lets one in', async () => {
      const { options } = await optionsOn(await opening(open));
      const withSignUp = withTestSignUp(options);
      const auth = await startAuth(withSignUp);
      const { cookie } = await signUp(auth, 'alice@acme.dev');
      const sessionOf = async (instance: typeof auth, origin: string): Promise<number> =>
        (
          await ask(instance, '/revoke-other-sessions', {
            method: 'POST',
            body: '{}',
            headers: { Cookie: cookie, Origin: origin },
          })
        ).status;

      assert.equal(await sessionOf(auth, 'https://evil.test'), 403, 'before: an origin that is not the console');
      try {
        process.env.BETTER_AUTH_TRUSTED_ORIGINS = 'https://evil.test';
        assert.equal(await sessionOf(auth, 'https://evil.test'), 200, 'the variable no longer adds an origin');

        process.env.BETTER_AUTH_SECRETS = '2:another-secret-that-nobody-gave-the-worker-0123456789';
        const other = await startAuth(withSignUp);
        assert.equal(await sessionOf(other, CONSOLE_URL), 401, 'the variable no longer takes the place of the secret');
      } finally {
        delete process.env.BETTER_AUTH_TRUSTED_ORIGINS;
        delete process.env.BETTER_AUTH_SECRETS;
      }
      // The control: with no variable, the cookie the worker signed is the cookie that is read.
      assert.equal(await sessionOf(await startAuth(withSignUp), CONSOLE_URL), 200);
    });

    it('gives no way to sign in with a password', async () => {
      const database = await opening(open);
      const { options } = await optionsOn(database);
      const auth = await startAuth(options);
      const answer = await ask(auth, '/sign-up/email', {
        method: 'POST',
        body: JSON.stringify({ email: 'alice@acme.dev', password: 'correct horse battery staple', name: 'Alice' }),
      });

      assert.ok(answer.status >= 400, `a sign-up with a password answered ${answer.status}`);
      assert.equal(answer.headers.get('Set-Cookie'), null);
      assert.deepEqual((await database.query('SELECT "id" FROM "user"')).rows, []);
    });
  });
}

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
