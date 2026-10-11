import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

/**
 * What a mutation job mutates, as two lines for `$GITHUB_OUTPUT` (FRU-172).
 *
 * `mutate` is a comma-separated list for `stryker run --mutate`, empty when there is nothing to do.
 * `full` is `--full` when the whole scope of the package is mutated, and empty otherwise.
 *
 * A pull request mutates the files of the scope that it changes, and those whose test it changes
 * (`src/x.test.ts` for `src/x.ts`). It mutates the whole scope when it
 * changes how mutation runs: the workflow, a `stryker.config.json`, or `tools/mutation/`. The lines
 * of `baseline.json` were measured with those, so a change to them is measured again in full. A
 * schedule and a run by hand mutate the whole scope.
 *
 *   node tools/mutation/scope.ts <package> <event> [<base sha>]
 */

/** The files a package mutates, as its `stryker.config.json` lists them. */
export function scopeOf(config: { mutate?: unknown }): string[] {
  const mutate = Array.isArray(config.mutate) ? config.mutate : [];

  return mutate.filter((entry): entry is string => typeof entry === 'string' && !entry.startsWith('!'));
}

/** What changes how mutation runs, for every package. */
export const MUTATION_SETUP = [
  /^\.github\/workflows\/mutation\.yml$/,
  /(^|\/)stryker\.config\.json$/,
  /^tools\/mutation\//,
];

export function choose(
  pkg: string,
  scope: string[],
  event: string,
  changed: string[] | undefined,
): { mutate: string[]; full: boolean } {
  if (event !== 'pull_request' || changed === undefined) return { mutate: scope, full: true };
  if (changed.some((file) => MUTATION_SETUP.some((pattern) => pattern.test(file)))) {
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

function main([pkg = '', event = '', base = '']: string[]): void {
  const config = JSON.parse(readFileSync(`${pkg}/stryker.config.json`, 'utf8')) as { mutate?: unknown };
  const changed = base === '' ? undefined : changedSince(base);
  const chosen = choose(pkg, scopeOf(config), event, changed);
  // StrykerJS stops on a file that is not there: a source the pull request deletes is not mutated.
  const mutate = chosen.mutate.filter((file) => existsSync(`${pkg}/${file}`));
  const { full } = chosen;

  console.log(`mutate=${mutate.join(',')}`);
  console.log(`full=${full ? '--full' : ''}`);
}

if (import.meta.main) main(process.argv.slice(2));
