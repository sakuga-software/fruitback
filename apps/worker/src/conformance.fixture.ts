import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
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
};

/** What a module of a store on a file exports: the function that builds it, and the one that closes its files. */
export type FileStoreModule<Store> = { create(path: string): Store; close(): void };

/** A store on its own file in a new directory. The directory is removed after the case. */
export function onFile<Store>(
  label: string,
  factory: string,
  load: () => FileStoreModule<Store> | Promise<FileStoreModule<Store>>,
): Subject<Store> {
  let opened: { directory: string; module: FileStoreModule<Store> } | undefined;

  return {
    factory,
    label,
    async open() {
      opened = { directory: mkdtempSync(join(tmpdir(), 'fruitback-conformance-')), module: await load() };

      return opened.module.create(join(opened.directory, 'store.db'));
    },
    close() {
      if (opened === undefined) return;
      opened.module.close();
      rmSync(opened.directory, { recursive: true, force: true });
      opened = undefined;
    },
  };
}

/**
 * A change that breaks one rule.
 *
 * `replace` changes the source of the reference implementation: the first `from` after `after`, or
 * the only `from` of the file. `wrap` is for a rule that the reference implementation cannot break:
 * it is synchronous, so only a store that waits between its read and its write loses a race.
 */
export type Violation<Store> = {
  /** The name of the case that must fail. */
  breaks: string;
  /** What the broken store does. It ends the name of the control. */
  by: string;
} & ({ replace: { after?: string; from: string; to: string } } | { wrap(real: Store): Store });

function collect<Store>(cases: Cases<Store>): Map<string, (store: Store) => Promise<void>> {
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
      it(name, async () => {
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
 * real one. `remove` deletes the temporary directory.
 */
export async function mutatedModule(
  file: string,
  { after, from, to }: { after?: string; from: string; to: string },
): Promise<{ module: Record<string, unknown>; remove(): void }> {
  const source = readFileSync(new URL(file, SOURCES), 'utf8');
  const start = after === undefined ? 0 : source.indexOf(after);
  assert.ok(start >= 0, `${file} no longer holds the text a mutation starts after: ${after}`);
  if (after === undefined) {
    assert.equal(source.split(from).length - 1, 1, `${file} must hold this text once, to be mutated: ${from}`);
  }
  const at = source.indexOf(from, start);
  assert.ok(at >= 0, `${file} no longer holds the text of a mutation: ${from}`);

  const mutated = `${source.slice(0, at)}${to}${source.slice(at + from.length)}`.replaceAll(
    /from '\.\//g,
    () => `from '${SOURCES.href}`,
  );
  const directory = mkdtempSync(join(tmpdir(), 'fruitback-mutant-'));
  const path = join(directory, 'mutant.ts');
  writeFileSync(path, mutated);

  return {
    module: (await import(pathToFileURL(path).href)) as Record<string, unknown>,
    remove: () => rmSync(directory, { recursive: true, force: true }),
  };
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
