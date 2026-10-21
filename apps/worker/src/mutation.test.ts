import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseDocument } from 'yaml';
import {
  type Baseline,
  type Report,
  type Status,
  linesOf,
  merged,
  regressions,
  scoreOf,
} from '../../../tools/mutation/ratchet.ts';
import { artifactOf, changedSince, choose, plan, scopeOf } from '../../../tools/mutation/scope.ts';
import { apart, git } from './git.fixture.ts';

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

/** The files that a pull request changes when it deletes one test and renames another, read by git. */
function deletedAndRenamed(): string[] {
  const repository = mkdtempSync(join(tmpdir(), 'fruitback-scope-'));
  try {
    git(repository, 'init', '-q', '-b', 'main');
    mkdirSync(join(repository, 'packages/shared/src'), { recursive: true });
    for (const file of ['issue', 'issue.test', 'seed', 'seed.test']) {
      writeFileSync(join(repository, `packages/shared/src/${file}.ts`), `export const name = '${file}';\n`);
    }
    git(repository, 'add', '.');
    git(repository, 'commit', '-q', '-m', 'base');
    const base = git(repository, 'rev-parse', 'HEAD').trim();
    rmSync(join(repository, 'packages/shared/src/issue.test.ts'));
    renameSync(join(repository, 'packages/shared/src/seed.test.ts'), join(repository, 'packages/shared/src/x.test.ts'));
    git(repository, 'add', '-A');
    git(repository, 'commit', '-q', '-m', 'a test deleted, a test renamed');
    return apart(() => changedSince(base, repository));
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
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

  /**
   * Each file is mutated by a job of its own (FRU-336): the line of a package is held on the reports
   * of all its jobs, and a job whose report is missing must not pass the package.
   */
  it('reads the reports of the jobs of a package as one, and fails a full run that left a file out', () => {
    const lines = linesOf(merged([report(['Killed', 'Killed']), report(['Killed', 'Survived'], 'src/new.ts')]));

    assert.deepEqual(Object.keys(lines.files).sort(), ['src/new.ts', 'src/seed.ts']);
    assert.equal(lines.score, 75);
    assert.deepEqual(regressions(lines, merged([report(['Killed', 'Killed'])]), true), [
      'src/new.ts has a line, and this full run did not measure it',
    ]);
    // A pull request mutates some files only: the others are not missing.
    assert.deepEqual(regressions(lines, merged([report(['Killed', 'Killed'])]), false), []);
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

  it('mutates a file whose test the pull request changes, so that deleting a test is measured', () => {
    assert.deepEqual(choose('packages/shared', scope, 'pull_request', ['packages/shared/src/issue.test.ts']), {
      mutate: ['src/issue.ts'],
      full: false,
    });
    assert.deepEqual(choose('packages/shared', scope, 'pull_request', ['packages/shared/src/seed-shape.test.ts']), {
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
      'packages/shared/stryker.config.json',
      'tools/mutation/ratchet.ts',
    ]) {
      assert.deepEqual(choose('packages/shared', scope, 'pull_request', [file]), { mutate: scope, full: true }, file);
    }
  });

  /**
   * A file added to the seed contract changes `packages/shared/stryker.config.json`. That ran the
   * whole worker too, and the worker ran out of time on #427 (FRU-336), with no mutant of its own changed.
   */
  it('mutates the whole scope of a package for its own configuration, and not for the one of another', () => {
    assert.deepEqual(choose('apps/worker', scope, 'pull_request', ['packages/shared/stryker.config.json']), {
      mutate: [],
      full: false,
    });
    assert.deepEqual(choose('apps/worker', scope, 'pull_request', ['apps/worker/stryker.config.json']), {
      mutate: scope,
      full: true,
    });
  });

  it('gives each file a job of its own, with an artifact that names its package and its file', () => {
    const { jobs, full } = plan([
      { pkg: 'packages/shared', mutate: ['src/seed.ts'], full: false },
      { pkg: 'apps/worker', mutate: ['src/kv.ts', 'src/cors.ts'], full: true },
      { pkg: 'apps/extension', mutate: [], full: true },
    ]);

    assert.deepEqual(jobs, [
      { package: 'packages/shared', file: 'src/seed.ts', artifact: 'mutation--packages-shared--src-seed.ts' },
      { package: 'apps/worker', file: 'src/kv.ts', artifact: 'mutation--apps-worker--src-kv.ts' },
      { package: 'apps/worker', file: 'src/cors.ts', artifact: 'mutation--apps-worker--src-cors.ts' },
    ]);
    // A package with nothing to mutate has no line to hold.
    assert.deepEqual(full, ['apps/worker']);
    // The line job takes the reports of a package by this prefix: no other package may share it.
    assert.ok(!artifactOf('apps/worker-x', 'src/a.ts').startsWith('mutation--apps-worker--'));
  });

  /**
   * A test deleted whole, or renamed, still brings its file into the run (raised in review). Run on
   * a real repository of git, because the defect was in the flags of the diff, not in the choice.
   * Git is started through `git.fixture.ts`, which keeps it out of the repository of a hook.
   */
  it('sees a test the pull request deletes or renames, through git itself', () => {
    assert.deepEqual(choose('packages/shared', scope, 'pull_request', deletedAndRenamed()), {
      mutate: ['src/seed.ts', 'src/issue.ts'],
      full: false,
    });
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
   * the module, fails on the first run and stops it: `security.test.ts` did, and it was left out of
   * the run until it imported the constants (measured in CI on 2026-10-11, FRU-179). Its tests of
   * behaviour did not count in the score for that time. So no test reads a mutated file as text, and
   * no test is left out of the run.
   */
  it('runs every test of the worker, and none reads a mutated file as text', () => {
    const scope = new Set(scopeOf(WORKER).map((file) => file.replace(/^src\//, '')));
    const readers = readdirSync(new URL('./', import.meta.url))
      .filter((file) => file.endsWith('.test.ts'))
      .filter((file) =>
        [...readFileSync(new URL(file, import.meta.url), 'utf8').matchAll(/new URL\('\.\/([\w.-]+\.ts)'/g)].some(
          (match) => scope.has(match[1] ?? ''),
        ),
      );
    const run = (WORKER as { tap?: { testFiles?: string[] } }).tap?.testFiles ?? [];

    assert.deepEqual(readers, [], 'a test reads a mutated file as text: import the module and its constants');
    assert.deepEqual(run, ['src/**/*.test.ts'], 'a test is left out of the mutation run of the worker');
  });

  /**
   * A file with no line is held only to the line of its package, and a line for a file that is gone
   * holds nothing. Both mean the baseline no longer describes the scope.
   */
  it('holds a line for each file it mutates, and none for another', () => {
    const baseline = JSON.parse(readFileSync(new URL('tools/mutation/baseline.json', ROOT), 'utf8')) as Baseline;

    for (const [name, config] of [
      ['packages/shared', SHARED],
      ['apps/worker', WORKER],
    ] as const) {
      const lines = baseline[name];
      assert.ok(lines !== undefined, `${name} has no line in tools/mutation/baseline.json`);
      assert.ok(lines.score > 0 && lines.score <= 100, `${name}: a line of ${lines.score}`);
      assert.deepEqual(Object.keys(lines.files).sort(), [...scopeOf(config)].sort(), name);
    }
  });

  // The dry run of the worker is its whole suite, one file at a time: over the 5 minutes of StrykerJS
  // since 2026-10-14, 9 minutes 29 on 2026-10-20, and the run then stops with no mutant run. Each job
  // of the matrix makes its own. See conventions.md.
  it('gives the dry run of the worker the time its suite takes', () => {
    const minutes = (WORKER as { dryRunTimeoutMinutes?: number }).dryRunTimeoutMinutes;

    assert.ok(minutes !== undefined && minutes >= 30, `dryRunTimeoutMinutes is ${minutes}`);
  });

  it('runs on every pull request, on a schedule and by hand', () => {
    const on = parseDocument(readFileSync(new URL('.github/workflows/mutation.yml', ROOT), 'utf8')).toJS().on as Record<
      string,
      unknown
    >;

    assert.deepEqual(Object.keys(on).sort(), ['pull_request', 'schedule', 'workflow_dispatch']);
    assert.equal(on.pull_request, null, 'the pull request trigger of mutation.yml holds a filter');
  });

  /**
   * The files of a pull request are read from its base (raised in review). With no base, `scope.ts`
   * mutates the whole scope, and with no history `git diff` fails the job: both fail safe. Another
   * value, the head for one, would measure nothing and pass.
   */
  it('reads the files of a pull request from its base, with the history to diff it', () => {
    type Step = {
      uses?: string;
      id?: string;
      with?: Record<string, unknown>;
      env?: Record<string, string>;
      run?: string;
    };
    const { jobs } = parseDocument(readFileSync(new URL('.github/workflows/mutation.yml', ROOT), 'utf8')).toJS() as {
      jobs: { plan: { steps: Step[] } };
    };
    const checkout = jobs.plan.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    const choice = jobs.plan.steps.find((step) => step.id === 'scope');

    assert.equal(checkout?.with?.['fetch-depth'], 0, 'the checkout of mutation.yml is shallow');
    assert.deepEqual(choice?.env, {
      EVENT: '${{ github.event_name }}',
      BASE: '${{ github.event.pull_request.base.sha }}',
    });
    assert.equal(
      choice?.run,
      'node tools/mutation/scope.ts "$EVENT" "$BASE" packages/shared apps/worker >> "$GITHUB_OUTPUT"',
    );
  });

  /**
   * The jobs of the matrix are the ones `plan` lists, a file each, and the line of a package is held
   * on a full run only after every one of them passed (FRU-336).
   */
  it('mutates one file a job, and holds the line of a package after all its jobs', () => {
    type Job = {
      needs?: string | string[];
      if?: string;
      strategy?: { matrix?: unknown };
      steps: { name?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> }[];
    };
    const { jobs } = parseDocument(readFileSync(new URL('.github/workflows/mutation.yml', ROOT), 'utf8')).toJS() as {
      jobs: Record<string, Job>;
    };
    const mutate = jobs.mutation?.steps.find((step) => step.name === 'Mutate');
    const hold = jobs.line?.steps.find((step) => step.name === 'Hold the line of the package');
    const take = jobs.line?.steps.find((step) => step.name === 'Take the reports of the package');

    assert.equal(jobs.mutation?.strategy?.matrix, '${{ fromJSON(needs.plan.outputs.matrix) }}');
    assert.deepEqual(mutate?.env, { MUTATE: '${{ matrix.file }}' });
    assert.deepEqual(jobs.line?.needs, ['plan', 'mutation']);
    // `always()` would hold the line on the reports of the jobs that passed, and pass a run that failed.
    assert.ok(!String(jobs.line?.if).includes('always()'), 'the line job runs when a job of the matrix failed');
    assert.equal(take?.with?.pattern, 'mutation--${{ steps.slug.outputs.slug }}--*');
    assert.match(String(hold?.run), /ratchet\.ts check "\$PACKAGE" reports\/\*\/mutation\.json --full/);
  });
});

/**
 * A pull request does not wait on mutation (Mathieu, 2026-10-21): its jobs report, and a line that
 * is not held is a warning. `main`, the schedule and a run by hand are still held to the line.
 */
describe('what the mutation of a pull request blocks', () => {
  type Step = { id?: string; name?: string; if?: string; run?: string; 'continue-on-error'?: unknown };
  type Job = { 'continue-on-error'?: unknown; steps: Step[] };
  const { jobs } = parseDocument(readFileSync(new URL('.github/workflows/mutation.yml', ROOT), 'utf8')).toJS() as {
    jobs: Record<string, Job>;
  };
  const ON_A_PULL_REQUEST = "${{ github.event_name == 'pull_request' }}";

  it('lets a job of a pull request fail without failing the run, and no other', () => {
    for (const name of ['mutation', 'line']) {
      assert.equal(jobs[name]?.['continue-on-error'], ON_A_PULL_REQUEST, name);
    }
    assert.equal(jobs.plan?.['continue-on-error'], undefined, 'a plan that fails mutates nothing');
  });

  it('turns a line that is not held into a warning on a pull request, and a failure elsewhere', () => {
    for (const name of ['mutation', 'line']) {
      const steps = jobs[name]?.steps ?? [];
      const hold = steps.find((step) => step.id === 'hold');
      const say = steps.find((step) => step.if === "steps.hold.outcome == 'failure'");

      assert.match(String(hold?.run), /ratchet\.ts check /, name);
      assert.equal(hold?.['continue-on-error'], ON_A_PULL_REQUEST, name);
      assert.match(String(say?.run), /^echo "::warning title=mutation::/, name);
      assert.equal(
        steps.indexOf(say as Step),
        steps.indexOf(hold as Step) + 1,
        `${name}: the warning follows the line`,
      );
    }
  });
});
