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
  const optionsPage = read('../entrypoints/options/main.ts');
  const guide = read('../../../docs/reviewing.md');

  /** Every value of `PAIRING_PROBLEM`, by its `key: 'message'` shape. */
  const problems = [
    ...(/const PAIRING_PROBLEM[^=]*= \{([\s\S]*?)\n\};/.exec(popup)?.[1] ?? '').matchAll(/: '([^']+)'/g),
  ]
    .map((match) => match[1] ?? '')
    .filter((message) => message !== '');

  /**
   * Every mode label the popup offers, out of the block that builds the options.
   *
   * **Matched by the tuple's shape and not by the two keys that exist today.** Naming `private|team`
   * here left a third mode outside both this list and the count below, so the guide could omit its
   * label with the suite green — a detector that passes while guarding less than it says. Raised in
   * review.
   */
  const options = /function modeField[\s\S]*?\[([\s\S]*?)\]\) \{/.exec(popup)?.[1] ?? '';
  const modes = [...options.matchAll(/\['[a-z-]+', '([^']+)'\]/g)].map((match) => match[1] ?? '');

  /**
   * A guard over an empty extraction passes. Say so here rather than discover it after a rewrite —
   * this is the check the first version of `worlds.test.ts` did not have.
   */
  it('finds the strings it is written to guard', () => {
    assert.equal(problems.length, 4, `read ${problems.length} pairing failures out of the popup`);
    assert.ok(options !== '', 'the options block of modeField was not found; this guard reads nothing');
    // Counted against the `SiteMode` union rather than against a number written here, so a third
    // mode raises the bar instead of slipping under it.
    const declared = (
      /export type SiteMode = ([^;]+);/.exec(
        readFileSync(fileURLToPath(new URL('./sites.ts', import.meta.url)), 'utf8'),
      )?.[1] ?? ''
    ).split('|').length;
    assert.equal(modes.length, declared, `the popup offers ${modes.length} of the ${declared} modes SiteMode declares`);
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
      // Not in `PAIRING_PROBLEM`, and the one a reviewer on an http worker actually meets: the popup
      // disables the button before `sessions.pair` runs, so the record's own `insecure-endpoint`
      // never reaches that screen. Raised in review.
      'Pairing needs https (localhost excepted): a session must not cross http.',
      "team mode · the site's own widget",
      'No rule covers this origin, so Fruitback does nothing here.',
      'Turn off for every site this rule covers',
      'All sites and rules',
    ];

    for (const control of controls) {
      assert.ok(popup.includes(control), `the popup no longer renders: ${control}`);
      assert.ok(guide.includes(control), `docs/reviewing.md no longer names: ${control}`);
    }
  });

  /** The same walk-through, on the options page (SKG-536). */
  it('names the options page controls it walks somebody through', () => {
    const controls = ['Add rule', 'Grant access', 'No access in this browser', 'Export rules', 'Import a rules file'];

    for (const control of controls) {
      assert.ok(optionsPage.includes(control), `the options page no longer renders: ${control}`);
      assert.ok(guide.includes(control), `docs/reviewing.md no longer names: ${control}`);
    }
  });
});
