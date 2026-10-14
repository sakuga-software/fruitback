import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { handleRequest } from './app.ts';
import { AUTH_SECRET } from './auth.fixture.ts';
import { IDENTITY_SECRET, envWith } from './auth-worker.fixture.ts';
import { beforePostgres } from './before-postgres.fixture.ts';
import {
  ACCOUNTS_FILE_REFUSED,
  DATABASE_REQUIRED,
  GITHUB_APP_REFUSED,
  REFUSED_SINCE_POSTGRES,
  REQUIRED_WITH_DATABASE,
  type WorkerEnv,
  readConfig,
} from './env.ts';

/**
 * What `readConfig` refuses, and how it says it (FRU-217).
 */

function missing(env: WorkerEnv): string[] {
  const config = readConfig(env);

  return config.ok ? [] : config.missing;
}

const SECRETS_KEY = 'a-key-that-opens-the-connectors-0123456789';

describe('the two variables of before are refused with the rest, in one start (FRU-150, FRU-217)', () => {
  const BEFORE = { FRUITBACK_ACCOUNTS_PATH: '/data/accounts.db', FRUITBACK_GITHUB_OAUTH: 'one-app:a-secret' };

  it('says both, and what else is wrong, together', () => {
    assert.deepEqual(missing(envWith(BEFORE)), [ACCOUNTS_FILE_REFUSED, GITHUB_APP_REFUSED]);
    // An operator who upgrades with a secret that is too short reads the three at once.
    const three = missing(envWith({ ...BEFORE, FRUITBACK_IDENTITY_SECRET: 'too-short' }));
    assert.deepEqual(
      [...three].sort(),
      ['FRUITBACK_IDENTITY_SECRET', ACCOUNTS_FILE_REFUSED, GITHUB_APP_REFUSED].sort(),
    );
    // On a worker with no database too, beside what that worker lacks (FRU-225).
    assert.deepEqual(missing({ FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: 'https://a.test', ...BEFORE }), [
      DATABASE_REQUIRED,
      ...Object.values(REQUIRED_WITH_DATABASE),
      ACCOUNTS_FILE_REFUSED,
      GITHUB_APP_REFUSED,
    ]);
  });

  it('says each one alone, and nothing for an empty value', () => {
    assert.deepEqual(missing(envWith({ FRUITBACK_ACCOUNTS_PATH: '/data/accounts.db' })), [ACCOUNTS_FILE_REFUSED]);
    assert.deepEqual(missing(envWith({ FRUITBACK_GITHUB_OAUTH: 'one-app:a-secret' })), [GITHUB_APP_REFUSED]);
    assert.deepEqual(missing(envWith({ FRUITBACK_ACCOUNTS_PATH: '', FRUITBACK_GITHUB_OAUTH: '' })), []);
  });
});

describe('a secret is not white space, and white space does not tell two secrets apart (FRU-217)', () => {
  const NAMES = ['FRUITBACK_IDENTITY_SECRET', 'FRUITBACK_SECRETS_KEY', 'FRUITBACK_AUTH_SECRET'] as const;
  const GOOD: Record<(typeof NAMES)[number], string> = {
    FRUITBACK_IDENTITY_SECRET: IDENTITY_SECRET,
    FRUITBACK_SECRETS_KEY: SECRETS_KEY,
    FRUITBACK_AUTH_SECRET: AUTH_SECRET,
  };
  const all = (overrides: Partial<WorkerEnv> = {}): WorkerEnv => envWith({ ...GOOD, ...overrides });

  it('starts with the three secrets these cases change', () => {
    assert.deepEqual(missing(all()), []);
  });

  for (const name of NAMES) {
    it(`refuses ${name} made of spaces, or with white space around it, and never quotes it`, () => {
      for (const [why, value] of [
        ['32 spaces', ' '.repeat(32)],
        ['40 tabs', '\t'.repeat(40)],
        ['a space after it', `${GOOD[name]} `],
        ['a space before it', ` ${GOOD[name]}`],
        ['the end of a line after it', `${GOOD[name]}\n`],
      ] as const) {
        const said = missing(all({ [name]: value }));
        assert.equal(said.length, 1, why);
        assert.match(said[0] ?? '', new RegExp(`^${name} \\(no white space at its start or at its end`), why);
        assert.equal((said[0] ?? '').includes(GOOD[name]), false, why);
      }
    });
  }

  it('reads two secrets that differ by white space only as one secret', () => {
    const spaced = (value: string): string => `${value.slice(0, 5)} ${value.slice(5)}`;

    // The secret of the cookie, against each of the two others.
    assert.match(
      missing(all({ FRUITBACK_AUTH_SECRET: spaced(IDENTITY_SECRET) })).join(),
      /^FRUITBACK_AUTH_SECRET \(it must differ from FRUITBACK_IDENTITY_SECRET and from FRUITBACK_SECRETS_KEY\)$/,
    );
    assert.match(
      missing(all({ FRUITBACK_AUTH_SECRET: spaced(SECRETS_KEY) })).join(),
      /^FRUITBACK_AUTH_SECRET \(it must differ/,
    );
    // The key of the connectors, against the secret of the identities.
    assert.match(
      missing(all({ FRUITBACK_SECRETS_KEY: spaced(IDENTITY_SECRET) })).join(),
      /^FRUITBACK_SECRETS_KEY \(it must differ from FRUITBACK_IDENTITY_SECRET\)$/,
    );
    // The control: a space inside a secret is not refused by itself.
    assert.deepEqual(missing(all({ FRUITBACK_AUTH_SECRET: spaced(AUTH_SECRET) })), []);
  });
});

describe('PostgreSQL is required, with what an administrator signs in with (FRU-225)', () => {
  /** Each variable of a worker of before, as an `.env` of before sets it. */
  const BEFORE: ReadonlyArray<[env: WorkerEnv, said: string]> = [
    [{ FRUITBACK_CLIENTS: '{"acme":{"teamId":"team_1"}}' }, REFUSED_SINCE_POSTGRES.FRUITBACK_CLIENTS],
    // A map that is not JSON is refused for being there, and not for its JSON.
    [{ FRUITBACK_CLIENTS: '{ not json' }, REFUSED_SINCE_POSTGRES.FRUITBACK_CLIENTS],
    [{ FRUITBACK_SESSION_PATH: '/data/sessions.db' }, REFUSED_SINCE_POSTGRES.FRUITBACK_SESSION_PATH],
    [{ FRUITBACK_SQLITE_PATH: '/data/fruitback.db' }, REFUSED_SINCE_POSTGRES.FRUITBACK_SQLITE_PATH],
    [{ FRUITBACK_STORE: 'sqlite' }, REFUSED_SINCE_POSTGRES.sqlite],
    [{ FRUITBACK_STORE: ' sqlite ' }, REFUSED_SINCE_POSTGRES.sqlite],
    [{ FRUITBACK_FIRST_REVIEWER: 'Alice Martin' }, REFUSED_SINCE_POSTGRES.FRUITBACK_FIRST_REVIEWER],
  ];

  it('refuses a worker with no database, and says in one start all that it needs', () => {
    assert.deepEqual(missing({ ALLOWED_ORIGINS: 'https://a.test' }), [
      DATABASE_REQUIRED,
      REQUIRED_WITH_DATABASE.FRUITBACK_AUTH_SECRET,
      REQUIRED_WITH_DATABASE.FRUITBACK_PUBLIC_URL,
      REQUIRED_WITH_DATABASE.FRUITBACK_CONSOLE_URL,
      REQUIRED_WITH_DATABASE.FRUITBACK_IDENTITY_SECRET,
    ]);
    // The control: a worker that has all of it starts, on the store of its database by default.
    const started = readConfig({ ...envWith(), FRUITBACK_STORE: undefined });
    assert.ok(started.ok, started.ok ? '' : started.missing.join(' | '));
    assert.equal(started.config.store.provider, 'postgres');
  });

  it('asks for each variable of the console beside a database, alone, and takes none of them as made', () => {
    for (const name of Object.keys(REQUIRED_WITH_DATABASE) as (keyof typeof REQUIRED_WITH_DATABASE)[]) {
      for (const absent of [undefined, '']) {
        assert.deepEqual(missing(envWith({ [name]: absent })), [REQUIRED_WITH_DATABASE[name]], name);
      }
    }
  });

  it('says what to do: the database, the command that copies a file, and the page that says how', () => {
    for (const said of [
      DATABASE_REQUIRED,
      REFUSED_SINCE_POSTGRES.FRUITBACK_CLIENTS,
      REFUSED_SINCE_POSTGRES.FRUITBACK_SQLITE_PATH,
      REFUSED_SINCE_POSTGRES.sqlite,
    ]) {
      for (const named of ['migrate-to-postgres', '« Upgrading » of docs/self-hosting.md']) {
        assert.ok(said.includes(named), `${said} does not name ${named}`);
      }
    }
    assert.match(DATABASE_REQUIRED, /^FRUITBACK_DATABASE_URL \(/);
    // The page and its section exist: a sentence that sends an operator nowhere is worse than none.
    const guide = readFileSync(new URL('../../../docs/self-hosting.md', import.meta.url), 'utf8');
    assert.match(guide, /^## Upgrading\b/m);
  });

  it('refuses each variable of before by its sentence, and never ignores it', () => {
    for (const [before, said] of BEFORE) {
      assert.deepEqual(missing(envWith(before)), [said], JSON.stringify(before));
    }
    // All of them, with no database, in one start (FRU-217).
    const all = missing({
      ALLOWED_ORIGINS: 'https://a.test',
      FRUITBACK_STORE: 'sqlite',
      FRUITBACK_SQLITE_PATH: '/data/fruitback.db',
      FRUITBACK_CLIENTS: '{"acme":{"teamId":"team_1"}}',
      FRUITBACK_SESSION_PATH: '/data/sessions.db',
      FRUITBACK_FIRST_REVIEWER: 'Alice Martin',
    });
    // Every sentence but the one of a store left unnamed: this store is named, `sqlite`.
    const { unnamedStore: _unnamed, ...named } = REFUSED_SINCE_POSTGRES;
    for (const said of [DATABASE_REQUIRED, ...Object.values(named)]) {
      assert.ok(all.includes(said), `not said: ${said}`);
    }
    assert.equal(all.length, 5 + Object.keys(named).length, all.join('\n'));
  });

  it('refuses a store left unnamed beside the variables of a tracker, which ran on Linear before', () => {
    for (const tracker of [
      { LINEAR_API_KEY: 'lin_api_key', LINEAR_TEAM_ID: 'team_1' },
      { LINEAR_API_KEY: 'lin_api_key' },
      { FRUITBACK_GITHUB_REPOSITORY: 'acme/feedback' } as WorkerEnv,
    ]) {
      for (const store of [undefined, '', '  ']) {
        assert.deepEqual(
          missing(envWith({ ...tracker, FRUITBACK_STORE: store })),
          [REFUSED_SINCE_POSTGRES.unnamedStore],
          JSON.stringify({ tracker, store }),
        );
      }
    }
    // The controls: a named store takes the same variables, and no tracker variable leaves the default.
    assert.deepEqual(
      missing(envWith({ LINEAR_API_KEY: 'lin_api_key', LINEAR_TEAM_ID: 'team_1', FRUITBACK_STORE: 'linear' })),
      [],
    );
    assert.deepEqual(missing(envWith({ LINEAR_API_KEY: 'lin_api_key', FRUITBACK_STORE: 'postgres' })), []);
    const unnamed = readConfig({ ...envWith(), FRUITBACK_STORE: undefined, LINEAR_API_KEY: '' });
    assert.ok(unnamed.ok && unnamed.config.store.provider === 'postgres');
    assert.match(REFUSED_SINCE_POSTGRES.unnamedStore, /FRUITBACK_STORE=linear/);
  });

  it('reads an empty variable of before as absent: the compose file hands each one over empty', () => {
    assert.deepEqual(
      missing(
        envWith({
          FRUITBACK_CLIENTS: '',
          FRUITBACK_SESSION_PATH: '',
          FRUITBACK_SQLITE_PATH: '',
          FRUITBACK_FIRST_REVIEWER: '',
          FRUITBACK_STORE: '',
        }),
      ),
      [],
    );
  });

  it('answers 503 on /health with the variable and the page, and 500 on every other route', async () => {
    const env = { ALLOWED_ORIGINS: 'https://a.test' };
    const ask = (path: string, method = 'GET') =>
      handleRequest(new Request(`https://worker.test${path}`, { method, headers: { Origin: 'https://a.test' } }), env, {
        clientIp: '192.0.2.40',
      });

    const health = await ask('/health');
    assert.equal(health.status, 503);
    const body = (await health.json()) as { error: string; missing: string[] };
    assert.equal(body.error, 'misconfigured');
    assert.equal(body.missing[0], DATABASE_REQUIRED);
    for (const [path, method] of [
      ['/feedback?url=https%3A%2F%2Fa.test%2F', 'GET'],
      ['/feedback', 'POST'],
      ['/session/sites', 'GET'],
      ['/console/me', 'GET'],
      ['/console/auth/ok', 'GET'],
    ] as const) {
      const answer = await ask(path, method);
      assert.equal(answer.status, 500, `${method} ${path}`);
      assert.equal(((await answer.json()) as { missing: string[] }).missing[0], DATABASE_REQUIRED, path);
    }
  });

  /**
   * The worker of before stays in the code for its tests until FRU-226, behind `WITHOUT_DATABASE`.
   * What keeps it out of a deployed worker: no environment of a process can hold a symbol, and no
   * file of the bundle names it but `env.ts`.
   */
  it('keeps the worker of before out of any environment a process can be given', () => {
    const before = beforePostgres({ FRUITBACK_STORE: 'memory', ALLOWED_ORIGINS: 'https://a.test' });
    assert.ok(readConfig(before).ok);
    // What a process gets: strings, as JSON and as `process.env` carry them.
    const carried = JSON.parse(JSON.stringify(before)) as WorkerEnv;
    assert.equal(missing(carried)[0], DATABASE_REQUIRED);
    assert.equal(missing({ ...carried, WITHOUT_DATABASE: 'true' } as WorkerEnv)[0], DATABASE_REQUIRED);

    const directory = new URL('./', import.meta.url);
    const naming = readdirSync(directory)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.fixture.ts'))
      .filter((file) => readFileSync(new URL(file, directory), 'utf8').includes('WITHOUT_DATABASE'));
    assert.deepEqual(naming, ['env.ts']);
    // The control: the scan reads the file that sets it, so an empty answer above is not a blind one.
    assert.ok(readFileSync(new URL('before-postgres.fixture.ts', directory), 'utf8').includes('WITHOUT_DATABASE'));
  });
});
