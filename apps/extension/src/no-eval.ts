/**
 * The extension builds zod without the `Function` constructor (FRU-389).
 *
 * zod v4 compiles a fast parser for an object with `new Function` (`Doc.compile`), and first asks
 * whether it may: `allowsEval` tries `new Function("")`. The CSP of a Manifest V3 extension refuses
 * both, so in the extension zod never compiles anything and parses as it does with `jitless`. But
 * the word stays in the bundle, and the validator of addons.mozilla.org, which reads the code and
 * runs none of it, says « The Function constructor is eval » for each file that holds it.
 * `z.config({ jitless: true })` does not help: the probe is still in the code.
 *
 * So the build takes the constructor out of the two files of zod that name it. `allowsEval` then
 * answers `false` at once, which is what it answered under the CSP, and `compile` throws if anything
 * ever calls it. Nothing else of zod changes. `no-eval.test.ts` holds each replacement to the version
 * of zod in the lockfile: a version that writes them differently fails the test, not the store.
 */

/** The two files of zod, and the one line of each that names the constructor. */
export const ZOD_EVAL = [
  { file: /[\\/]zod[\\/]v4[\\/]core[\\/]util\.(?:js|cjs)$/, line: 'const F = Function;' },
  { file: /[\\/]zod[\\/]v4[\\/]core[\\/]doc\.(?:js|cjs)$/, line: 'const F = Function;' },
] as const;

/** What the line becomes: `new F(...)` then throws, inside the `try` of the probe, or out of `compile`. */
export const WITHOUT_EVAL = 'const F = undefined;';

/**
 * The code of `id` with no `Function` constructor, or `undefined` when `id` is not one of the two
 * files. Throws when it is one of them and the line is not there: a new version of zod must not pass
 * with the constructor in the bundle.
 */
export function withoutEval(code: string, id: string): string | undefined {
  const target = ZOD_EVAL.find(({ file }) => file.test(id.split('?')[0] ?? id));
  if (target === undefined) return undefined;
  if (!code.includes(target.line)) {
    throw new Error(`no-eval: ${id} no longer writes « ${target.line} ». Read src/no-eval.ts.`);
  }

  return code.replaceAll(target.line, WITHOUT_EVAL);
}

/** The plugin of Vite that does it, for `wxt.config.ts`. */
export function noEval(): {
  name: string;
  enforce: 'pre';
  transform: (code: string, id: string) => string | undefined;
} {
  return { name: 'fruitback-no-eval', enforce: 'pre', transform: (code, id) => withoutEval(code, id) };
}
