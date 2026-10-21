import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Where the mutation run of a file starts on a pull request (FRU-341).
 *
 * The report of a mutation job, `mutation.json`, is the incremental file of StrykerJS: its JSON
 * reporter and its incremental mode write the same object. So the newest report of the same file,
 * from the base branch of the pull request and else from `main`, is the file the job starts from.
 * StrykerJS then runs again each mutant whose code changed, each killed mutant whose killing test
 * file changed or no longer reaches it, and each other mutant that a new or changed test file
 * reaches. It takes the result of the others from the report.
 *
 * With no such report, nothing is written, and StrykerJS mutates the whole file, as it did before
 * this. A report is read only from a run of this repository, never from a fork.
 *
 *   node tools/mutation/reference.ts <artifact> <destination> <branch>...
 *
 * reads `GH_REPO` and `GITHUB_REPOSITORY_ID`, and writes one line to `GITHUB_STEP_SUMMARY`.
 */

/** The fields of an artifact of the REST API that the choice reads. */
export type Artifact = {
  id: number;
  name: string;
  expired: boolean;
  created_at: string;
  workflow_run?: { id?: number; head_branch?: string; head_repository_id?: number } | null;
};

/**
 * The newest artifact of the first branch that has one, made by a run of this repository. An
 * artifact that expired has no content left, and one of a fork may hold anything.
 */
export function pick(artifacts: Artifact[], repositoryId: number, branches: string[]): Artifact | undefined {
  for (const branch of branches) {
    const newest = artifacts
      .filter(
        (artifact) =>
          !artifact.expired &&
          artifact.workflow_run?.head_repository_id === repositoryId &&
          artifact.workflow_run.head_branch === branch,
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (newest !== undefined) return newest;
  }

  return undefined;
}

/** The branches to read, in order, without an empty one or a repeat. */
export function branchesOf(names: string[]): string[] {
  return [...new Set(names.filter((name) => name !== ''))];
}

function gh(args: string[]): Buffer {
  return execFileSync('gh', args, { maxBuffer: 512 * 1024 * 1024 });
}

function main([name = '', destination = '', ...names]: string[]): void {
  const repository = process.env.GH_REPO ?? '';
  const repositoryId = Number(process.env.GITHUB_REPOSITORY_ID);
  if (name === '' || destination === '' || repository === '' || !Number.isInteger(repositoryId)) {
    throw new Error('usage: GH_REPO=… GITHUB_REPOSITORY_ID=… reference.ts <artifact> <destination> <branch>…');
  }
  const branches = branchesOf(names);
  const pages = JSON.parse(
    gh([
      'api',
      '--paginate',
      '--slurp',
      `repos/${repository}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100`,
    ]).toString('utf8'),
  ) as { artifacts: Artifact[] }[];
  const chosen = pick(
    pages.flatMap((page) => page.artifacts),
    repositoryId,
    branches,
  );
  const say = (line: string) => {
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  };
  if (chosen === undefined) {
    say(`No report of \`${name}\` on ${branches.join(', ')}: every mutant of the file runs.`);
    return;
  }

  const scratch = mkdtempSync(join(tmpdir(), 'mutation-reference-'));
  try {
    const zip = join(scratch, 'report.zip');
    writeFileSync(zip, gh(['api', `repos/${repository}/actions/artifacts/${chosen.id}/zip`]));
    const report = execFileSync('unzip', ['-p', zip, 'mutation.json'], { maxBuffer: 512 * 1024 * 1024 });
    // A report that is not JSON stops here, and not in StrykerJS after the dry run.
    JSON.parse(report.toString('utf8'));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, report);
  } catch (error) {
    // A report that cannot be read is no report: the whole file runs, as with none.
    rmSync(destination, { force: true });
    say(
      `The report of \`${name}\` from run ${chosen.workflow_run?.id} could not be read: every mutant of the file runs.`,
    );
    console.log(String(error));
    return;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  say(
    `Started from the report of \`${name}\` of run ${chosen.workflow_run?.id} on ${chosen.workflow_run?.head_branch}, made ${chosen.created_at}: https://github.com/${repository}/actions/runs/${chosen.workflow_run?.id}`,
  );
}

if (import.meta.main) main(process.argv.slice(2));
