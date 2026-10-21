import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parseDocument } from 'yaml';
import { covers, JOBS, needed } from '../../../tools/ci/changes.ts';

/**
 * `tools/ci/changes.ts` skips a job of `ci.yml` that builds an image when a pull request changes
 * none of its paths (FRU-344). A path left out of a list would skip a job that had something to
 * build: a check removed in silence. So each list is held here to the `COPY` lines of the Dockerfiles
 * the job builds.
 *
 * It lives beside `workflows.test.ts` because the root has no `test` target.
 */

const ROOT = new URL('../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), 'utf8');

/** The sources of the `COPY` lines of a Dockerfile that read the build context, not another stage. */
function copiedFrom(dockerfile: string): string[] {
  return read(dockerfile)
    .split('\n')
    .filter((line) => /^COPY\s/.test(line) && !/--from=/.test(line))
    .flatMap((line) => {
      const words = line
        .replace(/^COPY\s+/, '')
        .split(/\s+/)
        .filter((word) => word !== '' && !word.startsWith('--'));
      // The last word is the destination.
      return words.slice(0, -1);
    });
}

describe('which images a pull request can change', () => {
  const DOCKERFILES: Record<keyof typeof JOBS, string[]> = {
    worker: ['apps/worker/Dockerfile'],
    web: ['apps/console/Dockerfile', 'apps/playground/Dockerfile'],
    compose: ['apps/worker/Dockerfile', 'apps/console/Dockerfile'],
  };

  it('builds an image whenever a path that its Dockerfile copies changes', () => {
    for (const [job, files] of Object.entries(DOCKERFILES) as [keyof typeof JOBS, string[]][]) {
      for (const dockerfile of files) {
        const sources = copiedFrom(dockerfile);
        assert.ok(sources.length >= 4, `${dockerfile}: only ${sources.length} COPY sources found`);
        // A directory is copied with everything under it: one file inside stands for it.
        const left = sources.filter((source) => !covers(JOBS[job], source) && !covers(JOBS[job], `${source}/x`));
        assert.deepEqual(left, [], `${job}: ${dockerfile} copies paths that do not run the job`);
        assert.ok(covers(JOBS[job], dockerfile), `${job}: a change to ${dockerfile} does not run the job`);
      }
    }
  });

  it('builds every image on the files that all of them read, and on its own workflow', () => {
    for (const job of Object.keys(JOBS) as (keyof typeof JOBS)[]) {
      for (const file of ['pnpm-lock.yaml', 'package.json', '.dockerignore', '.github/workflows/ci.yml']) {
        assert.ok(covers(JOBS[job], file), `${job}: ${file}`);
      }
    }
    // What the compose step copies and runs beside the images.
    for (const file of ['docker-compose.yml', '.env.example', '.nvmrc', 'apps/worker/src/plant-a-pin.ts']) {
      assert.ok(covers(JOBS.compose, file), `compose: ${file}`);
    }
    // restore-drill.sh, and the journal of migrations that the boot of the worker counts.
    assert.ok(covers(JOBS.worker, 'apps/worker/cloud/restore-drill.sh'));
    assert.ok(covers(JOBS.worker, 'apps/worker/drizzle/meta/_journal.json'));
  });

  it('skips the images that a pull request of the widget, or of the docs, does not change', () => {
    assert.deepEqual(needed(['packages/widget/src/composer.ts', 'packages/widget/src/composer.test.ts']), {
      worker: false,
      web: true,
      compose: true,
    });
    assert.deepEqual(needed(['apps/worker/src/identity.ts']), { worker: true, web: false, compose: true });
    assert.deepEqual(needed(['docs/decisions/conventions.md', 'e2e/pins.spec.ts', 'apps/extension/src/a.ts']), {
      worker: false,
      web: false,
      compose: false,
    });
    // `apps/worker-x` is not `apps/worker`.
    assert.equal(needed(['apps/worker-x/a.ts']).worker, false);
  });

  it('builds every image when it has no list of files: a push, a merge queue, a release', () => {
    assert.deepEqual(needed(undefined), { worker: true, web: true, compose: true });
  });

  /**
   * The three jobs run on what `changes` says, and only on a value it wrote: a job whose condition
   * reads an output that does not exist would be skipped forever.
   */
  it('runs each job of an image on its own output of changes, and on nothing else', () => {
    type Job = { needs?: string | string[]; if?: string };
    const { jobs } = parseDocument(read('.github/workflows/ci.yml')).toJS() as {
      jobs: Record<string, Job & { outputs?: Record<string, string> }>;
    };
    const outputs = jobs.changes?.outputs ?? {};

    assert.deepEqual(Object.keys(outputs).sort(), Object.keys(JOBS).sort());
    for (const [id, output] of [
      ['image', 'worker'],
      ['image-web', 'web'],
      ['compose', 'compose'],
    ] as const) {
      assert.equal(outputs[output], `\${{ steps.changes.outputs.${output} }}`);
      assert.ok([jobs[id]?.needs].flat().includes('changes'), `${id} does not wait for changes`);
      assert.equal(jobs[id]?.if, `needs.changes.outputs.${output} == 'true'`, id);
    }
  });
});

/**
 * A suite cut in parts runs whole only when the parts are 1/N to N/N (FRU-344): a part left out of
 * the matrix is a quarter of the suite that never runs, and a green check.
 */
describe('the parts of test and postgres', () => {
  type Job = {
    needs?: string;
    if?: string;
    strategy?: { matrix?: Record<string, string[]> };
    steps?: { run?: string; env?: Record<string, string> }[];
  };
  const { jobs } = parseDocument(read('.github/workflows/ci.yml')).toJS() as { jobs: Record<string, Job> };

  /** Whether `parts` are exactly 1/N … N/N, in order. */
  const whole = (parts: string[]) =>
    parts.length > 0 && parts.every((part, index) => part === `${index + 1}/${parts.length}`);

  it('runs every test file of the worker, every package, and each under two locales', () => {
    const matrix = jobs['test-part']?.strategy?.matrix ?? {};
    const parts = matrix.part ?? [];

    assert.ok(parts.includes('packages'), 'no part runs the packages other than the worker');
    const worker = parts.filter((part) => part.startsWith('worker ')).map((part) => part.slice('worker '.length));
    assert.ok(whole(worker), `the parts of the worker are ${worker.join(', ')}`);
    assert.deepEqual(matrix.locale, ['runner', 'fr-FR']);
    assert.ok(!whole(['1/4', '2/4', '4/4']) && !whole(['1/3', '2/3', '3/3', '4/3']), 'the detector reads nothing');
  });

  it('runs every test file on PostgreSQL', () => {
    assert.ok(whole(jobs['postgres-part']?.strategy?.matrix?.part ?? []));
  });

  it('fails the check of a pull request when a part failed, was cancelled, or did not run', () => {
    for (const [check, parts] of [
      ['test', 'test-part'],
      ['postgres', 'postgres-part'],
      ['e2e', 'e2e-shard'],
    ] as const) {
      const job = jobs[check];
      assert.equal(job?.needs, parts, check);
      assert.equal(job?.if, 'always()', `${check}: a check that is skipped when a part failed passes`);
      assert.equal(job?.steps?.at(-1)?.run, 'test "$RESULT" = success', check);
      assert.equal(job?.steps?.at(-1)?.env?.RESULT, `\${{ needs.${parts}.result }}`, check);
    }
  });
});
