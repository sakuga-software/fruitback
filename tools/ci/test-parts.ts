import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * Checks that the parts of the tests of the worker ran each test file once, and lost none (FRU-480).
 *
 *   node tools/ci/test-parts.ts <directory of the package> <list of part 1> <list of part 2> …
 *
 * CI runs the vitest suite of the worker in parts, on several runners: `vitest.config.ts` gives
 * each part its `shard`, and writes the files that part ran into its list, one per line. A file
 * that no part ran is a test lost with a green check. A file that two parts ran is a cut that does
 * not work, and costs a runner. Both fail here, and so do a list that is missing or empty and a
 * file that a part ran and this does not list: then its pattern and the one of vitest differ.
 */

/** The test files of a package, as `vitest.config.ts` includes them: `src/**\/*.test.ts`. */
export function testFilesOf(directory: string): string[] {
  return readdirSync(join(directory, 'src'), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.test.ts'))
    .map((file) => join('src', file).split('\\').join('/'))
    .sort();
}

/** The lines of a list, without the empty ones. */
export function readList(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

export type Verdict = {
  /** The test files that no part ran. */
  missing: string[];
  /** The test files that more than one part ran, with the count of parts. */
  twice: [file: string, parts: number][];
  /** The files a part ran that `testFilesOf` does not list: the two patterns no longer agree. */
  unknown: string[];
  /** The parts that ran nothing. */
  empty: number[];
};

/** What the parts ran, against the test files of the package. */
export function verdictOf(files: readonly string[], parts: readonly (readonly string[])[]): Verdict {
  const runs = new Map<string, number>();
  for (const part of parts) for (const file of new Set(part)) runs.set(file, (runs.get(file) ?? 0) + 1);
  const known = new Set(files);

  return {
    missing: files.filter((file) => !runs.has(file)),
    twice: [...runs].filter(([, count]) => count > 1).sort(([a], [b]) => (a < b ? -1 : 1)),
    unknown: [...runs.keys()].filter((file) => !known.has(file)).sort(),
    empty: parts.flatMap((part, index) => (part.length === 0 ? [index + 1] : [])),
  };
}

/** Whether the parts ran every test file once, and nothing else. */
export function passes(verdict: Verdict): boolean {
  return Object.values(verdict).every((found) => found.length === 0);
}

function main([directory = '', ...lists]: string[]): void {
  const say = (line: string) => {
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  };
  if (lists.length < 2) {
    console.log(`::error title=test parts::${lists.length} list given, at least 2 expected: did a part not run?`);
    process.exit(1);
  }
  for (const list of lists) {
    if (!existsSync(list)) {
      console.log(`::error title=test parts::no list ${list}: did its part not run?`);
      process.exit(1);
    }
  }

  const files = testFilesOf(directory);
  const parts = lists.map(readList);
  const verdict = verdictOf(files, parts);

  say(`### Test files of \`${directory}\` in each part`);
  say('');
  say('| Part | Test files |');
  say('|---|---|');
  parts.forEach((part, index) => say(`| ${basename(lists[index] ?? '')} | ${part.length} |`));
  say(`| all, in the package | ${files.length} |`);
  say('');

  for (const file of verdict.missing) console.log(`::error title=test parts::${file} ran in no part`);
  for (const [file, count] of verdict.twice) console.log(`::error title=test parts::${file} ran in ${count} parts`);
  for (const part of verdict.empty) console.log(`::error title=test parts::part ${part} ran no test file`);
  for (const file of verdict.unknown)
    console.log(`::error title=test parts::${file} ran, and is not a test file of ${directory}`);
  if (!passes(verdict)) process.exit(1);
  say(`Each of the ${files.length} test files ran in one part exactly.`);
}

if (import.meta.main) main(process.argv.slice(2));
