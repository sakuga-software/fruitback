import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Whether a pull request moves the version of the extension, as a line for `$GITHUB_OUTPUT`
 * (FRU-612).
 *
 *   node tools/ci/extension-release.ts
 *
 * prints `archive=apps/extension/.output/fruitback-<version>-chrome.zip` when the version of
 * `apps/extension/package.json` differs from the one of the base, and `archive=` when it does not.
 * The pull request « chore: version x.y.z » of `version.yml` is the one that moves it. `published.yml`
 * then builds that archive as `release-extension.yml` builds it for the stores, and runs the
 * published specs against it: a spec that still reads the words of the last release fails before
 * the release, and not on every commit of `main` after it (FRU-555, 0.7.0).
 *
 * As in `changes.ts`, the checkout of a pull request is its merge commit: `HEAD^1` is the head of
 * its base.
 */

export const MANIFEST = 'apps/extension/package.json';

/** The archive for Chrome that `wxt zip` writes for a version, and that a release attaches. */
export function archiveOf(version: string): string {
  return `apps/extension/.output/fruitback-${version}-chrome.zip`;
}

/** The archive to build and test, or `undefined` when the version of the extension did not move. */
export function releasedArchive(base: string, head: string): string | undefined {
  const versionOf = (manifest: string) => (JSON.parse(manifest) as { version?: unknown }).version;
  const [before, after] = [versionOf(base), versionOf(head)];
  if (typeof after !== 'string' || after === '') throw new Error(`${MANIFEST} names no version`);

  return before === after ? undefined : archiveOf(after);
}

function main(): void {
  const base = execFileSync('git', ['show', `HEAD^1:${MANIFEST}`], { encoding: 'utf8' });
  const archive = releasedArchive(base, readFileSync(MANIFEST, 'utf8'));
  console.log(`archive=${archive ?? ''}`);
}

if (import.meta.main) main();
