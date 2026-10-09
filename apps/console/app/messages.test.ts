import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { nearest, translate } from './i18n.ts';
import { FRENCH } from './messages.fr.ts';

/**
 * The screens are read, not rendered: the console has no DOM under `node --test`.
 *
 * So the guard is on the sources. It finds every sentence a screen hands to `t` or marks with `msg`,
 * and every piece of text a screen shows with neither.
 */
const APP = new URL('./', import.meta.url);
const screens = [...readdirSync(new URL('routes/', APP)).map((name) => `routes/${name}`), 'root.tsx', 'ui.tsx'].filter(
  (name) => name.endsWith('.tsx'),
);
const sources = new Map(screens.map((name) => [name, readFileSync(new URL(name, APP), 'utf8')]));

/** The first argument of each `t(` and `msg(`, when it is a literal. */
function sentencesOf(source: string): string[] {
  return [...source.matchAll(/\b(?:t|msg)\(\s*'((?:[^'\\]|\\.)*)'/g)].map((match) =>
    (match[1] as string).replaceAll("\\'", "'"),
  );
}

const shown = new Set([...sources.values()].flatMap(sentencesOf));

describe('the words of the console (FRU-120)', () => {
  it('has French for every sentence a screen shows', () => {
    const missing = [...shown].filter((sentence) => !(sentence in FRENCH));

    assert.deepEqual(missing, []);
  });

  it('holds no French for a sentence no screen shows', () => {
    const unused = Object.keys(FRENCH).filter((sentence) => !shown.has(sentence));

    assert.deepEqual(unused, []);
  });

  it('keeps the placeholders of each sentence', () => {
    const placeholders = (text: string): string[] => [...text.matchAll(/\{\w+\}/g)].map(([name]) => name).sort();
    for (const [english, french] of Object.entries(FRENCH)) {
      assert.deepEqual(placeholders(french), placeholders(english), english);
    }
  });

  it('shows no text that did not go through t', () => {
    const loose: string[] = [];
    for (const [name, source] of sources) {
      source.split('\n').forEach((line, index) => {
        const code = line.trim();
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*') || code.startsWith('import '))
          return;
        // What `t` and `msg` already hold, and the class names, are not text of ours.
        const rest = line
          .replaceAll(/\b(?:t|msg)\(\s*'(?:[^'\\]|\\.)*'/g, '')
          .replaceAll(/className=(?:"[^"]*"|\{`[^`]*`\})/g, '');
        const text =
          // Words between two tags, or alone on a line of JSX.
          />\s*[A-Za-z][A-Za-z ,.'’]{2,}\s*<\//.test(rest) ||
          // Words alone on a line: text between two tags that are on other lines.
          // An attribute alone on its line (`disabled`) starts with a small letter and has no space.
          /^\s+(?:[A-Z][A-Za-z ,.'’-]*|[a-z]+(?: [A-Za-z,.'’-]+){2,})[a-z.?!…]$/.test(rest) ||
          // A sentence in an attribute a person reads or hears.
          /\b(?:title|lead|label|hint|aria-label|alt)="[^"]*[A-Za-z]{3}/.test(rest);
        if (text) loose.push(`${name}:${index + 1}: ${code}`);
      });
    }

    assert.deepEqual(loose, []);
  });

  it('finds a loose word when a screen has one, so the check above is not empty by accident', () => {
    const sample = '        <p>Hello there</p>';

    assert.ok(/>\s*[A-Za-z][A-Za-z ,.'’]{2,}\s*<\//.test(sample));
    assert.ok(shown.size > 100, `only ${shown.size} sentences were found`);
  });
});

/** The body of each component of a source: a function whose name starts with a capital. */
function components(source: string): { name: string; body: string }[] {
  const found: { name: string; body: string }[] = [];
  for (const match of source.matchAll(/^(?:export default |export )?function ([A-Z]\w*)\(/gm)) {
    // Past the parameters, to the brace that opens the body: the first one at depth 0 after `)`.
    let index = (match.index ?? 0) + match[0].length - 1;
    let depth = 0;
    for (; index < source.length; index += 1) {
      if (source[index] === '(') depth += 1;
      if (source[index] === ')' && (depth -= 1) === 0) break;
    }
    const open = source.indexOf(') {', index) === index ? index + 2 : source.indexOf('{', source.indexOf(')', index));
    let end = open + 1;
    for (let braces = 1; end < source.length && braces > 0; end += 1) {
      if (source[end] === '{') braces += 1;
      if (source[end] === '}') braces -= 1;
    }
    found.push({ name: match[1] as string, body: source.slice(open, end) });
  }

  return found;
}

describe('a change of language', () => {
  it('reaches every component that shows a sentence, because each one subscribes', () => {
    const deaf: string[] = [];
    let translating = 0;
    for (const [name, source] of sources) {
      for (const component of components(source)) {
        if (!/\bt\(/.test(component.body)) continue;
        translating += 1;
        if (!component.body.includes('useLocale()')) deaf.push(`${name}: ${component.name}`);
      }
    }

    assert.deepEqual(deaf, []);
    assert.ok(translating > 15, `only ${translating} components were found, so the check above saw too little`);
  });

  it('never mounts a screen again: the root holds no key on the language', () => {
    const root = sources.get('root.tsx') ?? '';

    assert.equal(/key=\{(?:tag|locale)/.test(root), false);
    assert.ok(root.includes('useLocale()'));
  });
});

describe('the language of a person', () => {
  it('reads a regional tag as its language, and a language with no words as English', () => {
    assert.equal(nearest('fr-CA'), 'fr');
    assert.equal(nearest('FR'), 'fr');
    assert.equal(nearest('ja-JP'), 'en');
    assert.equal(nearest(undefined), 'en');
  });

  it('fills the values of a sentence, and shows English for a sentence with no French', () => {
    assert.equal(translate('fr', 'Key of {person}', { person: 'Camille' }), 'Clé de Camille');
    assert.equal(translate('en', 'Key of {person}', { person: 'Camille' }), 'Key of Camille');
    assert.equal(translate('fr', 'A sentence nobody translated'), 'A sentence nobody translated');
  });
});
