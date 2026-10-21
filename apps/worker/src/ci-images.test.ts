import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { describe, it } from 'vitest';
import { covers, IMAGES, needed } from '../../../tools/ci/changes.ts';

/**
 * The images of `ci.yml` (FRU-344): built by one `docker buildx bake`, with their cache in the
 * registry, and skipped on a pull request that changes none of their files. A path left out of
 * `IMAGES` would skip a job that had something to build: a check removed in silence. So the list is
 * held here to the `COPY` lines of each Dockerfile that `docker-bake.hcl` builds.
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
    .flatMap((line) =>
      line
        .replace(/^COPY\s+/, '')
        .split(/\s+/)
        .filter((word) => word !== '' && !word.startsWith('--'))
        // The last word is the destination.
        .slice(0, -1),
    );
}

/** The Dockerfiles that `docker-bake.hcl` builds. */
const DOCKERFILES = [
  ...new Set([...read('docker-bake.hcl').matchAll(/dockerfile\s*=\s*"([^"]+)"/g)].map((m) => m[1] ?? '')),
];

describe('the images that ci.yml builds', () => {
  it('builds whenever a path that a Dockerfile of docker-bake.hcl copies changes', () => {
    assert.deepEqual(DOCKERFILES.sort(), [
      'apps/console/Dockerfile',
      'apps/playground/Dockerfile',
      'apps/worker/Dockerfile',
    ]);
    for (const dockerfile of DOCKERFILES) {
      const sources = copiedFrom(dockerfile);
      assert.ok(sources.length >= 4, `${dockerfile}: only ${sources.length} COPY sources found`);
      // A directory is copied with everything under it: one file inside stands for it.
      const left = sources.filter((source) => !covers(IMAGES, source) && !covers(IMAGES, `${source}/x`));
      assert.deepEqual(left, [], `${dockerfile} copies paths that do not build the images`);
      assert.ok(covers(IMAGES, dockerfile), dockerfile);
    }
  });

  it('builds on the files that build them, and on those its steps read', () => {
    for (const file of [
      'docker-bake.hcl',
      '.dockerignore',
      'pnpm-lock.yaml',
      '.github/workflows/ci.yml',
      'docker-compose.yml',
      '.env.example',
      '.nvmrc',
      'apps/worker/src/plant-a-pin.ts',
      'apps/worker/cloud/restore-drill.sh',
      'apps/worker/drizzle/meta/_journal.json',
    ]) {
      assert.ok(covers(IMAGES, file), file);
    }
  });

  it('skips a pull request of the docs, the e2e specs or the extension, and of nothing else', () => {
    assert.equal(needed(['docs/decisions/conventions.md', 'e2e/pins.spec.ts', 'apps/extension/src/a.ts']), false);
    assert.equal(needed(['packages/widget/src/composer.ts']), true);
    assert.equal(needed(['apps/worker/src/identity.ts']), true);
    // `apps/worker-x` is not `apps/worker`.
    assert.equal(needed(['apps/worker-x/a.ts']), false);
    // A push, a merge queue, a release: no list, every image.
    assert.equal(needed(undefined), true);
  });

  it('runs the job on what changes wrote, and writes the cache only after CI passed on main', () => {
    type Step = { name?: string; run?: string; env?: Record<string, string> };
    type Job = {
      needs?: string;
      if?: string;
      outputs?: Record<string, string>;
      permissions?: Record<string, string>;
      steps: Step[];
    };
    const ci = read('.github/workflows/ci.yml');
    const { jobs } = parseDocument(ci).toJS() as { jobs: Record<string, Job> };
    const bake = jobs.image?.steps.find((step) => step.run?.startsWith('docker buildx bake'));

    assert.deepEqual(jobs.changes?.outputs, { images: '${{ steps.changes.outputs.images }}' });
    assert.equal(jobs.image?.needs, 'changes');
    // A `changes` that wrote nothing must not skip the job: only an explicit `false` does.
    assert.equal(jobs.image?.if, "${{ !cancelled() && needs.changes.outputs.images != 'false' }}");
    assert.equal(bake?.run, 'docker buildx bake --file docker-bake.hcl --load ci');
    // A run of ci.yml reads the cache and never writes it: a pull request could write layers that
    // the next build reads.
    assert.equal(bake?.env?.CACHE_WRITE, undefined);
    assert.deepEqual(jobs.image?.permissions, { contents: 'read', packages: 'read' });
    const release = parseDocument(read('.github/workflows/release-image.yml')).toJS() as {
      jobs: Record<string, Job & { uses?: string }>;
    };
    const writer = release.jobs['layer-cache'];
    assert.equal(writer?.needs, 'ci', 'the cache is written from a commit that did not pass CI');
    assert.equal(writer?.if, "github.ref == 'refs/heads/main'", 'the cache is written from a branch nobody merged');
    assert.deepEqual(writer?.permissions, { contents: 'read', packages: 'write' });
    assert.equal(writer?.steps.at(-1)?.env?.CACHE_WRITE, 'true');
    assert.equal(writer?.steps.at(-1)?.run, 'docker buildx bake --file docker-bake.hcl ci');
    // A called workflow gets no permission that its caller does not give.
    assert.deepEqual(release.jobs.ci?.permissions, { contents: 'read', packages: 'read' });
    // The cache of GitHub Actions is for pnpm: no layer goes there any more.
    assert.ok(!ci.includes('type=gha'), 'ci.yml still caches layers in GitHub Actions');
    assert.ok(
      read('docker-bake.hcl').includes('CACHE_REPO != "" && CACHE_WRITE'),
      'bake writes the cache when not asked to',
    );
  });
});
