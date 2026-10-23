import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, DEFAULT_TRUSTED_PROXY_HOPS } from './env.ts';
import { DEFAULT_LIMIT } from './rate-limit.ts';

/**
 * `docker-compose.yml` and `.env.example` against the variables the worker reads (FRU-48).
 *
 * Dokploy does not read the compose file, so nothing else stops the two from drifting apart. The
 * worker's own variables come from `WorkerEnv`, and a store's come from its `envNames`, so a store
 * added later is covered with no edit here.
 */

function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
}

const COMPOSE = read('../../../docker-compose.yml');
const ENV_EXAMPLE = read('../../../.env.example');
const VARIABLES = read('../../../docs/self-hosting/environment-variables.md');

/** The worker reads these, and the compose file must not pass them. */
const NOT_PASSED: Readonly<Record<string, string>> = {
  NODE_ENV: 'the image sets production, which is what refuses the in-memory store',
  HOST: 'the default, 0.0.0.0, is the only value that works inside a container',
  FRUITBACK_FAKE_LINEAR: 'deprecated and dev-only, and the image ignores it',
  FRUITBACK_DEV_DATABASE: 'dev-only: the image refuses it, and holds no database to put in the process (FRU-223)',
  FRUITBACK_DEV_VISIBILITY: 'read by the worker of development alone, which is not in the image (FRU-223)',
  FRUITBACK_DEV_LINEAR: 'read by the worker of development alone, which is not in the image (FRU-426)',
};

function workerVariables(): string[] {
  const env = read('./env.ts');
  const block = /export type WorkerEnv = \{([\s\S]*?)\n\};/.exec(env)?.[1] ?? '';
  const own = [...block.matchAll(/^ {2}([A-Z][A-Z0-9_]*)\??:/gm)].map((match) => match[1] ?? '');

  const sources = readdirSync(fileURLToPath(new URL('.', import.meta.url))).filter(
    (file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.fixture.ts'),
  );
  const stores = sources.flatMap((file) =>
    [...read(`./${file}`).matchAll(/envNames: \{([^}]*)\}/g)].flatMap((match) =>
      [...(match[1] ?? '').matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((name) => name[1] ?? ''),
    ),
  );

  return [...new Set([...own, ...stores])].sort();
}

/** The `environment` mapping of the `worker` service, as written. */
function composeEnvironment(): Map<string, string> {
  const block = /^ {4}environment:\n((?: {6}.*\n| *#.*\n|\n)*)/m.exec(COMPOSE)?.[1] ?? '';

  return new Map(
    [...block.matchAll(/^ {6}([A-Z][A-Z0-9_]*): (.*)$/gm)].map((match) => [match[1] ?? '', (match[2] ?? '').trim()]),
  );
}

describe('docker-compose.yml', () => {
  it('reads the variables it compares with', () => {
    const variables = workerVariables();
    assert.ok(variables.length >= 15, `only ${variables.length} worker variables found`);
    assert.ok(variables.includes('LINEAR_API_KEY'), 'the Linear store was not found');
    assert.ok(variables.includes('FRUITBACK_SQLITE_PATH'), 'the SQLite store was not found');
    assert.ok(composeEnvironment().size >= 10, 'the environment of the worker service was not found');
  });

  it('passes every variable the worker reads, except the ones it must not pass', () => {
    const expected = workerVariables().filter((name) => !(name in NOT_PASSED));

    assert.deepEqual([...composeEnvironment().keys()].sort(), expected);
  });

  it('names only exclusions the worker still reads', () => {
    const variables = workerVariables();

    assert.deepEqual(
      Object.keys(NOT_PASSED).filter((name) => !variables.includes(name)),
      [],
    );
  });

  it('takes every value from .env, except the port inside the container', () => {
    const environment = composeEnvironment();
    assert.equal(environment.get('PORT'), '8080');
    assert.ok(COMPOSE.includes(`- '\${FRUITBACK_PORT:-8080}:8080'`), 'the host port does not come from FRUITBACK_PORT');

    const literal = [...environment].filter(
      ([name, value]) => name !== 'PORT' && !new RegExp(`^\\$\\{${name}(:[-?].*)?\\}$`).test(value),
    );
    assert.deepEqual(literal, []);
  });

  it('trusts no proxy by default, because it publishes the port directly', () => {
    assert.equal(composeEnvironment().get('TRUSTED_PROXY_HOPS'), '${TRUSTED_PROXY_HOPS:-0}');
  });

  it('keeps its data in a volume scoped to the Compose project', () => {
    assert.match(COMPOSE, /^ {6}- fruitback-data:\/data$/m);
    assert.match(COMPOSE, /^volumes:\n(?: {2}#.*\n)* {2}fruitback-data:$/m);
    // A global name shares the data of every stack on the host, and down -v in one stack deletes it.
    // A name on the volume does that, and so does a top-level name, which fixes the project name.
    assert.doesNotMatch(COMPOSE, /^ {4}name:/m);
    assert.doesNotMatch(COMPOSE, /^name:/m);
  });

  it('pulls the published image rather than building one', () => {
    // A complete reference, so that a digest can pin it. A variable after the colon can only be a tag.
    assert.match(COMPOSE, /^ {4}image: \$\{FRUITBACK_IMAGE:-ghcr\.io\/sakuga-software\/fruitback-worker:edge\}$/m);
    assert.doesNotMatch(COMPOSE, /^ {4}build:/m);
  });
});

/** The `postgres` service, as written, with the comments inside it. */
function composePostgres(): string {
  return /^ {2}postgres:\n((?: {4}.*\n| *#.*\n)*)/m.exec(COMPOSE)?.[1] ?? '';
}

describe('the PostgreSQL of docker-compose.yml (FRU-143)', () => {
  it('starts with every `docker compose up`, and the worker waits for it to answer (FRU-225)', () => {
    assert.ok(composePostgres().includes('healthcheck:'), 'the service was not found');
    assert.doesNotMatch(COMPOSE, /^ {4}profiles:/m);
    assert.match(COMPOSE, /^ {4}depends_on:\n {6}postgres:\n {8}condition: service_healthy$/m);
    // One service waits for another: the worker for its database, and nothing else.
    assert.equal(COMPOSE.match(/^ {4}depends_on:/gm)?.length, 1);
  });

  it('gives the worker the address of that database, unless .env names another one', () => {
    assert.equal(
      composeEnvironment().get('FRUITBACK_DATABASE_URL'),
      '${FRUITBACK_DATABASE_URL:-postgres://fruitback:${FRUITBACK_POSTGRES_PASSWORD}@postgres:5432/fruitback}',
    );
    // The user and the database of the address are the ones the service makes.
    assert.match(composePostgres(), /^ {6}POSTGRES_USER: fruitback$/m);
    assert.match(composePostgres(), /^ {6}POSTGRES_DB: fruitback$/m);
    // The store is handed over as .env says, even empty: the worker's default is the database, and it
    // refuses an unnamed store beside the key of a tracker. A default here would move those notes.
    assert.equal(composeEnvironment().get('FRUITBACK_STORE'), '${FRUITBACK_STORE:-}');
  });

  it('publishes no port of the database', () => {
    assert.ok(composePostgres().includes('image: postgres:'), 'the service was not found');
    assert.doesNotMatch(composePostgres(), /^ {4}(ports|network_mode):/m);
  });

  it('has no password of its own: the value comes from .env, and without one the file starts nothing', () => {
    assert.match(
      composePostgres(),
      /^ {6}POSTGRES_PASSWORD: \$\{FRUITBACK_POSTGRES_PASSWORD:\?set FRUITBACK_POSTGRES_PASSWORD in \.env/m,
    );
    assert.doesNotMatch(composePostgres(), /POSTGRES_HOST_AUTH_METHOD/);
  });

  it('keeps the database in a volume scoped to the Compose project', () => {
    assert.match(composePostgres(), /^ {6}- fruitback-postgres:\/var\/lib\/postgresql\/data$/m);
    assert.match(COMPOSE, /^ {2}fruitback-postgres:$/m);
  });

  it('runs the PostgreSQL that CI and the restore drill run', () => {
    const image = /^ {4}image: (postgres:\S+@sha256:[0-9a-f]{64})$/m.exec(composePostgres())?.[1];
    assert.ok(image !== undefined, 'the image of the service is not pinned by its digest');

    for (const path of ['../../../.github/workflows/ci.yml', '../cloud/restore-drill.sh']) {
      const named = [...new Set(read(path).match(/postgres:[\w.-]+@sha256:[0-9a-f]{64}/g) ?? [])];
      assert.deepEqual(named, [image], `${path} names another PostgreSQL`);
    }
  });
});

/** The `console` service, as written, with the comments inside it. */
function composeConsole(): string {
  return /^ {2}console:\n((?: {4}.*\n| *#.*\n)*)/m.exec(COMPOSE)?.[1] ?? '';
}

describe('the console of docker-compose.yml (FRU-222)', () => {
  it('starts with every `docker compose up`, beside the worker and its database (FRU-225)', () => {
    assert.ok(composeConsole().includes('image:'), 'the service was not found');
    assert.doesNotMatch(composeConsole(), /^ {4}profiles:/m);
  });

  it('pulls the published image of the console, as a complete reference, and builds nothing', () => {
    assert.match(
      composeConsole(),
      /^ {4}image: \$\{FRUITBACK_CONSOLE_IMAGE:-ghcr\.io\/sakuga-software\/fruitback-console:edge\}$/m,
    );
  });

  it('is given the address of the worker and a port, and nothing else: no secret reaches static files', () => {
    const block = /^ {4}environment:\n((?: {6}.*\n| *#.*\n)*)/m.exec(composeConsole())?.[1] ?? '';
    const given = [...block.matchAll(/^ {6}([A-Z][A-Z0-9_]*): (.*)$/gm)].map((match) => [match[1], match[2]]);

    assert.deepEqual(given, [
      // Not `:?`: Compose reads every service, and a worker with no console would then not start.
      ['FRUITBACK_API', '${FRUITBACK_PUBLIC_URL:-}'],
      ['FRUITBACK_CONSOLE_LISTEN', '8080'],
    ]);
    assert.doesNotMatch(composeConsole(), /^ {4}(volumes|env_file|depends_on):/m);
  });

  it('publishes its one port from FRUITBACK_CONSOLE_PORT, on the port the container is told to listen on', () => {
    assert.deepEqual(composeConsole().match(/^ {6}- '.*'$/gm), ["      - '${FRUITBACK_CONSOLE_PORT:-8081}:8080'"]);
  });

  it('runs with a root that is read-only, no capability and no new privilege', () => {
    assert.match(composeConsole(), /^ {4}read_only: true\n {4}tmpfs:\n {6}- \/tmp$/m);
    assert.match(composeConsole(), /^ {4}cap_drop:\n {6}- ALL$/m);
    assert.match(composeConsole(), /^ {4}security_opt:\n {6}- no-new-privileges:true$/m);
    assert.doesNotMatch(composeConsole(), /^ {4}(user|privileged|network_mode):/m);
  });
});

describe('.env.example', () => {
  it('lists each variable docker-compose.yml reads, once, and no other', () => {
    const assigned = [...ENV_EXAMPLE.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1] ?? '');
    const interpolated = [...new Set([...COMPOSE.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((match) => match[1] ?? ''))];

    assert.ok(interpolated.length >= 10, `only ${interpolated.length} interpolations found`);
    assert.deepEqual(
      assigned.filter((name, index) => assigned.indexOf(name) !== index),
      [],
      'a variable is assigned twice',
    );
    assert.deepEqual([...assigned].sort(), interpolated.sort());
  });
});

describe('docs/self-hosting/environment-variables.md', () => {
  /** The cells of each row of the variable reference, keyed by the variable name (FRU-50). */
  function referenceRows(): Map<string, string> {
    const rows = [...VARIABLES.matchAll(/^\| `([A-Z][A-Z0-9_]*)` *\|(.*)$/gm)].map(
      (match) => [match[1] ?? '', match[2] ?? ''] as const,
    );
    const names = rows.map(([name]) => name);
    // A Map keeps one row per name, so a duplicated row would pass the comparison below.
    assert.deepEqual(
      names.filter((name, index) => names.indexOf(name) !== index),
      [],
      'a variable has two rows',
    );

    return new Map(rows);
  }

  it('names every variable the worker and the compose file read, and no other', () => {
    const interpolated = [...COMPOSE.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((match) => match[1] ?? '');
    const expected = [...new Set([...workerVariables(), ...interpolated])].sort();

    assert.ok(expected.length >= 18, `only ${expected.length} variables found`);
    assert.deepEqual([...referenceRows().keys()].sort(), expected);
  });

  it('gives the defaults the code has', () => {
    const rows = referenceRows();
    const defaultOf = (name: string) => rows.get(name)?.split('|')[0] ?? '';

    assert.match(defaultOf('PORT'), new RegExp(`\`${DEFAULT_PORT}\``));
    assert.match(defaultOf('TRUSTED_PROXY_HOPS'), new RegExp(`\`${DEFAULT_TRUSTED_PROXY_HOPS}\` in the worker`));
    assert.match(defaultOf('RATE_LIMIT_PER_MINUTE'), new RegExp(`\`${DEFAULT_LIMIT}\``));
  });
});
