import { appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Which test files read the locale of the process (FRU-344).
 *
 * CI runs the tests once under the locale of the runner, then again under a French one, because a
 * test that reads the locale of the shell passes on one machine and fails on another (FRU-172).
 * Run again, the whole suite took half of the `test` job. Most files never read the locale, and
 * running them again proves nothing. So this module, loaded before each test file with
 * `--import`, writes the name of every test file that reads it, and only those run again.
 *
 * A test file reads the locale when it, or anything it runs, uses an API of the language with no
 * locale given: a formatter of `Intl` made with none, a `toLocale…` or `localeCompare` call with
 * none, or `navigator.language`. A formatter made with a locale given reads none, and is not
 * written. It is read at use, not at construction: a formatter that a module makes when it loads
 * and that the test never uses is no dependence. `ci-locale.test.ts` plants each kind.
 *
 * The variables of the environment are not watched: `ci-locale.test.ts` fails on a source that
 * reads `LANG`, `LC_…` or `LANGUAGE` itself.
 *
 * It does nothing unless `FRUITBACK_LOCALE_PROBE` names a directory, and it writes one line for
 * each file and API: `<absolute path of the test file>\t<API>`.
 */

/** The test file this process runs: from the setup of vitest, else from `node --test`. */
function testFile(): string | undefined {
  const fromVitest = (globalThis as { __fruitbackTestFile?: string }).__fruitbackTestFile;
  if (fromVitest !== undefined) return fromVitest;
  const script = process.argv[1];

  return script !== undefined && /\.test\.tsx?$/.test(script) ? resolve(script) : undefined;
}

/**
 * Code that reads `navigator.language` and whose answers do not depend on it, measured. PGlite gives
 * it to the PostgreSQL in WASM as `LANG`, and that build has the locale C alone: under en-US,
 * C.UTF-8 and fr-FR it answers the same collation, settings, order, formats and messages
 * (2026-10-21, PGlite 0.5.8). `ci-locale.test.ts` measures it again, and fails the day it differs.
 * Without this, every test file that starts PGlite, half of the worker, would run twice.
 */
export const READERS_WITH_NO_EFFECT = [/[\\/]@electric-sql[\\/]pglite[\\/]/];

/** Whether a `locales` argument leaves the choice to the process. */
export function noLocaleGiven(locales: unknown): boolean {
  return locales === undefined || (Array.isArray(locales) && locales.length === 0);
}

/** The formatters of `Intl` that take a locale, and the methods that use one. */
export const FORMATTERS: Record<string, string[]> = {
  Collator: ['compare'],
  DateTimeFormat: ['format', 'formatToParts', 'formatRange', 'formatRangeToParts'],
  DisplayNames: ['of'],
  DurationFormat: ['format', 'formatToParts'],
  ListFormat: ['format', 'formatToParts'],
  NumberFormat: ['format', 'formatToParts', 'formatRange', 'formatRangeToParts'],
  PluralRules: ['select', 'selectRange'],
  RelativeTimeFormat: ['format', 'formatToParts'],
  Segmenter: ['segment'],
};

/** The methods of the language that take `locales` as their argument at `index`, and their name. */
export const METHODS: [target: object, name: string, index: number, label: string][] = [
  [String.prototype, 'localeCompare', 1, 'String'],
  [String.prototype, 'toLocaleUpperCase', 0, 'String'],
  [String.prototype, 'toLocaleLowerCase', 0, 'String'],
  [Number.prototype, 'toLocaleString', 0, 'Number'],
  [BigInt.prototype, 'toLocaleString', 0, 'BigInt'],
  [Date.prototype, 'toLocaleString', 0, 'Date'],
  [Date.prototype, 'toLocaleDateString', 0, 'Date'],
  [Date.prototype, 'toLocaleTimeString', 0, 'Date'],
  [Array.prototype, 'toLocaleString', 0, 'Array'],
];

/**
 * Wraps the APIs above so that each use with no locale calls `seen(api)`. Exported for the test,
 * which runs it in a process of its own.
 */
export function install(seen: (api: string) => void): void {
  const Intl_ = Intl as unknown as Record<string, unknown>;
  const defaulted = new WeakSet<object>();

  for (const [name, methods] of Object.entries(FORMATTERS)) {
    const Original = Intl_[name] as (new (...args: unknown[]) => object) | undefined;
    if (typeof Original !== 'function') continue;
    for (const method of methods) {
      const descriptor = Object.getOwnPropertyDescriptor(Original.prototype, method);
      const original = descriptor?.value ?? descriptor?.get;
      if (typeof original !== 'function') continue;
      const wrapped = function (this: object, ...args: unknown[]) {
        if (defaulted.has(this)) seen(`Intl.${name}#${method}`);
        return Reflect.apply(original, this, args);
      };
      Object.defineProperty(
        Original.prototype,
        method,
        descriptor?.get ? { ...descriptor, get: wrapped } : { ...descriptor, value: wrapped },
      );
    }
    Intl_[name] = new Proxy(Original, {
      construct(target, args, newTarget) {
        const made = Reflect.construct(target, args, newTarget) as object;
        if (noLocaleGiven(args[0])) defaulted.add(made);
        return made;
      },
      apply(target, self, args) {
        const made = Reflect.apply(target, self, args) as object;
        if (noLocaleGiven(args[0])) defaulted.add(made);
        return made;
      },
    });
  }

  for (const [target, name, index, owner] of METHODS) {
    const original = (target as Record<string, unknown>)[name];
    if (typeof original !== 'function') continue;
    const label = `${owner}#${name}`;
    Object.defineProperty(target, name, {
      configurable: true,
      writable: true,
      value: function (this: unknown, ...args: unknown[]) {
        if (noLocaleGiven(args[index])) seen(label);
        return Reflect.apply(original, this, args);
      },
    });
  }

  const navigator_ = (globalThis as { navigator?: object }).navigator;
  const prototype = navigator_ === undefined ? undefined : Object.getPrototypeOf(navigator_);
  for (const name of ['language', 'languages']) {
    const descriptor = prototype === undefined ? undefined : Object.getOwnPropertyDescriptor(prototype, name);
    const get = descriptor?.get;
    if (get === undefined) continue;
    Object.defineProperty(prototype, name, {
      ...descriptor,
      get(this: unknown) {
        const caller = new Error().stack ?? '';
        if (!READERS_WITH_NO_EFFECT.some((reader) => reader.test(caller))) seen(`navigator.${name}`);
        return Reflect.apply(get, this, []);
      },
    });
  }
}

const directory = process.env.FRUITBACK_LOCALE_PROBE;
if (directory !== undefined && directory !== '') {
  mkdirSync(directory, { recursive: true });
  const written = new Set<string>();
  const out = join(directory, `${process.pid}.tsv`);
  install((api) => {
    const file = testFile();
    if (file === undefined) return;
    const line = `${file}\t${api}`;
    if (written.has(line)) return;
    written.add(line);
    appendFileSync(out, `${line}\n`);
  });
}
