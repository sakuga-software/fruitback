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
 * October 2026: the 8 files of the worker in one job ran out of the 150 minutes of the job.
 *
 *   node tools/mutation/scope.ts <event> <base sha or ''> <package>...
 *
 * prints `matrix`, the jobs as JSON for `strategy.matrix`, `count`, their number, and `full`, the
 * packages mutated in full as a JSON array.
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

/** One job of the matrix: one file of one package. */
export type Job = { package: string; file: string; artifact: string };

/** The name of the artifact of a job. `--` parts the package from the file, and neither holds it. */
export function artifactOf(pkg: string, file: string): string {
  const slug = (path: string) => path.replaceAll('/', '-');

  return `mutation--${slug(pkg)}--${slug(file)}`;
}

/** The jobs for what each package mutates, one per file, and the packages mutated in full. */
export function plan(chosen: { pkg: string; mutate: string[]; full: boolean }[]): { jobs: Job[]; full: string[] } {
  return {
    jobs: chosen.flatMap(({ pkg, mutate }) =>
      mutate.map((file) => ({ package: pkg, file, artifact: artifactOf(pkg, file) })),
    ),
    full: chosen.filter(({ full, mutate }) => full && mutate.length > 0).map(({ pkg }) => pkg),
  };
}

function main([event = '', base = '', ...packages]: string[]): void {
  const changed = base === '' ? undefined : changedSince(base);
  const { jobs, full } = plan(
    packages.map((pkg) => {
      const config = JSON.parse(readFileSync(`${pkg}/stryker.config.json`, 'utf8')) as { mutate?: unknown };
      const chosen = choose(pkg, scopeOf(config), event, changed);
      // StrykerJS stops on a file that is not there: a source the pull request deletes is not mutated.
      return { pkg, mutate: chosen.mutate.filter((file) => existsSync(`${pkg}/${file}`)), full: chosen.full };
    }),
  );

  console.log(`matrix=${JSON.stringify({ include: jobs })}`);
  console.log(`count=${jobs.length}`);
  console.log(`full=${JSON.stringify(full)}`);
}

if (import.meta.main) main(process.argv.slice(2));
