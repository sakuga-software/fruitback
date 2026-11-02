import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'vitest';

/**
 * The published guides read as guides, not as design notes (FRU-561). The rule is in
 * `docs/decisions/conventions.md`, « The published guides ». In the text of a guide:
 *
 * - no ticket reference (`FRU-` and a number): a reader outside the team cannot open one;
 * - no em dash, written as the character, as an entity, or as `---` that the site's kramdown turns
 *   into one;
 * - one bold segment per section at most, so that the one there stands out.
 *
 * The last clause of the rule, no bullet that opens with a bold label, has no guard yet (FRU-577):
 * 36 bullets still open with one, 22 of them in SECURITY.md, and changing that page is a pull request
 * of its own.
 *
 * Only what a reader sees as prose is read. A heading keeps its words, ticket included: its id is an
 * address that other pages, `moved.yml` and the extension link to. The front matter, fenced code,
 * code spans (over two lines too), HTML comments and tags, link targets and bare addresses are not
 * prose. Nor is the block that `apps/console/guide-docs.ts` copies from the steps of the guide: the
 * console shows the same steps with their bold, and `guide-steps.test.ts` holds the copy.
 *
 * Bold is read as pairs, inside one block (a paragraph, a list item, a table row), over several lines
 * if needed. A `**` left without a pair is reported too: it shows as two asterisks.
 *
 * It lives beside `docs-site.test.ts`, which also reads `docs/`, because the root has no `test` target.
 */

const ROOT = new URL('../../../', import.meta.url);

/** Every published guide, as a path from the root: README, SECURITY and `docs/` but its decisions. */
function published(): string[] {
  const docs = readdirSync(new URL('docs/', ROOT), { recursive: true, encoding: 'utf8' })
    .map((file) => `docs/${file.replaceAll('\\', '/')}`)
    .filter((file) => file.endsWith('.md'))
    .filter((file) => !/^docs\/(decisions|_[a-z]+|assets)\//.test(file));

  return ['README.md', 'SECURITY.md', ...docs].sort();
}

type What = 'ticket' | 'em dash' | 'second bold' | 'unpaired bold';

type Finding = { line: number; column: number; what: What; detail: string };

const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/;
const TABLE_ROW = /^[ \t]*\|/;
const BLANK_LINE = /\n[ \t]*\n/;

/**
 * What stands for a character that is not prose. It is neither a space nor a word character: a code
 * span inside a bold pair keeps the pair closed (« **the host `x`** »), and it joins no word.
 */
const HIDDEN = '\u2060';

/** Hides `chars[start, end)`, newlines kept, so that lines and columns do not move. */
function blank(chars: string[], start: number, end: number, by = HIDDEN): void {
  for (let index = start; index < Math.min(end, chars.length); index += 1) {
    if (chars[index] !== '\n') chars[index] = by;
  }
}

/**
 * The lines of a page, with what is not prose blanked out, and which lines are headings. A heading is
 * blanked too, and starts a section.
 */
function blocksOf(markdown: string): { lines: string[]; headings: Set<number> } {
  const lines = markdown.split('\n');
  const headings = new Set<number>();
  let fence: { char: string; length: number } | undefined;
  let front = lines[0]?.trim() === '---';
  let copied = false;

  const kept = lines.map((line, index) => {
    if (front) {
      if (index > 0 && line.trim() === '---') front = false;
      return '';
    }
    const marks = /^[ \t]*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marks?.[0] === fence.char && marks.length >= fence.length && line.trim() === marks) fence = undefined;
      return '';
    }
    if (marks) {
      fence = { char: marks[0] ?? '`', length: marks.length };
      return '';
    }
    if (line.trimStart().startsWith('<!-- guide:start')) copied = true;
    if (copied) {
      if (line.trimStart().startsWith('<!-- guide:end')) copied = false;
      return '';
    }
    if (HEADING.test(line)) {
      headings.add(index);
      return '';
    }
    // A thematic break, `***` or `___` included: its marks are not bold.
    if (/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line)) return '';
    // A reference definition, `[label]: https://…`: its target is an address.
    return line.replace(
      /^( {0,3}\[[^\]]+\]:[ \t]*)(\S+)/,
      (_, label: string, target: string) => label + HIDDEN.repeat(target.length),
    );
  });

  const chars = kept.join('\n').split(''); // UTF-16 units, as the indexes of a match are.
  const text = chars.join('');
  for (let index = 0; index < chars.length;) {
    const rest = text.slice(index, index + 2000);
    if (chars[index] === '\\' && /^\\[!-/:-@[-`{-~]/.test(rest)) {
      blank(chars, index, index + 2);
      index += 2;
      continue;
    }
    if (chars[index] === '`') {
      const length = /^`+/.exec(rest)?.[0].length ?? 1;
      let end = -1;
      for (const run of text.slice(index + length).matchAll(/`+/g)) {
        const at = index + length + run.index;
        if (BLANK_LINE.test(text.slice(index, at))) break;
        if (run[0].length === length) {
          end = at + length;
          break;
        }
      }
      // A run with no closing run of the same length is literal backticks: not prose either.
      blank(chars, index, end === -1 ? index + length : end);
      index = end === -1 ? index + length : end;
      continue;
    }
    if (rest.startsWith('<!--')) {
      const close = text.indexOf('-->', index + 4);
      const end = close === -1 ? chars.length : close + 3;
      blank(chars, index, end);
      index = end;
      continue;
    }
    const tag = /^<(?:\/?[A-Za-z][\w-]*(?:\s[^<>]*)?\/?|[A-Za-z][\w+.-]*:[^\s<>]*)>/.exec(rest);
    if (tag) {
      blank(chars, index, index + tag[0].length);
      index += tag[0].length;
      continue;
    }
    const target = /^\]\((?:<[^>\n]*>|(?:[^()\s]|\([^()\s]*\))*)(?:\s+"[^"\n]*")?\)/.exec(rest);
    if (target) {
      blank(chars, index + 2, index + target[0].length - 1);
      index += target[0].length;
      continue;
    }
    const address = /^(?:https?:\/\/|www\.)[^\s<>]*[^\s<>.,:;!?'")\]]/.exec(rest);
    if (address && !/\w/.test(chars[index - 1] ?? '')) {
      blank(chars, index, index + address[0].length);
      index += address[0].length;
      continue;
    }
    index += 1;
  }

  return { lines: chars.join('').split('\n'), headings };
}

/** What breaks the rule in one page of markdown, in the order of the page. */
function findingsIn(markdown: string): Finding[] {
  const { lines, headings } = blocksOf(markdown);
  const source = markdown.split('\n');
  const found: Finding[] = [];

  lines.forEach((line, index) => {
    const at = (column: number, what: What, detail: string) =>
      found.push({ line: index + 1, column: column + 1, what, detail });
    for (const match of line.matchAll(/FRU-\d+/g)) at(match.index, 'ticket', `${match[0]} in the text`);
    for (const match of line.matchAll(/—|&mdash;|&#8212;|&#x2014;/gi)) at(match.index, 'em dash', match[0]);
    // A line of dashes alone is a rule or the line under a table head; inside a sentence, an em dash.
    if (!/^[\s|:*_-]*$/.test(line)) {
      for (const match of line.matchAll(/(?<!-)---(?!-)/g)) at(match.index, 'em dash', '--- (kramdown)');
    }
  });

  // Blocks: a bold pair never crosses a blank line, a heading, a list item or a table row.
  type Block = { start: number; text: string; offsets: number[] };
  const sections: Block[][] = [[]];
  let block: Block | undefined;
  lines.forEach((line, index) => {
    const startsSection = headings.has(index);
    const startsBlock =
      startsSection || line.trim() === '' || LIST_ITEM.test(source[index] ?? '') || TABLE_ROW.test(line);
    if (startsSection) sections.push([]);
    if (startsBlock || !block) {
      block = { start: index, text: '', offsets: [] };
      sections.at(-1)?.push(block);
    }
    block.offsets.push(block.text.length);
    block.text += `${line}\n`;
  });

  const position = (current: Block, offset: number) => {
    let row = 0;
    while (row + 1 < current.offsets.length && (current.offsets[row + 1] ?? 0) <= offset) row += 1;
    return { line: current.start + row + 1, column: offset - (current.offsets[row] ?? 0) + 1 };
  };

  for (const section of sections) {
    const bolds: { line: number; column: number }[] = [];
    for (const current of section) {
      const left = current.text.split('');
      for (const pair of current.text.matchAll(/\*\*(?=[^\s*])[\s\S]*?[^\s*]\*\*|(?<!\w)__(?=\S)[\s\S]*?\S__(?!\w)/g)) {
        const opening = position(current, pair.index);
        bolds.push(opening);
        blank(left, pair.index, pair.index + pair[0].length, ' ');
      }
      for (const mark of left.join('').matchAll(/\*\*|(?<!\w)__|__(?!\w)/g)) {
        found.push({ ...position(current, mark.index), what: 'unpaired bold', detail: `${mark[0]} with no pair` });
      }
    }
    const [first, ...others] = bolds;
    for (const other of others) {
      found.push({ ...other, what: 'second bold', detail: `the section has one already, at line ${first?.line}` });
    }
  }

  return found.sort((a, b) => a.line - b.line || a.column - b.column);
}

/** One line per finding, as the failure message shows it. */
function report(file: string, markdown: string): string[] {
  const source = markdown.split('\n');

  return findingsIn(markdown).map(
    (finding) =>
      `${file}:${finding.line}:${finding.column} ${finding.what} (${finding.detail}): ${(source[finding.line - 1] ?? '').trim().slice(0, 100)}`,
  );
}

/** The findings of a page, short: `line:column what`. */
function short(markdown: string): string[] {
  return findingsIn(markdown).map((finding) => `${finding.line}:${finding.column} ${finding.what}`);
}

describe('the published guides (FRU-561)', () => {
  it('are README, SECURITY and the pages of docs/, without the decisions', () => {
    const files = published();

    assert.ok(files.length > 25, `only ${files.length} pages were read`);
    for (const file of ['README.md', 'SECURITY.md', 'docs/privacy.md', 'docs/privacy/notice.md', 'docs/install.md']) {
      assert.ok(files.includes(file), `${file} is not read`);
    }
    assert.deepEqual(
      files.filter((file) => file.startsWith('docs/decisions/') || file.startsWith('docs/_')),
      [],
    );
  });

  it('name no ticket, write no em dash, and put one bold segment at most in a section', () => {
    const broken = published().flatMap((file) => report(file, readFileSync(new URL(file, ROOT), 'utf8')));

    assert.equal(
      broken.length,
      0,
      `${broken.length} breaks of « The published guides » (docs/decisions/conventions.md):\n${broken.join('\n')}`,
    );
  });
});

describe('the guard of the guides finds (the control)', () => {
  it('a ticket, an em dash in each of its forms, and says where', () => {
    const page = [
      'A sentence (FRU-12).',
      'An aside — here.',
      'An entity &mdash; here.',
      // kramdown, which builds the site, renders `---` in a sentence as an em dash (measured, 2.5).
      'Typed --- by hand.',
      'A link whose words name [FRU-16](https://example.com/FRU-16): the reader sees them.',
      // A code span ends with its paragraph: these two backticks are literal, and FRU-17 is prose.
      'A lone ` in a paragraph.',
      '',
      'The next one names FRU-17 ` here.',
    ].join('\n');

    assert.deepEqual(short(page), [
      '1:13 ticket',
      '2:10 em dash',
      '3:11 em dash',
      '4:7 em dash',
      '5:26 ticket',
      '8:20 ticket',
    ]);
    assert.deepEqual(
      report('docs/page.md', page)[0],
      'docs/page.md:1:13 ticket (FRU-12 in the text): A sentence (FRU-12).',
    );
  });

  it('a second bold in a section, also over two lines, and a mark with no pair', () => {
    const page = [
      'One **bold**, then **another**.',
      '## A bold over two lines',
      'A **bold that',
      'ends here**, then **a second**.',
      '## A mark with no pair',
      'A **mark that never closes.',
      '',
      'And **one** in the next paragraph, the first pair of its section.',
      '## Bold in two list items is two segments',
      '- An item with **a mark',
      '- and an item** with another.',
    ].join('\n');

    assert.deepEqual(short(page), [
      '1:20 second bold',
      '4:19 second bold',
      '6:3 unpaired bold',
      '10:16 unpaired bold',
      '11:14 unpaired bold',
    ]);
  });

  it('nothing in a heading, the front matter, code, a comment, a tag, a link target or the copied guide', () => {
    const page = [
      '---',
      'title: FRU-1 — a title',
      '---',
      '# A heading (FRU-2) — with **two** **bolds**',
      'A span `FRU-3 — **code** **span**` and one over',
      'two lines: `test name (FRU-4',
      '— two **lines** **here**)`, then ``a `nested` FRU-5``.',
      '```ts',
      'FRU-6 — **fenced** **code**',
      '```',
      '~~~~',
      '```',
      'FRU-7 still fenced, by tildes.',
      '~~~~',
      'Before <!-- FRU-8 — a comment',
      '**still** **a comment** --> after.',
      'A [link to the ticket](https://linear.app/sakuga-software/issue/FRU-9/some-title "FRU-10 — title").',
      'A bare address https://linear.app/sakuga-software/issue/FRU-11 and <https://example.com/FRU-12>.',
      '<a href="https://example.com/FRU-13">a tag</a>, an escaped \\*\\* and a [reference][r].',
      '[r]: https://example.com/FRU-14',
      '<!-- guide:start: written from the steps. -->',
      'A copied step (FRU-15) — **one** **two**.',
      '<!-- guide:end -->',
      '***',
      '| Head | Head |',
      '| ---- | :--: |',
      '',
      '---',
      '',
      'The one **bold** of its section.',
    ].join('\n');

    assert.deepEqual(short(page), []);
  });

  it('what is planted in a copy of a real guide, and nothing else', () => {
    const readme = readFileSync(new URL('README.md', ROOT), 'utf8');
    // The copy starts clean, so that only what is planted can be found. Review of #799.
    assert.deepEqual(short(readme), [], 'README.md breaks the rule itself: the test of the guides says where');
    const lines = readme.split('\n');
    const end = lines.length;
    lines.push('', '## Planted', 'Since FRU-561 — a **first** and a **second** bold.');

    assert.deepEqual(short(lines.join('\n')), [
      `${end + 3}:7 ticket`,
      `${end + 3}:15 em dash`,
      `${end + 3}:35 second bold`,
    ]);
  });
});
