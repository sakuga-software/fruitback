import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FRENCH as CONSOLE } from '../../console/app/messages.fr.ts';
import { FRENCH as WIDGET } from '../../../packages/widget/src/locale-fr.ts';
import { ENGLISH as WIDGET_ENGLISH } from '../../../packages/widget/src/messages.ts';
import { FRENCH as EXTENSION } from './messages.fr.ts';

/**
 * The glossary of the screens (FRU-517) is written once, in `docs/decisions/conventions.md`. This
 * test reads its table, and fails on a word of « Never in French » in a French catalogue, and on a
 * word of « Never in English » in an English one (FRU-555).
 */
const CONVENTIONS = readFileSync(new URL('../../../docs/decisions/conventions.md', import.meta.url), 'utf8');

/** Product names, which hold a word of the glossary and are not a sentence of ours. */
const NAMES = ['GitHub Issues'];

/** The words of a cell: none for « — ». */
const words = (cell: string): string[] =>
  cell === '—' || cell === '' ? [] : cell.split(',').map((word) => word.trim());

/** The rows of the table under « The words of the screens »: what it is, English, French, never. */
function glossary(): { english: string; french: string; never: string[]; neverInEnglish: string[] }[] {
  const start = CONVENTIONS.indexOf('### The words of the screens');
  assert.ok(start >= 0, 'conventions.md has no glossary');
  const section = CONVENTIONS.slice(start, CONVENTIONS.indexOf('\n## ', start));

  return section
    .split('\n')
    .filter((line) => line.startsWith('|') && !/^\|\s*(What it is|-+)/.test(line))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )
    .map(([, english = '', french = '', never = '', neverInEnglish = '']) => ({
      english,
      french,
      never: words(never),
      neverInEnglish: words(neverInEnglish),
    }));
}

/** Each French sentence of a catalogue, the forms of a plural too, with no placeholder and no name. */
function sentences(catalogue: Readonly<Record<string, unknown>>): string[] {
  return Object.values(catalogue)
    .flatMap((value) => (typeof value === 'string' ? [value] : Object.values(value as Record<string, string>)))
    .map((text) => NAMES.reduce((rest, name) => rest.replaceAll(name, ''), text.replaceAll(/\{\w+\}/g, '')));
}

/** The sentences that hold a word, as a whole word, whatever its capitals. A path (`/pair`) is no word. */
function holding(texts: string[], word: string): string[] {
  const pattern = new RegExp(`(?<![\\p{L}/])${word}(?![\\p{L}])`, 'iu');

  return texts.filter((text) => pattern.test(text));
}

const CATALOGUES = { console: CONSOLE, extension: EXTENSION, widget: WIDGET } as const;

describe('the glossary of the screens (FRU-517)', () => {
  it('is a table of the words decided, each with the words it replaces', () => {
    const rows = glossary();

    assert.ok(rows.length >= 10, `only ${rows.length} rows were read`);
    assert.deepEqual(
      rows.find((row) => row.english === 'workspace'),
      { english: 'workspace', french: 'espace de travail', never: ['workspace', 'workspaces'], neverInEnglish: [] },
    );
  });

  for (const [name, catalogue] of Object.entries(CATALOGUES)) {
    it(`holds no word it replaced in the French of the ${name}`, () => {
      const texts = sentences(catalogue);
      const found = glossary().flatMap(({ french, never }) =>
        never.flatMap((word) => holding(texts, word).map((text) => `« ${word} » for « ${french} »: ${text}`)),
      );

      assert.deepEqual(found, []);
    });
  }

  // FRU-555: the English of a screen is its key in the console and the extension, and the values
  // of `ENGLISH` in the widget.
  const ENGLISH_CATALOGUES = {
    console: Object.fromEntries(Object.keys(CONSOLE).map((key) => [key, key])),
    extension: Object.fromEntries(Object.keys(EXTENSION).map((key) => [key, key])),
    widget: WIDGET_ENGLISH,
  } as const;
  for (const [name, catalogue] of Object.entries(ENGLISH_CATALOGUES)) {
    it(`holds no word it replaced in the English of the ${name}`, () => {
      const texts = sentences(catalogue);
      const found = glossary().flatMap(({ english, neverInEnglish }) =>
        neverInEnglish.flatMap((word) => holding(texts, word).map((text) => `« ${word} » for « ${english} »: ${text}`)),
      );

      assert.deepEqual(found, []);
    });
  }

  it('writes French with the typographic apostrophe, never the straight one', () => {
    for (const [name, catalogue] of Object.entries(CATALOGUES)) {
      assert.deepEqual(
        sentences(catalogue).filter((text) => text.includes("'")),
        [],
        name,
      );
    }
  });

  it('finds a word it replaced when a sentence holds one, so the checks above are not empty by accident', () => {
    assert.deepEqual(holding(['Le worker répond', 'Les workers', 'Un reworker'], 'worker'), ['Le worker répond']);
    assert.deepEqual(holding(['Votre session a expiré.'], 'session a expiré'), ['Votre session a expiré.']);
    assert.deepEqual(holding(['Pair it', 'the address before /pair'], 'pair'), ['Pair it']);
    assert.deepEqual(sentences({ a: 'Dans {workspace}, avec GitHub Issues' }), ['Dans , avec ']);
    assert.ok(sentences(CONSOLE).length > 500);
  });
});
