import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { describe, it } from 'vitest';
import { passes, testFilesOf, verdictOf } from '../../../tools/ci/test-parts.ts';

/**
 * The parts of the tests of the worker on CI (FRU-480), and the check that they lost no file.
 *
 * It lives here, beside `ci-e2e-shards.test.ts`, because the root has no `test` target.
 */

const ROOT = new URL('../../../', import.meta.url);
const WORKER = fileURLToPath(new URL('../', import.meta.url));
const SCRIPT = fileURLToPath(new URL('tools/ci/test-parts.ts', ROOT));

type Step = { name?: string; if?: string; env?: Record<string, string>; run?: string; with?: Record<string, unknown> };
type Job = {
  name?: string;
  needs?: string | string[];
  if?: string;
  strategy?: { matrix?: { include?: { part: number; projects: string }[] } };
  steps: Step[];
};
const JOBS = (
  parseDocument(readFileSync(new URL('.github/workflows/ci.yml', ROOT), 'utf8')).toJS() as {
    jobs: Record<string, Job>;
  }
).jobs;

describe('the parts of the tests of the worker', () => {
  it('lists the test files with the pattern of vitest.config.ts', () => {
    const config = readFileSync(new URL('vitest.config.ts', `file://${WORKER}`), 'utf8');
    assert.match(config, /^ {4}include: \['src\/\*\*\/\*\.test\.ts'\],$/m);
    const files = testFilesOf(WORKER);
    assert.ok(files.includes('src/ci-test-parts.test.ts'));
    assert.ok(files.every((file) => /^src\/.+\.test\.ts$/.test(file)));
    assert.ok(files.length > 100, `only ${files.length} test files`);
  });

  it('passes when each file ran in one part, and names each file lost, run twice or unknown', () => {
    const files = ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts'];
    assert.ok(passes(verdictOf(files, [['src/a.test.ts', 'src/c.test.ts'], ['src/b.test.ts']])));

    // The controls: each fault alone fails.
    const lost = verdictOf(files, [['src/a.test.ts'], ['src/b.test.ts']]);
    assert.deepEqual(lost.missing, ['src/c.test.ts']);
    assert.ok(!passes(lost));
    const twice = verdictOf(files, [files, ['src/b.test.ts']]);
    assert.deepEqual(twice.twice, [['src/b.test.ts', 2]]);
    assert.ok(!passes(twice));
    const empty = verdictOf(files, [files, []]);
    assert.deepEqual(empty.empty, [2]);
    assert.ok(!passes(empty));
    const unknown = verdictOf(files, [files, ['src/d.test.ts']]);
    assert.deepEqual(unknown.unknown, ['src/d.test.ts']);
    assert.ok(!passes(unknown));
  });

  it('exits 1 on a lost file and on a missing list, 0 on a whole cut', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fruitback-test-parts-'));
    try {
      mkdirSync(join(dir, 'pkg/src/deep'), { recursive: true });
      for (const file of ['a.test.ts', 'deep/b.test.ts', 'helper.ts']) writeFileSync(join(dir, 'pkg/src', file), '');
      writeFileSync(join(dir, '1'), 'src/a.test.ts\n');
      writeFileSync(join(dir, '2'), 'src/deep/b.test.ts\n');
      const run = (...lists: string[]) =>
        spawnSync(process.execPath, [SCRIPT, join(dir, 'pkg'), ...lists.map((list) => join(dir, list))], {
          encoding: 'utf8',
          env: { ...process.env, GITHUB_STEP_SUMMARY: '' },
        });

      assert.equal(run('1', '2').status, 0);
      const lost = run('1', '1');
      assert.equal(lost.status, 1);
      assert.match(lost.stdout, /src\/deep\/b\.test\.ts ran in no part/);
      assert.equal(run('1', 'absent').status, 1);
      assert.equal(run('1').status, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs on CI: each part writes its list, and the check `test` reads them all', () => {
    const part = JOBS['test-part'];
    assert.ok(part, 'ci.yml has no job test-part');
    const parts = part.strategy?.matrix?.include ?? [];
    assert.deepEqual(
      parts.map((entry) => entry.part),
      [1, 2],
    );

    const run = part.steps.find((step) => step.run?.includes('nx run-many -t test'));
    assert.equal(run?.env?.FRUITBACK_TEST_SHARD, '${{ matrix.part }}/${{ strategy.job-total }}');
    assert.ok(run?.env?.FRUITBACK_TEST_FILES, 'the part writes no list');
    // The worker runs in each part: a part without it would leave its share of the files to none.
    for (const { projects } of parts) {
      const named = projects.replace(/^--(exclude|projects)=/, '').split(',');
      assert.equal(named.includes('@fruitback/worker'), projects.startsWith('--projects='), projects);
    }
    // A package that no part names runs in the part that excludes the others.
    assert.equal(parts.filter((entry) => entry.projects.startsWith('--exclude=')).length, 1);

    const test = JOBS.test;
    assert.equal(test?.name, 'test');
    assert.equal(test?.needs, 'test-part');
    assert.equal(test?.if, 'always()');
    assert.ok(test?.steps.some((step) => step.run?.includes('node tools/ci/test-parts.ts apps/worker')));
  });
});
