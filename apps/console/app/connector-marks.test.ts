import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** The console has no DOM under `node --test`: the guard reads the source (FRU-435). */
const source = readFileSync(new URL('connector-marks.tsx', import.meta.url), 'utf8');
const notes = readFileSync(new URL('routes/notes.tsx', import.meta.url), 'utf8');

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
    assert.equal(svgs.length, 2);
    for (const svg of svgs) {
      assert.match(svg, /aria-hidden="true"/);
      assert.match(svg, /focusable="false"/);
    }
  });

  it('sit before the name of the source, in the column of where a note went', () => {
    // FRU-552: the name is said to a screen reader only where a reference or a host follows the mark.
    assert.match(
      notes,
      /<ConnectorMark kind=\{place\.kind\} \/>\s*\{after === null \? \(\s*<span className="font-semibold">\{name\}<\/span>/,
    );
    assert.match(notes, /<span className="sr-only">\{name\}<\/span>\s*\{after\}/);
  });
});
