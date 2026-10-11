import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parseDocument } from 'yaml';
import { type Report, type Status, linesOf, regressions, scoreOf } from '../../../tools/mutation/ratchet.ts';
import { choose, scopeOf } from '../../../tools/mutation/scope.ts';

/**
 * The mutation job, and the line its score may not go under (FRU-172).
 *
 * The ratchet and the choice of files are driven here on reports and diffs written for the test:
 * the job runs for minutes, and a defect in either would only show as a green check that holds
 * nothing. The configuration is held to the code it mutates, so a file added to the seed contract
 * joins the run or fails this test.
 *
 * It lives beside `workflows.test.ts` because the root has no `test` target.
 */

const ROOT = new URL('../../../', import.meta.url);
const SHARED = JSON.parse(readFileSync(new URL('packages/shared/stryker.config.json', ROOT), 'utf8')) as object;
const WORKER = JSON.parse(readFileSync(new URL('apps/worker/stryker.config.json', ROOT), 'utf8')) as object;

/** A report of one file, with one mutant for each status given. */
function report(statuses: Status[], file = 'src/seed.ts'): Report {
  return {
    files: {
      [file]: {
        mutants: statuses.map((status, index) => ({
          mutatorName: 'ConditionalExpression',
          replacement: 'false',
          status,
          location: { start: { line: index + 1, column: 1 } },
        })),
      },
    },
  };
}

describe('the score of a mutation run', () => {
  it('counts a timeout as detected, a mutant no test reaches as missed, and an invalid one as nothing', () => {
    assert.deepEqual(scoreOf(report(['Killed', 'Timeout', 'Survived', 'NoCoverage']).files['src/seed.ts']!.mutants), {
      score: 50,
      mutants: 4,
    });
    assert.deepEqual(
      scoreOf(report(['Killed', 'CompileError', 'RuntimeError', 'Ignored']).files['src/seed.ts']!.mutants),
      {
        score: 100,
        mutants: 1,
      },
    );
    assert.equal(scoreOf(report(['Ignored']).files['src/seed.ts']!.mutants), undefined);
    // Rounded down: two of three is 66.66, never 66.67.
    assert.equal(scoreOf(report(['Killed', 'Killed', 'Survived']).files['src/seed.ts']!.mutants)?.score, 66.66);
  });

  it('fails a file that scores under its line, and holds one that scores the same or more', () => {
    const lines = linesOf(report(['Killed', 'Killed', 'Survived']));

    assert.deepEqual(regressions(lines, report(['Killed', 'Killed', 'Survived']), true), []);
    assert.deepEqual(regressions(lines, report(['Killed', 'Killed', 'Killed']), true), []);
    assert.deepEqual(regressions(lines, report(['Killed', 'Survived', 'Survived']), false), [
      'src/seed.ts scores 33.33, under its line of 66.66',
    ]);
  });

  it('holds a file with no line yet to the line of its package', () => {
    const lines = linesOf(report(['Killed', 'Survived']));

    assert.deepEqual(regressions(lines, report(['Killed', 'Killed'], 'src/new.ts'), false), []);
    assert.deepEqual(regressions(lines, report(['Killed', 'Survived', 'Survived'], 'src/new.ts'), false), [
      'src/new.ts has no line yet, and scores 33.33, under the 50 of its package',
    ]);
  });

  it('fails a package with no line, rather than passing it in silence', () => {
    assert.deepEqual(regressions(undefined, report(['Killed']), true), [
      'this package has no line in tools/mutation/baseline.json',
    ]);
  });
});

describe('what a mutation job mutates', () => {
  const scope = ['src/seed.ts', 'src/issue.ts'];

  it('mutates the files of the scope that a pull request changes, and no other', () => {
    assert.deepEqual(choose('packages/shared', scope, 'pull_request', ['packages/shared/src/seed.ts', 'README.md']), {
      mutate: ['src/seed.ts'],
      full: false,
    });
    assert.deepEqual(choose('packages/shared', scope, 'pull_request', ['apps/worker/src/seed.ts']), {
      mutate: [],
      full: false,
    });
  });

  it('mutates the whole scope on a schedule, by hand, and when the pull request changes how mutation runs', () => {
    for (const event of ['schedule', 'workflow_dispatch']) {
      assert.deepEqual(choose('packages/shared', scope, event, undefined), { mutate: scope, full: true });
    }
    for (const file of [
      '.github/workflows/mutation.yml',
      'apps/worker/stryker.config.json',
      'tools/mutation/ratchet.ts',
    ]) {
      assert.deepEqual(choose('packages/shared', scope, 'pull_request', [file]), { mutate: scope, full: true }, file);
    }
  });

  it('reads the scope of a configuration, and leaves out what it excludes', () => {
    assert.deepEqual(scopeOf({ mutate: ['src/a.ts', '!src/b.ts'] }), ['src/a.ts']);
    assert.deepEqual(scopeOf({}), []);
  });
});

describe('the configuration of the mutation job', () => {
  it('mutates every file of the seed contract, and its tests are not mutated', () => {
    const contract = readdirSync(new URL('packages/shared/src/', ROOT))
      .filter((file) => file.endsWith('.ts') && !/\.(test|fixture)\.ts$/.test(file) && file !== 'index.ts')
      .map((file) => `src/${file}`)
      .sort();

    assert.ok(contract.length >= 3, `only ${contract.length} files found in packages/shared/src`);
    assert.deepEqual([...scopeOf(SHARED)].sort(), contract);
  });

  it('names only files that exist in the core of the worker', () => {
    const scope = scopeOf(WORKER);

    assert.ok(scope.length >= 5, `only ${scope.length} files in the scope of the worker`);
    const sources = new Set(readdirSync(new URL('./', import.meta.url)).map((file) => `src/${file}`));

    assert.deepEqual(
      scope.filter((file) => !sources.has(file)),
      [],
    );
  });

  /**
   * A mutation run rewrites the text of the files it mutates. A test that reads that text, and not
   * the module, fails on the first run and stops it: `security.test.ts` reads the constants of
   * `session.ts` and `identity.ts` from their source (measured in CI on 2026-10-11).
   */
  it('leaves out of the run of the worker each test that reads a mutated file as text', () => {
    const scope = new Set(scopeOf(WORKER).map((file) => file.replace(/^src\//, '')));
    const readers = readdirSync(new URL('./', import.meta.url))
      .filter((file) => file.endsWith('.test.ts'))
      .filter((file) =>
        [...readFileSync(new URL(file, import.meta.url), 'utf8').matchAll(/new URL\('\.\/([\w.-]+\.ts)'/g)].some(
          (match) => scope.has(match[1] ?? ''),
        ),
      );
    const run = (WORKER as { tap?: { testFiles?: string[] } }).tap?.testFiles ?? [];

    assert.deepEqual(readers, ['security.test.ts'], 'the list of tests that read a mutated file as text changed');
    for (const reader of readers) {
      assert.ok(
        run.some((glob) => glob.includes(`!(${reader.replace(/\.test\.ts$/, '')})`)),
        `${reader} reads a mutated file as text and is not left out of tap.testFiles`,
      );
    }
  });

  it('runs on every pull request, on a schedule and by hand', () => {
    const on = parseDocument(readFileSync(new URL('.github/workflows/mutation.yml', ROOT), 'utf8')).toJS().on as Record<
      string,
      unknown
    >;

    assert.deepEqual(Object.keys(on).sort(), ['pull_request', 'schedule', 'workflow_dispatch']);
    assert.equal(on.pull_request, null, 'the pull request trigger of mutation.yml holds a filter');
  });
});
