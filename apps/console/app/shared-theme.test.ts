import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'tailwindcss';

/**
 * The Tailwind theme that the console shares with the extension, the widget and the docs (FRU-677).
 *
 * `packages/shared/tailwind/theme.css` holds one `@theme` block and nothing else. Two surfaces
 * import it without the preflight of Tailwind (the extension and the docs), and one of them has a
 * dark scheme: its utilities must read `var(--color-…)`, so that a block of that surface sets the
 * tokens again under `prefers-color-scheme: dark`. The widget reads the same sizes, in px.
 */
const THEME = fileURLToPath(new URL('../../../packages/shared/tailwind/theme.css', import.meta.url));
const theme = readFileSync(THEME, 'utf8');
const require = createRequire(import.meta.url);

/** The source without its comments. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').trim();
}

/** Whether a stylesheet is one plain `@theme` block: no import, no rule, not `inline`, not `static`. */
function onlyTheme(source: string): boolean {
  return /^@theme\s*\{[^{}]*\}$/.test(code(source));
}

/** The CSS that Tailwind writes for `candidates`, from a stylesheet that imports the shared theme. */
async function built(input: string, candidates: string[]): Promise<string> {
  const compiler = await compile(input, {
    base: dirname(THEME),
    async loadStylesheet(id: string) {
      const path = id === '@fruitback/shared/tailwind/theme.css' ? THEME : require.resolve(id);

      return { path, base: dirname(path), content: await readFile(path, 'utf8') };
    },
  });

  return compiler.build(candidates);
}

/** How the extension and the docs import it: the theme and the utilities of Tailwind, no preflight. */
const WITHOUT_PREFLIGHT = `@import 'tailwindcss/theme.css' layer(theme);
@import '@fruitback/shared/tailwind/theme.css';
@import 'tailwindcss/utilities.css' layer(utilities);
@media (prefers-color-scheme: dark) {
  :root {
    --color-ink: #f4f4f5;
  }
}
`;

describe('the shared Tailwind theme (FRU-677)', () => {
  it('is one plain @theme block, and nothing else', () => {
    assert.ok(onlyTheme(theme), 'packages/shared/tailwind/theme.css holds more than one @theme block');
    // The control: an inline theme, an import, a rule beside the block are each refused.
    assert.equal(onlyTheme('@theme inline { --color-ink: #18181b; }'), false);
    assert.equal(onlyTheme("@import 'tailwindcss';\n@theme { --color-ink: #18181b; }"), false);
    assert.equal(onlyTheme('@theme { --color-ink: #18181b; }\nbody { color: red; }'), false);
    assert.equal(onlyTheme('/* a note */\n@theme { --color-ink: #18181b; }'), true);
  });

  it('builds without the preflight, and its utilities read the tokens through var()', async () => {
    const css = await built(WITHOUT_PREFLIGHT, [
      'text-ink',
      'bg-status-done',
      'h-control',
      'text-title',
      'rounded-frame',
    ]);

    assert.match(css, /\.text-ink \{\s*color: var\(--color-ink\);/);
    assert.match(css, /\.bg-status-done \{\s*background-color: var\(--color-status-done\);/);
    assert.match(css, /\.h-control \{\s*height: var\(--spacing-control\);/);
    assert.match(css, /\.text-title \{\s*font-size: var\(--text-title\);/);
    assert.match(css, /\.rounded-frame \{\s*border-radius: var\(--radius-frame\);/);
    // The values sit in the layer `theme`, which the dark block of a surface, in no layer, wins over.
    assert.match(css, /@layer theme \{[\s\S]*--color-ink: #18181b;/);
    assert.match(css, /@media \(prefers-color-scheme: dark\) \{\s*:root \{\s*--color-ink: #f4f4f5;/);
    // No preflight: no rule on every element.
    assert.doesNotMatch(css, /box-sizing: border-box/);
  });

  it('stays out of what @fruitback/shared publishes: the contract holds no colour', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../../packages/shared/package.json', import.meta.url), 'utf8'));
    const published = (files: string[], exports: Record<string, unknown>) => [
      ...files.filter((file) => file.startsWith('tailwind')),
      ...Object.keys(exports).filter((key) => key.includes('tailwind')),
    ];

    assert.deepEqual(published(pkg.files, pkg.publishConfig.exports), []);
    assert.ok('./tailwind/theme.css' in pkg.exports, 'the workspace does not export the theme');
    // The control: a theme in the files or in the published exports is found.
    assert.deepEqual(published(['dist', 'tailwind'], { './tailwind/theme.css': './tailwind/theme.css' }), [
      'tailwind',
      './tailwind/theme.css',
    ]);
  });

  it('writes every size in px, the unit the widget reads', () => {
    const sizes = [...code(theme).matchAll(/--((?:text|spacing|radius)-[a-z-]+):\s*([^;]+);/g)]
      .filter(([, name]) => !name?.endsWith('--line-height'))
      .map(([, name, value]) => [name, value]);
    const notPx = sizes.filter(([, value]) => !/^\d+px$/.test(value ?? ''));

    assert.deepEqual(notPx, []);
    assert.ok(sizes.length >= 20, `only ${sizes.length} sizes were read`);
  });
});
