import { readFileSync, writeFileSync } from 'node:fs';

/**
 * The score of a mutation run may not go down (FRU-172).
 *
 * `baseline.json` holds, for each package that is mutated, the score of each file and of the
 * package, as a full run measured them. A run then fails when a file scores less than its line, and
 * a file with no line yet scores less than its package. A full run also fails when the package
 * scores less than its own line. The lines move up only by a commit: `write` prints them from the
 * reports of a full run.
 *
 * The score is the one Stryker reports: killed and timed out, over every mutant that was valid. A
 * mutant no test reaches counts against it, as one a test reaches and lets live.
 *
 *   node tools/mutation/ratchet.ts check <package> <mutation.json> [--full]
 *   node tools/mutation/ratchet.ts write <package> <mutation.json> [<package> <mutation.json> …]
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
        location: { start: { line: number; column: number } };
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

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  const baselineFile = new URL('baseline.json', import.meta.url);
  const read = (path: string): Report => JSON.parse(readFileSync(path, 'utf8')) as Report;

  if (command === 'write') {
    const baseline = JSON.parse(readFileSync(baselineFile, 'utf8')) as Baseline;
    for (let index = 0; index + 1 < rest.length; index += 2) {
      baseline[rest[index] as string] = linesOf(read(rest[index + 1] as string));
    }
    writeFileSync(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`);

    return 0;
  }

  if (command === 'check' && rest.length >= 2) {
    const [name = '', path = ''] = rest;
    const baseline = JSON.parse(readFileSync(baselineFile, 'utf8')) as Baseline;
    const report = read(path);
    const measured = linesOf(report);
    const lines = baseline[name];
    const found = regressions(lines, report, rest.includes('--full'));

    console.log(`### Mutation score of ${name}\n`);
    console.log('| File | Valid mutants | Score | Line |\n| --- | --- | --- | --- |');
    for (const [file, line] of Object.entries(measured.files)) {
      console.log(`| \`${file}\` | ${line.mutants} | ${line.score} | ${lines?.files[file]?.score ?? 'none'} |`);
    }
    console.log(`\nPackage: ${measured.score}, line ${lines?.score ?? 'none'}.\n`);
    const left = survivors(report);
    console.log(
      `<details><summary>${left.length} mutants no test killed</summary>\n\n\`\`\`\n${left.join('\n')}\n\`\`\`\n</details>\n`,
    );
    for (const sentence of found) console.log(`**Fails:** ${sentence}.`);

    return found.length === 0 ? 0 : 1;
  }

  console.error('usage: ratchet.ts check <package> <mutation.json> [--full] | write <package> <mutation.json> …');

  return 2;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
