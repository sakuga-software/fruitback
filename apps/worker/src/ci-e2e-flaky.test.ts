import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { parseDocument } from 'yaml';
import { flakyOf } from '../../../tools/ci/e2e-flaky.ts';

/**
 * The traces of a test that passed only on its retry (FRU-737). Before, the part stayed green and its
 * traces were kept only when it failed: the first run of a flaky test, the one with the cause, was
 * lost, and FRU-736 read its error again in 30 logs of jobs.
 *
 * It lives beside `ci-e2e-shards.test.ts` because the root has no `test` target.
 */

const ROOT = new URL('../../../', import.meta.url);
const SCRIPT = fileURLToPath(new URL('tools/ci/e2e-flaky.ts', ROOT));

/**
 * A report of the `json` reporter of Playwright 1.64.1, cut to what the script reads. Written by a
 * run of four tests with `retries: 1`: one passed, one failed twice, one was skipped, and the one in
 * `describe('group')` failed on its first run and passed on its retry.
 */
const REPORT = {
  config: { rootDir: '/repo/e2e' },
  suites: [
    {
      title: 'a.spec.ts',
      specs: [
        { title: 'steady', file: 'a.spec.ts', line: 5, tests: [{ status: 'expected' }] },
        { title: 'broken', file: 'a.spec.ts', line: 6, tests: [{ status: 'unexpected' }] },
        { title: 'skipped', file: 'a.spec.ts', line: 7, tests: [{ status: 'skipped' }] },
      ],
      suites: [
        { title: 'group', specs: [{ title: 'flaky one', file: 'a.spec.ts', line: 3, tests: [{ status: 'flaky' }] }] },
      ],
    },
  ],
};

/** What the script writes to `$GITHUB_OUTPUT` for a report, or for no report at all. */
function outputOf(report: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'e2e-flaky-'));
  try {
    const path = join(directory, 'results.json');
    if (report !== undefined) writeFileSync(path, JSON.stringify(report));
    const output = join(directory, 'output');
    writeFileSync(output, '');
    execFileSync('node', [SCRIPT, path], { env: { ...process.env, GITHUB_OUTPUT: output }, stdio: 'pipe' });

    return readFileSync(output, 'utf8');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('the traces of a flaky test of the E2E suite', () => {
  it('finds the test that passed only on its retry, and not one that passed, failed or was skipped', () => {
    assert.deepEqual(flakyOf(REPORT, '/repo'), [{ file: 'e2e/a.spec.ts', line: 3, title: 'group › flaky one' }]);
  });

  it('writes flaky=true for a part with a flaky test, and flaky=false for a part with none', () => {
    assert.equal(outputOf(REPORT), 'flaky=true\n');
    const steady = structuredClone(REPORT);
    steady.suites[0]!.suites = [];
    assert.equal(outputOf(steady), 'flaky=false\n');
  });

  it('writes flaky=false when the run stopped before the report was written', () => {
    assert.equal(outputOf(undefined), 'flaky=false\n');
  });

  it('keeps the traces of a part with a flaky test, as of a part that failed', () => {
    const workflow = parseDocument(readFileSync(new URL('.github/workflows/ci.yml', ROOT), 'utf8')).toJS() as {
      jobs: Record<string, { steps: { id?: string; if?: string; run?: string; uses?: string }[] }>;
    };
    const steps = workflow.jobs['e2e-shard']?.steps ?? [];
    const find = steps.find((step) => step.run?.includes('tools/ci/e2e-flaky.ts'));
    assert.ok(find?.id !== undefined, 'a step of e2e-shard runs tools/ci/e2e-flaky.ts, with an id');
    assert.match(find.run ?? '', / playwright-report\/results\.json$/);
    assert.equal(find.if, '${{ !cancelled() }}');

    const upload = steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    assert.equal(upload?.if, `\${{ failure() || steps.${find.id}.outputs.flaky == 'true' }}`);
    assert.ok(steps.indexOf(find) < steps.indexOf(upload), 'the flaky step runs before the upload');
  });

  it('records on CI the trace of the first run and writes the report the script reads', () => {
    // In a process of its own: the config reads `CI` when it loads.
    const read = `const { default: c } = await import(${JSON.stringify(fileURLToPath(new URL('playwright.config.ts', ROOT)))});
      console.log(JSON.stringify({ trace: c.use.trace, reporter: c.reporter }));`;
    const config = (ci: string | undefined) => {
      const env = { ...process.env, CI: ci };
      if (ci === undefined) delete env.CI;
      return JSON.parse(
        execFileSync('node', ['--input-type=module', '-e', read], { env, encoding: 'utf8', stdio: 'pipe' }),
      ) as {
        trace: string;
        reporter: unknown[];
      };
    };

    const onCi = config('true');
    assert.equal(onCi.trace, 'retain-on-first-failure');
    assert.deepEqual(
      onCi.reporter.find((reporter) => Array.isArray(reporter) && reporter[0] === 'json'),
      ['json', { outputFile: 'playwright-report/results.json' }],
    );
    // Off CI, as before: one worker, no retry, and no trace to write for every test.
    assert.equal(config(undefined).trace, 'on-first-retry');
  });
});
