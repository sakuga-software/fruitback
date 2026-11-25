import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { LAYERS, buildSheet, moduleOf, offences, propertiesOnEveryElement, themeReference } from '../build-styles.ts';
import { TAILWIND_STYLES } from './tailwind-sheet.ts';
import { THEME_STYLES } from './theme.ts';
import { STYLES as HOST_STYLES } from './host.styles.ts';

/**
 * The Tailwind sheet of the widget (FRU-680): `build-styles.ts` writes it into `tailwind-sheet.ts`,
 * and these tests hold the committed copy to what Tailwind builds today, and to the rules of
 * `docs/decisions/widget.md`, « Tailwind in the Shadow root ».
 */
describe('the Tailwind sheet of the widget', () => {
  it('is the sheet Tailwind builds from tailwind.css and the class names of src', async () => {
    const built = await buildSheet();

    assert.equal(TAILWIND_STYLES, built, 'src/tailwind-sheet.ts is stale or edited: run pnpm styles:build');
  });

  it('writes the CSS of the sheet unchanged into the module, backslashes too', async () => {
    const css = '.fruitback\\:p-3{padding:12px}.a{content:"`${b}`"}';
    const module = moduleOf(css);
    const literal = /export const TAILWIND_STYLES = (`[\s\S]*`);/.exec(module)?.[1];
    assert.ok(literal);

    assert.equal(new Function(`return ${literal}`)(), css);
  });

  it('declares the layers first, in the order of Tailwind', () => {
    assert.ok(TAILWIND_STYLES.startsWith(LAYERS));
    // The base of host.styles.ts comes after this sheet, in the same root: the order is already set.
    assert.match(HOST_STYLES, /@layer base \{\s*\/\*[\s\S]*?\*\/\s*\*:not\(svg, svg \*\) \{ all: initial;/);
  });

  it('holds a rule for a utility that a module writes', () => {
    // The control of the scan: area.ts writes these, and a sheet built from no source would pass the rest.
    assert.match(TAILWIND_STYLES, /\.fruitback\\:inset-x-3\{inset-inline:12px\}/);
    assert.match(TAILWIND_STYLES, /\.fruitback\\:bg-accent\{background-color:var\(--fruitback-color-accent\)\}/);
  });

  it('holds no word of a comment or of a message as a rule', () => {
    // Without the prefix, « hidden » or « table » in a comment of src each gave a rule.
    assert.doesNotMatch(TAILWIND_STYLES, /\.(hidden|table|block|ring|container)\{/);
  });

  it('finds each thing the sheet must never hold, and finds none in it', () => {
    assert.deepEqual(offences('.a{padding:1rem}'), ['a size in rem']);
    assert.deepEqual(offences('.a{padding:.25rem}'), ['a size in rem']);
    assert.deepEqual(offences('@property --tw-x{syntax:"*";inherits:false}'), [
      'an @property rule, which a Shadow root ignores',
    ]);
    assert.deepEqual(offences(':root,:host{--fruitback-spacing:4px}'), ['a rule on :root or :host']);
    assert.deepEqual(offences('.a{color:red}:host{--fruitback-spacing:4px}'), ['a rule on :root or :host']);
    assert.deepEqual(offences(":host([data-fruitback-position$='-left']) .a{left:0}"), []);
    assert.deepEqual(offences('@import "x.css";'), ['a file to load, which the CSP refuses']);
    assert.deepEqual(offences('.a{padding:12px;font-size:1em}'), []);

    assert.deepEqual(offences(TAILWIND_STYLES), []);
  });

  it('gives the value of each @property to every element of the root, and drops the rule', () => {
    const raw = [
      '@layer properties { @supports (x) { *, :before { --tw-a: 0; } } }',
      '.b { outline-style: var(--tw-outline-style); }',
      '@property --tw-outline-style { syntax: "*"; inherits: false; initial-value: solid; }',
      '@property --tw-ring-color { syntax: "*"; inherits: false }',
    ].join('\n');
    const out = propertiesOnEveryElement(raw);

    assert.doesNotMatch(out, /@property|@supports/);
    assert.match(out, /\.b \{ outline-style: var\(--tw-outline-style\); \}/);
    assert.match(out, /\*, ::before, ::after, ::backdrop \{ --tw-outline-style: solid; --tw-ring-color: initial; \}/);
    assert.match(TAILWIND_STYLES, /@layer properties\{\*,:before,:after,::backdrop\{[^}]*--tw-outline-style:solid/);
  });

  it('stays under its ceiling, raw and gzipped', () => {
    // FRU-680 projects about 50 000 B raw once every sheet of the widget is Tailwind. A sheet past
    // this ceiling holds rules nobody writes: a scan of a wrong source, or a theme read whole.
    const gzipped = gzipSync(TAILWIND_STYLES).byteLength;

    assert.ok(TAILWIND_STYLES.length < 64_000, `${TAILWIND_STYLES.length} B raw`);
    assert.ok(gzipped < 14_000, `${gzipped} B gzipped`);
  });

  it('names every token of theme.ts that Tailwind can name, as its variable', () => {
    const reference = themeReference(THEME_STYLES);

    assert.match(reference, /^@theme inline reference prefix\(fruitback\) \{/);
    assert.match(reference, /--color-accent: var\(--fruitback-color-accent\);/);
    assert.match(reference, /--radius-sm: var\(--fruitback-radius-sm\);/);
    assert.match(reference, /--shadow-lg: var\(--fruitback-shadow-lg\);/);
    assert.match(reference, /--font-mono: var\(--fruitback-font-mono\);/);
    // A stage and a duration fill no namespace of Tailwind: a module names them as (--fruitback-…).
    assert.doesNotMatch(reference, /--stage-|--duration-/);
  });
});
