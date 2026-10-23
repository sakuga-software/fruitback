import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import { join, matchesGlob, relative } from 'node:path';
import { describe, it } from 'vitest';
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
 * So a test can leave the suite with a green check. `vitest run`, the runner of the worker since
 * FRU-346, exits 1 on a glob that matches no file, and the same rules still read what it runs. This
 * file holds three rules, each on the files of the repository and each on a planted violation:
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

/** A package with a `test` script, and the globs that script gives to `node --test` or to vitest. */
type Runner = { root: string; script: string; globs: string[] };

/** Not a place where a source file lives: what a tool installs, builds or writes. */
function isSource(path: string): boolean {
  return !path
    .split('/')
    .some((segment) => segment === 'node_modules' || segment === 'dist' || segment.startsWith('.'));
}

function files(pattern: string): string[] {
  // Files only: a directory under e2e/ (FRU-397: e2e/fixtures/old-copy) is no source to read.
  return globSync(pattern, { cwd: REPOSITORY, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(REPOSITORY, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
    .filter(isSource)
    .sort();
}

function runners(): Runner[] {
  return files('{apps,packages}/*/package.json').flatMap((manifest) => {
    const script = (JSON.parse(readFileSync(`${REPOSITORY}${manifest}`, 'utf8')) as { scripts?: { test?: string } })
      .scripts?.test;
    if (script === undefined) return [];

    const root = manifest.replace(/\/package\.json$/, '');
    const globs = isVitest(script)
      ? vitestGlobs(readFileSync(`${REPOSITORY}${root}/vitest.config.ts`, 'utf8'))
      : globsOf(script);

    return [{ root, script, globs }];
  });
}

/** The quoted arguments of a `node --test` command. A script that is another command has none. */
function globsOf(script: string): string[] {
  if (!isNodeTest(script)) return [];

  return [...script.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
}

/** The globs of `vitest run`: the `include` of the `vitest.config.ts` of the package, as literals. */
function vitestGlobs(config: string): string[] {
  const include = /\binclude: \[([^\]]*)\]/.exec(config)?.[1];
  assert.ok(include !== undefined, 'vitest.config.ts no longer names its include as literals');
  // With one of these, vitest no longer reads every file of its include, and rule 1 must learn it.
  assert.doesNotMatch(
    config,
    /\b(?:exclude|dir|root|projects)\b/,
    'vitest.config.ts filters its test files: update this guard',
  );

  return [...include.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
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

/**
 * Rule 2. The packages whose `node --test` or `vitest run` reads no file.
 *
 * A script that is another command is not counted here: this guard does not know what it reads, and
 * `unknownRunners` says so in its own words.
 */
function empty(tests: string[], packages: Runner[]): string[] {
  return packages
    .filter((candidate) => isNodeTest(candidate.script) || isVitest(candidate.script))
    .filter((candidate) => unread(tests, [candidate], '').length === tests.length)
    .map((candidate) => candidate.root);
}

/** The packages whose `test` script is neither: rules 1 and 2 cannot read what it runs. */
function unknownRunners(packages: Runner[]): string[] {
  return packages
    .filter((candidate) => !isNodeTest(candidate.script) && !isVitest(candidate.script))
    .map((candidate) => candidate.root);
}

function isNodeTest(script: string): boolean {
  return /^node --test\b/.test(script);
}

/** `vitest run` and nothing more: a file or a filter after it would narrow what it reads. */
function isVitest(script: string): boolean {
  return script === 'vitest run';
}

/**
 * Rule 3. Each skip of `source` that carries no reason, as `file:line`.
 *
 * - `it.skip(…)`, and the same on `test`, `describe` and `suite`: `node:test` takes the reason in
 *   the options, `{ skip: 'the reason' }`. Playwright has that call alone, so a spec may write
 *   `test.skip(condition, 'the reason')`, on one line or on several as oxfmt wraps it.
 *   `test.fixme` of Playwright is a skip under another name, and is read the same way. `test.fail`
 *   is not one: the test runs.
 * - `skip: true`: a reason is a string.
 * - `.skip()` with no argument, as on the context of a test: `t.skip('the reason')`.
 *
 * A reason that the code computes (`{ skip: NO_REAL_POSTGRES }`) is not read here: TypeScript holds
 * its type where it is declared as `string | false`. vitest takes a boolean there
 * (`{ skip: NO_REAL_POSTGRES !== false }`), and `it.skip` of vitest takes no reason, so it is read as
 * one with none.
 */
function bareSkips(file: string, source: string, specs: string): string[] {
  // The arguments up to the reason hold no parenthesis, or pairs that hold none: a callback with a
  // body does not pass, so `test.skip('name', async () => { … })` is never read as a reason.
  const withReason = /^test\.(?:skip|fixme)\((?:[^()]|\([^()]*\))*?,\s*(['"`])[^'"`\n]+\1,?\s*\)/;
  const inSpecs = file.startsWith(`${specs}/`);
  const lineOf = (index: number) => source.slice(0, index).split('\n').length;

  const calls = [...source.matchAll(/\b(?:it|test|describe|suite)\.(?:skip|fixme)\(/g)]
    .filter((call) => !(inSpecs && withReason.test(source.slice(call.index))))
    .map((call) => lineOf(call.index));
  const options = [...source.matchAll(/\bskip:\s*true\b|\.skip\(\s*\)/g)].map((option) => lineOf(option.index));

  return [...new Set([...calls, ...options])].sort((a, b) => a - b).map((line) => `${file}:${line}`);
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
      { root: 'packages/shared', script: "node --test 'src/**/*.test.ts'", globs: ['src/**/*.test.ts'] },
      { root: 'packages/fruitback', script: "node --test 'src/**/*.test.ts'", globs: ['src/**/*.test.ts'] },
      { root: 'packages/typo', script: "node --test 'scr/**/*.test.ts'", globs: ['scr/**/*.test.ts'] },
      { root: 'packages/no-glob', script: 'node --test', globs: [] },
    ];
    const tests = ['packages/shared/src/seed.test.ts', 'packages/typo/src/a.test.ts', 'packages/no-glob/src/a.test.ts'];

    assert.deepEqual(empty(tests, packages), ['packages/fruitback', 'packages/typo', 'packages/no-glob']);
  });

  it('knows the runner of each test script', () => {
    assert.deepEqual(
      unknownRunners(RUNNERS),
      [],
      'the test script of these packages is neither node --test nor vitest run: teach this guard what that runner reads',
    );
  });

  it('fails on a test script that is another runner, in its own words', () => {
    const packages: Runner[] = [
      { root: 'packages/shared', script: "node --test 'src/**/*.test.ts'", globs: ['src/**/*.test.ts'] },
      { root: 'packages/other-runner', script: 'jest', globs: [] },
      { root: 'packages/narrowed', script: 'vitest run src/a.test.ts', globs: [] },
      { root: 'apps/worker', script: 'vitest run', globs: ['src/**/*.test.ts'] },
    ];

    assert.deepEqual(unknownRunners(packages), ['packages/other-runner', 'packages/narrowed']);
    assert.deepEqual(
      empty(
        ['packages/shared/src/seed.test.ts', 'packages/other-runner/src/a.test.ts', 'apps/worker/src/a.test.ts'],
        packages,
      ),
      [],
    );
  });

  it('reads the globs of vitest in its config, and refuses a config that filters them', () => {
    assert.deepEqual(vitestGlobs("test: {\n    include: ['src/**/*.test.ts'],\n    pool: 'forks',\n  }"), [
      'src/**/*.test.ts',
    ]);
    assert.deepEqual(vitestGlobs("include: ['src/**/*.test.ts', 'app/**/*.test.ts'],"), [
      'src/**/*.test.ts',
      'app/**/*.test.ts',
    ]);
    assert.throws(() => vitestGlobs('include: GLOBS,'));
    assert.throws(() => vitestGlobs("include: ['src/**/*.test.ts'], exclude: ['src/slow.test.ts'],"));
    assert.throws(() => vitestGlobs("include: ['src/**/*.test.ts'], dir: 'src/fast',"));
    assert.throws(() => vitestGlobs("include: ['src/**/*.test.ts'], projects: ['a'],"));
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

/**
 * Rule 4. The test files of a package that vitest runs, and that still import `node:test`.
 *
 * vitest finds no suite in such a file, « No test suite found », and the `test` target of the
 * package fails. #456 and #461 each merged one beside the move of the worker to vitest (#450), and
 * `main` was red twice (FRU-345).
 *
 * Only a statement at the start of a line is an import that the file runs. A string that holds one,
 * written to a file that a test then runs under `node --test` (`ci-locale.test.ts`), is not.
 */
const NODE_TEST_IMPORT =
  /^\s*import\b[^;'"`]*\bfrom\s*['"]node:test['"]|^\s*(?:const|let|var)\b[^\n]*=\s*(?:await\s+)?(?:require|import)\(\s*['"]node:test['"]\s*\)/m;

function nodeTestUnderVitest(tests: string[], packages: Runner[], read: (file: string) => string): string[] {
  const vitest = packages.filter((candidate) => isVitest(candidate.script));

  return tests
    .filter((test) => vitest.some((candidate) => test.startsWith(`${candidate.root}/`)))
    .filter((test) => NODE_TEST_IMPORT.test(read(test)));
}

describe('a test file is written for the runner of its package (FRU-345)', () => {
  it('finds no test file of a package run by vitest that imports node:test', () => {
    assert.ok(
      RUNNERS.some((candidate) => isVitest(candidate.script)),
      'no package runs vitest: the scan reads nothing',
    );

    assert.deepEqual(
      nodeTestUnderVitest(
        TESTS.filter((test) => test !== SELF),
        RUNNERS,
        (file) => readFileSync(`${REPOSITORY}${file}`, 'utf8'),
      ),
      [],
      "vitest finds no suite in these files: import describe and it from 'vitest'",
    );
  });

  it('fails on a test file of a package run by vitest that imports node:test, in any form', () => {
    const packages: Runner[] = [
      { root: 'apps/worker', script: 'vitest run', globs: ['src/**/*.test.ts'] },
      { root: 'packages/shared', script: "node --test 'src/**/*.test.ts'", globs: ['src/**/*.test.ts'] },
    ];
    const sources: Record<string, string> = {
      'apps/worker/src/a.test.ts': "import { after, describe, it } from 'node:test';",
      'apps/worker/src/b.test.ts': 'import { describe } from "node:test";',
      'apps/worker/src/c.test.ts': "const { it } = require('node:test');",
      'apps/worker/src/d.test.ts': "const { it } = await import('node:test');",
      'apps/worker/src/e.test.ts':
        "import { describe, it } from 'vitest';\n// node:test took the reason in the options",
      'packages/shared/src/f.test.ts': "import { describe, it } from 'node:test';",
      'apps/worker/src/g.test.ts':
        "import { it } from 'vitest';\n    writeFileSync(file, `import { it } from 'node:test';\\nit('x', () => {});`);",
      'apps/worker/src/h.test.ts':
        "import { it } from 'vitest';\n      writeFileSync(file, \"import { it } from 'node:test';\\n\");",
      'apps/worker/src/i.test.ts': "import {\n  after,\n  describe,\n} from 'node:test';",
    };

    assert.deepEqual(
      nodeTestUnderVitest(Object.keys(sources), packages, (file) => sources[file] ?? ''),
      [
        'apps/worker/src/a.test.ts',
        'apps/worker/src/b.test.ts',
        'apps/worker/src/c.test.ts',
        'apps/worker/src/d.test.ts',
        'apps/worker/src/i.test.ts',
      ],
    );
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
    assert.deepEqual(bareSkips('e2e/zz.spec.ts', "  test.fixme(isMobile, 'the panel does not fit yet');", 'e2e'), []);
    assert.deepEqual(bareSkips('e2e/zz.spec.ts', "test.fixme('draws a pin', async ({ page }) => {", 'e2e'), [
      'e2e/zz.spec.ts:1',
    ]);
    assert.deepEqual(bareSkips('e2e/zz.spec.ts', "test.describe.skip('the panel', () => {", 'e2e'), [
      'e2e/zz.spec.ts:1',
    ]);
    assert.deepEqual(bareSkips('e2e/zz.spec.ts', '  test.skip(isMobile);', 'e2e'), ['e2e/zz.spec.ts:1']);
    // As oxfmt wraps a call that is longer than a line.
    const wrapped = [
      'test.beforeEach(async ({ browserName }) => {',
      '  test.skip(',
      "    browserName === 'webkit' || isMobile(browserName),",
      "    'WebKit has no such API, and a phone has no extension',",
      '  );',
      '});',
    ];
    assert.deepEqual(bareSkips('e2e/zz.spec.ts', wrapped.join('\n'), 'e2e'), []);
  });

  it('does not read the body of a skipped spec as its reason', () => {
    const skipped = [
      "test.skip('draws a pin', async ({ page }) => {",
      "  await page.goto('/pricing');",
      "  expect(await page.title(), 'the title');",
      '});',
      'test.fixme(',
      "  'draws a second pin',",
      '  async ({ page }) => {',
      "    await expect(page.getByRole('button'), 'the button').toBeVisible();",
      '  },',
      ');',
    ];

    assert.deepEqual(bareSkips('e2e/zz.spec.ts', skipped.join('\n'), 'e2e'), ['e2e/zz.spec.ts:1', 'e2e/zz.spec.ts:5']);
  });
});
