import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The popup's words, checked against the guide that quotes them (SKG-539).
 *
 * `docs/reviewing.md` is the reviewer's side of the three modes, and it walks somebody through a
 * screen by naming what is on it. A renamed button leaves that guide describing a popup nobody has,
 * and nothing else would say so: the strings are not imported anywhere, there is no Chromium on CI
 * to open the popup with, and prose does not fail a build.
 *
 * The failure messages and the mode labels are **read out of the popup** rather than listed here, so
 * a fifth message or a third mode is covered the day it is written. The buttons are named, because
 * they are built one by one at their call sites and a regex over them would guard whichever ones it
 * happened to match.
 *
 * Source text rather than an import: `popup/main.ts` binds `browser` at import, so `node --test`
 * cannot load it. The same reason `page-api.test.ts` reads `docs/install.md` as text.
 */
describe('the guide quotes the popup this extension renders', () => {
  const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
  const popup = read('../entrypoints/popup/main.ts');
  const guide = read('../../../docs/reviewing.md');

  /** Every value of `PAIRING_PROBLEM`, by its `key: 'message'` shape. */
  const problems = [
    ...(/const PAIRING_PROBLEM[^=]*= \{([\s\S]*?)\n\};/.exec(popup)?.[1] ?? '').matchAll(/: '([^']+)'/g),
  ]
    .map((match) => match[1] ?? '')
    .filter((message) => message !== '');

  /** Every mode label the popup offers, by the tuple it builds its options from. */
  const modes = [...popup.matchAll(/\['(?:private|team)', '([^']+)'\]/g)].map((match) => match[1] ?? '');

  /**
   * A guard over an empty extraction passes. Say so here rather than discover it after a rewrite —
   * this is the check the first version of `worlds.test.ts` did not have.
   */
  it('finds the strings it is written to guard', () => {
    assert.equal(problems.length, 4, `read ${problems.length} pairing failures out of the popup`);
    assert.equal(modes.length, 2, `read ${modes.length} mode labels out of the popup`);
  });

  it('names every way pairing can fail', () => {
    for (const message of problems) {
      assert.ok(guide.includes(message), `docs/reviewing.md does not carry the pairing failure: ${message}`);
    }
  });

  it('names every mode the popup offers', () => {
    for (const label of modes) {
      assert.ok(guide.includes(label), `docs/reviewing.md does not carry the mode label: ${label}`);
    }
  });

  /**
   * What the guide tells somebody to click, and what it tells them they will read back. Each one is
   * a step of the walk-through: rename it in the popup and the step points at nothing.
   */
  it('names the controls it walks somebody through', () => {
    const controls = [
      'Turn on for this site',
      'Turn off here',
      'Change',
      'Pair with this worker',
      'Log out',
      'Worker endpoint',
      'Client id',
      'Not paired — this site cannot reach the worker until you do',
      "team mode · the site's own widget",
    ];

    for (const control of controls) {
      assert.ok(popup.includes(control), `the popup no longer renders: ${control}`);
      assert.ok(guide.includes(control), `docs/reviewing.md no longer names: ${control}`);
    }
  });
});
