import { readFileSync } from 'node:fs';

/**
 * What a mutation run of the `tap` runner costs, read from its reports (FRU-342).
 *
 * Under `tap`, a test for StrykerJS is a test file. A mutant runs, in their order, the test files that
 * reach it, each in its own process, and stops at the first that fails (`forceBail`). So a report
 * says exactly how many files each mutant ran: `testsCompleted` is the place of its killer in
 * `coveredBy`, plus one, and a survivor ran all of `coveredBy`. This script checks that, then:
 *
 * - counts, for each mutated file, the test files that reach a mutant and those that it ran;
 * - lists the test files that killed a mutant first (`killedBy`), the « killers »;
 * - plays the same run again with `tap.testFiles` cut down to the killers of that file, and says
 *   which mutant could change: a killed mutant cannot, since its killer still runs; a timeout can.
 *
 * With `--times`, it also estimates the time in seconds. A timeout takes the budget of StrykerJS
 * 10.0.0 (`mutant-test-planner.js`): 1.5 × the net time of the files that reach it, + 5 s, + the
 * overhead of the whole dry run, which under `tap` is one process start for each test file.
 *
 *   node tools/mutation-study/cost.ts [--times <tsv>] [--overhead <s>] [--concurrency <n>] <mutation.json>…
 *
 * `--times`: lines whose first column is seconds and last a test file, such as `node --test` timings of each file; a file listed
 * more than once takes the mean. `--overhead`: seconds to start one test process (default 0.4).
 * Nothing here runs StrykerJS or a test.
 */

type Mutant = {
  id: string;
  status: string;
  coveredBy?: string[];
  killedBy?: string[];
  testsCompleted?: number;
};

type Report = {
  files: Record<string, { mutants: Mutant[] }>;
  testFiles?: Record<string, { tests: { id: string; name: string }[] }>;
};

/** What one mutated file costs, for one set of test files. */
export type Cost = {
  mutants: number;
  /** Mean of the test files that reach a mutant. */
  reached: number;
  /** Mean of the test files that a mutant ran (a timeout counts the files that reach it). */
  ran: number;
  /** Test files that the dry run runs. */
  dryRun: number;
  /** Estimated seconds of test processes, mutants and dry run, when times are known. */
  seconds?: { mutants: number; timeouts: number; dryRun: number };
};

const TIMEOUT_FACTOR = 1.5;
const TIMEOUT_MS = 5000;

export function testNames(report: Report): Map<string, string> {
  const names = new Map<string, string>();
  for (const [file, { tests }] of Object.entries(report.testFiles ?? {})) {
    for (const test of tests) names.set(test.id, file);
  }
  return names;
}

/** The mutants whose `testsCompleted` does not follow from `coveredBy` and `killedBy`. */
export function inconsistent(mutants: Mutant[]): Mutant[] {
  return mutants.filter((mutant) => {
    const reach = mutant.coveredBy ?? [];
    if (mutant.status === 'Killed') {
      return mutant.testsCompleted !== reach.indexOf(mutant.killedBy?.[0] ?? '') + 1;
    }
    if (mutant.status === 'Survived') return mutant.testsCompleted !== reach.length;
    return false;
  });
}

/** The test files that ran first for each killed mutant, with the number of mutants each killed. */
export function killers(mutants: Mutant[]): Map<string, number> {
  const count = new Map<string, number>();
  for (const mutant of mutants) {
    const killer = mutant.status === 'Killed' ? mutant.killedBy?.[0] : undefined;
    if (killer !== undefined) count.set(killer, (count.get(killer) ?? 0) + 1);
  }
  return count;
}

/**
 * The cost of the run with only `keep` as test files (all of them when `keep` is undefined). Order
 * and bail are those of the `tap` runner, so a killed mutant runs up to its killer.
 */
export function cost(
  mutants: Mutant[],
  allTests: string[],
  keep: Set<string> | undefined,
  time?: (test: string) => number,
  overhead = 0,
): Cost {
  const kept = (ids: string[]) => (keep === undefined ? ids : ids.filter((id) => keep.has(id)));
  const dryRunTests = kept(allTests);
  let reached = 0;
  let ran = 0;
  let mutantSeconds = 0;
  let timeoutSeconds = 0;
  const net = (ids: string[]) => ids.reduce((sum, id) => sum + (time?.(id) ?? 0), 0);

  for (const mutant of mutants) {
    const reach = kept(mutant.coveredBy ?? []);
    reached += reach.length;
    if (mutant.status === 'Timeout') {
      ran += reach.length;
      timeoutSeconds += TIMEOUT_FACTOR * net(reach) + TIMEOUT_MS / 1000 + overhead * dryRunTests.length;
      continue;
    }
    const killer = mutant.status === 'Killed' ? reach.indexOf(mutant.killedBy?.[0] ?? '') : -1;
    const run = killer >= 0 ? reach.slice(0, killer + 1) : reach;
    ran += run.length;
    mutantSeconds += net(run) + overhead * run.length;
  }

  const result: Cost = {
    mutants: mutants.length,
    reached: reached / mutants.length,
    ran: ran / mutants.length,
    dryRun: dryRunTests.length,
  };
  if (time !== undefined) {
    result.seconds = {
      mutants: mutantSeconds,
      timeouts: timeoutSeconds,
      dryRun: net(dryRunTests) + overhead * dryRunTests.length,
    };
  }
  return result;
}

function readTimes(path: string): Map<string, number> {
  const sums = new Map<string, number[]>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const columns = line.split('\t');
    const seconds = columns[0];
    const file = columns.at(-1);
    if (columns.length < 2 || file === undefined || seconds === undefined || Number.isNaN(Number(seconds))) continue;
    sums.set(file, [...(sums.get(file) ?? []), Number(seconds)]);
  }
  return new Map([...sums].map(([file, list]) => [file, list.reduce((a, b) => a + b, 0) / list.length]));
}

const round = (value: number) => (Math.round(value * 10) / 10).toString();
const minutes = (seconds: number) =>
  `${Math.floor(seconds / 60)} min ${String(Math.round(seconds % 60)).padStart(2, '0')}`;

function main(args: string[]) {
  const option = (name: string) => {
    const at = args.indexOf(name);
    if (at < 0) return undefined;
    const [value] = args.splice(at, 2).slice(1);
    return value;
  };
  const timesPath = option('--times');
  const overhead = Number(option('--overhead') ?? '0.4');
  const concurrency = Number(option('--concurrency') ?? '4');
  if (args.length === 0) {
    console.error(
      'usage: node tools/mutation-study/cost.ts [--times <tsv>] [--overhead <s>] [--concurrency <n>] <mutation.json>…',
    );
    process.exit(2);
  }
  const times = timesPath === undefined ? undefined : readTimes(timesPath);

  const rows: string[] = [];
  const pruned: string[] = [];
  const killerRows: string[] = [];
  for (const path of args) {
    const report = JSON.parse(readFileSync(path, 'utf8')) as Report;
    const names = testNames(report);
    const allTests = [...names.keys()];
    const time = times === undefined ? undefined : (id: string) => times.get(names.get(id) ?? '') ?? 0;
    for (const [file, { mutants }] of Object.entries(report.files)) {
      const status = (s: string) => mutants.filter((m) => m.status === s).length;
      const wrong = inconsistent(mutants);
      if (wrong.length > 0) {
        console.error(`${file}: ${wrong.length} mutants do not follow the tap order and bail; the model does not hold`);
      }
      const loadTime = mutants.filter((m) => (m.coveredBy ?? []).length * 2 >= allTests.length).length;
      const kill = killers(mutants);
      const keep = new Set(kill.keys());
      const before = cost(mutants, allTests, undefined, time, overhead);
      const after = cost(mutants, allTests, keep, time, overhead);
      const timeouts = mutants.filter((m) => m.status === 'Timeout');
      const timeoutsKept = timeouts.filter((m) => (m.coveredBy ?? []).every((id) => keep.has(id))).length;
      const timeoutsBare = timeouts.filter((m) => !(m.coveredBy ?? []).some((id) => keep.has(id))).length;

      rows.push(
        `| \`${file}\` | ${mutants.length} | ${status('Killed')} / ${status('Timeout')} / ${status('Survived')} / ${status('NoCoverage')} | ${allTests.length} | ${round(before.reached)} | ${round(before.ran)} | ${loadTime} | ${keep.size} |`,
      );
      const estimate = (c: Cost) =>
        c.seconds === undefined
          ? ''
          : ` ${minutes(c.seconds.dryRun)} | ${minutes((c.seconds.mutants + c.seconds.timeouts) / concurrency)} |`;
      pruned.push(
        `| \`${file}\` | ${before.dryRun} → ${after.dryRun} | ${round(before.ran)} → ${round(after.ran)} | ${timeoutsKept} of ${timeouts.length} | ${timeoutsBare} |${estimate(before)}${estimate(after)}`,
      );
      killerRows.push(
        `| \`${file}\` | ${[...kill]
          .sort((a, b) => b[1] - a[1])
          .map(([id, n]) => `${(names.get(id) ?? id).replace(/^src\//, '')} ${n}`)
          .join(', ')} |`,
      );
    }
  }

  console.log('## Test files for each mutant\n');
  console.log(
    '| Mutated file | Mutants | Killed / Timeout / Survived / NoCoverage | Test files | Reached, mean | Ran, mean | Reached by half the files or more | Killers |',
  );
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
  console.log(rows.join('\n'));
  console.log('\n## With `tap.testFiles` cut down to the killers of the file\n');
  const timeHead = times === undefined ? '' : ' Dry run | Mutants | Dry run, cut | Mutants, cut |';
  const timeRule = times === undefined ? '' : ' --- | --- | --- | --- |';
  console.log(
    `| Mutated file | Dry run files | Ran, mean | Timeouts whose files all stay | Timeouts left with no file |${timeHead}`,
  );
  console.log(`| --- | --- | --- | --- | --- |${timeRule}`);
  console.log(pruned.join('\n'));
  console.log('\n## Killers: test files that killed a mutant first, and how many\n');
  console.log('| Mutated file | Killers |');
  console.log('| --- | --- |');
  console.log(killerRows.join('\n'));
}

if (import.meta.main) main(process.argv.slice(2));
