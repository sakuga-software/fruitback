import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { git } from './git.fixture.ts';

/**
 * A test that starts git stays out of the repository that runs it (FRU-172).
 *
 * It lives in the worker because the root has no `test` target, and its second test reads every
 * package.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Everything a build, a browser or a package manager wrote. */
const IGNORED = new Set(['node_modules', 'dist', '.git', '.output', '.react-router', '.wxt', '.nx', '.stryker-tmp']);

/**
 * The files that may start git: the fixture, the script of the mutation job that tests wrap in
 * `apart`, and the script of CI that reads the files of a pull request (FRU-344), which no test runs.
 */
const ALLOWED = ['apps/worker/src/git.fixture.ts', 'tools/ci/changes.ts', 'tools/mutation/scope.ts'];

/** A call that starts git itself, or hands a line that begins with `git` to a shell. */
const STARTS_GIT = /\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\(\s*['"`]git\b/;

/**
 * The files of the tests: a test, a spec, a fixture, and all of `e2e/` and of `tools/`. They are
 * the files that the `test` target of the worker hashes outside its own project, so a change to
 * one of them runs this test again.
 */
function testFilesUnder(directory: string, all = false): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return IGNORED.has(entry.name) ? [] : testFilesUnder(path, all);
    const wanted = all ? /\.(?:ts|tsx|mts|mjs|js)$/ : /\.(?:test|spec|fixture)\.tsx?$/;
    return entry.isFile() && wanted.test(entry.name) ? [path] : [];
  });
}

describe('git in a test', () => {
  /**
   * `pre-push` runs the tests with `GIT_DIR` set to the worktree that pushes. A `git init` that
   * inherits it re-initialises that repository and guesses it bare, and a commit lands on the
   * branch being pushed. The test plants that variable on a clone and a worktree made for it.
   */
  it('stays in its own repository when a hook of git runs it', () => {
    const outer = mkdtempSync(join(tmpdir(), 'fruitback-hook-'));
    const caller = process.env.GIT_DIR;
    try {
      git(outer, 'init', '-q', '-b', 'main', 'clone');
      git(join(outer, 'clone'), 'commit', '-q', '--allow-empty', '-m', 'first');
      git(join(outer, 'clone'), 'worktree', 'add', '-q', '-b', 'pushed', '../worktree');
      // The value that `pre-push` exports in a worktree, read in the environment of a real hook.
      process.env.GIT_DIR = join(outer, 'clone/.git/worktrees/worktree');

      git(outer, 'init', '-q', '-b', 'main', 'fixture');
      git(join(outer, 'fixture'), 'commit', '-q', '--allow-empty', '-m', 'of the test');

      assert.equal(process.env.GIT_DIR, join(outer, 'clone/.git/worktrees/worktree'), 'the fixture keeps the variable');
      delete process.env.GIT_DIR;
      assert.equal(git(join(outer, 'fixture'), 'log', '--format=%s').trim(), 'of the test');
      assert.equal(git(join(outer, 'worktree'), 'log', '--format=%s').trim(), 'first');
      assert.equal(git(join(outer, 'clone'), 'config', 'core.bare').trim(), 'false');
    } finally {
      if (caller === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = caller;
      rmSync(outer, { recursive: true, force: true });
    }
  });

  /**
   * The scan reads the text of the files of the tests, so it sees a direct call and not a name
   * held in a variable, nor a script that a test starts. It holds the way the defect came in.
   */
  it('is started through git.fixture.ts, and by no other file', () => {
    const sources = [
      ...testFilesUnder(join(ROOT, 'apps')),
      ...testFilesUnder(join(ROOT, 'packages')),
      ...testFilesUnder(join(ROOT, 'e2e'), true),
      ...testFilesUnder(join(ROOT, 'tools'), true),
    ];
    assert.ok(sources.length > 100, `only ${sources.length} files of tests were read`);

    const starters = sources
      .filter((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .some((line) => STARTS_GIT.test(line)),
      )
      .map((file) => file.slice(ROOT.length))
      .sort();

    assert.deepEqual(starters, ALLOWED);
  });
});
