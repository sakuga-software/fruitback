import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** The console has no DOM under `node --test`: the guard reads the source (FRU-435). */
const source = readFileSync(new URL('connector-marks.tsx', import.meta.url), 'utf8');
const notes = readFileSync(new URL('routes/notes.tsx', import.meta.url), 'utf8');
const connectors = readFileSync(new URL('routes/connectors.tsx', import.meta.url), 'utf8');
const parts = readFileSync(new URL('routes/connector-parts.tsx', import.meta.url), 'utf8');

/** The kinds that have a mark: the keys of `MARKS`. */
const marked = new Set([...source.matchAll(/^ {2}(\w+): \{/gm)].map((match) => match[1]));

/** What would load a mark from elsewhere: an image, a `use` of another file, a font, a `src`. */
const FETCHES = /<(?:image|img|use|link)\b|\b(?:src|href|xlinkHref)=/;

describe('the marks of the sources (FRU-435)', () => {
  it('are drawn inline and load nothing', () => {
    assert.equal(FETCHES.test(source), false);
    // The control: a mark that loads its picture is found.
    assert.equal(FETCHES.test('<svg><image href="https://cdn.example/l.svg" /></svg>'), true);
  });

  it('are hidden from a screen reader, which reads the name beside them', () => {
    const svgs = source.match(/<svg\b[^>]*>/g) ?? [];
    assert.equal(svgs.length, 1);
    for (const svg of svgs) {
      assert.match(svg, /aria-hidden="true"/);
      assert.match(svg, /focusable="false"/);
    }
  });

  it('sit before the name of the source, in the column of where a note went', () => {
    assert.match(notes, /<ConnectorMark kind=\{place\.kind\} \/>\s*\{name\}/);
  });

  it('has one for each source of the Connectors screen, connected or to add (FRU-543)', () => {
    // The sources to add that do not exist yet, and the three that do.
    const later = [...connectors.matchAll(/\{ kind: '(\w+)', name: '/g)].map((match) => match[1]);
    assert.deepEqual(later, ['jira', 'gitlab', 'trello', 'notion', 'webhook']);
    for (const kind of [...later, 'linear', 'github', 'rest']) assert.ok(marked.has(kind), `a mark for ${kind}`);
    // The control: a kind with no mark is found.
    assert.equal(marked.has('asana'), false);
  });

  it('is drawn before the name of every source of the Connectors screen (FRU-543)', () => {
    // Every source to add and every connected one names its kind to the box of the mark.
    const sources = connectors.match(/<Source\b[^>]*>/gs) ?? [];
    assert.equal(sources.length, 4);
    for (const each of sources) assert.match(each, /\bkind=\{?["'\w.]/);
    assert.match(connectors, /<SourceMark kind=\{connector\.kind\} \/>/);
    // The box draws the mark, and no letter any more (the « L », « G », « { } » of the mockup).
    assert.match(parts, /<ConnectorMark kind=\{kind\} size=\{18\} \/>/);
    assert.doesNotMatch(parts, /mark: '/);
  });
});
