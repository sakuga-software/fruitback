import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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

function main([pkg = '', event = '', base = '']: string[]): void {
  const config = JSON.parse(readFileSync(`${pkg}/stryker.config.json`, 'utf8')) as { mutate?: unknown };
  const changed =
    base === ''
      ? undefined
      : execFileSync('git', ['diff', '--name-only', '--diff-filter=AMR', `${base}...HEAD`], { encoding: 'utf8' })
          .split('\n')
          .filter((line) => line !== '');
  const { mutate, full } = choose(pkg, scopeOf(config), event, changed);

  console.log(`mutate=${mutate.join(',')}`);
  console.log(`full=${full ? '--full' : ''}`);
}

if (import.meta.main) main(process.argv.slice(2));
