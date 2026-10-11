import { execFileSync } from 'node:child_process';
import { devNull } from 'node:os';

/**
 * Git for a test, apart from the repository that runs the test (FRU-172).
 *
 * A hook of git exports `GIT_DIR`, and a `git` started in a temporary directory then works on the
 * repository of the hook. On 2026-10-11 the `git init` of a test did so under `pre-push`: git
 * guessed that repository bare, and wrote `core.bare = true` to the configuration that the clone
 * and its worktrees share. A test starts git through this file, and `git-fixture.test.ts` fails on
 * another way.
 */

/**
 * Runs `body` without the variables of git of the process that runs the test, and without the
 * configuration of the machine. Wrap what starts git itself, as `changedSince` does.
 */
export function apart<T>(body: () => T): T {
  const caller = { ...process.env };
  const clear = () => {
    for (const name of Object.keys(process.env)) {
      if (name.startsWith('GIT_')) delete process.env[name];
    }
  };
  clear();
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = devNull;
  try {
    return body();
  } finally {
    clear();
    Object.assign(process.env, caller);
  }
}

/** Runs git in `cwd`, apart from the caller, as an author made for the test. Returns what it printed. */
export function git(cwd: string, ...args: string[]): string {
  return apart(() =>
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@fruitback.invalid', ...args], {
      cwd,
      encoding: 'utf8',
    }),
  );
}
