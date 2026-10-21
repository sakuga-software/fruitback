import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The durations of a CI job, and a warning before it runs out of time (FRU-343).
 *
 * The dry run of the mutation of the worker went from 1 min 07 on 2026-10-12 to 9 min 29 on
 * 2026-10-20, and no one saw it until the full run ran out of its 150 minutes. So the last step of
 * each long job writes what it took to the summary of the run and to its log, and a `::warning::`
 * when it took more than 60 % of its limit. For a mutation job: the dry run too, against
 * `dryRunTimeoutMinutes`, and the number of mutants and of test files.
 *
 *   node tools/ci/durations.ts --name <job> --timeout <minutes> [--stryker <package>]
 *
 * `JOB_STARTED_AT`, in seconds since the epoch, is set by the first step of the job. `--timeout` is
 * the `timeout-minutes` of the job: no context gives it to a step, and `ci-durations.test.ts` holds
 * the two equal. `--stryker` reads `stryker.log`, written by `--fileLogLevel info`, the report and
 * `stryker.config.json` of the package.
 *
 * This step only warns. It exits 0 whatever it reads, and its step has `continue-on-error`.
 */

/** A job or a dry run warns past this share of its limit. */
export const WARN_AT = 0.6;

/** The `dryRunTimeoutMinutes` of StrykerJS when the config does not set it. */
export const STRYKER_DRY_RUN_MINUTES = 5;

/**
 * One duration against its limit. `took` is `undefined` when it was not measured, and `why` says
 * why: a measure lost in silence is a drift no one sees (raised in review).
 */
export type Measure = { what: string; took: number | undefined; limit: number; why?: string };

/** Whether a duration took more than `WARN_AT` of its limit. Both in seconds. */
export function nearLimit(took: number, limit: number): boolean {
  return took > limit * WARN_AT;
}

/** `5 min 36 s`, `42 s`. */
export function format(seconds: number): string {
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);

  return minutes === 0 ? `${whole % 60} s` : `${minutes} min ${whole % 60} s`;
}

/** What StrykerJS says of its dry run, from its log. */
export type DryRun = { seconds: number; tests: number } | { seconds: undefined; started: boolean };

/**
 * The dry run, read from the log of StrykerJS 10:
 *
 *   Initial test run succeeded. Ran 105 tests in 5 minutes and 36 seconds (net 281555.0 ms, overhead 54529.0 ms).
 *
 * Net and overhead add up to the whole dry run. Under `tap` a test is a test file.
 */
export function dryRunOf(log: string): DryRun {
  const done = /Initial test run succeeded\. Ran (\d+) tests? .*\(net ([\d.]+) ms, overhead ([\d.]+) ms\)/.exec(log);
  if (done) {
    return { seconds: (Number(done[2]) + Number(done[3])) / 1000, tests: Number(done[1]) };
  }

  return { seconds: undefined, started: log.includes('Starting initial test run') };
}

/** The part of a report of `mutation-testing-report-schema` that this reads. */
export type Report = { files?: Record<string, { mutants?: unknown[] }>; testFiles?: Record<string, unknown> };

export function mutantsOf(report: Report): number {
  return Object.values(report.files ?? {}).reduce((sum, file) => sum + (file.mutants?.length ?? 0), 0);
}

export function testFilesOf(report: Report): number {
  return Object.keys(report.testFiles ?? {}).length;
}

/** The lines `::warning::` for each measure past `WARN_AT` of its limit, and for each not measured. */
export function warnings(name: string, measures: Measure[]): string[] {
  return measures.flatMap(({ what, took, limit, why }) => {
    if (took === undefined) {
      return [`::warning title=${name} not measured::${what} was not measured: ${why ?? 'no reason read'}.`];
    }
    if (!nearLimit(took, limit)) return [];

    return [
      `::warning title=${name} nears its limit::${what} took ${format(took)}, ` +
        `${Math.round((took / limit) * 100)} % of its ${limit / 60} minutes. It fails at 100 %.`,
    ];
  });
}

/** The summary of the job, in Markdown. */
export function summary(name: string, measures: Measure[], counts: string[]): string {
  const rows = measures.map(({ what, took, limit, why }) => {
    const share = took === undefined ? '' : `${Math.round((took / limit) * 100)} %`;
    const flag = took !== undefined && nearLimit(took, limit) ? ', past 60 %' : '';
    const time = took === undefined ? `not measured: ${why ?? 'no reason read'}` : format(took);

    return `| ${what} | ${time} | ${limit / 60} min | ${share}${flag} |`;
  });

  return [
    `### Durations of ${name}`,
    '',
    '| | Took | Limit | Share |',
    '|---|---|---|---|',
    ...rows,
    ...(counts.length === 0 ? [] : ['', counts.join(' · ')]),
    '',
    '',
  ].join('\n');
}

/**
 * How many mutant results an incremental run took from the report it started from (FRU-341), from
 * the line « Result: 812 of 829 mutant result(s) are reused. » of StrykerJS 10. The count may be
 * coloured. A run that started from no report has no such line.
 */
export function reusedOf(log: string): { reused: number; mutants: number } | undefined {
  // oxlint-disable-next-line no-control-regex -- the colour codes of chalk around the count
  const line = /(\d+)(?:\u001b\[[\d;]*m)* of (\d+) mutant result\(s\) are reused/.exec(log);

  return line === null ? undefined : { reused: Number(line[1]), mutants: Number(line[2]) };
}

/** What `--stryker <package>` reads. A file that is missing is not measured. */
export function strykerOf(dir: string): { measure: Measure; counts: string[] } {
  const read = (file: string) => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8') : undefined);
  const config = JSON.parse(read('stryker.config.json') ?? '{}') as { dryRunTimeoutMinutes?: number };
  const limit = (config.dryRunTimeoutMinutes ?? STRYKER_DRY_RUN_MINUTES) * 60;
  const log = read('stryker.log');
  const dry = log === undefined ? undefined : dryRunOf(log);
  const report = read('reports/mutation/mutation.json');
  const counts: string[] = [];

  if (report !== undefined) {
    const parsed = JSON.parse(report) as Report;
    counts.push(`${mutantsOf(parsed)} mutants`, `${testFilesOf(parsed)} test files`);
  } else if (dry?.seconds !== undefined) {
    counts.push(`${dry.tests} test files`);
  }
  const reused = log === undefined ? undefined : reusedOf(log);
  if (reused !== undefined) counts.push(`${reused.reused} of ${reused.mutants} results reused`);
  let why: string | undefined;
  if (dry === undefined) why = `no stryker.log in ${dir}, which \`--fileLogLevel info\` writes`;
  else if (dry.seconds === undefined) {
    why = dry.started ? 'the dry run started and did not end' : 'StrykerJS did not start its dry run';
  }

  return { measure: { what: 'Dry run', took: dry?.seconds, limit, ...(why === undefined ? {} : { why }) }, counts };
}

/** `--key value` pairs. */
export function argsOf(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i + 1 < argv.length; i += 2) {
    const key = argv[i];
    if (key?.startsWith('--')) args[key.slice(2)] = argv[i + 1] ?? '';
  }

  return args;
}

function main(argv: string[]): void {
  const args = argsOf(argv);
  const name = args.name ?? process.env.GITHUB_JOB ?? 'this job';
  const started = Number(process.env.JOB_STARTED_AT);
  const measures: Measure[] = [
    {
      what: 'Job',
      took: Number.isFinite(started) && started > 0 ? Date.now() / 1000 - started : undefined,
      limit: Number(args.timeout) * 60,
      why: 'JOB_STARTED_AT is not set, by the first step of the job',
    },
  ];
  const counts: string[] = [];

  if (args.stryker !== undefined) {
    const stryker = strykerOf(args.stryker);
    measures.push(stryker.measure);
    counts.push(...stryker.counts);
  }

  const text = summary(name, measures, counts);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  // The log too: the summary shows only to a signed-in reader, and no API returns it. The log is
  // what `gh run view --log` and an agent read.
  process.stdout.write(`::group::Durations\n${text}::endgroup::\n`);
  for (const line of warnings(name, measures)) console.log(line);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    // A step that measures must not fail the job it measures.
    console.log(`::warning title=durations.ts::${error instanceof Error ? error.message : String(error)}`);
  }
}
