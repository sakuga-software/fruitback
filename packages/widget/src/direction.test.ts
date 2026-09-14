import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * Which rules follow the reading direction, and which never do (SKG-531).
 *
 * happy-dom resolves no logical property and computes no layout, so a unit test cannot see a pin move.
 * It can read the stylesheets. Two failures are silent in a browser too:
 *
 * - geometry that names a logical property moves a pin off its element on a right-to-left page;
 * - layout that names a physical side leaves the dock in the left-to-right corner.
 *
 * `e2e/direction.spec.ts` is the proof in a browser.
 */

const FILES = ['host.ts', 'overlay.ts', 'composer.ts', 'panel.ts', 'orphans.ts'] as const;

/** Positions against the page: document coordinates, or a shape that points at an element. */
const GEOMETRY: Record<(typeof FILES)[number], readonly string[]> = {
  'host.ts': ['.fruitback-panel', '.fruitback-highlight'],
  'overlay.ts': ['.fruitback-overlay', '.fruitback-pin', '.fruitback-pin-badge'],
  'composer.ts': ['.fruitback-composer'],
  'panel.ts': [],
  'orphans.ts': [],
};

const LOGICAL = /\b(inset-inline|inset-block|margin-inline|padding-inline|border-inline)|text-align:\s*(start|end)\b/;
const PHYSICAL_SIDE = /(^|[\s;{])(left|right)\s*:|-(left|right)\s*:|text-align:\s*(left|right)\b/;

type Rule = { selector: string; body: string };

async function rulesOf(file: string): Promise<Rule[]> {
  const source = await readFile(new URL(`./${file}`, import.meta.url), 'utf8');
  const sheet = /const STYLES = `([^`]*)`/.exec(source)?.[1];
  assert.ok(sheet, `${file} has no STYLES literal, so this test would check nothing`);

  const withoutComments = sheet.replace(/\/\*[\s\S]*?\*\//g, '');

  return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: (match[1] ?? '').trim(),
    body: match[2] ?? '',
  }));
}

describe('the stylesheets and the reading direction (SKG-531)', () => {
  it('names a physical side only in a geometry rule', async () => {
    const offenders: string[] = [];
    let physicalSeen = 0;

    for (const file of FILES) {
      for (const { selector, body } of await rulesOf(file)) {
        if (!PHYSICAL_SIDE.test(body)) continue;
        physicalSeen += 1;
        if (!GEOMETRY[file].includes(selector)) offenders.push(`${file} ${selector}`);
      }
    }

    // The detector first: the pin's badge sits at a physical left, so a scan that finds nothing is broken.
    assert.ok(physicalSeen > 0, 'no physical side found anywhere, so the scan reads nothing');
    assert.deepEqual(offenders, []);
  });

  it('keeps geometry free of logical properties, so a pin stays on its element', async () => {
    const offenders: string[] = [];

    for (const file of FILES) {
      const rules = await rulesOf(file);
      for (const selector of GEOMETRY[file]) {
        const matching = rules.filter((rule) => rule.selector === selector);
        assert.ok(matching.length > 0, `${file} has no rule for ${selector}; update GEOMETRY`);
        if (matching.some((rule) => LOGICAL.test(rule.body))) offenders.push(`${file} ${selector}`);
      }
    }

    assert.deepEqual(offenders, []);
  });

  it('puts the dock, the panel and the drawer at the inline end, whichever side that is', async () => {
    for (const [file, selector] of [
      ['host.ts', '.fruitback-dock'],
      ['panel.ts', '.fruitback-panel-config'],
      ['orphans.ts', '.fruitback-orphans'],
    ] as const) {
      const bodies = (await rulesOf(file)).filter((rule) => rule.selector === selector).map((rule) => rule.body);
      assert.ok(
        bodies.some((body) => /inset-inline-end\s*:/.test(body)),
        `${file} ${selector} is not placed at the inline end`,
      );
    }
  });
});
