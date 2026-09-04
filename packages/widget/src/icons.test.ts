import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { type IconName, createIcon } from './icons.ts';
import { mountPage } from './dom.fixture.ts';

const NAMES: IconName[] = ['gear', 'close', 'drop', 'dropDashed'];
const SVG_NS = 'http://www.w3.org/2000/svg';

describe('createIcon', () => {
  it('builds every name in the SVG namespace', () => {
    // Namespace and not tag name: `createElement('svg')` produces an HTML element called svg, which
    // renders nothing at all and reports nothing either. That is the whole reason these are built
    // element by element instead of assigned through innerHTML.
    const page = mountPage('<main></main>');

    for (const name of NAMES) {
      const icon = createIcon(page.document, name);

      assert.equal(icon.namespaceURI, SVG_NS, name);
      assert.ok(icon.querySelector('path'), `${name} draws nothing`);
      for (const path of icon.querySelectorAll('path')) {
        assert.equal(path.namespaceURI, SVG_NS, `${name}: a path outside the SVG namespace`);
        assert.match(path.getAttribute('d') ?? '', /^M/, `${name}: a path with no geometry`);
      }
    }
  });

  it('is decorative, and never a tab stop', () => {
    // Each icon sits beside a label or inside a button that names itself, so a screen reader that
    // announced it would be reading the same thing twice. `focusable=false` is the other half: an
    // SVG is focusable in some engines, which would put a tab stop on a decoration.
    const page = mountPage('<main></main>');

    for (const name of NAMES) {
      const icon = createIcon(page.document, name);

      assert.equal(icon.getAttribute('aria-hidden'), 'true', name);
      assert.equal(icon.getAttribute('focusable'), 'false', name);
      assert.equal(icon.textContent, '', `${name} contributes text to its button's name`);
    }
  });

  it('carries the class the stylesheet paints it through', () => {
    // `all: initial` in the host reset would otherwise leave every icon black and unsized; the paint
    // rules hang off these two classes.
    const page = mountPage('<main></main>');

    assert.equal(createIcon(page.document, 'close').getAttribute('class'), 'fruitback-icon');
    assert.equal(createIcon(page.document, 'drop').getAttribute('class'), 'fruitback-icon fruitback-icon-filled');
    assert.equal(createIcon(page.document, 'dropDashed').getAttribute('class'), 'fruitback-icon fruitback-icon-dashed');
  });
});

describe('the widget renders no emoji (SKG-529)', () => {
  /**
   * The whole package, comments included, rather than the rendered strings alone.
   *
   * A rendered check can only see the states a test reaches, and the four emoji this ticket removed
   * were each on a path some test did not run. The rule is also simpler stated this way — there are
   * none in here — and a rule with no exceptions is one nobody has to be told twice.
   *
   * `≈` and `×` and `→` are deliberately outside the ranges below: they are typographic symbols with
   * one drawing in every font, which is the property emoji lack.
   */
  // The variation selector sits outside the class on purpose: it is a combining character, and
  // oxlint refuses one inside a character class because the range it appears to extend is not the
  // range it actually matches.
  const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]|\u{FE0F}/u;

  it('has none in any source file of this package', () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    const offenders: string[] = [];

    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.ts')) continue;

      const lines = readFileSync(join(directory, name), 'utf8').split('\n');
      for (const [index, line] of lines.entries()) {
        if (EMOJI.test(line)) offenders.push(`${name}:${index + 1} ${line.trim()}`);
      }
    }

    assert.deepEqual(offenders, [], 'an emoji is drawn by the system font, so we do not control it');
  });

  it('would notice one, so the check above is worth its line', () => {
    // The guard reads files; a guard that reads files can pass because its pattern matches nothing
    // it was pointed at. This is the mutation, run against the same pattern.
    assert.ok(EMOJI.test("button.textContent = '\u{1F331} Laisser un feedback';"));
    assert.ok(EMOJI.test("harvested: '\u{1F353} récolté'"));
    assert.ok(EMOJI.test("configure.textContent = '\u{2699}';"));
    assert.ok(!EMOJI.test("glyph.textContent = '≈';"), 'a typographic symbol is not an emoji');
    assert.ok(!EMOJI.test('anchor.textContent = `${issue.identifier} →`;'));
  });
});
