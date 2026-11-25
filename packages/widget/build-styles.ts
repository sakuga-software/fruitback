import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, optimize } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';
import { THEME_STYLES } from './src/theme.ts';

/**
 * The Tailwind sheet of the widget, built at authoring time into a string (FRU-680).
 *
 * The widget gives its CSS to the Shadow root as an adopted sheet, never as a `<style>` element or a
 * file: a page whose CSP says `style-src 'self'` refuses both (FRU-522). So Tailwind runs here, on
 * `tailwind.css` and the class names of `src/**`, and its output is written into
 * `src/tailwind-sheet.ts`. `host.ts` adopts it with `adoptStyles`, like every other sheet.
 *
 * The output is committed, as `src/icon-data.ts` is: the sources run under `node --test` with no
 * build step. `tailwind-sheet.test.ts` builds it again and fails on a stale or hand-edited copy.
 * `build.ts` runs this file before it bundles.
 *
 * Run it with `pnpm styles:build` after a change of a class name.
 */

const here = dirname(fileURLToPath(import.meta.url));
const INPUT = join(here, 'tailwind.css');
export const OUTPUT = join(here, 'src', 'tailwind-sheet.ts');

/** The layers of Tailwind, in its order. */
export const LAYERS = '@layer properties,theme,base,components,utilities;';

/** The Tailwind namespaces that a token of `theme.ts` can fill, by the start of its name. */
const NAMESPACES = ['color-', 'radius-', 'shadow-', 'font-', 'ease-'];

/**
 * The tokens of `theme.ts` as `@theme inline reference`: `fruitback:bg-accent` writes
 * `var(--fruitback-color-accent)`, and Tailwind declares nothing on `:host`: with `inline` alone, it
 * declared `--fruitback-color-accent: var(--fruitback-color-accent)` there, a cycle that
 * empties the token. `THEME_STYLES` stays the one place of the values, of the dark scheme and of
 * what a host may change.
 */
export function themeReference(themeStyles: string): string {
  const light = /:host\s*\{([^}]*)\}/.exec(themeStyles.replace(/\/\*[\s\S]*?\*\//g, ''))?.[1];
  if (light === undefined) throw new Error('THEME_STYLES has no :host block');

  const declarations = [...light.matchAll(/--fruitback-([a-z-]+):\s*([^;]+);/g)]
    .filter(([, name]) => NAMESPACES.some((namespace) => name?.startsWith(namespace)))
    .map(([, name]) => `  --${name}: var(--fruitback-${name});`);
  if (declarations.length === 0) throw new Error('no token of THEME_STYLES fills a namespace of Tailwind');

  return `@theme inline reference prefix(fruitback) {\n${declarations.join('\n')}\n}\n`;
}

/**
 * `@property` does nothing in a Shadow root: Chromium 156 ignores it in an adopted sheet, measured
 * (FRU-680). A variable of Tailwind with no value then breaks its utility: `outline-2` drew no
 * outline. Tailwind writes the same values for old browsers, under `@supports`. They are given
 * here to every element of the root, under no condition, and the `@property` rules go.
 *
 * It also stops the page: Tailwind 3 sets `--tw-shadow` and its kin on `*`, so on the host element,
 * and the Shadow root inherits them otherwise.
 */
export function propertiesOnEveryElement(css: string): string {
  const defaults: string[] = [];
  let out = css.replace(/@property\s+(--[\w-]+)\s*\{([^}]*)\}/g, (_rule, name: string, body: string) => {
    const initial = /initial-value:\s*([^;]+?)\s*;?\s*$/m.exec(body)?.[1];
    defaults.push(`${name}: ${initial ?? 'initial'};`);

    return '';
  });

  const start = out.indexOf('@layer properties {');
  if (start !== -1) out = out.slice(0, start) + out.slice(blockEnd(out, start));
  if (defaults.length === 0) return out;

  return `${out}\n@layer properties { *, ::before, ::after, ::backdrop { ${defaults.join(' ')} } }\n`;
}

/** The index after the `}` that closes the first block opened at or after `from`. */
function blockEnd(css: string, from: number): number {
  let depth = 0;
  for (let index = css.indexOf('{', from); index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') depth -= 1;
    if (depth === 0) return index + 1;
  }
  throw new Error('unbalanced braces in the output of Tailwind');
}

/** What the sheet must never hold. Each one is a reason of `docs/decisions/widget.md`. */
export function offences(css: string): string[] {
  const found: string[] = [];
  // A rem is the font size of the page of the host, not of the widget.
  if (/\d(\.\d+)?rem\b/.test(css)) found.push('a size in rem');
  if (/@property\b/.test(css)) found.push('an @property rule, which a Shadow root ignores');
  // A variable of the theme on :host loses to a rule of the page on the host element. A variant of a
  // corner, :host([data-fruitback-position…]) .part, styles a part and stays.
  if (/(^|[{},;])\s*:root\b|(^|[{},;])\s*:host\s*[,{]/.test(css)) found.push('a rule on :root or :host');
  if (/@import\b|url\(/.test(css)) found.push('a file to load, which the CSP refuses');

  return found;
}

/** A compiler of `tailwind.css`. A new one each time: `build` adds to what it built before. */
async function compiler(): Promise<Awaited<ReturnType<typeof compile>>> {
  const input = (await readFile(INPUT, 'utf8')) + themeReference(THEME_STYLES);

  return compile(input, { base: here, onDependency: () => {} });
}

/**
 * The rules of the utilities that `source` writes, minified: what a guard test reads of a module
 * that has no `*.styles.ts` any more (`direction.test.ts`, `motion.test.ts`, `theme.test.ts`).
 */
export async function sheetOfSource(source: string): Promise<string> {
  const candidates = new Scanner({}).scanFiles([{ content: source, extension: 'ts' }]);

  return optimize((await compiler()).build(candidates), { minify: true }).code.replace(/\/\*![\s\S]*?\*\//g, '');
}

/** The sheet, minified, from the input and the sources of today. */
export async function buildSheet(): Promise<string> {
  const tailwind = await compiler();
  const scanner = new Scanner({ sources: tailwind.sources });
  const raw = tailwind.build(scanner.scan());
  // The order of the layers is written again: the minifier folds the first statement into the block
  // of the first layer, and host.styles.ts writes its base after this sheet.
  const css = `${LAYERS}${optimize(propertiesOnEveryElement(raw), { minify: true })
    .code.replace(/\/\*![\s\S]*?\*\//g, '')
    .trim()}`;

  const found = offences(css);
  if (found.length > 0) throw new Error(`the Tailwind sheet of the widget holds ${found.join(', ')}`);

  return css;
}

/** The module written to `src/tailwind-sheet.ts`. */
export function moduleOf(css: string): string {
  const literal = css.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('${', '\\${');

  return [
    '// Generated by build-styles.ts from tailwind.css and the class names of src. Do not edit it:',
    '// run `pnpm styles:build`. tailwind-sheet.test.ts fails when it is stale (FRU-680).',
    `export const TAILWIND_STYLES = \`${literal}\`;`,
    '',
  ].join('\n');
}

if (import.meta.main) {
  await writeFile(OUTPUT, moduleOf(await buildSheet()));
}
