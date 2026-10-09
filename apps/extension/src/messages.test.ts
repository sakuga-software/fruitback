import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { nearest, setLanguage, translate } from './i18n.ts';
import { FRENCH } from './messages.fr.ts';
import { showProblem } from './problem-view.ts';
import { PROBLEMS, REMEDY_LABEL } from './remedy.ts';

/**
 * The words of the popup and of the options page, held to the French catalog (FRU-131).
 *
 * The two pages bind `browser` at import, so `node --test` cannot render them. This reads their
 * source, like `reviewing-doc.test.ts`.
 */
const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

/** The code of a source, with its comments taken out: a comment holds sentences nobody is shown. */
function code(source: string): string {
  return (
    source
      // Only a comment that starts its line: `https://*.host` holds the two characters that open one.
      .replace(/^\s*\/\*[\s\S]*?\*\//gm, '')
      .split('\n')
      .filter((line) => !/^\s*\/\//.test(line))
      .join('\n')
  );
}

const PAGES = ['../entrypoints/popup/main.ts', '../entrypoints/options/main.ts'] as const;
/** The modules whose constants are sentences a page shows through `showProblem` or `t`. */
const CONSTANTS = ['./remedy.ts', './site-form.ts', './site-editor.ts', './read-probe.ts'] as const;

const pages = new Map(PAGES.map((path) => [path, code(read(path))]));

const LITERAL = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
const unescape = (text: string): string => text.replace(/\\(.)/g, '$1');

/** Whether a string reads as words for a person: it starts like a sentence, or holds two words. */
function isWords(text: string): boolean {
  const plain = text.replace(/\$\{[^}]*\}/g, '');

  return /^[A-Z][a-z]/.test(plain) || /[A-Za-z]{2,} [A-Za-z]{2,}/.test(plain);
}

/** The sentences a page passes to `t` or marks with `msg`. */
function translated(source: string): string[] {
  return [...source.matchAll(/\b(?:t|msg)\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")/g)].map((match) =>
    unescape(match[1] ?? match[2] ?? ''),
  );
}

/** The sentences of a module of constants. `why` says why a problem has no remedy, to a developer. */
function constants(path: string): string[] {
  const source = code(read(path))
    .split('\n')
    .filter((line) => !/^\s*import /.test(line) && !/\bwhy: /.test(line) && !/^export const PAIRING_GUIDE/.test(line))
    .join('\n');

  return [...source.matchAll(LITERAL)].map((match) => unescape(match[1] ?? match[2] ?? match[3] ?? '')).filter(isWords);
}

/** The labels of the two modes, which stay English in the list the guide is checked against. */
function modeLabels(source: string): string[] {
  return [...source.matchAll(/\['(?:private|team)', '([^']+)'\]/g)].map((match) => match[1] ?? '');
}

const shown = new Set([
  ...[...pages.values()].flatMap((source) => [...translated(source), ...modeLabels(source)]),
  ...CONSTANTS.flatMap(constants),
]);

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();

describe('the French words of the extension', () => {
  it('finds the sentences it is written to guard', () => {
    assert.ok(shown.size > 60, `only ${shown.size} sentences were found`);
    for (const { text } of PROBLEMS) assert.ok(shown.has(text), `a problem was not found: ${text}`);
    for (const label of Object.values(REMEDY_LABEL)) assert.ok(shown.has(label), `a remedy was not found: ${label}`);
    assert.equal([...pages.values()].flatMap(modeLabels).length, 4, 'two mode labels on each page');
  });

  it('hold every sentence a page shows', () => {
    assert.deepEqual(
      [...shown].filter((sentence) => FRENCH[sentence] === undefined),
      [],
    );
  });

  it('hold no sentence that no page shows', () => {
    assert.deepEqual(
      Object.keys(FRENCH).filter((sentence) => !shown.has(sentence)),
      [],
    );
  });

  it('keep the placeholders of the English sentence', () => {
    for (const [english, french] of Object.entries(FRENCH)) {
      assert.deepEqual(placeholders(french), placeholders(english), english);
    }
  });
});

describe('a word on a page of the extension', () => {
  /** What reads as words and is none to translate: a line for the console, the name of the product. */
  const NOT_FOR_A_READER = (text: string): boolean => text.startsWith('[fruitback]') || text === 'Fruitback';

  it('goes through the catalog', () => {
    const loose: string[] = [];
    for (const [path, source] of pages) {
      const body = source
        .split('\n')
        .filter((line) => !/^\s*import /.test(line) && !/^\} from '/.test(line))
        .join('\n');
      for (const match of body.matchAll(LITERAL)) {
        const text = unescape(match[1] ?? match[2] ?? match[3] ?? '');
        if (!isWords(text) || NOT_FOR_A_READER(text)) continue;
        const before = body.slice(0, match.index).trimEnd();
        if (/\b(?:t|msg)\($/.test(before)) continue;
        // A mode label is translated where the option is written, and the test below holds that.
        if (modeLabels(source).includes(text)) continue;
        loose.push(`${path}: ${text}`);
      }
    }

    assert.deepEqual(loose, []);
  });

  it('is translated where a mode label and a problem are written', () => {
    for (const [path, source] of pages) {
      assert.match(source, /option\.textContent = t\(text/, `${path} writes its mode labels in English`);
    }
  });

  it('keeps its remedy when the problem is shown in French', () => {
    // `remedyFor` finds a problem by its English text. A problem translated before that loses its button.
    const children: unknown[] = [];
    const made: { textContent: string; type?: string; className?: string; addEventListener(): void }[] = [];
    const target = {
      ownerDocument: {
        createElement: () => {
          const node = { textContent: '', addEventListener: () => {} };
          made.push(node);

          return node;
        },
      },
      replaceChildren: (...nodes: unknown[]) => void children.splice(0, children.length, ...nodes),
      append: (...nodes: unknown[]) => void children.push(...nodes),
    } as unknown as HTMLElement;

    setLanguage('fr');
    try {
      showProblem(target, 'The worker did not answer. Try again.', { retry: () => {} });
    } finally {
      setLanguage('en');
    }

    assert.deepEqual(children[0], 'Le worker n’a pas répondu. Réessayez.');
    assert.equal(made.length, 1, 'the remedy button was not drawn');
    assert.equal(made[0]?.textContent, 'Réessayer');
  });
});

describe('the language of a reviewer', () => {
  it('is French for a French tag, and English for a tag with no catalog', () => {
    assert.equal(nearest('fr-CA'), 'fr');
    assert.equal(nearest('FR'), 'fr');
    assert.equal(nearest('ja'), 'en');
    assert.equal(nearest(undefined), 'en');
  });

  it('fills the values, and shows a sentence with no French in English', () => {
    assert.equal(translate('fr', 'Paired as {identity}', { identity: 'Alice' }), 'Appairé en tant que Alice');
    assert.equal(translate('en', 'Paired as {identity}', { identity: 'Alice' }), 'Paired as Alice');
    assert.equal(translate('fr', 'A sentence nobody translated'), 'A sentence nobody translated');
  });
});
