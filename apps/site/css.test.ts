import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { SHEETS, build, output } from './build.ts';

/**
 * The stylesheets of fruitback.com against their sources (FRU-681).
 *
 * GitHub Pages serves `docs/assets/*.css` as committed: a source changed without `pnpm --filter
 * @fruitback/site css` would ship nothing of the change, with no error anywhere.
 */
describe('the stylesheets of fruitback.com (FRU-681)', () => {
  for (const sheet of SHEETS) {
    it(`publishes what src/${sheet}.css builds`, () => {
      assert.equal(
        readFileSync(output(sheet), 'utf8'),
        build(sheet),
        `docs/assets/${sheet}.css is not what its source builds: run pnpm --filter @fruitback/site css`,
      );
    });
  }

  it('pins Tailwind to the one version the built sheets name', () => {
    // A range would let a refresh of the lockfile change the output with no source changed.
    const { devDependencies } = JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8')) as {
      devDependencies: Record<string, string>;
    };
    const pins = [devDependencies['tailwindcss'], devDependencies['@tailwindcss/cli']];
    assert.ok(
      pins.every((pin) => pin !== undefined && /^\d+\.\d+\.\d+$/.test(pin)),
      `not exact: ${pins.join(', ')}`,
    );
    assert.equal(pins[0], pins[1], 'the CLI and tailwindcss are not the same version');
    for (const sheet of SHEETS)
      assert.ok(readFileSync(output(sheet), 'utf8').includes(`tailwindcss v${pins[0]} `), sheet);
  });

  /** A colour written as a value: `#rgb`, `#rrggbb`, `rgb(…)`, `hsl(…)`, `oklch(…)`, outside a comment. */
  const VALUE = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\(/gi;

  it('writes the name of a token and never a colour, which only src/theme.css holds', () => {
    const written = SHEETS.flatMap((sheet) => {
      const source = readFileSync(new URL(`src/${sheet}.css`, import.meta.url), 'utf8').replaceAll(
        /\/\*[\s\S]*?\*\//g,
        '',
      );

      return [...source.matchAll(VALUE)].map((match) => `src/${sheet}.css: ${match[0]}`);
    });

    assert.deepEqual(written, [], 'a sheet writes these colours: name a token of src/theme.css instead');
  });

  it('takes no colour of the default palette of Tailwind', () => {
    // Its colours are oklch(…): a `bg-stone-100` would paint a colour the site never chose.
    for (const sheet of SHEETS) assert.doesNotMatch(readFileSync(output(sheet), 'utf8'), /oklch\(|oklab\(/);
  });
});
