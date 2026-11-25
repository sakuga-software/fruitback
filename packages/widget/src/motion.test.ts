import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { converted, moduleSheet, partsOf } from './sheets.fixture.ts';

/**
 * Every animation of the widget stops for a person who asked the system for less motion (FRU-471).
 *
 * happy-dom matches no media query and plays no animation, so the stylesheets are read: each rule
 * that starts an animation must have its selector set to `animation: none` in a
 * `prefers-reduced-motion: reduce` block of the same file. The widget lies over the site of
 * somebody else: it is the last thing on the page that should ignore that setting.
 */

const FILES = ['host.ts', 'overlay.ts', 'composer.ts', 'panel.ts', 'orphans.ts', 'sidebar.ts'] as const;

type Rule = { selectors: string[]; body: string; reduced: boolean };

/** The rules of a stylesheet, with whether they sit in a block for reduced motion. Flat CSS, one level of `@media`. */
export function rulesOf(sheet: string): Rule[] {
  const css = sheet.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  let index = 0;
  while (index < css.length) {
    const open = css.indexOf('{', index);
    if (open === -1) break;
    const head = css.slice(index, open).trim();
    if (head.startsWith('@media') || head.startsWith('@supports')) {
      // The block runs to the brace that closes it: its rules hold no brace of their own.
      let depth = 1;
      let cursor = open + 1;
      while (depth > 0 && cursor < css.length) {
        if (css[cursor] === '{') depth += 1;
        else if (css[cursor] === '}') depth -= 1;
        cursor += 1;
      }
      const reduced = /prefers-reduced-motion:\s*reduce/.test(head);
      for (const inner of rulesOf(css.slice(open + 1, cursor - 1)))
        rules.push({ ...inner, reduced: reduced || inner.reduced });
      index = cursor;
      continue;
    }
    const close = css.indexOf('}', open);
    if (head.startsWith('@keyframes')) {
      // Keyframes hold blocks of their own: skip to the brace that closes them.
      let depth = 1;
      let cursor = open + 1;
      while (depth > 0 && cursor < css.length) {
        if (css[cursor] === '{') depth += 1;
        else if (css[cursor] === '}') depth -= 1;
        cursor += 1;
      }
      index = cursor;
      continue;
    }
    rules.push({
      selectors: head.split(',').map((part) => part.trim()),
      body: css.slice(open + 1, close),
      reduced: false,
    });
    index = close + 1;
  }

  return rules;
}

/** The selectors that start an animation and that no block for reduced motion stops. */
export function unstopped(sheet: string): string[] {
  const rules = rulesOf(sheet);
  const stopped = new Set(
    rules
      .filter((rule) => rule.reduced && /animation(-name)?:\s*none/.test(rule.body))
      .flatMap((rule) => rule.selectors),
  );

  return rules
    .filter((rule) => !rule.reduced && /(^|[;\s])animation:\s*(?!none)/.test(rule.body))
    .flatMap((rule) => rule.selectors)
    .filter((selector) => !stopped.has(selector));
}

/** The parts whose class list starts an animation of Tailwind and has no stop for reduced motion. */
export function unstoppedParts(parts: Map<string, string>): string[] {
  return [...parts]
    .filter(([, classes]) => /fruitback:animate-(?!none)/.test(classes))
    .filter(([, classes]) => !/fruitback:motion-reduce:animate-none\b/.test(classes))
    .map(([part]) => part);
}

async function sheetOf(file: string): Promise<string> {
  // The sheet of `host.ts` is in `host.styles.ts`, and likewise for each module (FRU-509). A module
  // converted to Tailwind has the rules of the utilities it writes (FRU-680).
  const sheet = await moduleSheet(file);
  assert.ok(sheet.trim() !== '', `${file} has no CSS, so this test would check nothing`);

  return sheet;
}

describe('the motion of the widget (FRU-471)', () => {
  it('finds an animation that nothing stops, and none once a block for reduced motion stops it', () => {
    // The control: a scan that finds nothing would pass with nothing checked.
    const planted = '.a { animation: spin 1s; } .b { color: red; }';
    assert.deepEqual(unstopped(planted), ['.a']);
    assert.deepEqual(unstopped(`${planted} @media (prefers-reduced-motion: reduce) { .a { animation: none; } }`), []);
  });

  for (const file of FILES) {
    it(`stops every animation of ${file} for a person who asked for less motion`, async () => {
      assert.deepEqual(unstopped(await sheetOf(file)), []);
    });
  }

  it('stops each animation of a converted module beside it, in the class list of its part (FRU-680)', async () => {
    // The control: a part that animates and does not stop is found, and one that stops is not.
    assert.deepEqual(unstoppedParts(new Map([['a', "'fruitback:animate-spin'"]])), ['a']);
    assert.deepEqual(
      unstoppedParts(new Map([['a', "'fruitback:animate-spin fruitback:motion-reduce:animate-none'"]])),
      [],
    );

    for (const file of FILES) {
      if (await converted(file)) assert.deepEqual(unstoppedParts(await partsOf(file)), [], file);
    }
  });

  it('animates the dock, the settings and the thread (FRU-471)', async () => {
    assert.match(await sheetOf('host.ts'), /\.fruitback-dock \{ animation: fruitback-dock-in/);
    assert.match(
      await sheetOf('panel.ts'),
      /\.fruitback-panel-config:not\(\[hidden\]\) \{ animation: fruitback-panel-in/,
    );
    assert.match(await sheetOf('overlay.ts'), /animation: fruitback-thread-in/);
  });
});
