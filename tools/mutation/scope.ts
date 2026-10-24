import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import type { Baseline } from './ratchet.ts';

/**
 * What the mutation jobs mutate, as lines for `$GITHUB_OUTPUT` (FRU-172, FRU-336).
 *
 * A pull request mutates the files of the scope that it changes, and those whose test it changes
 * (`src/x.test.ts` for `src/x.ts`). It mutates the whole scope of a package when it changes how
 * mutation runs for that package: the workflow, `tools/mutation/`, or the `stryker.config.json` of
 * that package. The lines of `baseline.json` were measured with those, so a change to them is
 * measured again in full. A schedule and a run by hand mutate the whole scope.
 *
 * `baseline.json` itself does not change how mutation runs (FRU-447). A pull request that moves the
 * line of a file mutates that file, and one that moves the line of a package mutates each file of it
 * and holds that line. Both are incremental: a full run of the worker took 22 to 67 minutes on the
 * pull requests that only raised lines.
 *
 * Each file is mutated by a job of its own (FRU-336). Under the `tap` runner a mutant runs every test
 * file that reaches it, each in its own process, and the dry run of the worker took 7 to 9 minutes in
 * October 2026: the 8 files of the worker in one job ran out of the 150 minutes of the job.
 *
 *   node tools/mutation/scope.ts <event> <base sha or ''> <package>...
 *
 * prints `matrix`, the jobs as JSON for `strategy.matrix`, `count`, their number, and `lines`, the
 * packages whose line is held, as a JSON array.
 */

/** The files a package mutates, as its `stryker.config.json` lists them. */
export function scopeOf(config: { mutate?: unknown }): string[] {
  const mutate = Array.isArray(config.mutate) ? config.mutate : [];

  return mutate.filter((entry): entry is string => typeof entry === 'string' && !entry.startsWith('!'));
}

/** What changes how mutation runs for every package. */
export const MUTATION_SETUP = [/^\.github\/workflows\/mutation\.yml$/, /^tools\/mutation\/(?!baseline\.json$)/];

export const BASELINE = 'tools/mutation/baseline.json';

/** What a pull request moves in `baseline.json` for one package: the lines of files, and its own. */
export type Moved = { files: string[]; package: boolean };

/** The lines of `pkg` that differ between two baselines. A line added or taken away has moved. */
export function movedLines(pkg: string, before: Baseline | undefined, after: Baseline | undefined): Moved {
  const old = before?.[pkg];
  const now = after?.[pkg];
  const files = new Set([...Object.keys(old?.files ?? {}), ...Object.keys(now?.files ?? {})]);

  return {
    files: [...files].filter((file) => old?.files[file]?.score !== now?.files[file]?.score),
    package: old?.score !== now?.score,
  };
}

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
  moved: Moved = { files: [], package: false },
): { mutate: string[]; full: boolean; line: boolean } {
  if (event !== 'pull_request' || changed === undefined) return { mutate: scope, full: true, line: true };
  if (changed.some((file) => setsUp(pkg, file))) {
    return { mutate: scope, full: true, line: true };
  }
  // The line of a package is the score of all its files: each one is measured, from its last report.
  if (moved.package) return { mutate: scope, full: false, line: true };
  // A test that changes can stop killing the mutants of the file it tests, so that file is mutated
  // too: a pull request that deletes a test must not pass because it touched no source.
  const touched = new Set(changed);
  const tested = (file: string) =>
    touched.has(`${pkg}/${file}`) ||
    touched.has(`${pkg}/${file.replace(/\.ts$/, '.test.ts')}`) ||
    moved.files.includes(file);

  return { mutate: scope.filter(tested), full: false, line: false };
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
 * One job of the matrix: one file of one package. `incremental` is false when the package is mutated
 * in full: that run measures every mutant again, and its report is where the next ones start (FRU-341).
 */
export type Job = { package: string; file: string; artifact: string; incremental: boolean };

/** The name of the artifact of a job. `--` parts the package from the file, and neither holds it. */
export function artifactOf(pkg: string, file: string): string {
  const slug = (path: string) => path.replaceAll('/', '-');

  return `mutation--${slug(pkg)}--${slug(file)}`;
}

/** The jobs for what each package mutates, one per file, and the packages whose line is held. */
export function plan(chosen: { pkg: string; mutate: string[]; full: boolean; line: boolean }[]): {
  jobs: Job[];
  lines: string[];
} {
  return {
    jobs: chosen.flatMap(({ pkg, mutate, full }) =>
      mutate.map((file) => ({ package: pkg, file, artifact: artifactOf(pkg, file), incremental: !full })),
    ),
    lines: chosen.filter(({ line, mutate }) => line && mutate.length > 0).map(({ pkg }) => pkg),
  };
}

/** `baseline.json` at a commit, or in the checkout. `undefined` when the commit has none. */
export function baselineAt(commit?: string, cwd?: string): Baseline | undefined {
  if (commit === undefined)
    return JSON.parse(readFileSync(cwd === undefined ? BASELINE : `${cwd}/${BASELINE}`, 'utf8')) as Baseline;
  try {
    return JSON.parse(
      execFileSync('git', ['show', `${commit}:${BASELINE}`], {
        encoding: 'utf8',
        cwd,
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    ) as Baseline;
  } catch {
    return undefined;
  }
}

function main([event = '', base = '', ...packages]: string[]): void {
  const changed = base === '' ? undefined : changedSince(base);
  const baselines = changed?.includes(BASELINE) ? { before: baselineAt(base), after: baselineAt() } : undefined;
  const { jobs, lines } = plan(
    packages.map((pkg) => {
      const config = JSON.parse(readFileSync(`${pkg}/stryker.config.json`, 'utf8')) as { mutate?: unknown };
      const moved = baselines === undefined ? undefined : movedLines(pkg, baselines.before, baselines.after);
      const chosen = choose(pkg, scopeOf(config), event, changed, moved);
      // StrykerJS stops on a file that is not there: a source the pull request deletes is not mutated.
      return {
        pkg,
        mutate: chosen.mutate.filter((file) => existsSync(`${pkg}/${file}`)),
        full: chosen.full,
        line: chosen.line,
      };
    }),
  );

  console.log(`matrix=${JSON.stringify({ include: jobs })}`);
  console.log(`count=${jobs.length}`);
  console.log(`lines=${JSON.stringify(lines)}`);
}

if (import.meta.main) main(process.argv.slice(2));
