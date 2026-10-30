import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

/**
 * Every page of the guides, as a path under `docs/`: the guides, and the pages a guide was split into
 * (FRU-427), one folder down. The decisions and the folders of Jekyll are not pages.
 */
function pages(): string[] {
  return readdirSync(DOCS, { recursive: true, encoding: 'utf8' })
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => file.endsWith('.md') && file !== 'index.md')
    .filter((file) => !/^(decisions|_[a-z]+|assets)\//.test(file))
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

  it('keeps no word of the garden in its title, and promises the component only when the build exposes it (FRU-514)', () => {
    const landing = readFileSync(new URL('_layouts/landing.html', DOCS), 'utf8');
    const title = /<h1>([^<]*)<\/h1>/.exec(landing)?.[1] ?? '';

    assert.ok(title.length > 0, 'the landing has no h1');
    assert.doesNotMatch(title, /plant|harvest|seed|ripe/i, 'the h1 keeps the metaphor that FRU-355 removed');
    assert.ok(!landing.includes('attached to every note'), 'the landing says every note carries the React component');
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

    assert.ok(pages().length > guides().length, 'no page in a folder found — the walk stopped matching');
    assert.deepEqual(
      pages().filter((page) => !listed.has(page)),
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

  it('scrolls and goes from page to page with a transition, and with none for less motion (FRU-440)', () => {
    for (const sheet of ['assets/docs.css', 'assets/landing.css']) {
      const css = readFileSync(new URL(sheet, DOCS), 'utf8');
      const [always, reduced = ''] = css.split('@media (prefers-reduced-motion: reduce)');
      assert.match(always ?? '', /html \{[^}]*scroll-behavior: smooth;/, `${sheet}: no smooth scroll`);
      assert.match(always ?? '', /@view-transition \{\s*navigation: auto;/, `${sheet}: no transition between pages`);
      assert.match(reduced, /scroll-behavior: auto;/, `${sheet}: the scroll stays smooth for less motion`);
      assert.match(reduced, /@view-transition \{\s*navigation: none;/, `${sheet}: the pages fade for less motion`);
    }
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
    const exposed = pages().flatMap((guide) => {
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

/** Where a part of a guide went when the guide was split (FRU-427), from `_data/moved.yml`. */
function moved(): [string, string, string][] {
  const data = parse(readFileSync(new URL('_data/moved.yml', DOCS), 'utf8')) as Record<string, Record<string, string>>;

  return Object.entries(data).flatMap(([page, ids]) => Object.entries(ids).map(([id, to]) => [page, id, to] as const));
}

describe('the guides split in pages (FRU-427)', () => {
  it('sends every id that left a page to a page, and a heading of it', () => {
    const all = moved();
    assert.ok(all.length >= 20, `only ${all.length} moved ids found — the walk stopped matching`);

    assert.deepEqual(
      all.filter(([, , to]) => {
        const [page = '', fragment] = to.split('#');
        const source = sourceOf(page);

        return source === undefined || (fragment !== undefined && !headingIds(source).includes(fragment));
      }),
      [],
      'these ids of docs/_data/moved.yml lead to no page, or to no heading of it',
    );
  });

  /** The old page keeps an empty element with the old id: a heading with that id too would be two. */
  it('keeps the old page, and none of the ids that left it', () => {
    assert.deepEqual(
      moved().filter(([page, id]) => {
        const source = sourceOf(page);

        return source === undefined || headingIds(source).includes(id);
      }),
      [],
      'these ids of docs/_data/moved.yml are still headings of their page, or their page is gone',
    );
  });

  /**
   * The site publishes `docs/` and nothing above it, and not `decisions/` (FRU-429). A relative link
   * to `../SECURITY.md` reads well on GitHub, and answers 404 on fruitback.com. Such a link names the
   * file on GitHub instead.
   */
  it('links nothing out of the published pages by a relative path', () => {
    const outside = excluded();
    const leaving = pages().flatMap((page) => {
      const text = readFileSync(new URL(page, DOCS), 'utf8').replaceAll(/^```[\s\S]*?^```/gm, '');

      return [...text.matchAll(/\]\(([^)\s]+)\)/g)].flatMap((match) => {
        const link = match[1] as string;
        if (/^[a-z]+:/.test(link) || link.startsWith('#')) return [];
        const target = new URL(link.split('#')[0] ?? '', new URL(page, DOCS)).pathname;
        if (!target.startsWith(DOCS.pathname)) return [`${page}: ${link}`];
        const inside = target.slice(DOCS.pathname.length);

        return outside.some((entry) => inside === entry || inside.startsWith(`${entry}/`)) ? [`${page}: ${link}`] : [];
      });
    });

    assert.deepEqual(leaving, [], 'these links leave the site: name the file on GitHub');
  });

  /** A split moves headings from one file to another: a link between two guides is where it breaks. */
  it('links each guide only to pages that exist, and to headings they have', () => {
    const broken = pages().flatMap((page) => {
      const text = readFileSync(new URL(page, DOCS), 'utf8').replaceAll(/^```[\s\S]*?^```/gm, '');

      return [...text.matchAll(/\]\(([^)\s]+)\)/g)].flatMap((match) => {
        const link = match[1] as string;
        if (/^[a-z]+:/.test(link)) return [];
        const [path = '', fragment] = link.split('#');
        const target = path === '' ? new URL(page, DOCS) : new URL(path, new URL(page, DOCS));
        // A file out of `docs/` is read on GitHub: it has to exist, and its ids are GitHub's.
        if (!target.pathname.startsWith(DOCS.pathname) || target.pathname.includes('/docs/decisions/')) {
          return existsSync(target) ? [] : [`${page}: ${link}`];
        }
        const inside = target.pathname.slice(DOCS.pathname.length);
        try {
          readFileSync(target);
        } catch {
          return [`${page}: ${link}`];
        }
        if (fragment === undefined || !inside.endsWith('.md')) return [];

        return headingIds(inside).includes(fragment) ? [] : [`${page}: ${link}`];
      });
    });

    assert.deepEqual(broken, [], 'these links of a guide name no file, or no heading of it');
  });
});

/**
 * Sentences that were true before a release, or before FRU-330, and stayed in the guides after it
 * (FRU-514). The packages are on npm since 0.5.0, and the visibility of a site is not its mode.
 */
describe('the guides after the first release (FRU-514)', () => {
  const readme = readFileSync(new URL('../README.md', DOCS), 'utf8');
  const install = readFileSync(new URL('install.md', DOCS), 'utf8');

  it('says the packages and the extension are published', () => {
    const published = readme.split('\n').find((line) => line.startsWith('| Published'));

    assert.ok(published !== undefined, 'the table of the modes lost its row « Published »');
    assert.doesNotMatch(published, /not yet/, 'the README says the modes are not published');
    assert.ok(!install.includes('not on npm yet'), 'docs/install.md says the packages are not on npm');
  });

  it('does not call the visibility « Members of the workspace » the team mode', () => {
    assert.ok(!install.includes('this is the team mode'), 'docs/install.md names a visibility as a mode');
  });
});
