import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
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
import { type Artifact, branchesOf, coarsen, find, pick } from '../../../tools/mutation/reference.ts';
import {
  artifactOf,
  baselineAt,
  changedSince,
  choose,
  movedLines,
  plan,
  scopeOf,
} from '../../../tools/mutation/scope.ts';
import { apart, git } from './git.fixture.ts';
import base from '../vitest.config.ts';
import mutation, { mutationOrder } from '../vitest.mutation.config.ts';

/**
 * The mutation job, and the line its score may not go under (FRU-172).
 *
 * The ratchet and the choice of files are driven here on reports and diffs written for the test:
 * the job runs for minutes, and a defect in either would only show as a green check that holds
 * nothing. The configuration is held to the code it mutates, so a file added to the note contract
 * joins the run or fails this test.
 *
 * It lives beside `workflows.test.ts` because the root has no `test` target.
 */

const ROOT = new URL('../../../', import.meta.url);
const SHARED = JSON.parse(readFileSync(new URL('packages/shared/stryker.config.json', ROOT), 'utf8')) as object;
const WORKER = JSON.parse(readFileSync(new URL('apps/worker/stryker.config.json', ROOT), 'utf8')) as object;

/** A report of one file, with one mutant for each status given. */
function report(statuses: Status[], file = 'src/note.ts'): Report {
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
    for (const file of ['issue', 'issue.test', 'note', 'note.test']) {
      writeFileSync(join(repository, `packages/shared/src/${file}.ts`), `export const name = '${file}';\n`);
    }
    git(repository, 'add', '.');
    git(repository, 'commit', '-q', '-m', 'base');
    const base = git(repository, 'rev-parse', 'HEAD').trim();
    rmSync(join(repository, 'packages/shared/src/issue.test.ts'));
    renameSync(join(repository, 'packages/shared/src/note.test.ts'), join(repository, 'packages/shared/src/x.test.ts'));
    git(repository, 'add', '-A');
    git(repository, 'commit', '-q', '-m', 'a test deleted, a test renamed');
    return apart(() => changedSince(base, repository));
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
}

describe('the score of a mutation run', () => {
  it('counts a timeout as detected, a mutant no test reaches as missed, and an invalid one as nothing', () => {
    assert.deepEqual(scoreOf(report(['Killed', 'Timeout', 'Survived', 'NoCoverage']).files['src/note.ts']!.mutants), {
      score: 50,
      mutants: 4,
    });
    assert.deepEqual(
      scoreOf(report(['Killed', 'CompileError', 'RuntimeError', 'Ignored']).files['src/note.ts']!.mutants),
      {
        score: 100,
        mutants: 1,
      },
    );
    assert.equal(scoreOf(report(['Ignored']).files['src/note.ts']!.mutants), undefined);
    // Rounded down: two of three is 66.66, never 66.67.
    assert.equal(scoreOf(report(['Killed', 'Killed', 'Survived']).files['src/note.ts']!.mutants)?.score, 66.66);
  });

  it('fails a file that scores under its line, and holds one that scores the same or more', () => {
    const lines = linesOf(report(['Killed', 'Killed', 'Survived']));

    assert.deepEqual(regressions(lines, report(['Killed', 'Killed', 'Survived']), true), []);
    assert.deepEqual(regressions(lines, report(['Killed', 'Killed', 'Killed']), true), []);
    assert.deepEqual(regressions(lines, report(['Killed', 'Survived', 'Survived']), false), [
      'src/note.ts scores 33.33, under its line of 66.66',
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

    assert.deepEqual(Object.keys(lines.files).sort(), ['src/new.ts', 'src/note.ts']);
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
  const scope = ['src/note.ts', 'src/issue.ts'];

  it('mutates the files of the scope that a pull request changes, and no other', () => {
    assert.deepEqual(choose('packages/shared', scope, 'pull_request', ['packages/shared/src/note.ts', 'README.md']), {
      mutate: ['src/note.ts'],
      full: false,
      line: false,
    });
    assert.deepEqual(choose('packages/shared', scope, 'pull_request', ['apps/worker/src/note.ts']), {
      mutate: [],
      full: false,
      line: false,
    });
  });

  it('mutates a file whose test the pull request changes, so that deleting a test is measured', () => {
    assert.deepEqual(choose('packages/shared', scope, 'pull_request', ['packages/shared/src/issue.test.ts']), {
      mutate: ['src/issue.ts'],
      full: false,
      line: false,
    });
    assert.deepEqual(choose('packages/shared', scope, 'pull_request', ['packages/shared/src/note-shape.test.ts']), {
      mutate: [],
      full: false,
      line: false,
    });
  });

  it('mutates the whole scope on a schedule, by hand, and when the pull request changes how mutation runs', () => {
    for (const event of ['schedule', 'workflow_dispatch']) {
      assert.deepEqual(choose('packages/shared', scope, event, undefined), { mutate: scope, full: true, line: true });
    }
    for (const file of [
      '.github/workflows/mutation.yml',
      'packages/shared/stryker.config.json',
      'tools/mutation/ratchet.ts',
    ]) {
      assert.deepEqual(
        choose('packages/shared', scope, 'pull_request', [file]),
        { mutate: scope, full: true, line: true },
        file,
      );
    }
  });

  /**
   * `baseline.json` holds the lines, not how mutation runs (FRU-447). A pull request that only raised
   * lines ran the whole worker, 22 to 67 minutes, with no mutant and no test changed.
   */
  it('mutates, from their last report, the files whose line a pull request moves, and no other', () => {
    const changed = ['tools/mutation/baseline.json'];
    assert.deepEqual(choose('packages/shared', scope, 'pull_request', changed), {
      mutate: [],
      full: false,
      line: false,
    });
    assert.deepEqual(
      choose('packages/shared', scope, 'pull_request', changed, { files: ['src/issue.ts'], package: false }),
      {
        mutate: ['src/issue.ts'],
        full: false,
        line: false,
      },
    );
    // The line of a package is the score of every file of it: each one is measured, and the line held.
    assert.deepEqual(choose('packages/shared', scope, 'pull_request', changed, { files: [], package: true }), {
      mutate: scope,
      full: false,
      line: true,
    });
  });

  it('reads which lines moved, a line added or taken away included', () => {
    const before: Baseline = {
      'apps/worker': {
        score: 90,
        files: { 'src/kv.ts': { score: 80, mutants: 10 }, 'src/cors.ts': { score: 100, mutants: 5 } },
      },
    };
    const after: Baseline = {
      'apps/worker': {
        score: 90,
        files: { 'src/kv.ts': { score: 85, mutants: 10 }, 'src/cache.ts': { score: 100, mutants: 3 } },
      },
    };

    assert.deepEqual(movedLines('apps/worker', before, after), {
      files: ['src/kv.ts', 'src/cors.ts', 'src/cache.ts'],
      package: false,
    });
    assert.deepEqual(movedLines('apps/worker', before, before), { files: [], package: false });
    assert.deepEqual(
      movedLines('apps/worker', before, { 'apps/worker': { ...after['apps/worker']!, score: 91 } }).package,
      true,
    );
    // A base with no baseline moves every line.
    assert.deepEqual(movedLines('apps/worker', undefined, before), {
      files: ['src/kv.ts', 'src/cors.ts'],
      package: true,
    });
  });

  it('reads the baseline of the base through git, and none where the base has no file', () => {
    const repository = mkdtempSync(join(tmpdir(), 'fruitback-baseline-'));
    try {
      git(repository, 'init', '-q', '-b', 'main');
      mkdirSync(join(repository, 'tools/mutation'), { recursive: true });
      writeFileSync(join(repository, 'README.md'), 'base\n');
      git(repository, 'add', '.');
      git(repository, 'commit', '-q', '-m', 'no baseline');
      const empty = git(repository, 'rev-parse', 'HEAD').trim();
      const lines: Baseline = { 'apps/worker': { score: 90, files: {} } };
      writeFileSync(join(repository, 'tools/mutation/baseline.json'), JSON.stringify(lines));
      git(repository, 'add', '.');
      git(repository, 'commit', '-q', '-m', 'a baseline');
      const head = git(repository, 'rev-parse', 'HEAD').trim();

      assert.deepEqual(
        apart(() => baselineAt(head, repository)),
        lines,
      );
      assert.equal(
        apart(() => baselineAt(empty, repository)),
        undefined,
      );
      assert.deepEqual(baselineAt(undefined, repository), lines);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  /**
   * A file added to the note contract changes `packages/shared/stryker.config.json`. That ran the
   * whole worker too, and the worker ran out of time on #427 (FRU-336), with no mutant of its own changed.
   */
  it('mutates the whole scope of a package for its own configuration, and not for the one of another', () => {
    assert.deepEqual(choose('apps/worker', scope, 'pull_request', ['packages/shared/stryker.config.json']), {
      mutate: [],
      full: false,
      line: false,
    });
    assert.deepEqual(choose('apps/worker', scope, 'pull_request', ['apps/worker/stryker.config.json']), {
      mutate: scope,
      full: true,
      line: true,
    });
  });

  it('gives each file a job of its own, with an artifact that names its package and its file', () => {
    const { jobs, lines } = plan([
      { pkg: 'packages/shared', mutate: ['src/note.ts'], full: false, line: false },
      { pkg: 'apps/worker', mutate: ['src/kv.ts', 'src/cors.ts'], full: true, line: true },
      { pkg: 'apps/extension', mutate: [], full: true, line: true },
      { pkg: 'apps/console', mutate: ['src/a.ts'], full: false, line: true },
    ]);

    // A package mutated in full starts from nothing: its run is the one the next ones start from (FRU-341).
    assert.deepEqual(jobs, [
      {
        package: 'packages/shared',
        file: 'src/note.ts',
        artifact: 'mutation--packages-shared--src-note.ts',
        incremental: true,
      },
      { package: 'apps/worker', file: 'src/kv.ts', artifact: 'mutation--apps-worker--src-kv.ts', incremental: false },
      {
        package: 'apps/worker',
        file: 'src/cors.ts',
        artifact: 'mutation--apps-worker--src-cors.ts',
        incremental: false,
      },
      { package: 'apps/console', file: 'src/a.ts', artifact: 'mutation--apps-console--src-a.ts', incremental: true },
    ]);
    // A package with nothing to mutate has no line to hold.
    assert.deepEqual(lines, ['apps/worker', 'apps/console']);
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
      mutate: ['src/note.ts', 'src/issue.ts'],
      full: false,
      line: false,
    });
  });

  it('reads the scope of a configuration, and leaves out what it excludes', () => {
    assert.deepEqual(scopeOf({ mutate: ['src/a.ts', '!src/b.ts'] }), ['src/a.ts']);
    assert.deepEqual(scopeOf({}), []);
  });
});

describe('the configuration of the mutation job', () => {
  it('mutates every file of the note contract, and its tests are not mutated', () => {
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
   * no test is left out of the run. Under vitest (FRU-346), the run reads the `include` of
   * `vitest.config.ts`, and `related` would narrow it to the tests that import a mutated file: a test
   * that starts the worker in a process, or reads a document, would be left out.
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
    const { testRunner, vitest } = WORKER as {
      testRunner?: string;
      vitest?: { configFile?: string; related?: boolean };
    };
    const config = readFileSync(new URL('apps/worker/vitest.config.ts', ROOT), 'utf8');

    assert.deepEqual(readers, [], 'a test reads a mutated file as text: import the module and its constants');
    assert.equal(testRunner, 'vitest');
    assert.deepEqual(
      vitest,
      { configFile: 'vitest.mutation.config.ts', related: false },
      'a test is left out of the mutation run of the worker',
    );
    // The configuration of the mutation run changes the order of the tests, and nothing else.
    const { sequence, ...rest } = mutation.test ?? {};
    assert.deepEqual(rest, base.test, 'the mutation run of the worker runs other tests, or runs them otherwise');
    assert.ok(
      sequence?.sequencer !== undefined,
      'the mutation run of the worker runs its tests in the order of vitest',
    );
    assert.match(
      config,
      /^ {4}include: \['src\/\*\*\/\*\.test\.ts'\],$/m,
      'a test is left out of the mutation run of the worker',
    );
  });

  /**
   * vitest runs the largest test files first. Under StrykerJS a mutant then ran the route tests on
   * PGlite before the unit test that kills it: 87.7 tests a mutant on `cache.ts`, and 4.5 in this
   * order (FRU-451).
   */
  it('runs the test of the mutated file first, then the other test files, smallest first', () => {
    const files = [
      { path: 'src/app.test.ts', size: 90_000 },
      { path: 'src/cors.test.ts', size: 9_000 },
      { path: 'src/cache.test.ts', size: 12_000 },
      { path: 'src/batch.test.ts', size: 9_000 },
    ];

    assert.deepEqual(mutationOrder(files, 'src/cache.ts'), [
      'src/cache.test.ts',
      'src/batch.test.ts',
      'src/cors.test.ts',
      'src/app.test.ts',
    ]);
    // With no file named, or a file with no test of its name, the smallest first.
    assert.deepEqual(mutationOrder(files, undefined), mutationOrder(files, 'src/kv.ts'));
    assert.deepEqual(mutationOrder(files, undefined), [
      'src/batch.test.ts',
      'src/cors.test.ts',
      'src/cache.test.ts',
      'src/app.test.ts',
    ]);
  });

  /**
   * The order reads the file of the job from `MUTATE`, the variable that gives it to `--mutate`.
   */
  it('gives StrykerJS the file of the job in MUTATE', () => {
    const { jobs } = parseDocument(readFileSync(new URL('.github/workflows/mutation.yml', ROOT), 'utf8')).toJS() as {
      jobs: { mutation: { steps: { name?: string; run?: string; env?: Record<string, string> }[] } };
    };
    const mutate = jobs.mutation.steps.find((step) => step.name === 'Mutate');

    assert.equal(mutate?.env?.MUTATE, '${{ matrix.file }}');
    assert.match(String(mutate?.run), /--mutate "\$MUTATE"/);
  });

  /**
   * The runner of StrykerJS loads vitest from `tools/mutation`, and the tests import it from the
   * workspace. Two versions would run the tests of one under the runner of the other.
   * `@stryker-mutator/vitest-runner` 10.0.0 found no test under vitest 5.0.5 (measured on 2026-10-21):
   * every mutant survived.
   */
  it('runs the worker under the vitest that its tests import, with the coverage of each test', () => {
    const tools = JSON.parse(readFileSync(new URL('tools/mutation/package.json', ROOT), 'utf8')) as {
      devDependencies: Record<string, string>;
    };
    const catalog = parseDocument(readFileSync(new URL('pnpm-workspace.yaml', ROOT), 'utf8')).toJS() as {
      catalog: Record<string, string>;
    };

    assert.ok(tools.devDependencies.vitest !== undefined, 'tools/mutation installs no vitest');
    assert.equal(tools.devDependencies.vitest, catalog.catalog.vitest);
    assert.equal((WORKER as { coverageAnalysis?: string }).coverageAnalysis, 'perTest');
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

  /** A job that StrykerJS stopped holds no line: on a pull request it warns, since it reads as green. */
  it('warns when StrykerJS did not finish, whatever stopped it', () => {
    const steps = jobs.mutation?.steps ?? [];
    const mutate = steps.find((step) => step.name === 'Mutate');
    const say = steps.find((step) => step.name === 'Say that the file was not measured');

    assert.equal(mutate?.id, 'mutate');
    assert.equal(say?.if, "always() && steps.mutate.outcome != 'success'");
    assert.match(String(say?.run), /^echo "::warning title=mutation::/);
  });
});

/**
 * The report an incremental job starts from (FRU-341). StrykerJS takes from it the result of each
 * mutant whose code and tests did not change, so a report of another repository, or of a branch the
 * pull request does not start from, would put results in the score that nobody measured here.
 */
describe('the report a mutation job of a pull request starts from', () => {
  const REPOSITORY = 1323024055;
  const artifact = (id: number, branch: string, created: string, more: Partial<Artifact> = {}): Artifact => ({
    id,
    name: 'mutation--apps-worker--src-cors.ts',
    expired: false,
    created_at: created,
    workflow_run: { id: id * 10, head_branch: branch, head_repository_id: REPOSITORY },
    ...more,
  });

  it('takes the newest report of the base branch, and of main when the base has none', () => {
    const reports = [
      artifact(1, 'main', '2026-10-19T03:40:00Z'),
      artifact(2, 'main', '2026-10-26T03:40:00Z'),
      artifact(3, 'fru-x/stacked-base', '2026-10-21T10:00:00Z'),
      artifact(4, 'fru-y/other', '2026-10-27T10:00:00Z'),
    ];

    assert.equal(pick(reports, REPOSITORY, ['fru-x/stacked-base', 'main'])?.id, 3);
    assert.equal(pick(reports, REPOSITORY, ['main', 'main'])?.id, 2);
    assert.equal(pick(reports, REPOSITORY, ['fru-z/no-run', 'main'])?.id, 2);
    assert.equal(pick(reports, REPOSITORY, ['fru-z/no-run']), undefined);
    assert.equal(pick([], REPOSITORY, ['main']), undefined);
  });

  it('takes no report that expired, or that a fork made on a branch of the same name', () => {
    const fork = artifact(5, 'main', '2026-10-27T03:40:00Z', {
      workflow_run: { id: 50, head_branch: 'main', head_repository_id: 42 },
    });
    const expired = artifact(6, 'main', '2026-10-28T03:40:00Z', { expired: true });
    const kept = artifact(7, 'main', '2026-10-01T03:40:00Z');

    assert.equal(pick([fork, expired, kept], REPOSITORY, ['main'])?.id, 7);
    assert.equal(pick([fork, expired], REPOSITORY, ['main']), undefined);
    assert.equal(
      pick([artifact(8, 'main', '2026-10-01T03:40:00Z', { workflow_run: null })], REPOSITORY, ['main']),
      undefined,
    );
  });

  /**
   * Under vitest a test has a place, and StrykerJS calls a test changed only when its lines changed.
   * A helper changed above every test would then keep the old results: a test file that changed at
   * all is taken out of the report, so each of its tests is new.
   */
  it('takes out of the report each test file that changed or is gone, and keeps the others', () => {
    const report = {
      files: { 'src/a.ts': { source: 'a' } },
      testFiles: {
        'src/same.test.ts': { source: 'same' },
        'src/helper-changed.test.ts': { source: 'const helper = 1;\nit("x")' },
        'src/gone.test.ts': { source: 'gone' },
      },
    };
    const now: Record<string, string> = {
      'src/same.test.ts': 'same',
      'src/helper-changed.test.ts': 'const helper = 2;\nit("x")',
    };
    const { report: kept, dropped } = coarsen(report, (file) => now[file]);

    assert.deepEqual(dropped, ['src/gone.test.ts', 'src/helper-changed.test.ts']);
    assert.deepEqual(Object.keys(kept.testFiles ?? {}), ['src/same.test.ts']);
    // The mutants and their sources are left as they are: StrykerJS diffs those itself.
    assert.deepEqual(kept.files, report.files);
    assert.deepEqual(coarsen({ files: {} }, () => undefined).dropped, []);
  });

  it('starts from no report when the reports cannot be listed, so that the whole file runs', () => {
    const listed = find(() => [artifact(9, 'main', '2026-10-26T03:40:00Z')], REPOSITORY, ['main']);
    assert.equal(listed.artifact?.id, 9);
    assert.equal(listed.why, undefined);

    const failed = find(
      () => {
        throw new Error('HTTP 403: API rate limit exceeded\nmore');
      },
      REPOSITORY,
      ['main'],
    );
    assert.deepEqual(failed, { why: 'HTTP 403: API rate limit exceeded' });
  });

  it('reads the base branch, then main, once each', () => {
    assert.deepEqual(branchesOf(['main', 'main']), ['main']);
    assert.deepEqual(branchesOf(['', 'main']), ['main']);
    assert.deepEqual(branchesOf(['fru-x/stacked-base', 'main']), ['fru-x/stacked-base', 'main']);
  });

  /**
   * A full run measures every mutant: the step that takes a report runs only for a job that the plan
   * made incremental, and StrykerJS reads the file that step writes. With no file it mutates all.
   */
  it('runs only for an incremental job, and gives StrykerJS the file it wrote', () => {
    type Step = { name?: string; if?: string; env?: Record<string, string>; run?: string };
    const { jobs } = parseDocument(readFileSync(new URL('.github/workflows/mutation.yml', ROOT), 'utf8')).toJS() as {
      jobs: { mutation: { permissions?: Record<string, string>; steps: Step[] } };
    };
    const take = jobs.mutation.steps.find((step) => step.name === 'Take the report to start from');
    const mutate = jobs.mutation.steps.find((step) => step.name === 'Mutate');

    assert.equal(take?.if, 'matrix.incremental');
    assert.equal(
      take?.run,
      'node tools/mutation/reference.ts "$ARTIFACT" "$PACKAGE/reports/stryker-incremental.json" "$BASE" main',
    );
    assert.equal(take?.env?.BASE, '${{ github.base_ref }}');
    assert.equal(take?.env?.ARTIFACT, '${{ matrix.artifact }}');
    assert.match(String(mutate?.run), / --incremental --incrementalFile reports\/stryker-incremental\.json /);
    assert.deepEqual(jobs.mutation.permissions, { contents: 'read', actions: 'read' });
    assert.ok(
      jobs.mutation.steps.indexOf(take as Step) < jobs.mutation.steps.indexOf(mutate as Step),
      'the report is taken after StrykerJS ran',
    );
  });
});
