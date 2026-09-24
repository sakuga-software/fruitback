import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/**
 * The home page of the documentation site, against the guides beside it (SKG-619).
 *
 * The site is `docs/`, published by GitHub Pages from `main`. The markdown stays the source — every
 * other test here reads the files, not the site — so what can rot is the one page that was written
 * for the site alone: a guide added to the folder and linked from nowhere is a page nobody reaches,
 * and a renamed file is a dead link a reader meets instead of a 404 in a test.
 *
 * **A link is written to the `.md` file, never to the page it becomes.** `jekyll-relative-links`
 * rewrites it, which is what lets one file read the same on GitHub and on the site.
 *
 * It lives beside `contributing.test.ts`, which also guards files at the root, because the root has
 * no `test` target.
 */

const DOCS = new URL('../../../docs/', import.meta.url);

/** Every guide in `docs/`, by file name. The home page is not one of them. */
function guides(): string[] {
  return readdirSync(DOCS)
    .filter((file) => file.endsWith('.md') && file !== 'index.md')
    .sort();
}

/** Every relative link of the home page, as written. */
function linksOfIndex(): string[] {
  const index = readFileSync(new URL('index.md', DOCS), 'utf8');

  return [...index.matchAll(/\]\(([^)#]+)\)/g)].flatMap((match) => {
    const target = match[1] as string;

    return target.startsWith('http') ? [] : [target];
  });
}

describe('the documentation site (SKG-619)', () => {
  it('links every guide from its home page', () => {
    const linked = new Set(linksOfIndex());
    const all = guides();

    assert.ok(all.length >= 5, `only ${all.length} guides found — the walk stopped matching`);
    assert.deepEqual(
      all.filter((guide) => !linked.has(guide)),
      [],
      'these guides are published and linked from nowhere',
    );
  });

  it('links them by the file, and every file is there', () => {
    const missing = linksOfIndex().filter((link) => {
      if (!link.endsWith('.md')) return true;
      try {
        readFileSync(new URL(link, DOCS));

        return false;
      } catch {
        return true;
      }
    });

    assert.deepEqual(missing, [], 'these links name no markdown file of this folder');
  });
});
