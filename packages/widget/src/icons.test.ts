import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { type IconName, createIcon } from './icons.ts';
import { ICON_DATA, ICON_SOURCE } from './icon-data.ts';
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

  it('carries its own paint, rather than waiting for a stylesheet', () => {
    // Phosphor ships `fill="currentColor"` as a presentation attribute, and a `.fruitback-icon { fill }`
    // rule would beat it — class selector against specificity zero — so every imported icon would
    // render in the wrong colour or not at all. Ours are written the same way for that reason, and
    // the stylesheet only sizes them.
    const page = mountPage('<main></main>');

    for (const name of NAMES) {
      const icon = createIcon(page.document, name);

      assert.equal(icon.getAttribute('class'), 'fruitback-icon', name);
      for (const path of icon.querySelectorAll('path')) {
        const painted = path.getAttribute('fill') !== null || path.getAttribute('stroke') !== null;
        assert.ok(painted, `${name}: a path with no paint of its own`);
      }
    }
  });

  it('keeps its own shapes on its own grid, and takes the set on the set’s', () => {
    // Two sources, one shape. `drop` and `dropDashed` are the pin's silhouette and are drawn here on
    // a 16 grid; `gear` and `close` come from Phosphor, whose grid is 256. Mixing them costs nothing
    // because each carries its own viewBox — which is exactly what a shared one would have broken.
    const page = mountPage('<main></main>');

    assert.equal(createIcon(page.document, 'drop').getAttribute('viewBox'), '0 0 16 16');
    assert.equal(createIcon(page.document, 'gear').getAttribute('viewBox'), '0 0 256 256');
  });
});

describe('the icons taken from Iconify (SKG-529)', () => {
  /**
   * The committed data against the installed package.
   *
   * `icon-data.ts` is generated and committed, so the widget builds with no generation step — which
   * means nothing stops someone editing a path by hand, or a version bump leaving the copy stale.
   * This is what does. It reads `@iconify-json/ph` directly rather than re-running the generator,
   * so the two do not share the parsing that could be wrong in both.
   */
  const require = createRequire(import.meta.url);
  const set = require('@iconify-json/ph/icons.json') as { icons: Record<string, { body: string }> };
  const installed = require('@iconify-json/ph/package.json') as { version: string };

  it('carries the exact geometry the set ships', () => {
    for (const [ours, theirs] of Object.entries(ICON_SOURCE.names)) {
      const body = set.icons[theirs]?.body;
      assert.ok(body, `ph:${theirs} is not in the installed set`);

      const paths = ICON_DATA[ours as keyof typeof ICON_DATA]?.paths ?? [];
      assert.ok(paths.length > 0, `${ours} has no path`);
      for (const path of paths) {
        assert.ok(path.d, `${ours}: a path with no geometry`);
        assert.ok(body.includes(path.d as string), `${ours} has drifted from ph:${theirs} — run pnpm icons:build`);
      }
    }
  });

  it('records the version it was generated from', () => {
    // A bump that changes a path and not this field would leave the assertion above passing against
    // whatever happened to be installed, which is the one way it could lie.
    assert.equal(ICON_SOURCE.version, installed.version, 'icon-data.ts is stale — run pnpm icons:build');
    assert.equal(ICON_SOURCE.license, 'MIT');
  });

  it('is named in the notices, because it is compiled into dist', () => {
    // MIT asks the notice to travel with the code, and this geometry ships inside the bundle rather
    // than being installed by the consumer. Same obligation as react-grab and zod (SKG-515), and the
    // same guard: `package.test.ts` asserts the file is in the tarball, this asserts it says so.
    const notices = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'THIRD-PARTY-NOTICES.md'), 'utf8');

    assert.match(notices, /## Phosphor/);
    assert.match(notices, /MIT License/);
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
