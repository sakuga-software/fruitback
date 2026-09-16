import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The tests the documents name, against the tests that exist (SKG-601).
 *
 * `SECURITY.md`, `CLAUDE.md` and the pages under `docs/` say which test holds a claim. Nothing
 * checked that those names were real, and five had drifted: a renamed test, and a citation truncated
 * before a ` (SKG-517)` suffix. **A truncated citation still greps**, so looking for drift by hand
 * finds none.
 *
 * A name is cited as test:`the name`, and the marker is what makes this possible: backticks alone
 * are prose, and matching every backticked span reports sixteen false positives on these documents.
 * A name that is gone on purpose is cited as gone-test:`the name`, and this file fails if such a
 * name comes back — a sentence about a test that no longer exists is wrong in that direction too.
 *
 * It lives beside `contributing.test.ts` and `compose.test.ts`, which also guard files at the root,
 * because the root has no `test` target.
 */

const REPOSITORY = fileURLToPath(new URL('../../../', import.meta.url));

/** The path a reader can open, whatever shape the walk reported. */
function inRepository(path: string): string {
  return path.slice(REPOSITORY.length).replace(/^\//, '');
}

/** Everything a build, a browser or a package manager wrote. */
const IGNORED = new Set([
  'node_modules',
  'dist',
  '.git',
  '.output',
  '.react-router',
  '.nx',
  'test-results',
  'playwright-report',
  'coverage',
]);

/**
 * The walk descends rather than asking for `recursive`, so it never enters an ignored directory.
 * Reading them costs the whole of `node_modules`, and its workspace links point at a `dist` that
 * `package.test.ts` deletes while it runs — the walk then fails with `ENOENT` on a directory this
 * check has no business in.
 */
function filesUnder(extensions: string[]): string[] {
  const found: string[] = [];
  const directories = [REPOSITORY];

  while (directories.length > 0) {
    const directory = directories.pop() as string;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      // `isDirectory` answers false for a symbolic link, which is what keeps the walk out of the
      // workspace links in `node_modules`.
      if (entry.isDirectory() && !IGNORED.has(entry.name)) directories.push(path);
      if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))) found.push(path);
    }
  }

  return found;
}

/** A name wraps across lines in a document and never in the source, so both sides are compared flat. */
function flat(value: string): string {
  return value.split(/\s+/).join(' ').trim();
}

function declaredTestNames(): Set<string> {
  const names = new Set<string>();
  for (const path of filesUnder(['.test.ts', '.spec.ts'])) {
    for (const [, , name] of readFileSync(path, 'utf8').matchAll(/(?:^|\s)(?:it|test)\(\s*(['"`])(.+?)\1/gs)) {
      if (name !== undefined) names.add(flat(name));
    }
  }

  return names;
}

type Citation = { document: string; marker: string; name: string };

/**
 * Every marked citation in the documents.
 *
 * Fenced blocks are dropped first: the convention is written out in `CLAUDE.md`, and an example of
 * the marker is not a claim about a test. A name that holds a backtick — `promises only what
 * `public.ts` declares` — is cited between double backticks, as Markdown requires.
 */
function citations(): Citation[] {
  const found: Citation[] = [];
  for (const path of filesUnder(['.md'])) {
    const prose = readFileSync(path, 'utf8').replace(/```[\s\S]*?```/g, '');
    // A marker starts a word and sits outside a code span. A document that writes the convention says
    // `test:`, whose closing backtick would otherwise open a citation of the prose after it, and the
    // `test:` inside `gone-test:` would make a second one.
    for (const [, marker, doubled, single] of prose.matchAll(
      /(?<![`\w-])(gone-test|test):(?:``((?:[^`]|`(?!`))+)``|`([^`]+)`)/g,
    )) {
      const name = doubled ?? single;
      if (marker !== undefined && name !== undefined) {
        found.push({ document: inRepository(path), marker, name: flat(name) });
      }
    }
  }

  return found;
}

describe('the tests the documents cite (SKG-601)', () => {
  const names = declaredTestNames();
  const cited = citations();

  it('reads the tests and the documents it compares', () => {
    // Both walks are regexes over the whole repository: one that silently matches nothing would make
    // every assertion below pass for free.
    // Measured: walking the ignored directories too adds 170 test files from dependencies and 707
    // documents. A citation would then be free to match zod's own test name, and a dependency's
    // README could fail this repository's suite.
    const scanned = [...filesUnder(['.test.ts', '.spec.ts']), ...filesUnder(['.md'])];
    const strays = scanned.filter((path) =>
      inRepository(path)
        .split('/')
        .some((segment) => IGNORED.has(segment)),
    );
    assert.deepEqual(strays.map(inRepository).slice(0, 5), [], 'the walk reads files it has no business in');

    assert.ok(names.size > 500, `only ${names.size} test names found — the walk stopped matching`);
    assert.ok(cited.length > 20, `only ${cited.length} citations found — the marker stopped matching`);
    // A name that holds a backtick is cited between double backticks, and that branch has one user.
    assert.ok(
      cited.some((citation) => citation.name.includes('`')),
      'no citation of a name holding a backtick — the double-backtick form stopped matching',
    );
    assert.ok(
      cited.some((citation) => citation.marker === 'gone-test'),
      'no citation of a test that is gone — the marker for those stopped matching',
    );
  });

  it('names a test that exists, everywhere a document names one', () => {
    const missing = cited
      .filter((citation) => citation.marker === 'test' && !names.has(citation.name))
      .map((citation) => `${citation.document}: ${citation.name}`);

    assert.deepEqual(missing, [], 'these documents name a test that does not exist');
  });

  it('names no test that came back, where a document says one is gone', () => {
    const returned = cited
      .filter((citation) => citation.marker === 'gone-test' && names.has(citation.name))
      .map((citation) => `${citation.document}: ${citation.name}`);

    assert.deepEqual(returned, [], 'these documents say a test is gone, and it is back');
  });
});
