import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * The git hooks of `.githooks/` are installed by `pnpm install`, and git runs them (FRU-172).
 *
 * What a hook checks is proved by planting a violation and committing: that is in
 * `docs/decisions/dev-loop.md`. This test holds the three ways the hooks stop running, or stop an
 * install, with nothing to see.
 *
 * It lives beside `workflows.test.ts`, which also reads files of the root, because the root has no
 * `test` target.
 */

const ROOT = new URL('../../../', import.meta.url);
const HOOKS = [
  { name: 'pre-commit', file: new URL('.githooks/pre-commit', ROOT) },
  { name: 'pre-push', file: new URL('.githooks/pre-push', ROOT) },
];
const INSTALLER = new URL('.githooks/install.mjs', ROOT);

/** The `-e '^…'` patterns of the line that filters what the hook gives to oxfmt. */
function leftOutOfFormat(hook: string): string[] {
  const filter = hook.split('\n').find((line) => line.includes('grep -zv')) ?? '';

  return [...filter.matchAll(/-e '\^([^']+)'/g)]
    .map((match) => (match[1] ?? '').replaceAll('\\', '').replace(/\$$/, ''))
    .sort();
}

describe('the git hooks', () => {
  /**
   * Git does not run a hook that is not executable. It prints a hint and goes on, so the commit
   * passes and nothing was checked.
   */
  it(
    'are executable, or git passes over them',
    { skip: process.platform === 'win32' && 'Windows keeps no executable bit on a file' },
    () => {
      for (const { name, file } of HOOKS) {
        assert.notEqual(statSync(file).mode & 0o111, 0, `.githooks/${name} is not executable`);
        assert.match(readFileSync(file, 'utf8'), /^#!\/bin\/sh\n/, `.githooks/${name} names no interpreter`);
      }
    },
  );

  /**
   * `pnpm install` runs the `prepare` script of the root, with a `--filter` too (measured). The
   * three Dockerfiles copy the manifests and nothing else before they install, so a script that
   * needs a file of the repository fails every image build. An empty directory is that context.
   */
  it('are installed by a script that passes where the repository is not, as in an image build', () => {
    const { scripts } = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const prepare = scripts.prepare ?? '';
    assert.match(prepare, /\.githooks\/install\.mjs/, 'the prepare script of the root installs no hook');
    assert.ok(statSync(INSTALLER).isFile());

    const empty = mkdtempSync(join(tmpdir(), 'fruitback-prepare-'));
    try {
      const run = spawnSync(prepare, { shell: true, cwd: empty, encoding: 'utf8' });

      assert.equal(run.status, 0, `prepare failed in an empty directory:\n${run.stderr}`);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  /**
   * A relative path is what lets one setting serve every worktree: git resolves it from the top of
   * the working tree that runs the hook. An absolute path would name the hooks of one checkout.
   */
  it('are read from a relative path, so that a worktree runs the hooks of its own branch', () => {
    assert.match(readFileSync(INSTALLER, 'utf8'), /^const HOOKS = '\.githooks';$/m);
  });

  /**
   * The hook formats files of every package, so it cannot read `.oxfmtignore`, which gives `apps/`
   * and `packages/` back to their own targets. It names the rest of that list itself. A file CI
   * does not format must not stop a commit.
   */
  it('leave out of the format check what .oxfmtignore leaves out, but the packages', () => {
    const ignored = readFileSync(new URL('.oxfmtignore', ROOT), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#') && line !== 'apps/' && line !== 'packages/')
      .sort();

    assert.ok(ignored.length >= 2, `only ${ignored.length} entries found in .oxfmtignore`);
    assert.deepEqual(leftOutOfFormat(readFileSync(new URL('.githooks/pre-commit', ROOT), 'utf8')), ignored);
  });
});
