import { execFileSync } from 'node:child_process';

/**
 * Which images a pull request can change, as lines for `$GITHUB_OUTPUT` (FRU-344).
 *
 * Each Dockerfile copies a list of paths, not the repository, and `.dockerignore` takes out the rest.
 * So an image can change only when one of those paths changes, or the workflow that builds it, or a
 * file that its steps read. A job of `ci.yml` that builds an image is skipped when none of its paths
 * changed: it would build the same image and get the same answers. `ci-changes.test.ts` holds each
 * list to the `COPY` lines of its Dockerfile.
 *
 * Only a pull request is read: its checkout is the merge commit, and the first parent of that commit
 * is the head of its base, so `HEAD^1..HEAD` is what the pull request changes on top of its base. A
 * push to `main`, a merge queue and a call from a release build every image.
 *
 *   node tools/ci/changes.ts <event>
 *
 * prints `<job>=true` or `<job>=false` for each job of `JOBS`.
 */

/** A path that ends with `/` is a directory and everything under it. Any other is one file. */
export type Paths = readonly string[];

/** What the root gives every image: the install, and the files Docker reads. */
const ROOT: Paths = [
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package.json',
  '.dockerignore',
  '.github/workflows/ci.yml',
];

/** The paths that each job of `ci.yml` that builds an image is made of, or reads. */
export const JOBS = {
  // apps/worker/Dockerfile, and apps/worker/cloud/restore-drill.sh with the migrations it counts.
  worker: [...ROOT, 'packages/shared/', 'apps/worker/'],
  // apps/console/Dockerfile and apps/playground/Dockerfile.
  web: [...ROOT, 'packages/shared/', 'packages/widget/', 'apps/console/', 'apps/playground/'],
  // The worker and the console of docker-compose.yml, its .env.example, and the Node of plant-a-pin.ts.
  compose: [
    ...ROOT,
    'packages/shared/',
    'packages/widget/',
    'apps/worker/',
    'apps/console/',
    'docker-compose.yml',
    '.env.example',
    '.nvmrc',
  ],
} as const satisfies Record<string, Paths>;

export type Job = keyof typeof JOBS;

/** Whether `file` is one of `paths`, or under one of its directories. */
export function covers(paths: Paths, file: string): boolean {
  return paths.some((path) => (path.endsWith('/') ? file.startsWith(path) : file === path));
}

/** For each job, whether it runs. With no list of files, every job runs. */
export function needed(changed: string[] | undefined): Record<Job, boolean> {
  const jobs = Object.keys(JOBS) as Job[];

  return Object.fromEntries(
    jobs.map((job) => [job, changed === undefined || changed.some((file) => covers(JOBS[job], file))]),
  ) as Record<Job, boolean>;
}

/** The files of the merge commit of a pull request against the head of its base. */
export function changedOnTopOfBase(cwd?: string): string[] {
  return execFileSync('git', ['diff', '--name-only', '--no-renames', 'HEAD^1', 'HEAD'], { encoding: 'utf8', cwd })
    .split('\n')
    .filter((line) => line !== '');
}

function main([event = '']: string[]): void {
  const changed = event === 'pull_request' ? changedOnTopOfBase() : undefined;
  for (const [job, runs] of Object.entries(needed(changed))) console.log(`${job}=${runs}`);
}

if (import.meta.main) main(process.argv.slice(2));
