import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { matchesGlob, posix } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * What a test reads outside its project, against what Nx hashes for it (SKG-610).
 *
 * Nx replays `test` from its cache when none of the target's inputs changed. A test that reads
 * `CLAUDE.md` or another project's source reads a file Nx does not hash, so a broken document came
 * back from the cache with exit code 0 while the same test run directly failed (measured).
 *
 * Each project that reads outside itself declares its own `nx.targets.test.inputs`. **Such a list
 * replaces `targetDefaults.test.inputs`**, it does not extend it (measured: with one workspace entry
 * alone, a change to the worker's own `app.ts` was a cache hit), so every list starts with
 * `default` and `^production`.
 *
 * Only literal relative paths are checked. Two shapes cannot be resolved statically, and each is
 * counted instead, so that a new read of that shape is noticed rather than silently skipped:
 *
 * - a path built from a template, such as the walk over every `package.json` in `contributing.test.ts`;
 * - a path joined from segments, such as the root `README.md` that `package.test.ts` reads through
 *   `join` with two parent segments.
 *
 * It lives beside `contributing.test.ts`, which also guards files at the root, because the root has no
 * `test` target.
 */

const REPOSITORY = fileURLToPath(new URL('../../../', import.meta.url));
const NX = JSON.parse(readFileSync(new URL('../../../nx.json', import.meta.url), 'utf8')) as {
  targetDefaults: { test: { inputs: string[] } };
};

/** Paths built from a template in the test sources today, all in `contributing.test.ts`. */
const TEMPLATED_READS = 5;

/**
 * Paths joined from a parent segment in the test sources today: five in `packages/widget/src/package.test.ts`,
 * which reads the root `README.md` and packs its siblings, and four in `apps/worker/src/session.test.ts`,
 * which joins inside a temporary directory and reads nothing of the repository.
 */
const JOINED_READS = 9;

type Project = { root: string; name: string; inputs: string[]; declared: boolean; dependencies: string[] };

function projects(): Project[] {
  const found: Project[] = [];
  for (const group of ['apps', 'packages']) {
    for (const directory of readdirSync(`${REPOSITORY}${group}`)) {
      const manifestPath = `${REPOSITORY}${group}/${directory}/package.json`;
      if (!existsSync(manifestPath)) continue;

      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        name: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        nx?: { targets?: { test?: { inputs?: string[] } } };
      };
      found.push({
        root: `${group}/${directory}`,
        name: manifest.name,
        inputs: manifest.nx?.targets?.test?.inputs ?? NX.targetDefaults.test.inputs,
        declared: manifest.nx?.targets?.test?.inputs !== undefined,
        dependencies: Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }),
      });
    }
  }

  return found;
}

function testFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(`${REPOSITORY}${directory}`, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') found.push(...testFiles(path));
    if (entry.isFile() && entry.name.endsWith('.test.ts')) found.push(path);
  }

  return found;
}

type Reads = { reads: { test: string; path: string }[]; templated: string[]; joined: string[] };

/** Every literal relative path a project's tests name that leaves the project, repository-relative. */
function readsOutside(project: Project): Reads {
  const reads: Reads = { reads: [], templated: [], joined: [] };
  if (!existsSync(`${REPOSITORY}${project.root}/src`)) return reads;

  for (const test of testFiles(`${project.root}/src`)) {
    const source = readFileSync(`${REPOSITORY}${test}`, 'utf8');
    for (const [call] of source.matchAll(/\bjoin\([^)]*['"]\.\.['"][^)]*\)/g)) reads.joined.push(`${test}: ${call}`);
    for (const [, , written] of source.matchAll(/(['"`])((?:\.\.\/)+[^'"`\n]*)\1/g)) {
      if (written === undefined) continue;
      if (written.includes('${')) {
        reads.templated.push(`${test}: ${written}`);
        continue;
      }

      const resolved = posix.normalize(posix.join(posix.dirname(test), written));
      const path = written.endsWith('/') ? `${resolved.replace(/\/?$/, '/')}`.replace(/^\.\/$/, '') : resolved;
      if (!(path === '' || path.startsWith('../')) && !`${path}/`.startsWith(`${project.root}/`)) {
        reads.reads.push({ test, path });
      }
    }
  }

  return reads;
}

/** Everything before the first glob character: the directory a pattern cannot leave. */
function staticPrefix(pattern: string): string {
  const glob = pattern.search(/[*?[{]/);

  return glob === -1 ? pattern : pattern.slice(0, glob);
}

/**
 * Whether the target hashes the path.
 *
 * A file is covered by a `{workspaceRoot}` glob, or, when the target takes `^production`, by being a
 * file of a workspace dependency that is not a test. A directory the test walks is covered by a pattern
 * that stays inside it — for the repository root, a pattern that starts with a glob.
 */
function covers(project: Project, path: string, roots: Map<string, string>): boolean {
  const patterns = project.inputs.filter((input) => input.startsWith('{workspaceRoot}/'));
  const globs = patterns.map((input) => input.slice('{workspaceRoot}/'.length));

  if (path === '' || path.endsWith('/')) {
    return globs.some((glob) =>
      path === '' ? staticPrefix(glob) === '' : staticPrefix(glob) !== '' && path.startsWith(staticPrefix(glob)),
    );
  }
  if (globs.some((glob) => matchesGlob(path, glob))) return true;

  return (
    project.inputs.includes('^production') &&
    !/\.(test|spec)\.tsx?$/.test(path) &&
    project.dependencies.some((dependency) => {
      const root = roots.get(dependency);

      return root !== undefined && path.startsWith(`${root}/`);
    })
  );
}

describe('what a test reads, against what Nx hashes for it (SKG-610)', () => {
  const all = projects();
  const roots = new Map(all.map((project) => [project.name, project.root]));
  const scanned = all.map((project) => ({ project, ...readsOutside(project) }));

  it('finds the reads it checks, and counts the ones it cannot', () => {
    const reads = scanned.flatMap((entry) => entry.reads);
    const templated = scanned.flatMap((entry) => entry.templated);
    const joined = scanned.flatMap((entry) => entry.joined);

    assert.ok(reads.length > 15, `only ${reads.length} reads outside a project found — the scan stopped matching`);
    assert.equal(
      templated.length,
      TEMPLATED_READS,
      `a read built from a template is checked by nobody; these are the ones today:\n${templated.join('\n')}`,
    );
    assert.equal(
      joined.length,
      JOINED_READS,
      `a read joined from segments is checked by nobody; these are the ones today:\n${joined.join('\n')}`,
    );
  });

  it('starts every declared input list with the defaults it replaces', () => {
    // A declared list replaces targetDefaults.test.inputs. Without default, a change to the project's
    // own code comes back from the cache; without ^production, a change to a dependency does.
    const declared = all.filter((project) => project.declared);
    const incomplete = declared
      .filter((project) => project.inputs[0] !== 'default' || project.inputs[1] !== '^production')
      .map((project) => `${project.root}: ${project.inputs.slice(0, 2).join(', ')}`);

    assert.ok(
      declared.length >= 3,
      `only ${declared.length} projects declare inputs — the manifest read stopped matching`,
    );
    assert.deepEqual(incomplete, [], 'these lists replace the defaults and drop one of them');
  });

  it('declares every file a test reads as an input of its test target', () => {
    const missing = scanned.flatMap(({ project, reads }) =>
      reads
        .filter(({ path }) => !covers(project, path, roots))
        .map(({ test, path }) => `${test} reads ${path || './'}`),
    );

    assert.deepEqual(missing, [], 'Nx does not hash these, so a change to them comes back from the cache');
  });
});
