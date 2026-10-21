import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * What the conformance suites of `AccountStore` and `SessionStore` share (FRU-140).
 *
 * A suite is a list of cases, declared once. `describeConformance` runs the list on each
 * implementation. `describeControls` runs it on stores that break one rule each, and a case that
 * passes there holds nothing: « an absence needs a control ».
 */

/** Declares one case. The cases take it as `it`, so `cited-tests.test.ts` reads their names. */
export type Declare<Store> = (name: string, run: (store: Store) => Promise<void>) => void;
export type Cases<Store> = (it: Declare<Store>) => void;

export type Subject<Store> = {
  /** The exported function that builds the store, as `factoriesOf` reads it. */
  factory: string;
  /** What the report calls this implementation. */
  label: string;
  /** An empty store. Called before each case. */
  open(): Store | Promise<Store>;
  /** Removes what `open` made. Called after each case. */
  close(): void | Promise<void>;
  /** Why this implementation cannot run here. Its cases are then reported as skipped, never as passed. */
  skip?: string;
};

/**
 * A change that breaks one rule.
 *
 * `replace` changes the source of the reference implementation: the first `from` after `after`, or
 * the only `from` of the file. `wrap` is for a rule that no change of that source breaks with an
 * assertion. A race: the reference runs on PGlite, one connection, so only a store that waits
 * between its read and its write loses one. A foreign key: without it the statement fails, and a store that throws proves
 * nothing of the case.
 */
export type Violation<Store> = {
  /** The name of the case that must fail. */
  breaks: string;
  /** What the broken store does. It ends the name of the control. */
  by: string;
} & ({ replace: { after?: string; from: string; to: string } } | { wrap(real: Store): Store });

/** The cases by name, for a test that runs one of them on a store of its own. */
export function collect<Store>(cases: Cases<Store>): Map<string, (store: Store) => Promise<void>> {
  const declared = new Map<string, (store: Store) => Promise<void>>();
  cases((name, run) => {
    assert.equal(declared.has(name), false, `two cases have one name: ${name}`);
    declared.set(name, run);
  });

  return declared;
}

export function describeConformance<Store>(promises: string, cases: Cases<Store>, subject: Subject<Store>): void {
  describe(`${subject.label} keeps the ${promises} promises`, () => {
    cases((name, run) => {
      it(name, { skip: Boolean(subject.skip) }, async () => {
        const store = await subject.open();
        try {
          await run(store);
        } finally {
          await subject.close();
        }
      });
    });
  });
}

const SOURCES = new URL('./', import.meta.url);

/**
 * The module of `file` with one change applied, loaded from a temporary directory.
 *
 * The relative imports become absolute, so the changed module shares every other module with the
 * real one. The import of a package becomes the file that these sources resolve it to: the temporary
 * directory has no `node_modules` (FRU-180). `remove` deletes the temporary directory.
 *
 * When `app.ts` imports `file`, `module` also holds the exports of a copy of `app.ts` that imports
 * the changed module (FRU-374), the ones of `file` first: a change planted in a module of routes
 * then reaches `handleRequest`, as a change planted in `app.ts` does.
 */
export async function mutatedModule(
  file: string,
  { after, from, to }: { after?: string; from: string; to: string },
): Promise<{ module: Record<string, unknown>; url: string; remove(): void }> {
  const source = readFileSync(new URL(file, SOURCES), 'utf8');
  const start = after === undefined ? 0 : source.indexOf(after);
  assert.ok(start >= 0, `${file} no longer holds the text a mutation starts after: ${after}`);
  if (after === undefined) {
    assert.equal(source.split(from).length - 1, 1, `${file} must hold this text once, to be mutated: ${from}`);
  }
  const at = source.indexOf(from, start);
  assert.ok(at >= 0, `${file} no longer holds the text of a mutation: ${from}`);

  const mutated = absolute(`${source.slice(0, at)}${to}${source.slice(at + from.length)}`);
  const directory = mkdtempSync(join(tmpdir(), 'fruitback-mutant-'));
  const path = join(directory, 'mutant.ts');
  writeFileSync(path, mutated);

  const url = pathToFileURL(path).href;
  const own = (await import(url)) as Record<string, unknown>;

  return {
    module: { ...(await appThrough(file, url, directory)), ...own },
    // For a test that loads the changed module in another process.
    url,
    remove: () => rmSync(directory, { recursive: true, force: true }),
  };
}

/** A source of this directory whose imports name files: the real modules, and the packages they resolve. */
function absolute(source: string): string {
  return source
    .replaceAll(/from '\.\//g, () => `from '${SOURCES.href}`)
    .replaceAll(/from '([a-z@][^':]*)'/g, (_, specifier: string) => `from '${import.meta.resolve(specifier)}'`);
}

/**
 * The exports of a copy of `app.ts` that imports the changed `file` at `mutant` in place of the real
 * one, or none when `app.ts` does not import `file` (or is `file`).
 */
async function appThrough(file: string, mutant: string, directory: string): Promise<Record<string, unknown>> {
  if (file === 'app.ts') return {};
  const app = readFileSync(new URL('app.ts', SOURCES), 'utf8');
  const imported = `from './${file}'`;
  if (!app.includes(imported)) return {};

  const path = join(directory, 'app.ts');
  writeFileSync(path, absolute(app.replaceAll(imported, () => `from '${mutant}'`)));

  return (await import(pathToFileURL(path).href)) as Record<string, unknown>;
}

export function describeControls<Store>(
  promises: string,
  cases: Cases<Store>,
  violations: readonly Violation<Store>[],
  reference: Subject<Store>,
  /** The reference implementation, built from a changed source. */
  mutated: (change: { after?: string; from: string; to: string }) => Promise<Subject<Store>>,
): void {
  describe(`the ${promises} suite fails on a store that breaks a rule`, () => {
    const declared = collect(cases);

    it('plants a violation for every case, and for no case that is gone', () => {
      assert.deepEqual(
        [...new Set(violations.map((violation) => violation.breaks))].sort(),
        [...declared.keys()].sort(),
      );
    });

    for (const violation of violations) {
      it(`fails « ${violation.breaks} » on a store that ${violation.by}`, async () => {
        const run = declared.get(violation.breaks);
        assert.ok(run !== undefined, 'the violation names no case');
        const subject =
          'wrap' in violation
            ? { ...reference, open: async () => violation.wrap(await reference.open()) }
            : await mutated(violation.replace);

        const store = await subject.open();
        let failure: unknown;
        try {
          await run(store);
        } catch (error) {
          failure = error;
        } finally {
          await subject.close();
        }

        assert.ok(failure !== undefined, 'the case passed on the broken store, so it holds nothing');
        // A store that throws fails every case, and proves nothing of this one: the failure must be
        // an assertion of the case.
        assert.ok(
          failure instanceof assert.AssertionError,
          `the broken store threw, and no assertion of the case failed: ${String(failure)}`,
        );
      });
    }
  });
}

/**
 * The exported functions of the worker that answer `type`, by name.
 *
 * An implementation that no suite runs proves nothing, so each suite compares this list with its
 * subjects.
 */
export function factoriesOf(type: string): string[] {
  const declaration = new RegExp(`export (?:async )?function (create\\w+)\\([^)]*\\): (?:Promise<)?${type}\\b`, 'g');

  return readdirSync(fileURLToPath(SOURCES))
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.fixture.ts'))
    .flatMap((name) => [...readFileSync(new URL(name, SOURCES), 'utf8').matchAll(declaration)])
    .map((match) => match[1] as string)
    .sort();
}

/** A turn of the event loop: where a store that waits between a read and a write loses a race. */
export function turn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Long enough for two rows to get two different instants. */
export function pause(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 3));
}
