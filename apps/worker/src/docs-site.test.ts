import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { parse } from 'yaml';

/**
 * The home page of the documentation site, against the guides beside it (FRU-80).
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

describe('the documentation site (FRU-80)', () => {
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

/** The id GitHub Pages gives a heading (kramdown, GFM input): lower case, no punctuation, a dash per space. */
function headingId(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}\s_-]/gu, '')
    .replaceAll(/\s/g, '-');
}

/** The ids of the headings of a guide. */
function headingIds(guide: string): string[] {
  const text = readFileSync(new URL(guide, DOCS), 'utf8');

  return [...text.matchAll(/^#{1,6} (.+)$/gm)].map((match) => headingId(match[1] as string));
}

/** Every link of the landing to a page of the site with a fragment, as `[page.html, fragment]`. */
function anchoredLinksOfLanding(): [string, string][] {
  const landing = readFileSync(new URL('_layouts/landing.html', DOCS), 'utf8');

  return [...landing.matchAll(/'\/([a-z-]+)\.html#([^']+)' \| relative_url/g)].map((match) => [
    match[1] as string,
    match[2] as string,
  ]);
}

describe('the landing (FRU-418)', () => {
  it('leads to the install of the extension', () => {
    const links = anchoredLinksOfLanding().filter(
      ([page, fragment]) => page === 'reviewing' && fragment === '1-install-it',
    );

    // Firefox, by hand: the card « Sites you cannot touch », and the question about a site with no script.
    assert.equal(links.length, 2, 'the landing lost a link to « 1. Install it » of the reviewer’s guide');
  });

  it('leads Chrome and Edge to the Chrome Web Store', () => {
    const landing = readFileSync(new URL('_layouts/landing.html', DOCS), 'utf8');
    const store = 'https://chromewebstore.google.com/detail/fruitback/jjjemdloknmggncbickofjgbodplekoa';

    // The card, the question, and the footer.
    assert.equal(landing.split(`href="${store}"`).length - 1, 3, 'the landing lost a link to the Chrome Web Store');
    assert.ok(!landing.includes('not in a store yet'), 'the landing still says the extension is in no store');
  });

  it('names only fragments that are headings of their guide', () => {
    const links = anchoredLinksOfLanding();
    assert.ok(links.length > 0, 'no anchored link found — the walk stopped matching');

    assert.deepEqual(
      links.filter(([page, fragment]) => !headingIds(`${page}.md`).includes(fragment)),
      [],
      'these links name a heading their guide does not have',
    );
  });
});
