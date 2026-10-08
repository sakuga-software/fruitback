import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IMPORT_PROBLEM, PAIRING_GUIDE, PAIRING_PROBLEM, PROBLEMS, REMEDY_LABEL, remedyFor } from './remedy.ts';

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

describe('every problem says what to do next, or why nothing can be done (FRU-90)', () => {
  it('lists a problem once', () => {
    const texts = PROBLEMS.map((problem) => problem.text);

    assert.deepEqual(texts, [...new Set(texts)]);
  });

  it('gives a reason to each problem that has no remedy', () => {
    for (const problem of PROBLEMS) {
      if (problem.remedy === null) assert.ok(problem.why.length > 20, `no reason for: ${problem.text}`);
    }
  });

  it('holds every way a pairing fails and every way an import fails', () => {
    for (const text of [...Object.values(PAIRING_PROBLEM), ...Object.values(IMPORT_PROBLEM)]) {
      assert.ok(
        PROBLEMS.some((problem) => problem.text === text),
        `not in the list: ${text}`,
      );
    }
  });

  /**
   * Every message constant of the modules the two pages take their problems from. A constant added
   * there and left out of the list shows with no button and no reason, which is the defect.
   */
  it('holds every problem constant of the modules behind the two pages', () => {
    const constants = ['./site-editor.ts', './site-form.ts'].flatMap((module) =>
      [...read(module).matchAll(/export const ([A-Z_]+) =\s*'([^']+)'/g)].map((match) => ({
        name: match[1] ?? '',
        text: match[2] ?? '',
      })),
    );

    assert.ok(constants.length >= 5, `read ${constants.length} constants: the detector selects the wrong thing`);
    for (const { name, text } of constants) {
      assert.ok(
        PROBLEMS.some((problem) => problem.text === text),
        `${name} is in no entry of PROBLEMS`,
      );
    }
  });

  it('answers the remedy of a problem, and none for words it does not know', () => {
    assert.equal(remedyFor(PAIRING_PROBLEM.unavailable), 'retry');
    assert.equal(remedyFor(PAIRING_PROBLEM.blocked), 'grant');
    assert.equal(remedyFor(IMPORT_PROBLEM['not-json']), null);
    assert.equal(remedyFor('The client id is required.'), null);
    assert.equal(remedyFor(''), null);
  });

  it('names each remedy with words of its own', () => {
    const labels = Object.values(REMEDY_LABEL);

    assert.deepEqual(labels, [...new Set(labels)]);
  });
});

describe('the two pages draw a problem through one function', () => {
  const pages = { popup: read('../entrypoints/popup/main.ts'), options: read('../entrypoints/options/main.ts') };

  it('writes no problem by hand', () => {
    for (const [name, source] of Object.entries(pages)) {
      assert.ok(source.includes('showProblem('), `the ${name} page does not use showProblem: this check reads nothing`);
      assert.deepEqual(
        [...source.matchAll(/\b(?:problem|notice)\.textContent\s*=/g)].map((match) => match[0]),
        [],
        `the ${name} page writes a problem with no remedy beside it`,
      );
    }
  });

  /** A remedy in the list with no handler on the page that shows it draws no button. */
  it('gives a handler to each remedy a page can show', () => {
    const handled = (source: string, remedy: string) => new RegExp(`\\b${remedy}(:|,|\\s*\\})`).test(source);

    for (const remedy of ['retry', 'grant', 'change', 'list']) {
      assert.ok(handled(pages.popup, remedy), `the popup passes no handler for: ${remedy}`);
    }
    for (const remedy of ['grant', 'list']) {
      assert.ok(handled(pages.options, remedy), `the options page passes no handler for: ${remedy}`);
    }
  });
});

describe('the link to the guide', () => {
  it('points at a heading the guide has', () => {
    const guide = read('../../../docs/reviewing.md');
    const anchors = [...guide.matchAll(/^#{2,3} (.+)$/gm)].map((match) =>
      (match[1] ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9 -]/g, '')
        .trim()
        .replace(/ /g, '-'),
    );
    const [page, anchor] = PAIRING_GUIDE.split('#');

    assert.ok(page?.endsWith('/reviewing.html'), PAIRING_GUIDE);
    assert.ok(anchors.length > 3, 'no heading was read from the guide');
    assert.ok(anchors.includes(anchor ?? ''), `the guide has no heading for #${anchor}: ${anchors.join(', ')}`);
  });
});
