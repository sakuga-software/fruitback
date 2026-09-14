import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * `docker-compose.yml` and `.env.example` against the variables the worker reads (SKG-541).
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

/** The worker reads these, and the compose file must not pass them. */
const NOT_PASSED: Readonly<Record<string, string>> = {
  NODE_ENV: 'the image sets production, which is what refuses the in-memory store',
  HOST: 'the default, 0.0.0.0, is the only value that works inside a container',
  FRUITBACK_FAKE_LINEAR: 'deprecated and dev-only, and the image ignores it',
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

  it('keeps its data in the volume the docker run command names', () => {
    // Compose prefixes a volume with the project name unless the volume has a name of its own.
    assert.match(COMPOSE, /^volumes:\n {2}fruitback-data:\n(?: {4}#.*\n)* {4}name: fruitback-data$/m);
  });

  it('pulls the published image rather than building one', () => {
    // A complete reference, so that a digest can pin it. A variable after the colon can only be a tag.
    assert.match(COMPOSE, /^ {4}image: \$\{FRUITBACK_IMAGE:-ghcr\.io\/sakuga-software\/fruitback-worker:edge\}$/m);
    assert.doesNotMatch(COMPOSE, /^ {4}build:/m);
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
