import { execFileSync } from 'node:child_process';

/**
 * Whether a pull request can change an image that `ci.yml` builds, as a line for `$GITHUB_OUTPUT`
 * (FRU-344).
 *
 * Each Dockerfile copies a list of paths, not the repository, and `.dockerignore` takes out the rest.
 * So the images can change only when one of those paths changes, or the files that build them, or a
 * file that the steps of the job read. The job is skipped when none changed: it would build the same
 * images and get the same answers. `ci-images.test.ts` holds the list to the `COPY` lines of each
 * Dockerfile that `docker-bake.hcl` builds.
 *
 * Only a pull request is read: its checkout is the merge commit, and the first parent of that commit
 * is the head of its base, so `HEAD^1..HEAD` is what the pull request changes on top of its base. A
 * push to `main`, a merge queue and a call from a release build the images.
 *
 *   node tools/ci/changes.ts <event>
 *
 * prints `images=true` or `images=false`.
 */

/** A path that ends with `/` is a directory and everything under it. Any other is one file. */
export const IMAGES: readonly string[] = [
  // The install, and what Docker and bake read.
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package.json',
  '.dockerignore',
  'docker-bake.hcl',
  '.github/workflows/ci.yml',
  // What the four Dockerfiles copy, and the restore drill and migrations of the worker.
  'packages/shared/',
  'packages/widget/',
  'apps/worker/',
  'apps/console/',
  'apps/playground/',
  // The compose step: its file, its .env.example, and the Node that runs plant-a-pin.ts.
  'docker-compose.yml',
  '.env.example',
  '.nvmrc',
];

/** Whether `file` is one of `paths`, or under one of its directories. */
export function covers(paths: readonly string[], file: string): boolean {
  return paths.some((path) => (path.endsWith('/') ? file.startsWith(path) : file === path));
}

/** Whether the images are built. With no list of files, they are. */
export function needed(changed: string[] | undefined): boolean {
  return changed === undefined || changed.some((file) => covers(IMAGES, file));
}

/** The files of the merge commit of a pull request against the head of its base. */
export function changedOnTopOfBase(cwd?: string): string[] {
  return execFileSync('git', ['diff', '--name-only', '--no-renames', 'HEAD^1', 'HEAD'], { encoding: 'utf8', cwd })
    .split('\n')
    .filter((line) => line !== '');
}

function main([event = '']: string[]): void {
  console.log(`images=${needed(event === 'pull_request' ? changedOnTopOfBase() : undefined)}`);
}

if (import.meta.main) main(process.argv.slice(2));
