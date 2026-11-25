import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compile } from '@tailwindcss/node';

/**
 * What Tailwind writes for the sheets of the extension (FRU-679), read on its own output.
 *
 * Two things break in silence and no screenshot of the light scheme shows them:
 * - **A colour written as a value** in a rule of `@apply`. The dark scheme of `src/theme.css` sets
 *   the `--color-*` again, so a rule must read `var(--color-…)`: a value would stay light in the dark.
 * - **A variable of Tailwind with no start value.** `outline-2` writes `outline-style:
 *   var(--tw-outline-style)`, and `border` writes `var(--tw-border-style)`. With no preflight, the
 *   `@property` that gives each its start value must be in the same output, or the focus ring and
 *   the edges are not drawn.
 */

const KIT = fileURLToPath(new URL('./kit.css', import.meta.url));

/** What Tailwind writes for a sheet, or for the text of a sheet placed at `file`. */
async function built(file: string, text = readFileSync(file, 'utf8')): Promise<string> {
  const compiler = await compile(text, {
    base: fileURLToPath(new URL('.', `file://${file}`)),
    from: file,
    onDependency: () => {},
  });

  return compiler.build([]);
}

/** The rules of a built sheet, outside `@property` and `@layer`: selector and declarations. */
function rules(css: string): { selector: string; body: string }[] {
  const found: { selector: string; body: string }[] = [];
  const uncommented = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [, , selector, body] of uncommented.matchAll(/(^|\n)([^@\n{}][^{}]*)\{([^{}]*)\}/g)) {
    if (selector !== undefined && body !== undefined) found.push({ selector: selector.trim(), body });
  }

  return found;
}

/** The colour tokens of the extension: the shared theme, then src/theme.css. */
const TOKENS = new Set(
  [
    readFileSync(new URL('../../../packages/shared/tailwind/theme.css', import.meta.url), 'utf8'),
    readFileSync(new URL('./theme.css', import.meta.url), 'utf8'),
  ].flatMap((text) => [...text.matchAll(/(--color-[a-z0-9-]+):/g)].map(([, name]) => name)),
);

/**
 * The colours a rule writes that the dark scheme cannot reach: a value (hex, rgb(), oklch()…) outside
 * the fallback of a variable, and a `--color-*` that no theme of the extension sets, whose fallback is
 * then the colour drawn (`text-red-500` of the palette of Tailwind).
 */
function writtenColours(body: string): string[] {
  const unknown = [...body.matchAll(/var\((--color-[a-z0-9-]+)/g)]
    .map(([, name]) => name)
    .filter((name) => name !== undefined && !TOKENS.has(name));
  const withoutFallbacks = body.replace(/var\(--[a-z0-9-]+,\s*[^()]*(?:\([^()]*\))?[^()]*\)/gi, 'var()');
  const values = [...withoutFallbacks.matchAll(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|color-mix)\(/gi)].map(
    ([colour]) => colour,
  );

  return [...values, ...unknown.map((name) => `var(${name})`)];
}

describe('what Tailwind writes for the kit (FRU-679)', () => {
  it('reads every colour of a rule from a variable, which the dark scheme sets again', async () => {
    const css = await built(KIT);
    const kitRules = rules(css).filter(({ selector }) => /kit-|focus-visible|visually-hidden/.test(selector));
    assert.ok(kitRules.length > 60, `only ${kitRules.length} rules of the kit were read`);
    const values = kitRules.flatMap(({ selector, body }) => writtenColours(body).map((c) => `${selector}: ${c}`));

    assert.deepEqual(values, []);
    // The focus ring and the main action, as Tailwind writes them.
    assert.match(css, /:focus-visible \{[^}]*outline-color: var\(--color-accent\b/);
    assert.match(css, /button\.kit-primary \{[^}]*background-color: var\(--color-accent\b/);
  });

  it('finds a colour written as a value, and not one in the fallback of a variable', async () => {
    assert.deepEqual(writtenColours('color: var(--color-accent, #dd2c27);'), []);
    assert.deepEqual(writtenColours('color: #dd2c27;'), ['#dd2c27']);
    assert.deepEqual(writtenColours('background-color: oklch(57.7% 0.245 27.325);'), ['oklch(']);
    // The control, built: a value in a rule, and a colour of the theme of Tailwind that the theme of
    // the extension does not set, are both found.
    const planted = await built(KIT, "@reference './theme.css';\n.kit-planted { @apply bg-[#123456] text-red-500; }");
    const body = rules(planted).find(({ selector }) => selector === '.kit-planted')?.body ?? '';
    assert.deepEqual(writtenColours(body), ['#123456', 'var(--color-red-500)']);
  });

  it('sets no style of edge through a variable, which a later edge of the same element would read', async () => {
    // `border-none` writes `--tw-border-style: none`; then `border` on the same element, from the sheet
    // of a page, reads it and draws nothing: a button of the kit lost its edge so. `border: 0` stays CSS.
    const css = await built(KIT);
    assert.doesNotMatch(css, /--tw-border-style: none/);
    // The control: the utility does write it.
    assert.match(
      await built(KIT, "@reference './theme.css';\n.kit-planted { @apply border-none; }"),
      /--tw-border-style: none/,
    );
  });

  it('gives each variable of Tailwind that a rule reads a start value, in the same output', async () => {
    const css = await built(KIT);
    const read = new Set([...css.matchAll(/var\((--tw-[a-z-]+)\)/g)].map(([, name]) => name));
    const started = new Set(
      [...css.matchAll(/@property (--tw-[a-z-]+) \{[^}]*initial-value:/g)].map(([, name]) => name),
    );
    // The two the focus ring and the edges need are among them.
    assert.ok(read.has('--tw-outline-style') && read.has('--tw-border-style'), [...read].join(', '));

    assert.deepEqual(
      [...read].filter((name) => !started.has(name)),
      [],
    );
  });
});
