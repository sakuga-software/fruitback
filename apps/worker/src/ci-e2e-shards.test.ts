import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { CI_WORKERS, filesOfShard, partSeconds, partsOf, shardOf } from '../../../e2e/shards.ts';
import { durationsOf, median, secondsOf } from '../../../tools/ci/e2e-durations.ts';

/**
 * The parts of the E2E suite on CI, chosen by the duration of their files (`e2e/shards.ts`).
 *
 * It lives here, beside `ci-durations.test.ts`, because the root has no `test` target.
 */

const E2E = fileURLToPath(new URL('../../../e2e/', import.meta.url));
const SPECS = readdirSync(E2E).filter((name) => name.endsWith('.spec.ts'));
const DURATIONS = JSON.parse(readFileSync(`${E2E}durations.json`, 'utf8')) as Record<string, number>;

/** The count of parts of the matrix of `e2e-shard` in `ci.yml` (FRU-480: six, three before). */
const PARTS = (() => {
  const workflow = readFileSync(fileURLToPath(new URL('../../../.github/workflows/ci.yml', import.meta.url)), 'utf8');
  const shards = /^ {8}shard: \[([\d, ]+)\]$/m.exec(workflow)?.[1]?.split(',').map(Number) ?? [];
  assert.deepEqual(
    shards,
    Array.from({ length: shards.length }, (_, index) => index + 1),
    'the parts are 1 to n',
  );
  assert.ok(shards.length > 1, 'ci.yml cuts the E2E suite in parts');

  return shards.length;
})();

describe('the parts of the E2E suite', () => {
  it('runs every spec file of e2e/ in exactly one of the parts of CI', () => {
    const parts = Array.from({ length: PARTS }, (_, index) => filesOfShard(`${index + 1}/${PARTS}`, E2E));
    assert.deepEqual(parts.flat().toSorted(), SPECS.toSorted());
    for (const part of parts) assert.ok(part.length > 0);
  });

  it('cuts the parts of CI on any machine: the count of workers there does not change them', () => {
    assert.equal(CI_WORKERS, 4);
    assert.deepEqual(filesOfShard(`2/${PARTS}`, E2E), partsOf(SPECS, DURATIONS, PARTS, CI_WORKERS)[1]);
  });

  it('gives the parts about the same time, where --shard gave one twice the time of another', () => {
    const seconds = (file: string) => DURATIONS[file] ?? 0;
    const times = partsOf(SPECS, DURATIONS, PARTS, 4).map((part) => partSeconds(part, seconds, 4));
    // The control: by the count of files, in the order of the paths, as `--shard` cuts by count.
    const sorted = SPECS.toSorted();
    const size = Math.ceil(sorted.length / PARTS);
    const byCount = Array.from({ length: PARTS }, (_, i) =>
      partSeconds(sorted.slice(i * size, (i + 1) * size), seconds, 4),
    );
    assert.ok(Math.max(...times) / Math.min(...times) < 1.1, `parts of ${times.map(Math.round).join(', ')} s`);
    assert.ok(Math.max(...times) < Math.max(...byCount), `${Math.max(...times)} s against ${Math.max(...byCount)} s`);
  });

  it('places a new spec file, that no run measured, as the mean of the others', () => {
    const files = ['a.spec.ts', 'b.spec.ts', 'c.spec.ts', 'new.spec.ts'];
    const parts = partsOf(files, { 'a.spec.ts': 30, 'b.spec.ts': 10, 'c.spec.ts': 20 }, 2, 1);
    assert.deepEqual(parts.flat().toSorted(), files);
    // Mean 20: a (30) alone, then c (20), new (20) and b (10) share the time of the other part.
    assert.deepEqual(parts, [
      ['a.spec.ts', 'b.spec.ts'],
      ['c.spec.ts', 'new.spec.ts'],
    ]);
  });

  it('computes the same parts in every job of the matrix, whatever the order of the folder', () => {
    const forward = partsOf(SPECS, DURATIONS, PARTS, 4);
    assert.deepEqual(partsOf(SPECS.toReversed(), DURATIONS, PARTS, 4), forward);
  });

  it('names no file that e2e/ no longer has', () => {
    assert.deepEqual(
      Object.keys(DURATIONS).filter((file) => !SPECS.includes(file)),
      [],
    );
  });

  it('refuses a part that is not « <part>/<parts> »', () => {
    assert.deepEqual(shardOf('2/3'), { index: 2, total: 3 });
    for (const value of ['', '0/3', '4/3', '1', '1/0', 'a/b']) assert.throws(() => shardOf(value), /E2E_SHARD/);
  });
});

describe('tools/ci/e2e-durations.ts', () => {
  it('sums the tests of each file in the log of a run, retries and parts included', () => {
    const log = [
      'e2e (1/3)\tUNKNOWN STEP\t2026-10-28T15:42:21.5Z   ✓   53 e2e/drafts.spec.ts:94:5 › a send (4.3s)',
      'e2e (3/3)\tUNKNOWN STEP\t2026-10-28T15:43:06.5Z   ✘   64 e2e/drafts.spec.ts:97:7 › b › c (30.4s)',
      'e2e (3/3)\tUNKNOWN STEP\t2026-10-28T15:43:38.6Z   ✘   82 e2e/drafts.spec.ts:97:7 › b › c (retry #1) (30.6s)',
      'e2e (2/3)\tUNKNOWN STEP\t2026-10-28T15:43:38.6Z   ✓  101 e2e/overflow.spec.ts:8:5 › overflows (163ms)',
      'test\tRun\t2026-10-28T15:45:34.6Z   ✔ carries French (0.3ms)',
    ].join('\n');
    const seconds = secondsOf(log);
    assert.equal(seconds.size, 2);
    assert.ok(Math.abs((seconds.get('drafts.spec.ts') ?? 0) - 65.3) < 1e-9);
    assert.ok(Math.abs((seconds.get('overflow.spec.ts') ?? 0) - 0.163) < 1e-9);
  });

  it('keeps the median of the runs, and leaves out a file no run measured', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    const runs = [new Map([['a.spec.ts', 10]]), new Map([['a.spec.ts', 30]]), new Map([['a.spec.ts', 12.34]])];
    assert.deepEqual(durationsOf(runs, ['b.spec.ts', 'a.spec.ts']), { 'a.spec.ts': 12.3 });
  });
});
