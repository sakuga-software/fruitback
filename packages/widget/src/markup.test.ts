import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/**
 * Two rules of the widget that fail with nothing to see, held on the sources.
 *
 * **A word, a note and a comment body are text.** A note is written by anybody who can reach the page,
 * and a comment by anybody who can comment on the issue. The widget draws both inside the page of
 * somebody else, so markup made from either is a script on a client's site. The composer parses one
 * constant template and sets its words after, with `textContent`. This test holds that: markup is
 * assigned from a constant with no substitution, and from nothing else.
 *
 * **A library the widget uses is compiled into it.** A client site must not have to install it, or
 * resolve a version conflict over it. So it is a devDependency, and its notice travels in
 * `THIRD-PARTY-NOTICES.md`, because bundling makes that notice our obligation (FRU-22). A library
 * added to `dependencies`, or bundled with no notice, breaks nothing here.
 */

const SRC = new URL('./', import.meta.url);
const SHARED = new URL('../../shared/src/', import.meta.url);

/** The files a directory ships: no test, no fixture. */
function shipped(directory: URL): string[] {
  return readdirSync(directory).filter((file) => /\.ts$/.test(file) && !/\.(test|fixture)\.ts$/.test(file));
}

function read(directory: URL, file: string): string {
  return readFileSync(new URL(file, directory), 'utf8');
}

/** The code of a source, without its comments: a comment may name what the code must not do. */
function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

/** Every way to hand a string to the HTML parser. */
const MARKUP = /\.(innerHTML|outerHTML)\s*[+]?=(?!=)\s*([^;\n]*)|\.(insertAdjacentHTML|setHTMLUnsafe)\(([^;\n]*)/g;

/** What is wrong with each place a source makes markup from a string. */
export function markupOffences(file: string, source: string): string[] {
  const code = codeOf(source);

  return [...code.matchAll(MARKUP)].flatMap((match) => {
    const how = match[1] ?? match[3];
    const value = (match[2] ?? match[4] ?? '').trim();
    const name = /^[A-Z][A-Z0-9_]*$/.exec(value)?.[0];

    if (name === undefined) return [`${file}: ${how} takes « ${value} », which is no constant template`];

    const literal = new RegExp(`const ${name} = \`([^\`]*)\``).exec(code)?.[1];
    if (literal === undefined) return [`${file}: ${how} takes ${name}, which is no template of this file`];

    return literal.includes('${') ? [`${file}: the template ${name} holds a substitution`] : [];
  });
}

/** The packages a directory imports: `react-grab/primitives` is `react-grab`. */
function packagesOf(directory: URL): string[] {
  const found = new Set<string>();

  for (const file of shipped(directory)) {
    for (const match of codeOf(read(directory, file)).matchAll(/from '([^'.][^']*)'/g)) {
      const specifier = match[1] as string;
      if (specifier.startsWith('node:')) continue;

      found.add(
        specifier
          .split('/')
          .slice(0, specifier.startsWith('@') ? 2 : 1)
          .join('/'),
      );
    }
  }

  return [...found].sort();
}

describe('a word, a note and a comment body are text', () => {
  const files = shipped(SRC);

  /** A guard over an empty set passes. */
  it('finds the sources it is written to guard, and the one template they parse', () => {
    assert.ok(files.length > 20, `only ${files.length} sources found in packages/widget/src`);
    assert.match(codeOf(read(SRC, 'composer.ts')), /\.innerHTML = TEMPLATE;/);
  });

  it('makes markup from a constant template, and from nothing else', () => {
    assert.deepEqual(
      files.flatMap((file) => markupOffences(file, read(SRC, file))),
      [],
      'set a word, a note or a comment body with textContent or an attribute, after the template is parsed',
    );
  });

  it('refuses a variable, a substitution and an insertion', () => {
    assert.equal(markupOffences('a.ts', 'const T = `<b></b>`;\nroot.innerHTML = T;').length, 0);
    assert.equal(markupOffences('a.ts', 'root.innerHTML = note.body;').length, 1);
    assert.equal(markupOffences('a.ts', 'const T = `<b>${word}</b>`;\nroot.innerHTML = T;').length, 1);
    assert.equal(markupOffences('a.ts', 'root.innerHTML = `<b>${word}</b>`;').length, 1);
    assert.equal(markupOffences('a.ts', "root.insertAdjacentHTML('beforeend', word);").length, 1);
    assert.equal(markupOffences('a.ts', '// root.innerHTML = word;\nroot.textContent = word;').length, 0);
  });
});

describe('a library the widget uses is compiled into it', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const notices = readFileSync(new URL('../THIRD-PARTY-NOTICES.md', import.meta.url), 'utf8');
  const own = (name: string): boolean => name.startsWith('@fruitback/');
  const bundled = [...new Set([...packagesOf(SRC), ...packagesOf(SHARED)])].filter((name) => !own(name)).sort();

  /** A guard over an empty set passes. */
  it('finds the libraries it is written to guard', () => {
    assert.deepEqual(bundled, ['react-grab', 'zod']);
  });

  it('asks a client site to install nothing but our own packages', () => {
    assert.deepEqual(
      Object.keys(manifest.dependencies ?? {}).filter((name) => !own(name)),
      [],
      'a library of the widget is bundled: it is a devDependency, never a dependency',
    );
  });

  it('holds each one it imports as a devDependency', () => {
    const missing = packagesOf(SRC).filter((name) => !own(name) && manifest.devDependencies?.[name] === undefined);

    assert.deepEqual(missing, []);
  });

  it('carries the notice of each one it compiles in', () => {
    const missing = bundled.filter((name) => !new RegExp(`^## ${name}$`, 'm').test(notices));

    assert.deepEqual(missing, [], 'add its licence to packages/widget/THIRD-PARTY-NOTICES.md, under « ## <name> »');
  });
});
