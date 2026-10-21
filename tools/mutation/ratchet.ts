import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Job } from './scope.ts';

/**
 * The score of a mutation run may not go down (FRU-172).
 *
 * `baseline.json` holds, for each package that is mutated, the score of each file and of the
 * package, as a full run measured them. A run then fails when a file scores less than its line, and
 * a file with no line yet scores less than its package. A full run also fails when the package
 * scores less than its own line. The lines move up only by a commit: `write` prints them from the
 * reports of a full run.
 *
 * Each file is mutated by a job of its own (FRU-336), or by a job for each part of it (FRU-340), so a
 * package has one report per job. `line` reads the reports of all the jobs of a package together, and
 * fails when a job of the plan left no report, when two jobs measured the same mutant, and on a full
 * run when a file that has a line was not measured. `check` holds the line of one job: a part holds
 * only some mutants of its file, so `--part` prints its score and holds nothing.
 *
 * The score is the one Stryker reports: killed and timed out, over every mutant that was valid. A
 * mutant no test reaches counts against it, as one a test reaches and lets live.
 *
 *   node tools/mutation/ratchet.ts check <package> <mutation.json>… [--full | --part]
 *   node tools/mutation/ratchet.ts line <package> <reports directory> <matrix> <full>
 *   node tools/mutation/ratchet.ts write <package> <mutation.json> [<package> <mutation.json> …]
 *
 * `write` takes a package once for each of its reports. `line` reads the report of each job of the
 * package in `<reports directory>/<artifact>/mutation.json`, `<matrix>` and `<full>` as `plan` prints them.
 */

export type Status = 'Killed' | 'Timeout' | 'Survived' | 'NoCoverage' | 'CompileError' | 'RuntimeError' | 'Ignored';

/** The part of a report of `mutation-testing-report-schema` that this reads. */
export type Report = {
  files: Record<
    string,
    {
      mutants: {
        mutatorName: string;
        replacement?: string;
        status: Status;
        statusReason?: string;
        location: { start: { line: number; column: number }; end?: { line: number; column: number } };
      }[];
    }
  >;
};

export type Line = { score: number; mutants: number };
export type Baseline = Record<string, { score: number; files: Record<string, Line> }>;

const DETECTED: Status[] = ['Killed', 'Timeout'];
const UNDETECTED: Status[] = ['Survived', 'NoCoverage'];

/** Two decimals, rounded down: a line never asks for more than was measured. */
function floor2(value: number): number {
  return Math.floor(value * 100) / 100;
}

/** The score of some mutants, or `undefined` when none of them was valid. */
export function scoreOf(mutants: { status: Status }[]): Line | undefined {
  const detected = mutants.filter((mutant) => DETECTED.includes(mutant.status)).length;
  const valid = detected + mutants.filter((mutant) => UNDETECTED.includes(mutant.status)).length;

  return valid === 0 ? undefined : { score: floor2((detected / valid) * 100), mutants: valid };
}

/** The lines of one package, from the report of a full run. */
export function linesOf(report: Report): { score: number; files: Record<string, Line> } {
  const files: Record<string, Line> = {};
  for (const [file, { mutants }] of Object.entries(report.files)) {
    const line = scoreOf(mutants);
    if (line !== undefined) files[file] = line;
  }
  const all = scoreOf(Object.values(report.files).flatMap((file) => file.mutants));

  return { score: all?.score ?? 0, files };
}

/**
 * The reports of the jobs of one package, as one. The parts of a file each hold the mutants that start
 * in them, and list the others as `Ignored`, which counts for nothing: the mutants are put together.
 */
export function merged(reports: Report[]): Report {
  const files: Report['files'] = {};
  for (const report of reports) {
    for (const [file, { mutants }] of Object.entries(report.files)) {
      files[file] = { mutants: [...(files[file]?.mutants ?? []), ...mutants] };
    }
  }

  return { files };
}

/**
 * The mutants that more than one report measured, one sentence each. Two parts that measure the same
 * mutant count it twice: the ignorer of `part-ignorer.ts` was not loaded, or the parts overlap.
 */
export function measuredTwice(reports: Report[]): string[] {
  const seen = new Map<string, number>();
  for (const report of reports) {
    const keys = new Set(
      Object.entries(report.files).flatMap(([file, { mutants }]) =>
        mutants
          .filter((mutant) => mutant.status !== 'Ignored')
          .map(({ location: { start, end }, mutatorName, replacement }) => {
            const to = end === undefined ? '' : `-${end.line}:${end.column}`;
            return `${file}:${start.line}:${start.column}${to} ${mutatorName}${replacement === undefined ? '' : ` → ${replacement}`}`;
          }),
      ),
    );
    for (const key of keys) seen.set(key, (seen.get(key) ?? 0) + 1);
  }

  return [...seen].filter(([, count]) => count > 1).map(([key]) => `${key} was measured by more than one job`);
}

/** The jobs of the plan for one package, the parts of a file included: `line` expects a report of each. */
export function expected(matrix: { include: Job[] }, pkg: string): Job[] {
  return matrix.include.filter((job) => job.package === pkg);
}

/** A job of the plan that left no report, one sentence each. */
export function unmeasured(jobs: Job[], has: (artifact: string) => boolean): string[] {
  return jobs
    .filter((job) => !has(job.artifact))
    .map(
      (job) =>
        `${job.file}${job.lines === '' ? '' : ` lines ${job.lines}`} was not measured: ${job.artifact} has no report`,
    );
}

/** What fails in a run, one sentence each, and nothing when the run holds every line. */
export function regressions(
  lines: { score: number; files: Record<string, Line> } | undefined,
  report: Report,
  full: boolean,
): string[] {
  if (lines === undefined) return ['this package has no line in tools/mutation/baseline.json'];
  const measured = linesOf(report);
  const found: string[] = [];

  for (const [file, line] of Object.entries(measured.files)) {
    const before = lines.files[file];
    if (before !== undefined && line.score < before.score) {
      found.push(`${file} scores ${line.score}, under its line of ${before.score}`);
    }
    if (before === undefined && line.score < lines.score) {
      found.push(`${file} has no line yet, and scores ${line.score}, under the ${lines.score} of its package`);
    }
  }
  if (full) {
    for (const file of Object.keys(lines.files)) {
      if (!(file in report.files)) found.push(`${file} has a line, and this full run did not measure it`);
    }
  }
  if (full && measured.score < lines.score) {
    found.push(`the package scores ${measured.score}, under its line of ${lines.score}`);
  }

  return found;
}

/** The mutants a test let live, by file, for the summary of a job. */
export function survivors(report: Report): string[] {
  return Object.entries(report.files).flatMap(([file, { mutants }]) =>
    mutants
      .filter((mutant) => UNDETECTED.includes(mutant.status))
      .map(
        (mutant) =>
          `${file}:${mutant.location.start.line} ${mutant.status} ${mutant.mutatorName}` +
          (mutant.replacement === undefined ? '' : ` → ${mutant.replacement.replace(/\s+/g, ' ').slice(0, 80)}`),
      ),
  );
}

/** The summary of a run, as Markdown, with a sentence for each thing that fails it. */
function summary(name: string, lines: Baseline[string] | undefined, report: Report, found: string[]): string {
  const measured = linesOf(report);
  const rows = Object.entries(measured.files).map(
    ([file, line]) => `| \`${file}\` | ${line.mutants} | ${line.score} | ${lines?.files[file]?.score ?? 'none'} |`,
  );
  const left = survivors(report);

  return [
    `### Mutation score of ${name}\n`,
    '| File | Valid mutants | Score | Line |\n| --- | --- | --- | --- |',
    ...rows,
    `\nPackage: ${measured.score}, line ${lines?.score ?? 'none'}.\n`,
    `<details><summary>${left.length} mutants no test killed</summary>\n\n\`\`\`\n${left.join('\n')}\n\`\`\`\n</details>\n`,
    ...found.map((sentence) => `**Fails:** ${sentence}.`),
  ].join('\n');
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  const baselineFile = new URL('baseline.json', import.meta.url);
  const read = (path: string): Report => JSON.parse(readFileSync(path, 'utf8')) as Report;
  const baseline = (): Baseline => JSON.parse(readFileSync(baselineFile, 'utf8')) as Baseline;

  if (command === 'write') {
    const lines = baseline();
    // A package has a report per job: the pairs of one package are read together.
    const reports = new Map<string, Report[]>();
    for (let index = 0; index + 1 < rest.length; index += 2) {
      const pkg = rest[index] as string;
      reports.set(pkg, [...(reports.get(pkg) ?? []), read(rest[index + 1] as string)]);
    }
    for (const [pkg, list] of reports) lines[pkg] = linesOf(merged(list));
    writeFileSync(baselineFile, `${JSON.stringify(lines, null, 2)}\n`);

    return 0;
  }

  if (command === 'line' && rest.length === 4) {
    const [name, directory, matrix, full] = rest as [string, string, string, string];
    const jobs = expected(JSON.parse(matrix) as { include: Job[] }, name);
    const path = (artifact: string) => join(directory, artifact, 'mutation.json');
    const reports = jobs.filter((job) => existsSync(path(job.artifact))).map((job) => read(path(job.artifact)));
    const report = merged(reports);
    const lines = baseline()[name];
    const found = [
      ...(jobs.length === 0 ? ['the plan has no job for this package'] : []),
      ...unmeasured(jobs, (artifact) => existsSync(path(artifact))),
      ...measuredTwice(reports),
      ...regressions(lines, report, (JSON.parse(full) as string[]).includes(name)),
    ];
    console.log(summary(name, lines, report, found));

    return found.length === 0 ? 0 : 1;
  }

  const [name = '', ...paths] = rest.filter((arg) => arg !== '--full' && arg !== '--part');
  if (command === 'check' && paths.length > 0) {
    const report = merged(paths.map(read));
    const lines = baseline()[name];
    // A part holds some mutants of its file only: its score is no measure of the line of that file.
    const found = rest.includes('--part') ? [] : regressions(lines, report, rest.includes('--full'));
    console.log(summary(name, lines, report, found));

    return found.length === 0 ? 0 : 1;
  }

  console.error(
    'usage: ratchet.ts check <package> <mutation.json>… [--full | --part] | line <package> <directory> <matrix> <full> | write <package> <mutation.json> …',
  );

  return 2;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
