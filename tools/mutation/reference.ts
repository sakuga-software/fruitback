import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

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

/** The part of a report of StrykerJS that `coarsen` reads. */
export type Report = { testFiles?: Record<string, { source?: string }> } & Record<string, unknown>;

/**
 * The report without each test file whose source changed since it was written, or is gone.
 *
 * StrykerJS tells a changed test by its place in the file. Under vitest each test has one, so a
 * change outside every test, to a helper or a `beforeEach` at the top of the file, would change no
 * test, and a killed mutant would keep a result that the new file might not give. A test file that is
 * not in the report is new to StrykerJS: each of its tests is added, a mutant it killed runs again,
 * and so does a mutant it reaches. So a test file that changed at all counts as a new one, as under
 * `tap`, where a test is a whole file.
 */
export function coarsen(
  report: Report,
  read: (file: string) => string | undefined,
): { report: Report; dropped: string[] } {
  const testFiles = report.testFiles ?? {};
  const dropped = Object.keys(testFiles).filter((file) => read(file) !== testFiles[file]?.source);
  const kept = Object.fromEntries(Object.entries(testFiles).filter(([file]) => !dropped.includes(file)));

  return { report: { ...report, testFiles: kept }, dropped: dropped.sort() };
}

/**
 * The report to start from, or none. A list that cannot be read, a limit of the API or a network
 * that fails, is no report: the job then mutates the whole file, and does not stop before
 * StrykerJS (raised in review).
 */
export function find(
  list: () => Artifact[],
  repositoryId: number,
  branches: string[],
): { artifact?: Artifact; why?: string } {
  try {
    return { artifact: pick(list(), repositoryId, branches) };
  } catch (error) {
    return { why: error instanceof Error ? error.message.split('\n')[0] : String(error) };
  }
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
  const say = (line: string) => {
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  };
  const found = find(
    () =>
      (
        JSON.parse(
          gh([
            'api',
            '--paginate',
            '--slurp',
            `repos/${repository}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100`,
          ]).toString('utf8'),
        ) as { artifacts: Artifact[] }[]
      ).flatMap((page) => page.artifacts),
    repositoryId,
    branches,
  );
  if (found.artifact === undefined) {
    say(
      `${found.why === undefined ? `No report of \`${name}\` on ${branches.join(', ')}` : `The reports of \`${name}\` could not be listed (${found.why})`}: every mutant of the file runs.`,
    );
    return;
  }
  const chosen = found.artifact;

  const scratch = mkdtempSync(join(tmpdir(), 'mutation-reference-'));
  try {
    const zip = join(scratch, 'report.zip');
    writeFileSync(zip, gh(['api', `repos/${repository}/actions/artifacts/${chosen.id}/zip`]));
    const raw = execFileSync('unzip', ['-p', zip, 'mutation.json'], { maxBuffer: 512 * 1024 * 1024 });
    // A report that is not JSON stops here, and not in StrykerJS after the dry run.
    const parsed = JSON.parse(raw.toString('utf8')) as Report;
    // The names of the report are relative to the package, which holds `reports/`.
    const pkg = resolve(dirname(destination), '..');
    const { report, dropped } = coarsen(parsed, (file) =>
      existsSync(join(pkg, file)) ? readFileSync(join(pkg, file), 'utf8') : undefined,
    );
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, JSON.stringify(report));
    if (dropped.length > 0)
      say(`Test files that changed since that report, run as new: ${dropped.map((file) => `\`${file}\``).join(', ')}.`);
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
