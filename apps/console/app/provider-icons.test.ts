import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** The console has no DOM under `node --test`: the guard reads the source (FRU-362). */
const source = readFileSync(new URL('provider-icons.tsx', import.meta.url), 'utf8');
const form = readFileSync(new URL('sign-in-form.tsx', import.meta.url), 'utf8');

/** What would load a mark from elsewhere: an image, a `use` of another file, a font, a `src`. */
const FETCHES = /<(?:image|img|use|link)\b|\b(?:src|href|xlinkHref)=/;

describe('the marks of the providers of sign-in (FRU-362)', () => {
  it('are drawn inline and load nothing', () => {
    assert.equal(FETCHES.test(source), false);
    // The control: a mark that loads its picture is found.
    assert.equal(FETCHES.test('<svg><image href="https://cdn.example/g.svg" /></svg>'), true);
  });

  it('are hidden from a screen reader, which reads the words of the button', () => {
    const svgs = source.match(/<svg\b[^>]*>/g) ?? [];
    assert.equal(svgs.length, 2);
    for (const svg of svgs) {
      assert.match(svg, /aria-hidden="true"/);
      assert.match(svg, /focusable="false"/);
    }
  });

  it('paint the G in the four colours of Google, and GitHub in the colour of the words', () => {
    for (const colour of ['blue', 'green', 'yellow', 'red']) assert.match(source, new RegExp(`fill-google-${colour}`));
    assert.match(source, /fill-current/);
  });

  it('sit beside the words of their own button', () => {
    assert.match(form, /<GoogleMark \/>\s*\{t\('Continue with Google'\)\}/);
    assert.match(form, /<GitHubMark \/>\s*\{t\('Continue with GitHub'\)\}/);
  });
});
