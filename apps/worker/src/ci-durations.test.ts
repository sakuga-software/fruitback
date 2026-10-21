import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import {
  argsOf,
  dryRunOf,
  format,
  nearLimit,
  STRYKER_DRY_RUN_MINUTES,
  strykerOf,
  summary,
  WARN_AT,
  warnings,
} from '../../../tools/ci/durations.ts';

/**
 * `tools/ci/durations.ts` writes what a long CI job took, and warns past 60 % of its limit (FRU-343).
 *
 * It lives here, beside `workflows.test.ts` and `mutation.test.ts`, because the root has no `test`
 * target.
 */

const ROOT = new URL('../../../', import.meta.url);
const SCRIPT = fileURLToPath(new URL('tools/ci/durations.ts', ROOT));

/** The line StrykerJS 10 wrote for the dry run of `session.ts` on 2026-10-21 (run 39565743025). */
const DRY_RUN_LINE =
  '08:04:27 (2415) INFO DryRunExecutor Initial test run succeeded. Ran 105 tests in 5 minutes and 36 seconds ' +
  '(net 281555.0044400001 ms, overhead 54528.995559999894 ms).';

describe('durations.ts', () => {
  it('warns past 60 % of a limit, and not at 60 % or below', () => {
    assert.equal(WARN_AT, 0.6);
    // 150 minutes, the job of mutation: 60 % is 90 minutes.
    assert.equal(nearLimit(90 * 60, 150 * 60), false);
    assert.equal(nearLimit(90 * 60 + 1, 150 * 60), true);
    assert.equal(nearLimit(10, 150 * 60), false);
    // 30 minutes, the dry run of the worker: 60 % is 18 minutes.
    assert.equal(nearLimit(18 * 60, 30 * 60), false);
    assert.equal(nearLimit(18 * 60 + 1, 30 * 60), true);
  });

  it('writes one warning for each measure past its 60 %, and none for one under it', () => {
    const lines = warnings('mutation apps/worker src/clients.ts', [
      { what: 'Job', took: 95 * 60, limit: 150 * 60 },
      { what: 'Dry run', took: 5 * 60 + 36, limit: 30 * 60 },
    ]);

    assert.deepEqual(lines, [
      '::warning title=mutation apps/worker src/clients.ts nears its limit::Job took 95 min 0 s, 63 % of its 150 minutes. It fails at 100 %.',
    ]);
    assert.deepEqual(warnings('postgres', [{ what: 'Job', took: 6 * 60, limit: 10 * 60 }]), []);
  });

  it('reads the dry run from the log of StrykerJS', () => {
    const dry = dryRunOf(`... Starting initial test run ...\n${DRY_RUN_LINE}\n`);

    assert.equal(dry.seconds !== undefined && Math.round(dry.seconds), 336);
    assert.equal(format(336.084), '5 min 36 s');
    assert.equal(format(42), '42 s');
    assert.deepEqual(dryRunOf('INFO DryRunExecutor Starting initial test run (tap test runner)'), {
      seconds: undefined,
      started: true,
    });
    assert.deepEqual(dryRunOf(''), { seconds: undefined, started: false });
  });

  it('reads the dry run, the mutants and the test files of a package, and its dryRunTimeoutMinutes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fruitback-durations-'));
    try {
      mkdirSync(join(dir, 'reports/mutation'), { recursive: true });
      writeFileSync(join(dir, 'stryker.log'), `${DRY_RUN_LINE}\n`);
      writeFileSync(join(dir, 'stryker.config.json'), JSON.stringify({ dryRunTimeoutMinutes: 30 }));
      writeFileSync(
        join(dir, 'reports/mutation/mutation.json'),
        JSON.stringify({
          files: { 'src/a.ts': { mutants: [{}, {}] }, 'src/b.ts': { mutants: [{}] } },
          testFiles: { 'src/a.test.ts': {}, 'src/b.test.ts': {} },
        }),
      );
      const read = strykerOf(dir);
      assert.equal(read.measure.limit, 30 * 60);
      assert.equal(Math.round(read.measure.took ?? 0), 336);
      assert.deepEqual(read.counts, ['3 mutants', '2 test files']);

      // A package that sets no dryRunTimeoutMinutes has the 5 minutes of StrykerJS.
      writeFileSync(join(dir, 'stryker.config.json'), '{}');
      assert.equal(strykerOf(dir).measure.limit, STRYKER_DRY_RUN_MINUTES * 60);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // A job that stopped before StrykerJS wrote anything is not measured, says why, and does not throw.
    const absent = join(tmpdir(), 'fruitback-durations-absent');
    assert.deepEqual(strykerOf(absent), {
      measure: {
        what: 'Dry run',
        took: undefined,
        limit: STRYKER_DRY_RUN_MINUTES * 60,
        why: `no stryker.log in ${absent}, which \`--fileLogLevel info\` writes`,
      },
      counts: [],
    });
  });

  /** A measure lost in silence is the drift this file is for, unseen (raised in review). */
  it('warns of a measure it could not take, and says why', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fruitback-durations-'));
    try {
      writeFileSync(join(dir, 'stryker.log'), 'INFO DryRunExecutor Starting initial test run (tap test runner)\n');
      const dry = strykerOf(dir).measure;
      assert.equal(dry.why, 'the dry run started and did not end');

      assert.deepEqual(
        warnings('mutation apps/worker src/kv.ts', [
          { what: 'Job', took: undefined, limit: 9000, why: 'JOB_STARTED_AT is not set, by the first step of the job' },
          dry,
        ]),
        [
          '::warning title=mutation apps/worker src/kv.ts not measured::Job was not measured: JOB_STARTED_AT is not set, by the first step of the job.',
          '::warning title=mutation apps/worker src/kv.ts not measured::Dry run was not measured: the dry run started and did not end.',
        ],
      );
      assert.match(
        summary('kv', [dry], []),
        /^\| Dry run \| not measured: the dry run started and did not end \| 5 min \| {2}\|$/m,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes a table of each measure against its limit', () => {
    const text = summary('postgres', [{ what: 'Job', took: 7 * 60, limit: 10 * 60 }], ['3 mutants']);

    assert.match(text, /^### Durations of postgres$/m);
    assert.match(text, /^\| Job \| 7 min 0 s \| 10 min \| 70 %, past 60 % \|$/m);
    assert.match(text, /^3 mutants$/m);
    assert.deepEqual(argsOf(['--name', 'e2e 1', '--timeout', '15']), { name: 'e2e 1', timeout: '15' });
  });

  it('writes the summary, prints the warning, and exits 0, even on what it cannot read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fruitback-durations-'));
    try {
      const out = join(dir, 'summary.md');
      const run = (args: string[], started: string) =>
        execFileSync(process.execPath, [SCRIPT, ...args], {
          encoding: 'utf8',
          env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: out, JOB_STARTED_AT: started },
        });
      // Seven minutes ago, on a limit of ten: 70 %.
      const printed = run(['--name', 'postgres', '--timeout', '10'], String(Math.floor(Date.now() / 1000) - 7 * 60));

      assert.match(printed, /^::warning title=postgres nears its limit::Job took 7 min \d+ s, 70 % of its 10 minutes/m);
      assert.match(readFileSync(out, 'utf8'), /^\| Job \| 7 min \d+ s \| 10 min \| 70 %, past 60 % \|$/m);
      // The same table in the log, which an API returns, and the summary does not.
      assert.match(
        printed,
        /^::group::Durations\n### Durations of postgres\n[^]*^\| Job \| 7 min \d+ s \| 10 min \| 70 %, past 60 % \|$[^]*^::endgroup::$/m,
      );

      // A stryker.config.json that is not JSON: a warning about the script, and still exit 0.
      writeFileSync(join(dir, 'stryker.config.json'), 'not json');
      assert.match(run(['--name', 'x', '--timeout', '10', '--stryker', dir], ''), /^::warning title=durations\.ts::/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A step of a workflow, as far as this reads it. */
type Step = { name?: string; if?: string; 'continue-on-error'?: boolean; env?: Record<string, string>; run?: string };
type Job = { 'timeout-minutes'?: number; steps: Step[] };

const WORKFLOWS: Record<string, URL> = {
  'ci.yml': new URL('.github/workflows/ci.yml', ROOT),
  'mutation.yml': new URL('.github/workflows/mutation.yml', ROOT),
};

function jobsOf(file: string): Record<string, Job> {
  const url = WORKFLOWS[file];
  assert.ok(url, `no workflow ${file}`);

  return (parseDocument(readFileSync(url, 'utf8')).toJS() as { jobs: Record<string, Job> }).jobs;
}

describe('the long jobs of CI', () => {
  const LONG: [file: string, job: string][] = [
    ['ci.yml', 'check'],
    ['ci.yml', 'e2e-shard'],
    ['ci.yml', 'postgres'],
    ['ci.yml', 'image'],
    ['mutation.yml', 'mutation'],
  ];

  /**
   * No context gives its `timeout-minutes` to a step, so the step repeats it. A limit raised in one
   * place and not the other would warn at the wrong time: this holds them equal.
   */
  it('note when they start, and write their durations against their own timeout-minutes, always', () => {
    for (const [file, name] of LONG) {
      const job = jobsOf(file)[name];
      assert.ok(job, `${file} has no job ${name}`);
      const first = job.steps[0];
      const last = job.steps.at(-1);
      const timeout = job['timeout-minutes'];

      assert.equal(first?.run, 'echo "JOB_STARTED_AT=$(date +%s)" >> "$GITHUB_ENV"', `${file} ${name}: first step`);
      assert.equal(typeof timeout, 'number', `${file} ${name} has no timeout-minutes: 60 % of 360 warns of nothing`);
      assert.equal(last?.name, 'Write the durations', `${file} ${name}: last step`);
      assert.equal(last?.if, 'always()', `${file} ${name}: a job that failed has durations too`);
      // The step only warns: what it reads must never fail the job it measures.
      assert.equal(last?.['continue-on-error'], true, `${file} ${name}: the durations can fail the job`);
      assert.match(
        String(last?.run),
        new RegExp(`^node tools/ci/durations\\.ts --name "\\$NAME" --timeout ${timeout}\\b`),
      );
    }
  });

  it('read the dry run of a mutation job from the log that StrykerJS writes', () => {
    const job = jobsOf('mutation.yml').mutation;
    const mutate = job?.steps.find((step) => step.name === 'Mutate');

    assert.match(String(mutate?.run), /--fileLogLevel info$/);
    assert.match(String(job?.steps.at(-1)?.run), /--stryker "\$PACKAGE"$/);
    assert.equal(job?.steps.at(-1)?.env?.PACKAGE, '${{ matrix.package }}');
  });
});
