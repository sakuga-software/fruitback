import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

/**
 * What the mutation jobs mutate, as lines for `$GITHUB_OUTPUT` (FRU-172, FRU-336).
 *
 * A pull request mutates the files of the scope that it changes, and those whose test it changes
 * (`src/x.test.ts` for `src/x.ts`). It mutates the whole scope of a package when it changes how
 * mutation runs for that package: the workflow, `tools/mutation/`, or the `stryker.config.json` of
 * that package. The lines of `baseline.json` were measured with those, so a change to them is
 * measured again in full. A schedule and a run by hand mutate the whole scope.
 *
 * Each file is mutated by a job of its own (FRU-336). Under the `tap` runner a mutant runs every test
 * file that reaches it, each in its own process, and the dry run of the worker took 7 to 9 minutes in
 * October 2026: the 8 files of the worker in one job ran out of the 150 minutes of the job. A file
 * that `parts.json` cuts is mutated by a job for each part (FRU-340): `identity.ts` alone took 81
 * minutes on 2026-10-21.
 *
 *   node tools/mutation/scope.ts <event> <base sha or ''> <package>...
 *
 * prints `matrix`, the jobs as JSON for `strategy.matrix`, `count`, their number, `full`, the
 * packages mutated in full as a JSON array, and `packages`, the packages that have a job.
 */

/** The files a package mutates, as its `stryker.config.json` lists them. */
export function scopeOf(config: { mutate?: unknown }): string[] {
  const mutate = Array.isArray(config.mutate) ? config.mutate : [];

  return mutate.filter((entry): entry is string => typeof entry === 'string' && !entry.startsWith('!'));
}

/** What changes how mutation runs for every package. */
export const MUTATION_SETUP = [/^\.github\/workflows\/mutation\.yml$/, /^tools\/mutation\//];

/**
 * Whether `file` changes how the mutation of `pkg` runs. The `stryker.config.json` of another
 * package does not: it changes neither the mutants nor the tests of this one (FRU-336).
 */
export function setsUp(pkg: string, file: string): boolean {
  return file === `${pkg}/stryker.config.json` || MUTATION_SETUP.some((pattern) => pattern.test(file));
}

export function choose(
  pkg: string,
  scope: string[],
  event: string,
  changed: string[] | undefined,
): { mutate: string[]; full: boolean } {
  if (event !== 'pull_request' || changed === undefined) return { mutate: scope, full: true };
  if (changed.some((file) => setsUp(pkg, file))) {
    return { mutate: scope, full: true };
  }
  // A test that changes can stop killing the mutants of the file it tests, so that file is mutated
  // too: a pull request that deletes a test must not pass because it touched no source.
  const touched = new Set(changed);
  const tested = (file: string) =>
    touched.has(`${pkg}/${file}`) || touched.has(`${pkg}/${file.replace(/\.ts$/, '.test.ts')}`);

  return { mutate: scope.filter(tested), full: false };
}

/**
 * The files a pull request changes since its base, deleted ones included.
 *
 * A test deleted whole is a test that changed: its file must be mutated (raised in review). Renames
 * are read as a deletion and an addition, so that the old name of a test is seen too.
 */
export function changedSince(base: string, cwd?: string): string[] {
  return execFileSync('git', ['diff', '--name-only', '--no-renames', '--diff-filter=AMD', `${base}...HEAD`], {
    encoding: 'utf8',
    cwd,
  })
    .split('\n')
    .filter((line) => line !== '');
}

/**
 * The lines at which a file is cut into jobs, by package and by file: `parts.json` (FRU-340). A cut
 * is the first line of a part. A file with no cuts is mutated whole, by one job.
 */
export type Cuts = Record<string, Record<string, number[]>>;

/**
 * One job of the matrix: one file of one package, or the lines `lines` of it.
 *
 * `mutate` is what StrykerJS mutates, and `last` the last line the job measures, `''` for none. A
 * part runs from its first line to the end of the file, because StrykerJS mutates only a node that a
 * range holds whole, and the ignorer of `part-ignorer.ts` then leaves out each node that starts after
 * `last`. So a mutant belongs to the part that holds the line where it starts, and a node that crosses
 * a cut is not lost.
 */
export type Job = { package: string; file: string; lines: string; mutate: string; last: string; artifact: string };

/** The name of the ignorer of `part-ignorer.ts`, which a package with cuts lists in its `ignorers`. */
export const PART_IGNORER = 'mutation-part';

/** Why a part leaves a mutant out: `ratchet.ts` reads it to find a mutant that no part measured. */
export const LEFT_TO_ANOTHER_PART = 'Left to the job of the part where it starts (FRU-340)';

/**
 * The reason the ignorer gives for a node that starts at `start`, in a part whose last line is `last`
 * (`MUTATION_LAST_LINE`), or `undefined` when the part measures it. Its descendants start after it,
 * so they belong to a later part too.
 */
export function leftOut(last: string | undefined, start: number | undefined): string | undefined {
  if (last === undefined || last === '' || start === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(last)) throw new Error(`MUTATION_LAST_LINE is ${JSON.stringify(last)}, not a line`);

  return start > Number(last) ? LEFT_TO_ANOTHER_PART : undefined;
}

/** The name of the artifact of a job. `--` parts the package from the file, and neither holds it. */
export function artifactOf(pkg: string, file: string, lines = ''): string {
  const slug = (path: string) => path.replaceAll('/', '-');

  return `mutation--${slug(pkg)}--${slug(file)}${lines === '' ? '' : `--${lines}`}`;
}

/**
 * The parts of a file of `length` lines that `cuts` makes, first and last line each. They follow one
 * another from line 1 to the last line, so no line is left out. A cut that is not in the file, or not
 * after the one before, stops the plan rather than leave a part empty.
 */
export function partsOf(file: string, cuts: number[], length: number): { from: number; to: number }[] {
  cuts.forEach((cut, index) => {
    if (!Number.isInteger(cut) || cut <= (cuts[index - 1] ?? 1) || cut > length) {
      throw new Error(`${file}: the cut at line ${cut} is not after the one before and inside its ${length} lines`);
    }
  });
  const starts = [1, ...cuts];

  return starts.map((from, index) => ({ from, to: (starts[index + 1] ?? length + 1) - 1 }));
}

/** The jobs of one file: one for the whole file, or one for each part that its cuts make. */
export function jobsOf(pkg: string, file: string, cuts: number[] | undefined, length: number): Job[] {
  if (cuts === undefined || cuts.length === 0) {
    return [{ package: pkg, file, lines: '', mutate: file, last: '', artifact: artifactOf(pkg, file) }];
  }
  const parts = partsOf(file, cuts, length);

  return parts.map(({ from, to }, index) => ({
    package: pkg,
    file,
    lines: `${from}-${to}`,
    mutate: `${file}:${from}-${length}`,
    last: index === parts.length - 1 ? '' : String(to),
    artifact: artifactOf(pkg, file, `${from}-${to}`),
  }));
}

/** The number of lines of a file of a package, as StrykerJS counts them for a range. */
export function lengthOf(pkg: string, file: string): number {
  return readFileSync(`${pkg}/${file}`, 'utf8').split('\n').length;
}

/**
 * The jobs for what each package mutates, one per file or per part of a file, the packages mutated
 * in full, and the packages that have a job: the `line` job holds the line of each of those.
 */
export function plan(
  chosen: { pkg: string; mutate: string[]; full: boolean }[],
  cuts: Cuts = {},
  length: (pkg: string, file: string) => number = lengthOf,
): { jobs: Job[]; full: string[]; packages: string[] } {
  const jobs = chosen.flatMap(({ pkg, mutate }) =>
    mutate.flatMap((file) => {
      const fileCuts = cuts[pkg]?.[file];
      return jobsOf(pkg, file, fileCuts, fileCuts === undefined ? 0 : length(pkg, file));
    }),
  );

  return {
    jobs,
    full: chosen.filter(({ full, mutate }) => full && mutate.length > 0).map(({ pkg }) => pkg),
    packages: chosen.filter(({ mutate }) => mutate.length > 0).map(({ pkg }) => pkg),
  };
}

/**
 * What is wrong with the cuts of a package, one sentence each. A cut file must be in the scope, and
 * the package must load the ignorer: without it each part would mutate up to the end of the file, and
 * a mutant would count once for each part.
 */
export function cutProblems(
  pkg: string,
  config: { mutate?: unknown; ignorers?: unknown; plugins?: unknown },
  cuts: Cuts,
): string[] {
  const files = Object.keys(cuts[pkg] ?? {});
  if (files.length === 0) return [];
  const scope = new Set(scopeOf(config));
  const ignorers = Array.isArray(config.ignorers) ? config.ignorers : [];
  const plugins = Array.isArray(config.plugins) ? config.plugins : [];

  return [
    ...files.filter((file) => !scope.has(file)).map((file) => `${pkg}: ${file} is cut, and is not in its scope`),
    ...(ignorers.includes(PART_IGNORER)
      ? []
      : [`${pkg}: its stryker.config.json does not list the ignorer ${PART_IGNORER}`]),
    ...(plugins.some((plugin) => typeof plugin === 'string' && plugin.endsWith('tools/mutation/part-ignorer.ts'))
      ? []
      : [`${pkg}: its stryker.config.json does not load tools/mutation/part-ignorer.ts`]),
  ];
}

function main([event = '', base = '', ...packages]: string[]): void {
  const changed = base === '' ? undefined : changedSince(base);
  const cuts = JSON.parse(readFileSync(new URL('parts.json', import.meta.url), 'utf8')) as Cuts;
  const problems: string[] = [];
  const {
    jobs,
    full,
    packages: measured,
  } = plan(
    packages.map((pkg) => {
      const config = JSON.parse(readFileSync(`${pkg}/stryker.config.json`, 'utf8')) as { mutate?: unknown };
      problems.push(...cutProblems(pkg, config, cuts));
      const chosen = choose(pkg, scopeOf(config), event, changed);
      // StrykerJS stops on a file that is not there: a source the pull request deletes is not mutated.
      return { pkg, mutate: chosen.mutate.filter((file) => existsSync(`${pkg}/${file}`)), full: chosen.full };
    }),
    cuts,
  );
  if (problems.length > 0) throw new Error(problems.join('\n'));

  console.log(`matrix=${JSON.stringify({ include: jobs })}`);
  console.log(`count=${jobs.length}`);
  console.log(`full=${JSON.stringify(full)}`);
  console.log(`packages=${JSON.stringify(measured)}`);
}

if (import.meta.main) main(process.argv.slice(2));
