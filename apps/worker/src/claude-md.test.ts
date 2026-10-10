import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/**
 * `CLAUDE.md` stays short, and every page it sends a reader to is there.
 *
 * `CLAUDE.md` is loaded into every session of an agent, and `docs/decisions/` is not. The file grew
 * to 1,450 lines one paragraph at a time, each of them true, until no session read it whole. It was
 * cut to what no lint rule and no test can hold, and this test is what keeps it there: the split is
 * written in `docs/decisions/README.md`, and a rule that is only written is a rule that drifts.
 *
 * The budget is a tripwire, not a target. A paragraph that trips it belongs in a lint rule, in a
 * guard test or in a decisions page, and `CLAUDE.md` keeps one line of it at most.
 *
 * The links are checked here too, anchors included, because the file is now mostly an index: a page
 * renamed without it leaves an agent with a rule and no reason.
 *
 * It lives beside `contributing.test.ts`, which also guards files at the root, because the root has
 * no `test` target.
 */

const ROOT = new URL('../../../', import.meta.url);
const DECISIONS = new URL('docs/decisions/', ROOT);

const MAX_LINES = 190;
const MAX_BYTES = 12_500;

function read(url: URL): string {
  return readFileSync(url, 'utf8');
}

/** The pages of `docs/decisions/`, by file name. The README is their index and not one of them. */
function decisionPages(): string[] {
  return readdirSync(DECISIONS)
    .filter((file) => file.endsWith('.md') && file !== 'README.md')
    .sort();
}

/** A fenced block is an example, and an example of a link is not a link. */
function withoutFences(source: string): string {
  return source.replace(/^ *```[\s\S]*?^ *```/gm, '');
}

/** Every relative link of a document, as written. */
function relativeLinks(source: string): string[] {
  return [...withoutFences(source).matchAll(/\]\(([^)\s]+)\)/g)]
    .map((match) => match[1] as string)
    .filter((target) => !/^(https?:|mailto:)/.test(target));
}

/**
 * The anchor GitHub gives a heading: lower case, punctuation removed, each space a hyphen.
 *
 * Inline markup is taken off first, because GitHub slugs the rendered text. Measured on 2026-10-10
 * against the anchors GitHub renders for `CLAUDE.md` and every decisions page: 184 headings, and
 * every one the same. A heading that holds an underscore inside a code span was not among them.
 */
export function slugOf(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');
}

/**
 * The anchors of a document. A heading that repeats takes a number, as on GitHub: the second
 * `The rules, in short` of a page is `the-rules-in-short-1`.
 */
export function anchorsOf(source: string): Set<string> {
  const seen = new Map<string, number>();
  const anchors = new Set<string>();

  for (const match of withoutFences(source).matchAll(/^#{1,6} +(.+)$/gm)) {
    const slug = slugOf(match[1] as string);
    const count = seen.get(slug) ?? 0;

    seen.set(slug, count + 1);
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
  }

  return anchors;
}

/** What is wrong with each relative link of one document: a file that is not there, or a heading. */
function brokenLinks(document: URL): string[] {
  return relativeLinks(read(document)).flatMap((target) => {
    const [path = '', anchor] = target.split('#');
    const file = path === '' ? document : new URL(path, document);

    if (!existsSync(file)) return [`${target} names no file`];
    if (anchor === undefined || !file.pathname.endsWith('.md')) return [];

    return anchorsOf(read(file)).has(anchor) ? [] : [`${target} names no heading of that file`];
  });
}

describe('CLAUDE.md is what no machine holds, and an index of the rest', () => {
  const claude = read(new URL('CLAUDE.md', ROOT));

  it('stays inside its budget', () => {
    const lines = claude.split('\n').length - 1;
    const bytes = Buffer.byteLength(claude);
    const where = 'move the paragraph to a lint rule, a guard test or docs/decisions/, and keep one line here';

    assert.ok(lines <= MAX_LINES, `CLAUDE.md is ${lines} lines, over ${MAX_LINES}: ${where}`);
    assert.ok(bytes <= MAX_BYTES, `CLAUDE.md is ${bytes} bytes, over ${MAX_BYTES}: ${where}`);
  });

  /** A guard over an empty set passes. */
  it('finds the decisions pages it is written to guard', () => {
    assert.ok(decisionPages().length >= 9, `only ${decisionPages().length} pages found in docs/decisions/`);
  });

  it('sends a reader to every decisions page', () => {
    const missing = decisionPages().filter((page) => !claude.includes(`](docs/decisions/${page})`));

    assert.deepEqual(missing, [], 'a decisions page that CLAUDE.md does not name is a page no agent opens');
  });

  it('is indexed, page by page, in the README of the decisions', () => {
    const readme = read(new URL('README.md', DECISIONS));
    const missing = decisionPages().filter((page) => !readme.includes(`](${page})`));

    assert.deepEqual(missing, []);
  });

  it('holds no link to a file or a heading that is not there', () => {
    assert.deepEqual(brokenLinks(new URL('CLAUDE.md', ROOT)), []);
  });

  it('holds no such link in a decisions page either', () => {
    for (const page of [...decisionPages(), 'README.md']) {
      assert.deepEqual(brokenLinks(new URL(page, DECISIONS)), [], `docs/decisions/${page}`);
    }
  });

  it('slugs a heading as GitHub does', () => {
    assert.equal(slugOf('The widget'), 'the-widget');
    assert.equal(slugOf('One prefix, and it is `fruitback`'), 'one-prefix-and-it-is-fruitback');
    assert.equal(slugOf('The feedback as text (FRU-109)'), 'the-feedback-as-text-fru-109');
    assert.equal(
      slugOf('The session, and the token that never goes down (FRU-60)'),
      'the-session-and-the-token-that-never-goes-down-fru-60',
    );
  });

  it('numbers a heading that repeats, as GitHub does', () => {
    const anchors = anchorsOf('# The widget\n\n## The widget\n\n### The rules, in short\n\n### The rules, in short\n');

    assert.deepEqual([...anchors], ['the-widget', 'the-widget-1', 'the-rules-in-short', 'the-rules-in-short-1']);
  });
});
