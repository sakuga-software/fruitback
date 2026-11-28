import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Whether a part of the E2E suite had a test that failed once and passed on its retry (FRU-737).
 *
 *   node tools/ci/e2e-flaky.ts playwright-report/results.json
 *
 * It reads the report of the `json` reporter of `playwright.config.ts`, prints each flaky test, and
 * writes `flaky=true` or `flaky=false` to `$GITHUB_OUTPUT`. The job then keeps its traces when the
 * part failed and also when a test was flaky. Such a part is green, so before this a flaky test lost
 * the trace of its first run, and the cause had to be read again in the logs of each job (FRU-736).
 *
 * A missing report is not an error: the run can stop before the reporter writes it, and the upload
 * then runs on the failure of the run. It writes `flaky=false` and says so.
 */

/** The parts of the `json` reporter's report that this script reads. */
type Report = { config?: { rootDir?: string }; suites?: Suite[] };
type Suite = { title: string; specs?: Spec[]; suites?: Suite[] };
type Spec = { title: string; file: string; line: number; tests: { status: string; projectName?: string }[] };

/** One test that failed on its first run and passed on a retry. */
export type Flaky = { file: string; line: number; title: string };

/** Every flaky test of a report, in the order of the report. `file` is relative to `cwd`. */
export function flakyOf(report: Report, cwd: string): Flaky[] {
  const rootDir = report.config?.rootDir ?? cwd;
  const found: Flaky[] = [];
  const walk = (suite: Suite, titles: string[]) => {
    for (const spec of suite.specs ?? []) {
      if (!spec.tests.some((test) => test.status === 'flaky')) continue;
      found.push({
        file: relative(cwd, join(rootDir, spec.file)),
        line: spec.line,
        title: [...titles, spec.title].join(' › '),
      });
    }
    for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
  };
  // The title of a top suite is its file name, which `file` already says.
  for (const suite of report.suites ?? []) walk(suite, []);

  return found;
}

function main([path = '']: string[]): void {
  const write = (flaky: boolean) => {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `flaky=${flaky}\n`);
  };
  if (!existsSync(path)) {
    console.log(`No report at ${path}: the run stopped before the reporter wrote it.`);
    write(false);

    return;
  }

  const flaky = flakyOf(JSON.parse(readFileSync(path, 'utf8')) as Report, process.cwd());
  for (const test of flaky) console.log(`flaky: ${test.file}:${test.line} › ${test.title}`);
  console.log(
    flaky.length === 0
      ? 'No test of this part passed only on its retry.'
      : `${flaky.length} test(s) passed only on the retry: the traces of their first run are kept.`,
  );
  write(flaky.length > 0);
}

if (import.meta.main) main(process.argv.slice(2));
