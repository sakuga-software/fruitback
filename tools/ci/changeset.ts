import { changedOnTopOfBase } from './changes.ts';

/**
 * Whether a pull request that changes a published package carries a changeset (FRU-28).
 *
 * The packages go to npm, and `changeset version` writes their version and their changelog from the
 * files in `.changeset/`. A change with no changeset reaches no changelog, and a consumer reads that
 * nothing changed. A pull request that changes only an app, a document or a test needs none.
 *
 * Only a pull request is read, as in `changes.ts`: `HEAD^1..HEAD` of its merge commit.
 *
 *   node tools/ci/changeset.ts <event>
 *
 * exits 1, with the reason, when a published package changed and no changeset was added.
 */

/** The directories of the packages that go to npm. */
export const PUBLISHED: readonly string[] = [
  'packages/shared/',
  'packages/widget/',
  'packages/element/',
  'packages/react/',
  'packages/fruitback/',
];

/** A file that a consumer of a published package can get: in its directory, and not a test. */
export function isPublished(file: string): boolean {
  return PUBLISHED.some((directory) => file.startsWith(directory)) && !file.endsWith('.test.ts');
}

/** A changeset is one Markdown file in `.changeset/`. The README of the directory is not one. */
export function isChangeset(file: string): boolean {
  return /^\.changeset\/[^/]+\.md$/.test(file) && file !== '.changeset/README.md';
}

/** The published files that changed, when no changeset came with them. Empty means the check passes. */
export function withoutChangeset(changed: readonly string[]): string[] {
  return changed.some(isChangeset) ? [] : changed.filter(isPublished);
}

function main([event = '']: string[]): void {
  if (event !== 'pull_request') return;
  const missing = withoutChangeset(changedOnTopOfBase());
  if (missing.length === 0) return;

  console.error(
    [
      'This pull request changes a package that goes to npm, and adds no changeset:',
      ...missing.map((file) => `  ${file}`),
      'Run `pnpm changeset` and commit the file it writes. For a change that a consumer cannot see,',
      'run `pnpm changeset --empty`.',
    ].join('\n'),
  );
  process.exitCode = 1;
}

if (import.meta.main) main(process.argv.slice(2));
