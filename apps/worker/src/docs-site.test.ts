import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

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
 * **And a file on disk is not a page on the site.** A link out of `docs/`, or into what `_config.yml`
 * excludes, resolves to a file that exists and to a page that answers `404` — the reader meets it,
 * and no test does. Raised in review.
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

/** What the site does not publish, from `_config.yml`: a name, or a folder written with its slash. */
function excluded(): string[] {
  const config = parse(readFileSync(new URL('_config.yml', DOCS), 'utf8')) as { exclude?: string[] };

  return (config.exclude ?? []).map((entry) => entry.replace(/\/$/, ''));
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

  /**
   * The decisions are the per-ticket histories, written for whoever works on this repository. The
   * site leaves them out, and the check above leans on that list: a reader that found none would
   * pass every link into them.
   */
  it('publishes the guides and not the decisions', () => {
    assert.deepEqual(excluded(), ['decisions']);
  });

  it('links them by the file, and every file is published', () => {
    const outside = excluded();
    const unreachable = linksOfIndex().filter((link) => {
      if (!link.endsWith('.md')) return true;
      // A link that climbs out of `docs/` names a file GitHub renders and the site never publishes.
      const resolved = new URL(link, DOCS);
      if (!resolved.pathname.startsWith(DOCS.pathname)) return true;

      const inside = resolved.pathname.slice(DOCS.pathname.length);
      if (outside.some((entry) => inside === entry || inside.startsWith(`${entry}/`))) return true;

      try {
        readFileSync(resolved);

        return false;
      } catch {
        return true;
      }
    });

    assert.deepEqual(unreachable, [], 'these links name no page of this site');
  });
});
