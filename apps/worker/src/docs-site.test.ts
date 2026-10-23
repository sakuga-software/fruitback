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

    // The card « Sites you cannot touch », the question about a site with no script, and the footer.
    assert.equal(links.length, 3, 'the landing lost a link to « 1. Install it » of the reviewer’s guide');
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

/** The six sections of the guides (FRU-417), as `_data/docs.yml` lists them. */
type Section = { title: string; short?: string; pages: { title: string; url: string }[] };

function sections(): Section[] {
  return parse(readFileSync(new URL('_data/docs.yml', DOCS), 'utf8')) as Section[];
}

/** The source of a page of the site, from its address: `/install.html` is `install.md`. */
function sourceOf(page: string): string | undefined {
  const name = page.replace(/^\//, '').replace(/\.html$/, '');
  for (const candidate of [`${name}.md`, `${name}.html`]) {
    try {
      readFileSync(new URL(candidate, DOCS));

      return candidate;
    } catch {
      // The other extension, then nothing.
    }
  }

  return undefined;
}

/** The relative luminance of a `#rrggbb` colour, as WCAG 2 defines it. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = Number.parseInt(hex.slice(at, at + 2), 16) / 255;

    return channel <= 0.039_28 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(one: string, other: string): number {
  const [light, dark] = [luminance(one), luminance(other)].sort((a, b) => b - a) as [number, number];

  return (light + 0.05) / (dark + 0.05);
}

describe('the guides (FRU-417)', () => {
  it('lists every guide in a section of the sidebar', () => {
    const listed = new Set(
      sections().flatMap((section) => section.pages.map((page) => sourceOf(page.url.split('#')[0] ?? ''))),
    );

    assert.deepEqual(
      guides().filter((guide) => !listed.has(guide)),
      [],
      'these guides are in no section of docs/_data/docs.yml',
    );
  });

  it('links only pages of the site, and headings they have', () => {
    const links = sections().flatMap((section) => section.pages.map((page) => page.url));
    assert.ok(links.length >= 20, `only ${links.length} links found — the walk stopped matching`);

    const broken = links.filter((link) => {
      if (link.startsWith('https://github.com/sakuga-software/fruitback/')) return false;
      const [page = '', fragment] = link.split('#');
      const source = sourceOf(page);
      if (source === undefined) return true;

      return fragment !== undefined && !headingIds(source).includes(fragment);
    });

    assert.deepEqual(broken, [], 'these entries of docs/_data/docs.yml name no page, or no heading of it');
  });

  it('starts each section with a page, which the header links to', () => {
    assert.deepEqual(
      sections()
        .filter((section) => (section.pages[0]?.url ?? '#').includes('#'))
        .map((section) => section.title),
      [],
    );
  });

  it('keeps every text of the code blocks at 4.5:1 on their surface', () => {
    const css = readFileSync(new URL('assets/docs.css', DOCS), 'utf8');
    const surface = /--code-surface: (#[0-9a-f]{6});/.exec(css)?.[1];
    assert.ok(surface !== undefined, 'docs.css names no --code-surface');
    const text = /--code-text: (#[0-9a-f]{6});/.exec(css)?.[1];
    const palette = [...css.matchAll(/\.highlight [^{]*\{\s*color: (#[0-9a-f]{6});/g)].map(
      (match) => match[1] as string,
    );
    assert.ok(palette.length >= 6, `only ${palette.length} colours of the code found — the walk stopped matching`);

    assert.deepEqual(
      [text ?? 'none', ...palette].filter((colour) => colour === 'none' || contrast(colour, surface ?? '') < 4.5),
      [],
      'these colours of the code fall under 4.5:1 on the surface of a code block',
    );
  });

  it('keeps the text of the pages at 4.5:1 on the page and on a card', () => {
    const css = readFileSync(new URL('assets/docs.css', DOCS), 'utf8');
    const token = (name: string) => new RegExp(`--${name}: (#[0-9a-f]{6});`).exec(css)?.[1] ?? 'none';
    const pairs = ['ink', 'body', 'muted', 'link'].flatMap((text) =>
      ['page', 'surface', 'inset', 'chip'].map((ground) => [text, ground] as const),
    );

    assert.deepEqual(
      pairs.filter(
        ([text, ground]) =>
          token(text) === 'none' || token(ground) === 'none' || contrast(token(text), token(ground)) < 4.5,
      ),
      [],
      'these text colours fall under 4.5:1',
    );
  });
});

describe('the guides as Jekyll reads them (FRU-417)', () => {
  /**
   * Jekyll runs Liquid on every page, code blocks included: `{{println .}}` in a command of
   * `self-hosting.md` became an empty string on fruitback.com, and the command printed nothing. A
   * brace pair of Liquid goes between `<!-- {% raw %} -->` and `<!-- {% endraw %} -->`, which GitHub
   * hides and Jekyll reads.
   */
  it('keeps every Liquid brace of a guide inside a raw block', () => {
    const exposed = guides().flatMap((guide) => {
      const text = readFileSync(new URL(guide, DOCS), 'utf8').replaceAll(
        /<!-- \{% raw %\} -->[\s\S]*?<!-- \{% endraw %\} -->/g,
        '',
      );

      return text
        .split('\n')
        .filter((line) => /\{\{|\{%/.test(line))
        .map((line) => `${guide}: ${line.trim()}`);
    });

    assert.deepEqual(exposed, [], 'Jekyll would run these lines as Liquid');
  });
});
