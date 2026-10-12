import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import { matchesGlob } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * A test that nothing runs, and a test that is skipped with no reason (FRU-174).
 *
 * `node --test 'src/**\/*.test.ts'` exits 0 in each of these cases (measured on 2026-10-11):
 *
 * - a test file that the glob does not match: beside `src/`, or named `.test.tsx` or `.spec.ts`;
 * - a glob that matches no file at all: `tests 0`;
 * - `it.skip(…)`: `skipped 1`.
 *
 * So a test can leave the suite with a green check. This file holds three rules, each on the files
 * of the repository and each on a planted violation:
 *
 * 1. each test file is read by the `test` script of its package, or by Playwright;
 * 2. each `test` script reads one test file or more;
 * 3. a skip carries its reason, a string that the reporter prints.
 *
 * `it.only` is not held here: without `--test-only` Node runs every test and prints a warning
 * (measured), and Playwright has `forbidOnly` in CI.
 *
 * It lives beside `workflows.test.ts`, which also reads files of the root, because the root has no
 * `test` target.
 */

const REPOSITORY = fileURLToPath(new URL('../../../', import.meta.url));
/** This file plants each violation in a string, so the scan of rule 3 leaves it out. */
const SELF = fileURLToPath(import.meta.url).slice(REPOSITORY.length);

/** A name that says « this is a test », whatever runs it. Playwright reads the same names by default. */
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** A package with a `test` script, and the globs that script gives to `node --test`. */
type Runner = { root: string; script: string; globs: string[] };

/** Not a place where a source file lives: what a tool installs, builds or writes. */
function isSource(path: string): boolean {
  return !path
    .split('/')
    .some((segment) => segment === 'node_modules' || segment === 'dist' || segment.startsWith('.'));
}

function files(pattern: string): string[] {
  return globSync(pattern, { cwd: REPOSITORY })
    .map((path) => path.replaceAll('\\', '/'))
    .filter(isSource)
    .sort();
}

function runners(): Runner[] {
  return files('{apps,packages}/*/package.json').flatMap((manifest) => {
    const script = (JSON.parse(readFileSync(`${REPOSITORY}${manifest}`, 'utf8')) as { scripts?: { test?: string } })
      .scripts?.test;
    if (script === undefined) return [];

    return [{ root: manifest.replace(/\/package\.json$/, ''), script, globs: globsOf(script) }];
  });
}

/** The quoted arguments of a `node --test` command. A script that is another command has none. */
function globsOf(script: string): string[] {
  if (!/^node --test\b/.test(script)) return [];

  return [...script.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
}

/** The directory of the specs, as `playwright.config.ts` names it. */
function playwrightDirectory(config: string): string {
  const directory = /\btestDir: '\.\/([^']+)'/.exec(config)?.[1];
  assert.ok(directory !== undefined, 'playwright.config.ts no longer names its testDir as a literal');
  // With one of these, Playwright no longer reads every `*.spec.*` and `*.test.*` of that directory,
  // and rule 1 must learn what it reads.
  assert.doesNotMatch(config, /\btest(?:Match|Ignore)\b/, 'playwright.config.ts filters its specs: update this guard');

  return directory;
}

/** Rule 1. The test files that nothing runs. */
function unread(tests: string[], packages: Runner[], specs: string): string[] {
  return tests.filter((test) => {
    if (test.startsWith(`${specs}/`)) return false;
    const owner = packages.find((candidate) => test.startsWith(`${candidate.root}/`));
    if (owner === undefined) return true;
    const inPackage = test.slice(owner.root.length + 1);

    return !owner.globs.some((glob) => matchesGlob(inPackage, glob));
  });
}

/** Rule 2. The packages whose `test` script reads no file. */
function empty(tests: string[], packages: Runner[]): string[] {
  return packages
    .filter((candidate) => unread(tests, [candidate], '').length === tests.length)
    .map((candidate) => candidate.root);
}

/**
 * Rule 3. Each skip of `source` that carries no reason, as `file:line`.
 *
 * - `it.skip(…)`, and the same on `test`, `describe` and `suite`: `node:test` takes the reason in
 *   the options, `{ skip: 'the reason' }`. Playwright has that call alone, so a spec may write
 *   `test.skip(condition, 'the reason')` on one line.
 * - `skip: true`: a reason is a string.
 * - `.skip()` with no argument, as on the context of a test: `t.skip('the reason')`.
 *
 * A reason that the code computes (`{ skip: NO_REAL_POSTGRES }`) is not read here: TypeScript holds
 * its type where it is declared as `string | false`.
 */
function bareSkips(file: string, source: string, specs: string): string[] {
  const withReason = /\btest\.skip\([^\n]+,\s*(['"`])[^'"`\n]+\1,?\s*\)/;

  return source.split('\n').flatMap((line, index) => {
    const call = /\b(?:it|test|describe|suite)\.skip\(/.test(line);
    const allowed = file.startsWith(`${specs}/`) && withReason.test(line);
    const bare = (call && !allowed) || /\bskip:\s*true\b/.test(line) || /\.skip\(\s*\)/.test(line);

    return bare ? [`${file}:${index + 1}`] : [];
  });
}

const TESTS = files('**/*').filter((path) => TEST_FILE.test(path));
const RUNNERS = runners();
const SPECS = playwrightDirectory(readFileSync(`${REPOSITORY}playwright.config.ts`, 'utf8'));

describe('each test file is run (FRU-174)', () => {
  it('finds the test files and the packages of the repository', () => {
    // A scan that finds nothing passes every rule below.
    assert.ok(TESTS.length >= 100, `only ${TESTS.length} test files found`);
    assert.ok(RUNNERS.length >= 6, `only ${RUNNERS.length} packages with a test script found`);
    assert.ok(TESTS.includes(SELF));
    assert.ok(TESTS.some((test) => test.startsWith(`${SPECS}/`)));
  });

  it('gives each test file to the test script of its package, or to Playwright', () => {
    assert.deepEqual(
      unread(TESTS, RUNNERS, SPECS),
      [],
      'no test script reads these files: move them under the glob of their package, or rename them',
    );
  });

  it('fails on a test file that the glob of its package does not match', () => {
    const shared: Runner = { root: 'packages/shared', script: '', globs: ['src/**/*.test.ts'] };
    const planted = [
      'packages/shared/zz.test.ts',
      'packages/shared/src/zz.test.tsx',
      'packages/shared/src/zz.spec.ts',
      'packages/shared/test/zz.test.ts',
      'packages/unknown/src/zz.test.ts',
      'tools/mutation/zz.test.ts',
      'zz.test.ts',
    ];
    const read = ['packages/shared/src/seed.test.ts', 'packages/shared/src/deep/er/zz.test.ts', 'e2e/zz.spec.ts'];

    assert.deepEqual(unread([...planted, ...read], [shared], 'e2e'), planted);
  });

  it('reads the globs of a test script, and none of a script that is not node --test', () => {
    assert.deepEqual(
      globsOf(
        "node --test ${FRUITBACK_TEST_CONCURRENCY:+--test-concurrency=$FRUITBACK_TEST_CONCURRENCY} 'src/**/*.test.ts'",
      ),
      ['src/**/*.test.ts'],
    );
    assert.deepEqual(globsOf("node --test 'src/**/*.test.ts' 'app/**/*.test.ts'"), [
      'src/**/*.test.ts',
      'app/**/*.test.ts',
    ]);
    assert.deepEqual(globsOf("vitest run 'src/**/*.test.ts'"), []);
  });

  it('has one test file or more behind each test script', () => {
    assert.deepEqual(empty(TESTS, RUNNERS), [], 'the test script of these packages runs no test, and exits 0');
  });

  it('fails on a test script whose glob matches no file', () => {
    const packages: Runner[] = [
      { root: 'packages/shared', script: '', globs: ['src/**/*.test.ts'] },
      { root: 'packages/fruitback', script: '', globs: ['src/**/*.test.ts'] },
      { root: 'packages/typo', script: '', globs: ['scr/**/*.test.ts'] },
      { root: 'packages/other-runner', script: '', globs: [] },
    ];
    const tests = [
      'packages/shared/src/seed.test.ts',
      'packages/typo/src/a.test.ts',
      'packages/other-runner/src/a.test.ts',
    ];

    assert.deepEqual(empty(tests, packages), ['packages/fruitback', 'packages/typo', 'packages/other-runner']);
  });

  it('has one spec or more for Playwright', () => {
    assert.ok(TESTS.filter((test) => test.startsWith(`${SPECS}/`)).length >= 10);
  });

  it('refuses a Playwright configuration that filters its specs, or that names no directory', () => {
    assert.equal(playwrightDirectory("export default defineConfig({\n  testDir: './e2e',\n});"), 'e2e');
    assert.throws(() => playwrightDirectory("export default defineConfig({ testDir: './e2e', testMatch: /x/ });"));
    assert.throws(() => playwrightDirectory("export default defineConfig({ testDir: './e2e', testIgnore: /x/ });"));
    assert.throws(() => playwrightDirectory('export default defineConfig({ testDir: DIRECTORY });'));
  });
});

describe('a skip carries its reason (FRU-174)', () => {
  it('finds no skip without a reason in a test, a spec or a fixture', () => {
    const sources = files('**/*').filter(
      (path) => path !== SELF && (TEST_FILE.test(path) || /\.fixture\.ts$/.test(path) || path.startsWith(`${SPECS}/`)),
    );
    assert.ok(sources.length > TESTS.length - 1, 'the fixtures and the helpers of the specs are not scanned');

    assert.deepEqual(
      sources.flatMap((file) => bareSkips(file, readFileSync(`${REPOSITORY}${file}`, 'utf8'), SPECS)),
      [],
      "a skipped test exits 0: give the reason, { skip: 'the reason' }, or delete the test",
    );
  });

  it('fails on a skip without a reason', () => {
    const planted = [
      "  it.skip('refuses an empty note', () => {",
      "  test.skip('refuses an empty note', async () => {",
      "describe.skip('the composer', () => {",
      "suite.skip('the composer', () => {",
      "  it('refuses an empty note', { skip: true }, () => {",
      "  it('refuses an empty note', { skip:true, timeout: 5 }, () => {",
      '    t.skip();',
      "    test.skip(browserName === 'webkit', 'WebKit has no such API');",
    ];

    assert.deepEqual(
      bareSkips('packages/shared/src/zz.test.ts', planted.join('\n'), 'e2e'),
      planted.map((_, index) => `packages/shared/src/zz.test.ts:${index + 1}`),
    );
  });

  it('accepts a skip that says why', () => {
    const accepted = [
      "  it('fails on a real server', { skip: NO_REAL_POSTGRES }, async () => {",
      "    { skip: process.platform === 'win32' && 'the hook is a POSIX shell script' },",
      '      it(name, { skip: subject.skip ?? false }, async () => {',
      "      t.skip('FRUITBACK_MIGRATIONS_BASE is not set');",
      "  { label: 'PGlite', open: createPgliteDatabase, skip: false },",
      '  // A store may skip a rule it cannot have, with skipReason.',
    ];

    assert.deepEqual(bareSkips('apps/worker/src/zz.test.ts', accepted.join('\n'), 'e2e'), []);
    assert.deepEqual(
      bareSkips('e2e/zz.spec.ts', "    test.skip(browserName === 'webkit', 'WebKit has no such API');", 'e2e'),
      [],
    );
    assert.deepEqual(bareSkips('e2e/zz.spec.ts', "test.skip('draws a pin', async ({ page }) => {", 'e2e'), [
      'e2e/zz.spec.ts:1',
    ]);
  });
});
