import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';

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
/** What the `test` script of a package passes to `node --test`: nothing, unless the variable is set. */
const CONCURRENCY = '${FRUITBACK_TEST_CONCURRENCY:+--test-concurrency=$FRUITBACK_TEST_CONCURRENCY}';

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

  /**
   * Without a bound, `node --test` runs the files of a package on every core but one, and
   * `NODE_OPTIONS` refuses `--test-concurrency`. So the `test` script of each package passes
   * `FRUITBACK_TEST_CONCURRENCY` to Node. The option goes before the files, because Node ignores
   * it after them (measured). `pre-push` sets the variable. CI does not, so CI keeps every core.
   */
  it(
    'bound the test files that a push runs at a time, and leave CI on every core',
    { skip: process.platform === 'win32' && 'the scripts of the packages are read by a POSIX shell' },
    () => {
      const scripts = ['apps', 'packages'].flatMap((directory) =>
        readdirSync(new URL(`${directory}/`, ROOT), { withFileTypes: true })
          .filter(
            (entry) => entry.isDirectory() && existsSync(new URL(`${directory}/${entry.name}/package.json`, ROOT)),
          )
          .map((entry) => {
            const file = `${directory}/${entry.name}/package.json`;
            const { scripts: all = {} } = JSON.parse(readFileSync(new URL(file, ROOT), 'utf8')) as {
              scripts?: Record<string, string>;
            };
            return { file, test: all.test ?? '' };
          })
          .filter(({ test }) => test.startsWith('node --test')),
      );
      assert.ok(scripts.length >= 7, `only ${scripts.length} packages run node --test`);
      for (const { file, test } of scripts) {
        assert.ok(test.startsWith(`node --test ${CONCURRENCY} '`), `${file} runs every test file at once: ${test}`);
      }

      const hook = readFileSync(new URL('.githooks/pre-push', ROOT), 'utf8');
      assert.match(hook, /^export FRUITBACK_TEST_CONCURRENCY="\$\{FRUITBACK_TEST_CONCURRENCY:-[1-9]\d*\}"$/m);
      const workflows = new URL('.github/workflows/', ROOT);
      for (const workflow of readdirSync(workflows)) {
        assert.doesNotMatch(readFileSync(new URL(workflow, workflows), 'utf8'), /FRUITBACK_TEST_CONCURRENCY/, workflow);
      }

      const args = (value: string | undefined) => {
        const env = { ...process.env };
        delete env.FRUITBACK_TEST_CONCURRENCY;
        if (value !== undefined) env.FRUITBACK_TEST_CONCURRENCY = value;
        const run = spawnSync('sh', ['-c', `printf '%s\\n' node --test ${CONCURRENCY} file`], {
          env,
          encoding: 'utf8',
        });
        return run.stdout.trim().split('\n');
      };
      assert.deepEqual(args('2'), ['node', '--test', '--test-concurrency=2', 'file']);
      assert.deepEqual(args(undefined), ['node', '--test', 'file']);
    },
  );

  /**
   * Git gives a hook `GIT_DIR`. A test that starts git in a temporary directory then works on the
   * repository that pushes: one did, and it set `core.bare` on the clone (2026-10-11). So the hook
   * starts Nx, and with it every test, without the variables that name a repository. The function
   * is run here as the hook wrote it, with `env` in the place of Nx.
   */
  it(
    'hide the repository that pushes from the tests they run',
    { skip: process.platform === 'win32' && 'the hook is a POSIX shell script' },
    () => {
      const hook = readFileSync(new URL('.githooks/pre-push', ROOT), 'utf8');
      const nx = /^nx\(\) \{\n[\s\S]*?^\}\n/m.exec(hook)?.[0] ?? '';
      assert.match(nx, /exec node_modules\/\.bin\/nx "\$@"/, 'pre-push holds no function that starts Nx');

      const started = hook.replace(nx, '').match(/^(?!#).*node_modules\/\.bin\/nx(?! \]).*$/gm) ?? [];
      assert.deepEqual(started, [], 'pre-push starts Nx outside the function that hides the repository');

      const env = {
        PATH: process.env.PATH ?? '',
        GIT_DIR: '/a',
        GIT_WORK_TREE: '/b',
        GIT_INDEX_FILE: '/c',
        KEPT: 'yes',
      };
      const run = spawnSync('sh', ['-c', `${nx.replace('node_modules/.bin/nx "$@"', 'env')}nx`], {
        env,
        encoding: 'utf8',
      });
      const seen = run.stdout.split('\n').filter((line) => /^(GIT_|KEPT=)/.test(line));
      assert.deepEqual(seen, ['KEPT=yes'], run.stderr);
    },
  );
});
