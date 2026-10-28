import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

/**
 * Writes `e2e/durations.json` again: the seconds that each spec file took on CI, which
 * `e2e/shards.ts` reads to cut the suite in parts of the same time.
 *
 *   gh run view <run> --log > run-1.log   # one or more runs of `ci.yml`, all parts
 *   node tools/ci/e2e-durations.ts run-1.log run-2.log …
 *
 * It reads the lines of the `list` reporter (`✓  12 e2e/a.spec.ts:8:5 › … (4.2s)`) of every part.
 * A file is the sum of its tests in one run, retries included: a retry takes the time of the part
 * too. Over several runs, it keeps the median. A spec file of `e2e/` that no run measured is left
 * out, and counts as the mean.
 */

const LINE = /^e2e \(\d+\/\d+\)\t.*?[✓✘-]\s+\d+ e2e\/([\w.-]+\.spec\.ts):\d+:\d+ .*\(([\d.]+)(m?s)\)\s*$/u;

/** The seconds of each spec file in the log of one run. */
export function secondsOf(log: string): Map<string, number> {
  const seconds = new Map<string, number>();
  for (const line of log.split('\n')) {
    const match = LINE.exec(line);
    if (match === null) continue;
    const [, file = '', value = '0', unit] = match;
    seconds.set(file, (seconds.get(file) ?? 0) + Number(value) / (unit === 'ms' ? 1000 : 1));
  }

  return seconds;
}

export function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** The median seconds of each file of `files` over the runs, rounded to a tenth. */
export function durationsOf(runs: readonly Map<string, number>[], files: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const file of files.toSorted()) {
    const measured = runs.flatMap((run) => (run.has(file) ? [run.get(file) ?? 0] : []));
    if (measured.length > 0) out[file] = Math.round(median(measured) * 10) / 10;
  }

  return out;
}

if (import.meta.main) {
  const logs = process.argv.slice(2);
  if (logs.length === 0) {
    console.error('usage: node tools/ci/e2e-durations.ts <log of a run>…');
    process.exit(2);
  }
  const files = readdirSync('e2e').filter((name) => name.endsWith('.spec.ts'));
  const durations = durationsOf(
    logs.map((path) => secondsOf(readFileSync(path, 'utf8'))),
    files,
  );
  writeFileSync('e2e/durations.json', `${JSON.stringify(durations, null, 2)}\n`);
  console.log(`e2e/durations.json: ${Object.keys(durations).length} of ${files.length} spec files measured`);
}
