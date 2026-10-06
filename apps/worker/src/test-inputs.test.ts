import assert from 'node:assert/strict';
import { existsSync, globSync, readFileSync, readdirSync } from 'node:fs';
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
 * A literal relative path is resolved and checked. **A path read through `new URL(path, BASE)` is
 * resolved against `BASE`**, when the file declares it as `new URL(literal, import.meta.url)` or
 * from another such base (SKG-622). Resolved against the test file instead, `'../worker/LICENSE'`
 * read from `apps/extension/` reads as a path inside the extension, and the file really read is
 * hashed by nobody.
 *
 * Three shapes cannot be resolved statically — a path built from a template, a path joined from `..`
 * segments, and a path read through a base the file does not declare — so each one is written out in
 * `DYNAMIC_READS` with what it reads, and those paths are checked the same way. A new dynamic read fails
 * until it is added there, and an entry whose read is gone fails as stale (raised in review on PR #63).
 *
 * It lives beside `contributing.test.ts`, which also guards files at the root, because the root has no
 * `test` target.
 */

const REPOSITORY = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * This file, which names every joined call of `DYNAMIC_READS` inside a string, and writes sources with a
 * base for the scan to read. It is still scanned for literal paths, its own read of `nx.json` included,
 * and never for joined calls or bases: it reads nothing through either.
 */
const SELF = fileURLToPath(import.meta.url).slice(REPOSITORY.length);
const NX = JSON.parse(readFileSync(new URL('../../../nx.json', import.meta.url), 'utf8')) as {
  targetDefaults: { test: { inputs: string[] } };
};

/**
 * Every read a scan cannot resolve, by test and source, with what it reads.
 *
 * A value is a list of repository globs, expanded against the repository, or directories ending in `/`.
 * An empty list is a read that reaches nothing Nx should hash: a temporary directory, or a `dist` a test
 * deletes before it builds.
 */
const DYNAMIC_READS: Record<string, string[]> = {
  'apps/worker/src/contributing.test.ts: ../../../${group}/': ['apps/', 'packages/'],
  'apps/worker/src/contributing.test.ts: ../../../${group}/${dir}/package.json': [
    'apps/*/package.json',
    'packages/*/package.json',
  ],
  // The test files the commands in CONTRIBUTING.md run.
  'apps/worker/src/contributing.test.ts: ../../../${dir}/${file}': ['**/*.test.ts'],
  "packages/widget/src/package.test.ts: join(root, '..', 'shared')": ['packages/shared/'],
  "packages/widget/src/package.test.ts: join(root, '..', '..', 'README.md')": ['README.md'],
  // The workspace a package is packed from: the root LICENSE pnpm copies, and the front-door package.
  "packages/widget/src/package.test.ts: join(root, '..', '..')": ['LICENSE', 'packages/fruitback/'],
  "packages/widget/src/package.test.ts: join(root, '..', name, 'dist')": [],
  // The icons the manifest declares, rendered by `build-icons.ts` and committed (SKG-617).
  'apps/extension/src/icons.test.ts: ../public/${iconPath(size)}': ['apps/extension/public/icon/*.png'],
  "apps/worker/src/session.test.ts: join(path, '..')": [],
  "apps/worker/src/session.test.ts: join(path, '..', name)": [],
};

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

type Scan = { paths: string[]; templated: string[]; joined: string[] };
type Reads = { reads: { test: string; path: string }[]; templated: string[]; joined: string[] };

const IDENTIFIER = '[A-Za-z_$][\\w$]*';
const BASE_DECLARATION = new RegExp(
  `\\bconst (${IDENTIFIER}) = (?:fileURLToPath\\()?new URL\\((['"])([^'"\\n]*)\\2, (import\\.meta\\.url|${IDENTIFIER})\\)`,
  'g',
);
const READ_FROM_BASE = new RegExp(`\\bnew URL\\((?:(['"])([^'"\\n]*)\\1|([^,()]+)), (${IDENTIFIER})\\)`, 'g');

/** `path` resolved the way `new URL` resolves it against `base`, both relative to the repository. */
function resolveUrl(path: string, base: string): string {
  return decodeURIComponent(new URL(path, `file:///${base}`).pathname.slice(1));
}

/**
 * Every relative path `test` names, resolved against the repository, before any filter on the project.
 *
 * A literal is resolved against the test file, unless it is the path of a `new URL` with a declared base.
 * A computed path through a declared base reads the base, so the base is what is checked.
 */
function scan(test: string, source: string): Scan {
  const found: Scan = { paths: [], templated: [], joined: [] };
  const throughBase = new Set<number>();

  if (test !== SELF) {
    for (const [call] of source.matchAll(/\bjoin\([^)]*['"]\.\.['"][^)]*\)/g)) found.joined.push(`${test}: ${call}`);

    const bases = new Map<string, string>([['import.meta.url', test]]);
    for (const [, name, , path, base] of source.matchAll(BASE_DECLARATION)) {
      const resolvedBase = bases.get(base as string);
      if (resolvedBase !== undefined) bases.set(name as string, resolveUrl(path as string, resolvedBase));
    }

    for (const read of source.matchAll(READ_FROM_BASE)) {
      const [call, , literal, computed, name] = read;
      const base = bases.get(name as string);
      if (literal !== undefined) throughBase.add(read.index + 'new URL('.length);
      if (base === undefined) {
        found.joined.push(`${test}: ${call}`);
        continue;
      }
      if (literal === undefined) {
        const expression = (computed as string).trim();
        if (expression.startsWith('`')) found.templated.push(`${test}: ${expression}`);
        else found.paths.push(resolveUrl('./', base));
        continue;
      }

      if (literal.includes('${')) found.templated.push(`${test}: ${literal}`);
      else found.paths.push(resolveUrl(literal, base));
    }
  }

  for (const literal of source.matchAll(/(['"`])((?:\.\.\/)+[^'"`\n]*)\1/g)) {
    const written = literal[2];
    if (written === undefined || throughBase.has(literal.index)) continue;
    if (written.includes('${')) {
      found.templated.push(`${test}: ${written}`);
      continue;
    }

    const resolved = posix.normalize(posix.join(posix.dirname(test), written));
    found.paths.push(written.endsWith('/') ? `${resolved.replace(/\/?$/, '/')}`.replace(/^\.\/$/, '') : resolved);
  }

  return found;
}

/** Every relative path a project's tests name that leaves the project, repository-relative. */
function readsOutside(project: Project): Reads {
  const reads: Reads = { reads: [], templated: [], joined: [] };
  if (!existsSync(`${REPOSITORY}${project.root}/src`)) return reads;

  for (const test of testFiles(`${project.root}/src`)) {
    const { paths, templated, joined } = scan(test, readFileSync(`${REPOSITORY}${test}`, 'utf8'));
    reads.templated.push(...templated);
    reads.joined.push(...joined);
    for (const path of paths) {
      if (!(path === '' || path.startsWith('../')) && !`${path}/`.startsWith(`${project.root}/`)) {
        reads.reads.push({ test, path });
      }
    }
  }

  return reads;
}

/** The files a declared glob reads today, or the directory itself. */
function expand(declared: string): string[] {
  if (declared.endsWith('/')) return [declared];

  return globSync(declared, { cwd: REPOSITORY }).filter(
    (path) => !path.split('/').some((segment) => segment === 'node_modules' || segment === 'dist'),
  );
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
 *
 * **A path inside the project's own root is covered by `default`**, which is `{projectRoot}/**` plus
 * the shared globals. Every list starts with it — `starts every declared input list with the defaults
 * it replaces` is what keeps that true, so this does not check it again. The scan drops those reads
 * before they reach here, so only a `DYNAMIC_READS` entry brings one: the icons of the extension were
 * the first, and they read as unhashed (SKG-617).
 */
function covers(project: Project, path: string, roots: Map<string, string>): boolean {
  if (`${path}/`.startsWith(`${project.root}/`)) return true;

  const patterns = project.inputs.filter((input) => input.startsWith('{workspaceRoot}/'));
  const globs = patterns.map((input) => input.slice('{workspaceRoot}/'.length));

  const inDependency = () =>
    project.inputs.includes('^production') &&
    project.dependencies.some((dependency) => {
      const root = roots.get(dependency);

      return root !== undefined && `${path}/`.startsWith(`${root}/`);
    });

  if (path === '' || path.endsWith('/')) {
    return (
      globs.some((glob) =>
        path === '' ? staticPrefix(glob) === '' : staticPrefix(glob) !== '' && path.startsWith(staticPrefix(glob)),
      ) || inDependency()
    );
  }
  if (globs.some((glob) => matchesGlob(path, glob))) return true;

  return !/\.(test|spec)\.tsx?$/.test(path) && inDependency();
}

/**
 * A source as a test file would write it. `UP/` stands for the parent segment, so the scan of this file
 * does not read the paths of these examples as reads of its own.
 */
function source(lines: string[]): string {
  return lines.join('\n').replaceAll('UP/', '../');
}

describe('how the scan resolves a path (SKG-622)', () => {
  const test = 'apps/extension/src/license.test.ts';

  it('resolves a read through a declared base against that base, as it resolves one from the file', () => {
    const fromFile = scan(test, source(["readFileSync(new URL('UP/UP/worker/LICENSE', import.meta.url));"]));
    const fromBase = scan(
      test,
      source([
        "const EXTENSION = new URL('UP/', import.meta.url);",
        "readFileSync(new URL('UP/worker/LICENSE', EXTENSION));",
      ]),
    );

    assert.deepEqual(fromFile.paths, ['apps/worker/LICENSE']);
    // The declaration reads the base too, and that base is the extension itself.
    assert.deepEqual(fromBase.paths, ['apps/worker/LICENSE', 'apps/extension/']);
  });

  it('follows a base declared from another base, and a path with no parent segment', () => {
    const { paths } = scan(
      test,
      source([
        "const REPOSITORY = fileURLToPath(new URL('UP/UP/UP/', import.meta.url));",
        "const WORKER = new URL('apps/worker/', REPOSITORY);",
        "readFileSync(new URL('package.json', WORKER));",
      ]),
    );

    assert.ok(paths.includes('apps/worker/package.json'), paths.join(', '));
  });

  it('reads the base itself when the path through it is computed', () => {
    const { paths, templated } = scan(
      test,
      source([
        "const DOCS = new URL('UP/UP/UP/docs/', import.meta.url);",
        'readFileSync(new URL(link, DOCS));',
        'readFileSync(new URL(`${name}.md`, DOCS));',
      ]),
    );

    assert.ok(paths.includes('docs/'), paths.join(', '));
    assert.deepEqual(templated, [`${test}: \`\${name}.md\``]);
  });

  it('refuses a read through a base the file does not declare', () => {
    const { paths, joined } = scan(test, source(["readFileSync(new URL('UP/worker/LICENSE', elsewhere));"]));

    assert.deepEqual(joined, [`${test}: new URL('../worker/LICENSE', elsewhere)`]);
    assert.deepEqual(paths, []);
  });
});

describe('what a test reads, against what Nx hashes for it (SKG-610)', () => {
  const all = projects();
  const roots = new Map(all.map((project) => [project.name, project.root]));
  const scanned = all.map((project) => ({ project, ...readsOutside(project) }));

  it('finds the reads it checks, and knows what every read it cannot resolve reads', () => {
    const reads = scanned.flatMap((entry) => entry.reads);
    const dynamic = new Set(scanned.flatMap((entry) => [...entry.templated, ...entry.joined]));

    assert.ok(reads.length > 15, `only ${reads.length} reads outside a project found — the scan stopped matching`);
    assert.deepEqual(
      [...dynamic].filter((read) => !(read in DYNAMIC_READS)),
      [],
      'these reads cannot be resolved: write out what each one reads in DYNAMIC_READS',
    );
    assert.deepEqual(
      Object.keys(DYNAMIC_READS).filter((read) => !dynamic.has(read)),
      [],
      'these entries of DYNAMIC_READS name a read that is gone',
    );
    for (const [read, declared] of Object.entries(DYNAMIC_READS)) {
      for (const glob of declared) assert.ok(expand(glob).length > 0, `${read}: ${glob} matches nothing`);
    }
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
    const declared = Object.entries(DYNAMIC_READS).flatMap(([read, globs]) =>
      globs.flatMap((glob) => expand(glob).map((path) => ({ test: read.split(': ')[0] as string, path }))),
    );
    const missing = scanned.flatMap(({ project, reads }) =>
      [...reads, ...declared.filter(({ test }) => test.startsWith(`${project.root}/`))]
        .filter(({ path }) => !covers(project, path, roots))
        .map(({ test, path }) => `${test} reads ${path || './'}`),
    );

    assert.deepEqual(missing, [], 'Nx does not hash these, so a change to them comes back from the cache');
  });
});
