import { spawnSync } from 'node:child_process';

/**
 * Point git at `.githooks/`, from the `prepare` script of the root (FRU-172).
 *
 * `core.hooksPath` is a relative path, and git resolves it from the top of the working tree that
 * runs the hook. So one setting serves every worktree of a clone, each with the hooks of its own
 * branch, and a branch that holds no `.githooks/` runs none.
 *
 * It never fails an install. An image is built with no git and no `.git`, and a CI job can run as a
 * user that git refuses the repository to. Each case prints one line and exits 0.
 *
 * Plain JavaScript, and not TypeScript as the rest: `pnpm install` must not fail on a Node that
 * strips no types, before anybody has read which Node this repository asks for.
 */

const HOOKS = '.githooks';

/**
 * @param {...string} args
 * @returns {{ ok: boolean, out: string }}
 */
function git(...args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });

  return { ok: result.status === 0, out: (result.stdout ?? '').trim() };
}

/** @returns {string} What was done, for the one line this prints. */
function install() {
  if (!git('rev-parse', '--git-dir').ok) return 'not a git repository, or no git: no hook installed';

  const current = git('config', '--local', '--get', 'core.hooksPath').out;
  if (current === HOOKS) return `hooks already read from ${HOOKS}/`;
  // Somebody chose another directory for this clone. That choice is theirs.
  if (current !== '')
    return `core.hooksPath is ${current}: left as it is. The hooks of this repository are in ${HOOKS}/`;

  return git('config', '--local', 'core.hooksPath', HOOKS).ok
    ? `hooks installed: git reads them from ${HOOKS}/ (pre-commit, pre-push)`
    : 'git refused to write core.hooksPath: no hook installed';
}

console.log(`[fruitback] ${install()}`);
